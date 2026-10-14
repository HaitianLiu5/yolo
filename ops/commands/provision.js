import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { apiToken, cloudflareAccount, cloudflareApi, withAccount, zoneFor } from "../lib/cloudflare.js";
import { DEFAULT_TUNNEL_METRICS, INIT_FIX, readInstance, setField, validateInstance, withDefaults, writeInstance } from "../lib/instance.js";
import { CF_PROFILE, provisionMediaDns } from "../lib/media-dns.js";
import { overall } from "../lib/output.js";
import { parseJsonOutput, run as exec, which, wrangler, wranglerError } from "../lib/run.js";
import { InstanceConfigError, readTemplate, renderInstanceConfig, writeGenerated } from "../lib/wrangler-config.js";

export const summary = "Find or create the instance's D1 database, KV namespace, tunnel, and Workers VPC service (idempotent); `media-dns` creates the DNS token for direct play by name";
export const usage = "provision [d1|kv|tunnel|vpc|media-dns] [--token-file <file>] [--rotate]";
export const options = {
  "token-file": { type: "string" },
  rotate: { type: "boolean" },
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const STEPS = ["d1", "kv", "tunnel", "vpc"];
// Run only when named: direct play by name is optional, and the token
// belongs to a Worker that is already deployed.
const OPTIONAL = ["media-dns"];
export const DASHBOARD_TUNNELS = "https://dash.cloudflare.com/?to=/:account/workers/vpc/tunnels";

// A tunnel token is base64 JSON { a: account tag, t: tunnel id, s: secret }.
export function decodeTunnelToken(token) {
  try {
    const value = JSON.parse(Buffer.from(token.trim(), "base64").toString("utf8"));
    if (typeof value?.t === "string" && UUID.test(value.t) && typeof value.s === "string") return { accountId: value.a ?? null, tunnelId: value.t };
  } catch {
    // Not a token.
  }
  return null;
}

async function d1(ctx) {
  const { p, raw, instance, env } = ctx;
  const list = await wrangler(p, ["d1", "list", "--json"], { config: p.template, env, timeoutMs: 60_000 });
  let dbs;
  try {
    dbs = parseJsonOutput(list.stdout);
  } catch {
    return { status: "fail", message: `Cannot list D1 databases: ${wranglerError(list)}`, fix: "npm run yolo -- doctor" };
  }
  if (instance.d1.id) {
    const found = dbs.find((db) => db.uuid === instance.d1.id);
    return found
      ? { status: "unchanged", message: `D1 database ${found.name} (${found.uuid}) exists` }
      : { status: "fail", message: `D1 database ${instance.d1.id} is not in this account`, fix: "Remove d1.id from the instance file to find or create one by name" };
  }
  const named = dbs.find((db) => db.name === instance.d1.name);
  if (named) {
    setField(raw, "d1.id", named.uuid);
    setField(raw, "d1.name", named.name);
    return { status: "done", message: `Using the existing D1 database ${named.name} (${named.uuid})` };
  }
  const created = await wrangler(p, ["d1", "create", instance.d1.name], { config: p.template, env, timeoutMs: 120_000 });
  const id = /"database_id":\s*"([^"]+)"/.exec(created.stdout)?.[1] ?? UUID.exec(created.stdout)?.[0];
  if (created.code !== 0 || !id) return { status: "fail", message: `Cannot create D1 database ${instance.d1.name}: ${wranglerError(created)}`, fix: "npm run yolo -- doctor" };
  setField(raw, "d1.id", id);
  setField(raw, "d1.name", instance.d1.name);
  return { status: "done", message: `Created the D1 database ${instance.d1.name} (${id})` };
}

async function kv(ctx) {
  const { p, raw, instance, env } = ctx;
  const list = await wrangler(p, ["kv", "namespace", "list"], { config: p.template, env, timeoutMs: 60_000 });
  let namespaces;
  try {
    namespaces = parseJsonOutput(list.stdout);
  } catch {
    return { status: "fail", message: `Cannot list KV namespaces: ${wranglerError(list)}`, fix: "npm run yolo -- doctor" };
  }
  if (instance.kv.id) {
    const found = namespaces.find((entry) => entry.id === instance.kv.id);
    return found
      ? { status: "unchanged", message: `KV namespace ${found.title} (${found.id}) exists` }
      : { status: "fail", message: `KV namespace ${instance.kv.id} is not in this account`, fix: "Remove kv.id from the instance file to find or create one by title" };
  }
  const titled = namespaces.find((entry) => entry.title === instance.kv.title);
  if (titled) {
    setField(raw, "kv.id", titled.id);
    return { status: "done", message: `Using the existing KV namespace ${titled.title} (${titled.id})` };
  }
  const created = await wrangler(p, ["kv", "namespace", "create", instance.kv.title], { config: p.template, env, timeoutMs: 120_000 });
  const id = /"id":\s*"([0-9a-f]{32})"/i.exec(created.stdout)?.[1];
  if (created.code !== 0 || !id) return { status: "fail", message: `Cannot create KV namespace ${instance.kv.title}: ${wranglerError(created)}`, fix: "npm run yolo -- doctor" };
  setField(raw, "kv.id", id);
  setField(raw, "kv.title", instance.kv.title);
  return { status: "done", message: `Created the KV namespace ${instance.kv.title} (${id})` };
}

