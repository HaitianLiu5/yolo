// The Worker secret MEDIA_DNS_TOKEN: a Cloudflare API token that can edit the
// DNS records of the instance's zone, which LAN and remote direct play by
// name need (Agent Note 2026-10-12-lan-direct-play). `wrangler login` cannot
// grant DNS edit, so `provision media-dns` creates the token with Cloudflare's
// own CLI, `cf`, under its auth profile "yolo", which `npm run yolo -- auth`
// signs in once with the owner's approval on any device (lib/cf.js). The
// token is account-owned, limited to DNS Write and Zone Read on that one
// zone, and its value goes from cf's output straight to `wrangler secret put`
// on stdin: it is never printed or written to disk. Without cf, or without
// the owner's consent, the owner creates the token from a pre-filled
// dashboard page instead (Agent Note 2026-10-13-no-domain-deployment).
//
// An instance without a domain has no zone and needs no token. It can name
// the media listeners through a DNS provider plugin instead, deSEC first
// (Agent Note 2026-10-14-dns-provider-plugins): `provisionPluginDns()`
// below prints the owner's steps at the provider, reads the provider's token
// from stdin, checks it with the provider, and stores it as the secret the
// plugin names; `pluginDnsChecks()` is doctor's view of the same. Both learn
// the provider from the plugin's setup entry (`yolo.setup` in its
// package.json), found through the plugin config the Worker's build reads.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_FILE, loadPluginConfig, pluginConfigPath, readPluginConfig } from "@useyolo/plugin-api/host";
import { cfError, parseCf as parse, tokenFailure } from "./cf.js";
import { ROOT } from "./paths.js";

export const TOKEN_NAME = "Yolo media DNS";
export const SECRET = "MEDIA_DNS_TOKEN";
// What this step needs of the "yolo" profile; `auth` asks for these and more.
export const CF_SCOPES = Object.freeze(["account_api_tokens:create", "dns.write", "zone.read"]);
const PERMISSION_GROUPS = ["DNS Write", "Zone Read"];

export const CF_LOGIN = "npm run yolo -- auth (a link the owner approves on any device, a phone included)";
export const PUT_BY_HAND = `npm run wrangler -- secret put ${SECRET}`;

