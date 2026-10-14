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
// An instance without a domain has no zone and needs no token.

import { cfError, parseCf as parse, tokenFailure } from "./cf.js";

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
    return { status: "unchanged", message: "Not needed: an instance without a domain has no zone, so the node's media names and this token do not apply" };
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
