import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptsProtocol, signOperatorRequest } from "@useyolo/core";
import { localSocketPath, socketPathFits } from "../../service/node/src/local.js";
import { compareVersions } from "../lib/changelog.js";
import { credentialChecks } from "../lib/capabilities.js";
import { apiToken, cloudflareAccount, cloudflareApi, withAccount, workersSubdomain, zoneFor } from "../lib/cloudflare.js";
import { credentialSource, describeCredential } from "../lib/credentials.js";
import { appliedMigrations, localMigrations } from "../lib/d1.js";
import { readEnvFile } from "../lib/env-file.js";
import { INIT_FIX, readInstance, validateInstance, workersDevHost } from "../lib/instance.js";
import { byHand, SECRET } from "../lib/media-dns.js";
import { nodeHealth } from "../lib/node-health.js";
import { overall } from "../lib/output.js";
import { dailyUsage, isolationCheck, usageCheck } from "../lib/plan.js";
import { parseJsonOutput, run as exec, which, wrangler, wranglerError } from "../lib/run.js";
import { manager, serviceStatus } from "../lib/service.js";
import { generatedDrift, readTemplate, renderInstanceConfig, writeGenerated } from "../lib/wrangler-config.js";

export const summary = "Check everything an instance needs, from prerequisites to the Worker reaching the node";
export const usage = "doctor [--offline] [--origin <url>] [--json]";
export const options = {
  offline: { type: "boolean" },
  origin: { type: "string" },
};

const MIN_NODE = [22, 12];

// The body is parsed whatever its Content-Type: cloudflared's /ready sends
// its JSON as text/plain.
export const fetchJson = async (url, { headers = {}, timeoutMs = 10_000 } = {}) => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON, such as an HTML page.
  }
  return { status: response.status, json };
};


// Checks of the account that need its API: the workers.dev subdomain against
// the instance's host, the DNS token for the node's media names, and the
// day's usage against Workers Free's limits
// (Agent Note 2026-10-13-no-domain-deployment).
async function planChecks({ p, instance, accountId, env, secretNames, add }) {
  let api = null;
  try {
    const token = await apiToken(p, env);
    if (token) api = cloudflareApi(token, { env });
  } catch {
    // Reported below.
  }
  if (!api) {
    add("cloudflare", "cloudflare.api", "warn", "Cannot get the token wrangler signs in with, so the workers.dev subdomain and the day's usage are not checked", "npm run yolo -- auth");
    return;
  }
  if (instance.workersDev && instance.host) {
    try {
      const subdomain = await workersSubdomain(api, accountId);
      const expected = subdomain ? workersDevHost(instance.worker, subdomain) : null;
      if (expected === instance.host) add("cloudflare", "cloudflare.workersdev", "ok", `The account's workers.dev subdomain is ${subdomain}: the Worker is served at https://${expected}`);
      else add("cloudflare", "cloudflare.workersdev", "fail", subdomain ? `The account's workers.dev subdomain is now ${subdomain}, so the Worker is served at https://${expected}, not https://${instance.host}, where passkeys, agents, and screens are bound` : "The account has no workers.dev subdomain", "npm run yolo -- init --change-domain, npm run yolo -- deploy, then a new passkey with npm run owner-code; agents reconnect and screens pair again (skills/yolo-deploy)");
    } catch (error) {
      add("cloudflare", "cloudflare.workersdev", "warn", `Cannot read the account's workers.dev subdomain: ${error.message}`);
    }
  } else if (!instance.workersDev && secretNames && !secretNames.includes(SECRET) && !secretNames.includes("LAN_DNS_TOKEN")) {
    let zone = null;
    try {
      zone = await zoneFor(api, accountId, instance.domain);
    } catch {
      // The page below works without the zone id.
    }
    add("cloudflare", "cloudflare.media-dns", "info", `The Worker has no ${SECRET}: LAN and remote direct play by name are off`, `npm run yolo -- provision media-dns (cf, after one browser consent); without cf, ${byHand({ accountId, zoneId: zone?.id })}`);
  }
  try {
    const { id, status, message, fix } = usageCheck(await dailyUsage(api, accountId));
    add("cloudflare", id, status, message, fix);
  } catch (error) {
    add("cloudflare", "cloudflare.limits", "info", `Cannot read the account's usage: ${error.message}`, "A CLOUDFLARE_API_TOKEN needs Account Analytics Read");
  }
}