// The tunnel is created in the dashboard (wrangler's OAuth login has no
// tunnel permission) or with an API token; either way its token lands in
// .yolo/tunnel-token, mode 600, for the cloudflared service.
async function tunnel(ctx) {
  const { p, raw, instance, values, env, accountId } = ctx;
  const save = (token) => {
    const decoded = decodeTunnelToken(token);
    if (!decoded) return { status: "fail", message: "That is not a Cloudflare Tunnel token", fix: "Copy the long token from the dashboard's install command (the text after --token or service install)" };
    if (instance.tunnel.id && instance.tunnel.id !== decoded.tunnelId && existsSync(p.tunnelToken)) {
      return { status: "fail", message: `The token is for tunnel ${decoded.tunnelId}, but the instance uses ${instance.tunnel.id}`, fix: "Remove tunnel.id from the instance file and .yolo/tunnel-token to switch tunnels" };
    }
    mkdirSync(dirname(p.tunnelToken), { recursive: true, mode: 0o700 });
    writeFileSync(p.tunnelToken, `${token.trim()}\n`, { mode: 0o600 });
    chmodSync(p.tunnelToken, 0o600);
    setField(raw, "tunnel.id", decoded.tunnelId);
    if (!instance.accountId && decoded.accountId) setField(raw, "accountId", decoded.accountId);
    if (!instance.tunnel.metrics) setField(raw, "tunnel.metrics", DEFAULT_TUNNEL_METRICS);
    return { status: "done", message: `Saved the token of tunnel ${decoded.tunnelId} to ${p.tunnelToken}` };
  };
  if (values["token-file"]) return save(readFileSync(values["token-file"], "utf8"));
  if (existsSync(p.tunnelToken)) {
    const decoded = decodeTunnelToken(readFileSync(p.tunnelToken, "utf8"));
    if (decoded && (!instance.tunnel.id || instance.tunnel.id === decoded.tunnelId)) {
      setField(raw, "tunnel.id", decoded.tunnelId);
      return { status: "unchanged", message: `Tunnel ${decoded.tunnelId} (token in ${p.tunnelToken})` };
    }
  }
  if (instance.tunnel.id) {
    return { status: "unchanged", message: `Tunnel ${instance.tunnel.id} (run by a cloudflared this command did not install)` };
  }
  if (env.CLOUDFLARE_API_TOKEN && accountId) {
    const api = (path, init = {}) => fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel${path}`, {
      ...init,
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    }).then((response) => response.json());
    try {
      const listed = await api(`?name=${encodeURIComponent(instance.tunnel.name)}&is_deleted=false`);
      let id = listed.result?.[0]?.id;
      if (!id) {
        const created = await api("", { method: "POST", body: JSON.stringify({ name: instance.tunnel.name, config_src: "cloudflare" }) });
        if (!created.success) throw new Error(created.errors?.map((error) => error.message).join("; ") || "create failed");
        id = created.result.id;
      }
      const token = await api(`/${id}/token`);
      if (!token.success) throw new Error(token.errors?.map((error) => error.message).join("; ") || "no token");
      return save(token.result);
    } catch (error) {
      return { status: "fail", message: `Cannot create the tunnel with the API token: ${error.message}`, fix: "The token needs Account > Cloudflare Tunnel > Edit; or create the tunnel in the dashboard" };
    }
  }
  return {
    status: "needs_human",
    message: `Create a tunnel named "${instance.tunnel.name}" in the Cloudflare dashboard: Workers VPC > Tunnels > Create (${DASHBOARD_TUNNELS}). Skip its install commands; copy only the token (the long text after --token), and save it to a file.`,
    fix: "npm run yolo -- provision tunnel --token-file <file> (then delete the file)",
  };
}

// `wrangler vpc service update` replaces the whole service (a PUT of the same
// body as `create`), so it needs the name, type, tunnel, address, and port,
// and it can move the service to another tunnel.
export function vpcUpdateArgs({ serviceId, name, tunnelId, port }) {
  return ["vpc", "service", "update", serviceId, "--name", name, "--type", "http", "--tunnel-id", tunnelId, "--ipv4", "127.0.0.1", "--http-port", String(port)];
}

const shellArg = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

async function vpc(ctx) {
  const { p, raw, instance, env } = ctx;
  const port = instance.node.port;
  if (instance.transport !== "vpc") return { status: "unchanged", message: "transport is \"tunnel\": no VPC service" };
  if (instance.vpc.serviceId) {
    const got = await wrangler(p, ["vpc", "service", "get", instance.vpc.serviceId], { config: p.template, env, timeoutMs: 60_000 });
    if (got.code !== 0) return { status: "fail", message: `VPC service ${instance.vpc.serviceId}: ${wranglerError(got)}`, fix: "Remove vpc.serviceId from the instance file to find or create one by name" };
    const name = /^\s*Name: (.+)$/m.exec(got.stdout)?.[1].trim() || instance.vpc.name;
    const tunnelId = /Tunnel ID: (\S+)/.exec(got.stdout)?.[1] ?? null;
    const httpPort = Number(/HTTP Port: (\d+)/.exec(got.stdout)?.[1] || 80);
    const ipv4 = /IPv4: (\S+)/.exec(got.stdout)?.[1] ?? null;
    if (!instance.tunnel.id && tunnelId) setField(raw, "tunnel.id", tunnelId);
    const tunnelOk = !instance.tunnel.id || instance.tunnel.id === tunnelId;
    if (!tunnelOk || httpPort !== port || ipv4 !== "127.0.0.1") {
      // An existing service is never changed here: it may serve a live node.
      const wantedTunnel = instance.tunnel.id ?? tunnelId;
      const update = vpcUpdateArgs({ serviceId: instance.vpc.serviceId, name: shellArg(name), tunnelId: wantedTunnel ?? "<tunnel-id>", port });
      return { status: "fail", message: `VPC service ${instance.vpc.serviceId} points at ${ipv4}:${httpPort} through tunnel ${tunnelId}; the instance wants 127.0.0.1:${port} through ${wantedTunnel}`, fix: `After the owner approves: npx wrangler ${update.join(" ")}` };
    }
    return { status: "unchanged", message: `VPC service ${instance.vpc.serviceId} reaches 127.0.0.1:${port} through tunnel ${tunnelId}` };
  }
  if (!instance.tunnel.id) return { status: "needs_human", message: "The VPC service needs the tunnel first", fix: "npm run yolo -- provision tunnel" };
  const list = await wrangler(p, ["vpc", "service", "list"], { config: p.template, env, timeoutMs: 60_000 });
  if (list.code !== 0) return { status: "fail", message: `Cannot list VPC services: ${wranglerError(list)}`, fix: "npm run yolo -- doctor" };
  const row = list.stdout.split("\n").find((line) => line.includes(` ${instance.vpc.name} `) && UUID.test(line));
  if (row) {
    const id = UUID.exec(row)[0];
    setField(raw, "vpc.serviceId", id);
    return { status: "done", message: `Using the existing VPC service ${instance.vpc.name} (${id}); the next run checks where it points` };
  }
  const created = await wrangler(p, ["vpc", "service", "create", instance.vpc.name, "--type", "http", "--tunnel-id", instance.tunnel.id, "--ipv4", "127.0.0.1", "--http-port", String(port)], { config: p.template, env, timeoutMs: 120_000 });
  const id = /Created VPC service: (\S+)/.exec(created.stdout)?.[1];
  if (created.code !== 0 || !id) return { status: "fail", message: `Cannot create VPC service ${instance.vpc.name}: ${wranglerError(created)}`, fix: "The login needs the Connectivity Directory Admin role (Workers VPC is in beta)" };
  setField(raw, "vpc.serviceId", id);
  return { status: "done", message: `Created the VPC service ${instance.vpc.name} (${id}) for 127.0.0.1:${port}` };
}

// The DNS token for the node's media names (lib/media-dns.js).
async function mediaDns(ctx) {
  const { p, instance, values, env, accountId } = ctx;
  if (instance.workersDev || !instance.domain) return provisionMediaDns({ instance }, {});
  let zone = null;
  try {
    const token = await apiToken(p, env);
    zone = token ? await zoneFor(cloudflareApi(token, { env }), accountId, instance.domain) : null;
  } catch (error) {
    return { status: "fail", message: `Cannot find the zone of ${instance.domain}: ${error.message}`, fix: "npm run yolo -- doctor" };
  }
  const cfPath = which("cf", env);
  const cf = cfPath ? (args) => exec(cfPath, ["--profile", CF_PROFILE, ...args], { env: withAccount(env, accountId), timeoutMs: 60_000 }) : null;
  const secrets = {
    async list() {
      const listed = await wrangler(p, ["secret", "list", "--format", "json"], { env, timeoutMs: 60_000 });
      try {
        return parseJsonOutput(listed.stdout).map((entry) => entry.name);
      } catch {
        throw new Error(wranglerError(listed));
      }
    },
    async put(name, value) {
      const put = await wrangler(p, ["secret", "put", name], { env, timeoutMs: 60_000, input: value });
      return put.code === 0 ? { ok: true } : { ok: false, error: wranglerError(put) };
    },
  };
  return provisionMediaDns({ instance: { ...instance, accountId }, zone, rotate: Boolean(values.rotate) }, { cf, secrets });
}

const RUNNERS = { d1, kv, tunnel, vpc, "media-dns": mediaDns };

export async function run({ values, positionals, p }) {
  const only = positionals[0];
  if (only && !STEPS.includes(only) && !OPTIONAL.includes(only)) return { command: "provision", status: "failed", summary: `Unknown step "${only}"; use ${[...STEPS, ...OPTIONAL].join(", ")}` };
  const current = readInstance(p.instance);
  if (current.error || !current.exists) return { command: "provision", status: "failed", summary: current.error ?? `No instance file at ${p.instance}`, next: [INIT_FIX] };
  const raw = current.raw;
  const base = validateInstance(raw);
  if (base.length) return { command: "provision", status: "failed", summary: "Fix the instance file first", steps: base.map((problem) => ({ id: problem.field, status: "fail", message: problem.message, fix: problem.fix })) };

  const steps = [];
  const needsCloudflare = !(only === "tunnel" && values["token-file"]);
  let accountId = withDefaults(raw).accountId;
  if (needsCloudflare) {
    const account = await cloudflareAccount(p, withDefaults(raw));
    steps.push({ id: "account", status: account.status === "ok" ? "ok" : account.status, message: account.message, fix: account.fix });
    if (account.status !== "ok") return { command: "provision", status: overall(steps), summary: "Provisioning needs Cloudflare access", steps };
    accountId = account.accountId;
    if (account.chosen) setField(raw, "accountId", accountId);
  }
  // media-dns uses the rendered config to reach the deployed Worker.
  if (only === "media-dns") {
    try {
      writeGenerated(p.generated, renderInstanceConfig(readTemplate(p.template), raw));
    } catch (error) {
      if (!(error instanceof InstanceConfigError)) throw error;
      return { command: "provision", status: "failed", summary: "Provision and deploy the instance first", steps: error.problems.map((problem) => ({ id: problem.field, status: "fail", message: problem.message, fix: problem.fix })) };
    }
  }
  const env = withAccount(process.env, accountId);
  // An instance that already has a VPC service learns its tunnel from it
  // before the tunnel step would ask for a new one.
  const known = withDefaults(raw);
  const order = known.vpc.serviceId && !known.tunnel.id ? ["d1", "kv", "vpc", "tunnel"] : STEPS;
  for (const step of only ? [only] : order) {
    const result = await RUNNERS[step]({ p, raw, instance: withDefaults(raw), values, env, accountId });
    steps.push({ id: step, ...result });
    writeInstance(p.instance, raw);
    if (result.status === "fail" || result.status === "needs_human") break;
  }
  try {
    writeGenerated(p.generated, renderInstanceConfig(readTemplate(p.template), raw));
    steps.push({ id: "render", status: "ok", message: `Rendered ${p.generated}` });
  } catch (error) {
    if (!(error instanceof InstanceConfigError)) throw error;
  }
  const status = overall(steps);
  return {
    command: "provision",
    status,
    summary: status === "ok" ? `${only ? `The ${only} step is` : "Cloudflare resources are"} in place` : "Provisioning stopped",
    steps,
    next: status !== "ok" ? [] : only === "media-dns" ? ["npm run yolo -- doctor"] : ["npm run yolo -- migrate", "npm run yolo -- deploy"],
  };
}