// The dashboard's token form, filled in with DNS edit and Zone read on the
// instance's zone. It makes a token owned by the signed-in user.
export function tokenTemplateUrl({ accountId = null, zoneId = null } = {}) {
  const keys = encodeURIComponent(JSON.stringify([{ key: "dns", type: "edit" }, { key: "zone", type: "read" }]));
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=${accountId ?? "*"}&zoneId=${zoneId ?? "all"}&name=${encodeURIComponent(TOKEN_NAME)}`;
}

export const byHand = (ids) => `the owner opens ${tokenTemplateUrl(ids)}, creates the token, and runs ${PUT_BY_HAND} to paste it`;

const zoneResource = (zoneId) => `com.cloudflare.api.account.zone.${zoneId}`;
const coversZone = (token, zoneId) => (token.policies ?? []).some((policy) => policy.effect === "allow" && Object.hasOwn(policy.resources ?? {}, zoneResource(zoneId)));

/**
 * @param {object} ctx  { instance, zone: { id, name } | null, rotate }
 * @param {object} deps
 *   cf(args) → { code, stdout, stderr } runs `cf --profile yolo …` in the
 *     instance's account, or is null when cf is not installed
 *   secrets.list() → the Worker's secret names; secrets.put(name, value) →
 *     { ok, error }, the value on stdin
 * @returns a provision step: { status, message, fix? }
 */
export async function provisionMediaDns({ instance, zone, rotate = false }, { cf, secrets }) {
  if (instance.workersDev || !instance.domain) {
    return { status: "unchanged", message: "Not needed: an instance without a domain has no zone, so the node's media names and this token do not apply. A free deSEC name gives them: npm run yolo -- provision media-dns --provider desec (skills/yolo-deploy)" };
  }
  const ids = { accountId: instance.accountId, zoneId: zone?.id ?? null };
  if (!zone) return { status: "fail", message: `No zone in account ${instance.accountId ?? "(unknown)"} holds ${instance.domain}`, fix: "The domain's DNS must be on Cloudflare in the instance's account" };

  let names;
  try {
    names = await secrets.list();
  } catch (error) {
    return { status: "fail", message: `Cannot list the Worker's secrets: ${error.message}`, fix: "npm run yolo -- deploy first: the secret belongs to the deployed Worker" };
  }
  // A token the owner stored by hand is kept too; --rotate replaces it.
  if (names.includes(SECRET) && !rotate) return { status: "unchanged", message: `The Worker has ${SECRET} (--rotate replaces it with a new value)` };

  if (!cf) {
    return { status: "needs_human", message: `cf, Cloudflare's CLI, is not installed, so the token cannot be created here`, fix: `npm install -g cf, then npm run yolo -- provision media-dns; or ${byHand(ids)}` };
  }
  const who = await cf(["auth", "whoami"]);
  const login = parse(who.stdout);
  const missing = CF_SCOPES.filter((scope) => !(login?.scopes ?? []).includes(scope));
  if (!login?.authenticated || missing.length) {
    return {
      status: "needs_human",
      message: `cf's "yolo" profile ${login?.authenticated ? `lacks ${missing.join(", ")}` : "is not signed in"}: the owner approves one page, on any device, that lets cf create one API token with DNS edit on ${zone.name}`,
      fix: `${CF_LOGIN}, then npm run yolo -- provision media-dns; or, without cf, ${byHand(ids)}`,
    };
  }

  const listed = await cf(["accounts", "tokens", "list"]);
  const tokens = parse(listed.stdout);
  if (listed.code !== 0 || !Array.isArray(tokens)) return { status: "fail", message: `Cannot list the account's API tokens: ${cfError(listed)}`, fix: `${CF_LOGIN}; or ${byHand(ids)}` };
  const existing = tokens.find((token) => token.name === TOKEN_NAME && token.status !== "expired");

  const groups = [];
  for (const name of PERMISSION_GROUPS) {
    const found = await cf(["accounts", "tokens", "permission-groups", "list", "--name", encodeURIComponent(name)]);
    const group = [parse(found.stdout)].flat().find((entry) => entry?.name === name);
    if (!group?.id) return { status: "fail", message: `Cannot find the permission group "${name}": ${found.code === 0 ? "not listed" : cfError(found)}`, fix: byHand(ids) };
    groups.push({ id: group.id });
  }
  const policies = JSON.stringify([{ effect: "allow", resources: { [zoneResource(zone.id)]: "*" }, permission_groups: groups }]);

  let value;
  let did;
  if (existing) {
    if (!coversZone(existing, zone.id)) {
      const updated = await cf(["accounts", "tokens", "update", existing.id, "--name", TOKEN_NAME, "--policies", policies]);
      if (updated.code !== 0) return { status: "fail", message: `Cannot point the token "${TOKEN_NAME}" at ${zone.name}: ${cfError(updated)}`, fix: byHand(ids) };
    }
    const rolled = await cf(["accounts", "tokens", "roll", existing.id, "--force"]);
    const result = parse(rolled.stdout);
    value = typeof result === "string" ? result : result?.value;
    if (rolled.code !== 0 || !value) return { status: "fail", message: `Cannot roll the token "${TOKEN_NAME}": ${tokenFailure(rolled)}`, fix: byHand(ids) };
    did = `Rolled the account token "${TOKEN_NAME}"`;
  } else {
    const created = await cf(["accounts", "tokens", "create", "--name", TOKEN_NAME, "--policies", policies]);
    value = parse(created.stdout)?.value;
    if (created.code !== 0 || !value) return { status: "fail", message: `Cannot create the token "${TOKEN_NAME}": ${tokenFailure(created)}`, fix: byHand(ids) };
    did = `Created the account token "${TOKEN_NAME}"`;
  }
  const put = await secrets.put(SECRET, value);
  value = null;
  if (!put.ok) return { status: "fail", message: `${did}, but storing it as the Worker secret ${SECRET} failed: ${put.error}`, fix: "npm run yolo -- provision media-dns --rotate" };
  return { status: "done", message: `${did} (DNS Write and Zone Read on ${zone.name} only) and stored it as the Worker secret ${SECRET}; its value was not printed or saved. Within 5 minutes the Worker names the node` };
}

// --- DNS provider plugins --------------------------------------------------

// Where the official DNS provider plugins live, for the fix that lists one.
const OFFICIAL_DNS_PLUGINS = Object.freeze({ desec: "./plugins/dns-desec" });
const OWNER_TERMINAL = "The owner, in their own terminal: npm run yolo -- provision media-dns --token-stdin (paste the token; nothing is shown, and it never passes through an agent)";

/**
 * The enabled plugin of the plugin config whose setup entry sets up
 * `provider`: { plugin: { name, source }, setup, configPath }, or
 * plugin: null when none does. `env` gives YOLO_CONFIG, as for the build.
 */