// Every check is { id, group, status: ok | warn | fail | skip | info, message, fix }.
export async function doctor({ p, offline = false, origin: originOverride = null, env = process.env }) {
  const checks = [];
  const add = (group, id, status, message, fix = null) => {
    const check = { id, group, status, message, ...(fix ? { fix } : {}) };
    checks.push(check);
    return check;
  };
  const facts = { checkout: null, worker: null, node: null, secretNames: null };

  // --- Prerequisites ----------------------------------------------------
  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  add("prerequisites", "prereq.node", nodeOk ? "ok" : "fail", `Node.js ${process.versions.node}`, nodeOk ? null : "Install Node.js 22.12 or newer (brew install node)");
  const tools = [
    ["git", "fail", "brew install git (macOS) or your package manager"],
    ["ffmpeg", "fail", "brew install ffmpeg"],
    ["yt-dlp", "warn", "brew install yt-dlp (the yt-dlp source plugin needs it)"],
    ["deno", "warn", "brew install deno (yt-dlp needs it for YouTube)"],
    ["cloudflared", "fail", "brew install cloudflared"],
  ];
  for (const [tool, missing, fix] of tools) {
    const path = which(tool, env);
    add("prerequisites", `prereq.${tool}`, path ? "ok" : missing, path ? `${tool} at ${path}` : `${tool} is not on PATH`, path ? null : fix);
  }
  add("prerequisites", "prereq.dependencies", existsSync(p.wrangler) ? "ok" : "fail", existsSync(p.wrangler) ? "Dependencies installed" : "Dependencies are not installed", "npm ci");

  // --- Checkout ---------------------------------------------------------
  const rootPackage = JSON.parse(readFileSync(join(p.root, "package.json"), "utf8"));
  facts.checkout = { version: rootPackage.version, migrations: localMigrations(p.migrations) };
  const head = await exec("git", ["describe", "--tags", "--always", "--dirty"], { cwd: p.root, timeoutMs: 10_000 });
  add("checkout", "checkout.version", "info", `Checkout ${rootPackage.version}${head.code === 0 ? ` at ${head.stdout.trim()}` : ""}`);
  const built = existsSync(join(p.root, "clients/player/dist/index.html"));
  add("checkout", "checkout.build", built ? "ok" : "warn", built ? "The player is built" : "The player is not built", "npm run build");

  // --- Configuration ----------------------------------------------------
  const { exists, raw, instance, error } = readInstance(p.instance);
  let deployable = false;
  if (error) add("config", "config.instance", "fail", error, `Fix the JSON in ${p.instance}`);
  else if (!exists) add("config", "config.instance", "fail", `No instance file at ${p.instance}`, INIT_FIX);
  else {
    const base = validateInstance(raw);
    if (base.length) for (const problem of base) add("config", `config.${problem.field}`, "fail", problem.message, problem.fix);
    else add("config", "config.instance", "ok", `Instance ${instance.publicOrigin ?? "(no address yet)"}${instance.workersDev ? " on workers.dev, without a domain" : ""} (${p.instance})`);
    // Agent Note 2026-10-13-no-domain-deployment.
    if (instance.workersDev) {
      add("config", "config.workersdev", "warn", "Served on workers.dev without a domain. Cloudflare may rename workers.dev subdomains for any or no reason, and renaming the account's subdomain or the Worker does the same: the address moves, and every passkey, agent authorization, and paired screen stays bound to the old one (the owner registers a passkey again with the 6-digit code, reconnects agents, and pairs screens again)", "A domain removes this risk: npm run yolo -- init --domain <host> --change-domain (skills/yolo-deploy)");
    }
    const missing = validateInstance(raw, { deploy: true }).filter((problem) => !base.some((other) => other.field === problem.field));
    for (const problem of missing) add("config", `config.${problem.field}`, "fail", problem.message, problem.fix);
    deployable = base.length === 0 && missing.length === 0;
    if (deployable) {
      // The rendered config is derived; doctor brings it up to date.
      const template = readTemplate(p.template);
      const drift = generatedDrift(p.generated, template, raw);
      if (drift) writeGenerated(p.generated, renderInstanceConfig(template, raw));
      add("config", "config.rendered", "ok", drift ? `Rendered wrangler.instance.jsonc (${drift})` : "wrangler.instance.jsonc matches the template and the instance file");
    }
  }
  const envValues = readEnvFile(p.envFile);
  const secret = envValues?.NODE_SECRET || null;
  if (!envValues) add("config", "config.env", "fail", `No node settings file at ${p.envFile}`, INIT_FIX);
  else if (!secret) add("config", "config.env", "fail", `NODE_SECRET is not set in ${p.envFile}`, "npm run yolo -- init");
  else add("config", "config.env", secret.length >= 32 ? "ok" : "warn", secret.length >= 32 ? `NODE_SECRET is set in ${p.envFile}` : "NODE_SECRET is shorter than 32 characters", "Replace it with `openssl rand -base64 32` in .env, then redeploy: npm run yolo -- deploy");
  const nodeHost = envValues?.NODE_HOST || "127.0.0.1";
  const nodePort = Number(envValues?.NODE_PORT || 9191);
  if (instance && instance.node.port !== nodePort) {
    add("config", "config.port", "fail", `The node listens on ${nodePort} (.env NODE_PORT) but the instance file says ${instance.node.port}, which the Worker and the VPC service use`, `Set node.port to ${nodePort} in ${p.instance}, or NODE_PORT=${instance.node.port} in .env`);
  }
  if (instance && envValues && envValues.PUBLIC_ORIGIN && envValues.PUBLIC_ORIGIN !== instance.publicOrigin) {
    add("config", "config.origin", "warn", `.env PUBLIC_ORIGIN (${envValues.PUBLIC_ORIGIN}) is not the instance's ${instance.publicOrigin}; owner-code prints it`, "npm run yolo -- init");
  }
  const socketPath = localSocketPath({ NODE_LOCAL_SOCKET: envValues?.NODE_LOCAL_SOCKET }, join(p.root, ".yolo-node.sock"));
  add("config", "config.socket", socketPathFits(socketPath) ? "ok" : "fail", `Owner commands socket ${socketPath}`, "Set NODE_LOCAL_SOCKET in .env to a shorter path");
  if (exists) {
    add("config", "config.backup", "info", `This instance's identity is ${p.instance} and NODE_SECRET in ${p.envFile}; keep a copy of both outside this machine`);
  }

  // --- The media node, on this machine -------------------------------------
  if (secret) {
    try {
      const { status, json } = await nodeHealth({ secret, host: nodeHost, port: nodePort });
      if (status === 200 && json) {
        facts.node = json;
        add("node", "node.health", "ok", `The node answers on ${nodeHost}:${nodePort}: Yolo ${json.version}, protocol ${json.protocol ?? 0}, up ${json.uptime}s`);
        for (const plugin of json.plugins ?? []) {
          const bad = plugin.status === "failed";
          add("node", `node.plugin.${plugin.name}`, bad ? "fail" : plugin.status === "disabled" ? "info" : "ok", `Plugin ${plugin.name}: ${plugin.status}${plugin.error ? ` (${plugin.error})` : ""}`, bad ? "Fix the plugin's settings in .env or yolo.config.json, then npm run yolo -- service restart node" : null);
        }
        for (const source of json.sources ?? []) {
          if (source.online === false) add("node", `node.source.${source.id}`, "warn", `Source ${source.id} reports offline${source.error ? `: ${source.error}` : ""}`, "Check the source's own server (for Plex: PLEX_URL and PLEX_TOKEN)");
        }
        if (json.lan) {
          const lan = json.lan;
          const off = lan.enabled === false ? " on this node (LAN_PORT=0)" : lan.error ? `: ${lan.error}` : " until the Worker has the MEDIA_DNS_TOKEN secret";
          add("node", "node.lan", lan.error ? "warn" : "info", lan.listening ? `LAN direct play on ${lan.origin}` : `LAN direct play is off${off}`, lan.error ? "See the owner setup in the LAN direct play note" : null);
        }
        // Remote direct play (Agent Note 2026-10-13-media-off-the-worker).
        if (json.wan) {
          const wan = json.wan;
          const mapping = wan.mapping ?? {};
          if (!wan.listening) {
            const waiting = wan.certificate === "ip" ? " until the node has a certificate for the home's public address" : " until the Worker has named it and installed its certificate";
            add("node", "node.wan", wan.error ? "warn" : "info", `Remote direct play is not listening${wan.enabled === false ? (wan.port === 0 ? " on this node (WAN_PORT=0)" : ": remote access is off in settings") : wan.error ? `: ${wan.error}` : waiting}`, wan.error ? "See the owner setup in the media-off-the-Worker note" : null);
          } else if (wan.nat) {
            add("node", "node.wan", "warn", `Remote direct play cannot work here: ${wan.natReason}`, "Phones and the car use the relay while the owner has it on; ask the ISP for a public IPv4 address, or set WAN_IPV6 where the networks have IPv6");
          } else if (!mapping.method) {
            add("node", "node.wan", "warn", `The remote listener has no router port: ${mapping.error ?? "not mapped yet"}`, `Forward TCP port ${mapping.externalPort ?? wan.port} on the router to this machine's port ${wan.port} and set WAN_MAPPING=manual in .env`);
          } else {
            add("node", "node.wan", "ok", `Remote direct play on ${wan.origin} (${mapping.method === "manual" ? "the owner's port forward" : `router mapping by ${mapping.method}`}, public address ${wan.publicAddress ?? mapping.externalAddress ?? "unknown"})`);
          }
        }
      } else if (status === 401) {
        add("node", "node.health", "fail", "The node rejected the signature: it runs with another NODE_SECRET", `Restart the node so it reads ${p.envFile}: npm run yolo -- service restart node`);
      } else {
        add("node", "node.health", "fail", `The node answered ${status}${json?.error?.message ? `: ${json.error.message}` : ""}`, "npm run yolo -- service restart node");
      }
    } catch (fetchError) {
      add("node", "node.health", "fail", `Nothing answers on ${nodeHost}:${nodePort} (${fetchError.cause?.code ?? fetchError.name})`, "Start the node: npm run yolo -- service install node (or npm run dev:node in a terminal)");
    }
  } else {
    add("node", "node.health", "skip", "Needs NODE_SECRET to sign the health request");
  }

  // --- Services ----------------------------------------------------------
  if (instance && manager()) {
    for (const [role, label] of Object.entries(instance.services)) {
      const status = await serviceStatus(label);
      const level = status.running ? "ok" : role === "node" && facts.node ? "info" : "warn";
      add("services", `service.${role}`, level, `${role} service ${label}: ${status.detail}`, status.running ? null : `npm run yolo -- service install ${role}`);
    }
  }

  // --- The tunnel ----------------------------------------------------------
  if (instance) {
    const metrics = instance.tunnel.metrics;
    if (metrics) {
      try {
        const { status, json } = await fetchJson(`http://${metrics}/ready`, { timeoutMs: 3_000 });
        const connections = json?.readyConnections ?? 0;
        add("tunnel", "tunnel.connected", status === 200 && connections > 0 ? "ok" : "fail", status === 200 ? `cloudflared has ${connections} connection(s) to Cloudflare` : `cloudflared is not connected (ready: ${status})`, "Check the cloudflared log; Workers VPC needs outbound UDP 7844 (QUIC)");
      } catch {
        add("tunnel", "tunnel.connected", "fail", `cloudflared's metrics at ${metrics} do not answer`, "npm run yolo -- service install cloudflared");
      }
    } else {
      add("tunnel", "tunnel.connected", "info", "No tunnel.metrics in the instance file; the Worker's probe below shows whether the tunnel carries requests");
    }
  }

  // --- Cloudflare ------------------------------------------------------------
  if (offline) {
    add("cloudflare", "cloudflare", "skip", "Skipped (--offline)");
  } else if (!existsSync(p.wrangler)) {
    add("cloudflare", "cloudflare", "skip", "Wrangler is not installed", "npm ci");
  } else {
    const account = await cloudflareAccount(p, instance ?? { accountId: null }, env);
    const cfEnv = withAccount(env, account.accountId);
    const source = credentialSource(p, env);
    if (account.status !== "ok") {
      add("cloudflare", "cloudflare.auth", account.status === "needs_human" ? "warn" : "fail", account.message, account.fix);
      if (source.kind !== "login") add("cloudflare", "cloudflare.credential", "info", `Wrangler acts with ${describeCredential(p, source)}`);
    } else {
      add("cloudflare", "cloudflare.auth", "ok", account.message);
      // Which credential wrangler uses, and what it can do (lib/capabilities.js).
      let api = null;
      try {
        const token = await apiToken(p, cfEnv);
        if (token) api = cloudflareApi(token, { env: cfEnv });
      } catch {
        // Each check below says what it could not read.
      }
      for (const check of await credentialChecks({ p, source, instance, accountId: account.accountId, scopes: account.scopes, api })) {
        add("cloudflare", check.id, check.status, check.message, check.fix);
      }
      if (deployable) {
        const [secrets, migrations, vpc] = await Promise.all([
          wrangler(p, ["secret", "list", "--format", "json"], { env: cfEnv, timeoutMs: 30_000 }),
          appliedMigrations(p, instance, cfEnv),
          instance.transport === "vpc" ? wrangler(p, ["vpc", "service", "get", instance.vpc.serviceId], { env: cfEnv, timeoutMs: 30_000 }) : null,
        ]);
        let secretNames = null;
        try {
          secretNames = parseJsonOutput(secrets.stdout).map((entry) => entry.name);
          const names = secretNames;
          add("cloudflare", "cloudflare.secret", names.includes("NODE_SECRET") ? "ok" : "fail", names.includes("NODE_SECRET") ? `Worker secrets: ${names.join(", ")}` : "The Worker has no NODE_SECRET", "npm run yolo -- deploy (uploads it from .env)");
        } catch {
          add("cloudflare", "cloudflare.secret", "fail", `Cannot list the Worker's secrets: ${wranglerError(secrets)}`, "npm run yolo -- deploy (the Worker may not exist yet)");
        }
        facts.secretNames = secretNames;
        if (migrations.ok) {
          const pending = facts.checkout.migrations.filter((name) => !migrations.names.includes(name));
          add("cloudflare", "cloudflare.migrations", pending.length ? "fail" : "ok", pending.length ? `D1 misses ${pending.length} migration(s): ${pending.join(", ")}` : `D1 has every migration of this checkout (${migrations.names.at(-1) ?? "none"})`, "npm run yolo -- migrate");
        } else {
          add("cloudflare", "cloudflare.migrations", "fail", `Cannot read D1's migrations: ${migrations.error}`, "npm run yolo -- provision d1, then npm run yolo -- migrate");
        }
        if (vpc) {
          const text = vpc.stdout;
          const tunnelId = /Tunnel ID: (\S+)/.exec(text)?.[1];
          const port = Number(/HTTP Port: (\d+)/.exec(text)?.[1] || 80);
          if (vpc.code !== 0) add("cloudflare", "cloudflare.vpc", "fail", `VPC service ${instance.vpc.serviceId}: ${wranglerError(vpc)}`, "npm run yolo -- provision vpc");
          else if (instance.tunnel.id && tunnelId !== instance.tunnel.id) add("cloudflare", "cloudflare.vpc", "fail", `VPC service points at tunnel ${tunnelId}, not ${instance.tunnel.id}`, "npm run yolo -- provision vpc");
          else if (port !== instance.node.port) add("cloudflare", "cloudflare.vpc", "fail", `VPC service points at port ${port}, not the node's ${instance.node.port}`, "npm run yolo -- provision vpc");
          else add("cloudflare", "cloudflare.vpc", "ok", `VPC service ${instance.vpc.name} reaches 127.0.0.1:${port} through tunnel ${tunnelId}`);
        }
      }
      if (instance && validateInstance(raw).length === 0) {
        await planChecks({ p, instance, accountId: account.accountId, env: cfEnv, secretNames: facts.secretNames ?? null, add });
      }
    }
  }

  // --- The Worker ------------------------------------------------------------
  const origin = originOverride || instance?.publicOrigin;
  if (offline && !originOverride) {
    add("worker", "worker", "skip", "Skipped (--offline)");
  } else if (!origin) {
    add("worker", "worker", "skip", instance?.workersDev ? "No workers.dev host yet" : "No domain yet");
  } else {
    const path = "/.well-known/yolo";
    try {
      const open = await fetchJson(`${origin}${path}`);
      if (open.status !== 200 || !open.json?.version) {
        add("worker", "worker.reachable", "fail", `${origin}${path} answered ${open.status} without Yolo's status`, "npm run yolo -- deploy (an older deploy lacks /.well-known/yolo)");
      } else {
        facts.worker = open.json;
        add("worker", "worker.reachable", "ok", `${origin} serves Yolo ${open.json.version} (protocol ${open.json.protocol})`);
        try {
          const page = await fetch(`${origin}/`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
          await page.body?.cancel();
          const { id, status, message, fix } = isolationCheck(page.status, page.headers);
          add("worker", id, status, message, fix);
        } catch (pageError) {
          add("worker", "worker.isolation", "warn", `Cannot load ${origin}/ (${pageError.cause?.code ?? pageError.name})`);
        }
        const { required, applied } = open.json.migrations ?? {};
        add("worker", "worker.migrations", required && applied && applied >= required ? "ok" : "fail", `The Worker needs migration ${required}; D1 has ${applied ?? "none"}`, "npm run yolo -- migrate");
        if (secret) {
          const signed = await fetchJson(`${origin}${path}`, { headers: await signOperatorRequest(secret, { path }) });
          const operator = signed.json?.operator;
          if (!operator) {
            add("worker", "worker.secret", "fail", "The Worker does not accept this .env's NODE_SECRET", "npm run yolo -- deploy (uploads NODE_SECRET from .env)");
          } else {
            add("worker", "worker.node", operator.node.reachable ? "ok" : "fail", operator.node.reachable ? `The Worker reaches the node through the tunnel (Yolo ${operator.node.version}, protocol ${operator.node.protocol})` : `The Worker cannot reach the node: ${operator.node.error}`, operator.node.reachable ? null : "Check the tunnel and the VPC service above, and that the node runs");
            add("worker", "worker.owner", operator.owner.passkey ? "ok" : "warn", operator.owner.passkey ? "The owner's passkey is registered" : "No owner passkey yet", "Human step: npm run owner-code, then enter the code at /login (skills/yolo-deploy)");
            const media = operator.media;
            if (media) {
              const remote = media.remote ?? {};
              const remoteText = { off: "off", ok: `reachable from outside at ${remote.origin}`, pending: "being set up", cgnat: "behind carrier-grade NAT", unreachable: "not reachable from outside", certificate: "without a valid certificate", error: "failing" }[remote.status] ?? remote.status;
              const level = remote.status === "ok" ? "ok" : ["off", "pending"].includes(remote.status) ? "info" : "warn";
              add("worker", "worker.remote", level, `Remote direct play: ${remoteText}${remote.reason ? ` (${remote.reason})` : remote.error ? ` (${remote.error.step}: ${remote.error.message})` : ""}`, level === "warn" ? "See the owner setup in the media-off-the-Worker note; Settings > Media paths shows the same state" : null);
              add("worker", "worker.relay", media.relay ? "warn" : "ok", media.relay ? "The media relay through Cloudflare is on: likely outside Cloudflare's terms on Free, Pro, and Business zones" : "The media relay through Cloudflare is off", media.relay ? "Once remote direct play is ok, the owner turns the relay off in Settings > Media paths" : null);
            }
            const nodePlugins = new Set((facts.node?.plugins ?? []).map((plugin) => plugin.name));
            for (const plugin of operator.plugins ?? []) {
              if (facts.node && !nodePlugins.has(plugin.name)) add("worker", `worker.plugin.${plugin.name}`, "warn", `The Worker bundles ${plugin.name}, which the node does not load`, "Deploy and restart from the same yolo.config.json: npm run yolo -- deploy, then npm run yolo -- service restart node");
            }
          }
        }
      }
    } catch (fetchError) {
      add("worker", "worker.reachable", "fail", `${origin} does not answer (${fetchError.cause?.code ?? fetchError.name})`, instance?.workersDev ? "npm run yolo -- deploy; a Worker's first workers.dev address can take a few minutes to answer" : "npm run yolo -- deploy; a new custom domain can take a few minutes to get its certificate");
    }
  }

  // --- Versions ----------------------------------------------------------------
  const sides = [["checkout", facts.checkout?.version], ["Worker", facts.worker?.version], ["node", facts.node?.version]].filter(([, version]) => version);
  if (sides.length > 1) {
    const same = sides.every(([, version]) => version === sides[0][1]);
    add("versions", "versions.match", same ? "ok" : "warn", sides.map(([side, version]) => `${side} ${version}`).join(", "), same ? null : "npm run yolo -- upgrade --to v<version> brings both sides to one release; a node or Worker deployed from another checkout also differs");
  }
  if (facts.worker && facts.node) {
    const ok = acceptsProtocol(facts.worker.protocol, facts.node.protocol ?? 0);
    add("versions", "versions.protocol", ok ? "ok" : "fail", `The Worker speaks protocol ${facts.worker.protocol}; the node accepts ${(facts.node.protocol ?? 0) - 1} and ${facts.node.protocol ?? 0}`, ok ? null : "Bring both to one release: npm run yolo -- upgrade");
  }
  if (!offline) {
    const tags = await exec("git", ["ls-remote", "--tags", "--refs", "origin", "v*"], { cwd: p.root, timeoutMs: 15_000 });
    const versions = tags.code === 0 ? [...tags.stdout.matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)$/gm)].map((match) => match[1]) : [];
    const newest = versions.sort(compareVersions).at(-1);
    if (newest && compareVersions(newest, facts.checkout.version) > 0) add("versions", "versions.available", "info", `${newest} is available (this checkout is ${facts.checkout.version})`, `npm run yolo -- upgrade --to ${newest} (asks for the owner's approval first)`);
  }

  return { checks, facts };
}

export async function run({ values, p }) {
  const { checks, facts } = await doctor({ p, offline: Boolean(values.offline), origin: values.origin ?? null });
  const status = overall(checks);
  const counts = Object.fromEntries(["ok", "warn", "fail", "skip", "info"].map((key) => [key, checks.filter((check) => check.status === key).length]));
  return {
    command: "doctor",
    status,
    summary: `Yolo doctor: ${counts.fail} failing, ${counts.warn} warnings, ${counts.ok} ok${counts.skip ? `, ${counts.skip} skipped` : ""}`,
    counts,
    versions: { checkout: facts.checkout?.version ?? null, worker: facts.worker?.version ?? null, node: facts.node?.version ?? null },
    checks,
  };
}