export async function findDnsPlugin({ root, env = process.env, provider }) {
  let config;
  try {
    config = loadPluginConfig({ root, env });
  } catch (error) {
    return { plugin: null, setup: null, configPath: null, error: error.message };
  }
  for (const plugin of config.plugins) {
    if (!plugin.enabled || plugin.error || !plugin.root) continue;
    let entry;
    try {
      entry = JSON.parse(readFileSync(join(plugin.root, "package.json"), "utf8"))?.yolo?.setup;
    } catch {
      continue;
    }
    if (typeof entry !== "string") continue;
    const setup = await import(pathToFileURL(resolve(plugin.root, entry)).href);
    if (setup.provider === provider) return { plugin: { name: plugin.name, source: plugin.source }, setup, configPath: config.path };
  }
  return { plugin: null, setup: null, configPath: config.path };
}

/**
 * An official DNS provider plugin is not in plugins/official.json: an
 * instance loads it only once it chooses that provider. When the instance
 * loads the official list (no yolo.config.json, no YOLO_CONFIG), this writes
 * <root>/yolo.config.json with the official plugins, unchanged, and the DNS
 * plugin from `checkout`, and returns its path; otherwise null, and an
 * owner's own plugin config is never changed.
 */
export function listDnsPlugin({ root, env = process.env, provider, checkout = ROOT }) {
  const source = OFFICIAL_DNS_PLUGINS[provider];
  if (!source) return null;
  const { path, explicit } = pluginConfigPath({ root, env });
  if (explicit) return null;
  const fromRoot = (target) => {
    const inside = relative(root, target);
    return inside.startsWith("..") || isAbsolute(inside) ? target : `./${inside.split(sep).join("/")}`;
  };
  const plugins = readPluginConfig(path).map((entry) => ({
    source: entry.source.startsWith(".") ? fromRoot(resolve(dirname(path), entry.source)) : entry.source,
    ...(entry.enabled ? {} : { enabled: false }),
    ...(Object.keys(entry.options).length ? { options: entry.options } : {}),
  }));
  plugins.push({ source: fromRoot(join(checkout, source)) });
  const file = join(root, CONFIG_FILE);
  writeFileSync(file, `${JSON.stringify({ plugins }, null, 2)}\n`);
  return file;
}

function listPluginFix(provider, configPath) {
  const source = OFFICIAL_DNS_PLUGINS[provider];
  const official = !configPath || configPath.endsWith(`${sep}plugins${sep}official.json`);
  if (official && source) return `npm run yolo -- provision media-dns --provider ${provider}, which lists it with the official plugins in a new yolo.config.json, then npm run yolo -- deploy`;
  const entry = source ? `{ "source": "${source}" }` : `the plugin that provides "${provider}"`;
  return `Add ${entry} to ${official ? "a yolo.config.json that lists the official plugins too" : configPath}, then npm run yolo -- deploy, which bundles it into the Worker`;
}

const missingPlugin = (provider, found) => ({
  status: "fail",
  message: `No plugin in ${found?.configPath ?? "the plugin config"} provides the DNS provider "${provider}" that media.dns.provider names`,
  fix: listPluginFix(provider, found?.configPath),
});

/**
 * `provision media-dns` for a plugin's DNS provider.
 * @param {object} ctx  { instance (withDefaults), found (findDnsPlugin), rotate, readToken }
 *   `readToken()` reads the token from stdin (--token-stdin), or is null
 * @param {object} deps  { secrets: { list, put }, fetchImpl, api }; `api` moves the provider's API (tests)
 * @returns a provision step: { status, message, instructions?, fix? }
 */
export async function provisionPluginDns({ instance, found, rotate = false, readToken = null }, { secrets, fetchImpl = (...args) => fetch(...args), api } = {}) {
  const { provider, zone } = instance.media.dns;
  if (!found?.plugin || !found.setup) return missingPlugin(provider, found);
  const { setup } = found;
  if (!zone) {
    return { status: "needs_human", message: `${setup.title} needs a name for the node first; the owner's steps:`, instructions: setup.steps({ zone: null }), fix: `npm run yolo -- provision media-dns --provider ${provider} --zone <name>` };
  }
  const problem = setup.checkZone?.(zone);
  if (problem) return { status: "fail", message: problem, fix: `npm run yolo -- provision media-dns --provider ${provider} --zone <name>` };

  let names;
  try {
    names = await secrets.list();
  } catch (error) {
    return { status: "fail", message: `Cannot list the Worker's secrets: ${error.message}`, fix: "npm run yolo -- deploy first: the secret belongs to the deployed Worker" };
  }
  if (!readToken) {
    if (names.includes(setup.secret) && !rotate) return { status: "unchanged", message: `The Worker has ${setup.secret} for ${setup.title} (${zone}); --rotate --token-stdin replaces it` };
    return {
      status: "needs_human",
      message: `Direct play by name under ${zone} needs a ${setup.title} token that only the owner can create. The owner follows these steps; the last runs in their own terminal`,
      instructions: setup.steps({ zone }),
      fix: OWNER_TERMINAL,
    };
  }

  let token;
  try {
    token = String((await readToken()) ?? "").trim();
  } catch (error) {
    return { status: "fail", message: `No token was read: ${error.message}`, fix: OWNER_TERMINAL };
  }
  if (!token) return { status: "fail", message: "No token arrived on stdin", fix: OWNER_TERMINAL };
  const check = await setup.checkToken({ token, zone, fetch: fetchImpl, api });
  if (!check.ok) return { status: "fail", message: check.message, fix: OWNER_TERMINAL };
  const put = await secrets.put(setup.secret, token);
  token = null;
  if (!put.ok) return { status: "fail", message: `${check.message}, but storing it as the Worker secret ${setup.secret} failed: ${put.error}`, fix: OWNER_TERMINAL };
  return { status: "done", message: `${check.message}. Stored it as the Worker secret ${setup.secret}; its value was not printed or saved` };
}

/** The NS names public DNS answers for `zone` (DNS over HTTPS), [] for none. */
export async function lookupNameservers(zone, { fetchImpl = (...args) => fetch(...args) } = {}) {
  const response = await fetchImpl(`https://cloudflare-dns.com/dns-query?${new URLSearchParams({ name: zone, type: "NS" })}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000) });
  const data = await response.json();
  return (data?.Answer ?? []).filter((answer) => answer.type === 2).map((answer) => String(answer.data).toLowerCase().replace(/\.$/, ""));
}

/**
 * doctor's checks of a plugin's DNS provider, as { id, group, status,
 * message, fix? }: the plugin in the plugin config, the Worker's secret
 * (`secretNames`, null when unknown), the name's delegation (`nameservers`,
 * null offline), and the Worker's media names (`media`, the operator view of
 * /.well-known/yolo, null when unread).
 */
export function pluginDnsChecks({ instance, found, secretNames = null, nameservers = null, media = null }) {
  const { provider, zone } = instance.media.dns;
  const checks = [];
  const add = (group, id, status, message, fix = null) => checks.push({ id, group, status, message, ...(fix ? { fix } : {}) });
  if (!found?.plugin || !found.setup) {
    const { message, fix } = missingPlugin(provider, found);
    add("config", "config.media-dns", "fail", message, fix);
    return checks;
  }
  const { setup } = found;
  add("config", "config.media-dns", "ok", `${setup.title} keeps the node's media names under ${zone} (${found.plugin.name})`);
  if (secretNames) {
    if (secretNames.includes(setup.secret)) add("cloudflare", "cloudflare.media-dns", "ok", `The Worker has ${setup.secret}`);
    else add("cloudflare", "cloudflare.media-dns", "warn", `The Worker has no ${setup.secret}: LAN and remote direct play by name stay off`, `${OWNER_TERMINAL}; npm run yolo -- provision media-dns lists the steps at ${setup.title} first`);
  }
  if (nameservers) {
    const expected = setup.nameservers ?? [];
    if (nameservers.some((name) => expected.includes(name))) add("dns", "dns.delegation", "ok", `Public DNS delegates ${zone} to ${nameservers.join(", ")}`);
    else add("dns", "dns.delegation", "warn", `Public DNS has no ${setup.title} nameservers for ${zone}${nameservers.length ? ` (it names ${nameservers.join(", ")})` : ": no such name"}`, `Check media.dns.zone against the name in your ${setup.title} account`);
  }
  const lan = media?.lan;
  if (lan) {
    if (lan.status === "off") add("worker", "worker.media-dns", "warn", `The Worker keeps no media names: it was deployed before media.dns chose ${provider}`, "npm run yolo -- deploy");
    else if (lan.error) add("worker", "worker.media-dns", "warn", `The Worker's media names through ${setup.title}: ${lan.error.step}: ${lan.error.message}`, `Settings > Media paths shows the same. A rejected or deleted token: ${OWNER_TERMINAL.replace("--token-stdin", "--rotate --token-stdin")}`);
    else if (lan.status === "ready") add("worker", "worker.media-dns", "ok", `The Worker keeps the LAN name through ${setup.title}`);
    else add("worker", "worker.media-dns", "info", `The Worker is setting up the LAN name through ${setup.title}; a first certificate takes a few minutes`);
  }
  return checks;
}
