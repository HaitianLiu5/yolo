import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The instance file (yolo.instance.json, ignored by git) holds what makes a
// deployment one owner's: its address, the Cloudflare resource ids, the node's
// port, and the service labels. The tracked wrangler.jsonc stays a template;
// wrangler-config.js merges the two
// (Agent Note 2026-10-13-agent-deployment).
//
// The address is one of two tiers (Agent Note 2026-10-13-no-domain-deployment):
//   domain       a custom domain on a Cloudflare zone the owner holds
//   workers.dev  `workersDev: true` and no domain: the Worker is served at
//                `host`, <worker>.<account subdomain>.workers.dev
// `host` is the control plane's public host and `publicOrigin` https://<host>;
// a file from before the tiers has only `domain` and is the domain tier.
// `media.wan.certificate` says how the node's remote listener is certified:
// "name" (a DNS name in the zone) or "ip" (its public address), "ip" without
// a domain.

export const INSTANCE_VERSION = 1;
export const DEFAULT_LABELS = Object.freeze({ node: "app.useyolo.node", cloudflared: "app.useyolo.cloudflared" });
// cloudflared's own default metrics ports are 20241-20245; this one stays
// clear of another tunnel on the same machine.
export const DEFAULT_TUNNEL_METRICS = "127.0.0.1:20249";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KV_ID = /^[0-9a-f]{32}$/i;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export const WORKERS_DEV = "workers.dev";
// An account's workers.dev subdomain: one DNS label.
export const SUBDOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const CERTIFICATES = ["name", "ip"];
const LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isWorkersDev = (host) => String(host).toLowerCase().endsWith(`.${WORKERS_DEV}`);
export const INIT_FIX = "npm run yolo -- init (workers.dev, no domain) or npm run yolo -- init --domain <your-domain>";

// The instance with every default filled in; the file keeps only what was set.
export function withDefaults(instance = {}) {
  const worker = instance.worker || "yolo-control";
  const domain = instance.domain ?? null;
  const workersDev = instance.workersDev === true;
  const host = instance.host ?? (workersDev ? null : domain);
  return {
    version: instance.version ?? INSTANCE_VERSION,
    domain,
    workersDev,
    host,
    publicOrigin: instance.publicOrigin ?? (host ? `https://${host}` : null),
    accountId: instance.accountId ?? null,
    worker,
    d1: { name: "yolo", id: null, ...(instance.d1 ?? {}) },
    kv: { title: `${worker}-oauth`, id: null, ...(instance.kv ?? {}) },
    tunnel: { name: "yolo", id: null, metrics: null, ...(instance.tunnel ?? {}) },
    vpc: { name: "yolo-node", serviceId: null, ...(instance.vpc ?? {}) },
    node: { port: 9191, ...(instance.node ?? {}) },
    transport: instance.transport ?? "vpc",
    nodePublicOrigin: instance.nodePublicOrigin ?? "",
    services: { ...DEFAULT_LABELS, ...(instance.services ?? {}) },
    media: { ...(instance.media ?? {}), wan: { certificate: domain ? "name" : "ip", ...(instance.media?.wan ?? {}) } },
  };
}

// The workers.dev host of a Worker in an account with that subdomain.
export const workersDevHost = (worker, subdomain) => `${worker}.${subdomain}.${WORKERS_DEV}`;

// Problems as { field, message, fix }. `deploy: true` also requires every id
// a deployment binds.
export function validateInstance(raw, { deploy = false } = {}) {
  const problems = [];
  const add = (field, message, fix) => problems.push({ field, message, fix });
  if (!isObject(raw)) {
    add("", "The instance file must hold a JSON object", INIT_FIX);
    return problems;
  }
  const instance = withDefaults(raw);
  if (instance.version !== INSTANCE_VERSION) add("version", `Unsupported instance file version ${instance.version}; this checkout reads version ${INSTANCE_VERSION}`, "Upgrade the checkout, or fix \"version\"");
  if (raw.workersDev != null && typeof raw.workersDev !== "boolean") add("workersDev", "workersDev must be true or false", "Remove \"workersDev\" for a custom domain");
  if (instance.domain && !HOSTNAME.test(instance.domain)) add("domain", `"${instance.domain}" is not a hostname (no scheme, no path)`, "Set \"domain\" to a hostname such as yolo.example.com");
  else if (instance.domain && isWorkersDev(instance.domain)) add("domain", `${instance.domain} is a workers.dev host, not a custom domain`, "npm run yolo -- init --workers-dev --change-domain");
  if (instance.workersDev) {
    if (instance.domain) add("domain", "An instance is served on its custom domain or on workers.dev, not both", "Remove \"domain\", or remove \"workersDev\" to use the domain");
    const prefix = `${instance.worker}.`;
    const subdomain = instance.host?.startsWith(prefix) && isWorkersDev(instance.host) ? instance.host.slice(prefix.length, -WORKERS_DEV.length - 1) : null;
    if (instance.host && !(subdomain && SUBDOMAIN.test(subdomain))) add("host", `"${instance.host}" is not ${instance.worker}.<account subdomain>.workers.dev`, "npm run yolo -- init (reads the account's workers.dev subdomain)");
  } else {
    if (!instance.domain) add("domain", "No domain, and workers.dev is not chosen: the instance has no address", INIT_FIX);
    if (raw.host && raw.host !== instance.domain) add("host", `host "${raw.host}" is not the domain ${instance.domain}`, "Remove \"host\"; the domain is the host");
  }
  if (raw.publicOrigin && !/^https:\/\/[^/]+$/.test(raw.publicOrigin)) add("publicOrigin", `"${raw.publicOrigin}" must be an https origin without a path`, "Remove \"publicOrigin\" to use https://<host>");
  const certificate = instance.media.wan.certificate;
  if (!CERTIFICATES.includes(certificate)) add("media.wan.certificate", `media.wan.certificate must be "name" or "ip", not "${certificate}"`, "Remove it to use \"name\" with a domain and \"ip\" without one");
  else if (certificate === "name" && !instance.domain) add("media.wan.certificate", "A named certificate for the remote listener needs a domain", "Remove media.wan.certificate, or add a domain");
  if (instance.accountId && !KV_ID.test(instance.accountId)) add("accountId", `"${instance.accountId}" is not a Cloudflare account id (32 hex characters)`, "npx wrangler whoami shows the account id");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(instance.worker)) add("worker", `"${instance.worker}" is not a valid Worker name`, "Use lowercase letters, digits and dashes");
  const port = Number(instance.node.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) add("node.port", `${instance.node.port} is not a TCP port`, "Set node.port, normally 9191");
  if (!["vpc", "tunnel"].includes(instance.transport)) add("transport", `transport must be "vpc" or "tunnel", not "${instance.transport}"`, "Remove \"transport\" to use Workers VPC");
  for (const [key, label] of Object.entries(instance.services)) {
    if (!LABEL.test(String(label))) add(`services.${key}`, `"${label}" is not a valid service label`, "Use a reverse-DNS label such as app.useyolo.node");
  }
  if (instance.d1.id && !UUID.test(instance.d1.id)) add("d1.id", `"${instance.d1.id}" is not a D1 database id`, "npm run yolo -- provision d1");
  if (instance.kv.id && !KV_ID.test(instance.kv.id)) add("kv.id", `"${instance.kv.id}" is not a KV namespace id`, "npm run yolo -- provision kv");
  if (instance.vpc.serviceId && !UUID.test(instance.vpc.serviceId)) add("vpc.serviceId", `"${instance.vpc.serviceId}" is not a VPC service id`, "npm run yolo -- provision vpc");
  if (instance.tunnel.id && !UUID.test(instance.tunnel.id)) add("tunnel.id", `"${instance.tunnel.id}" is not a tunnel id`, "npm run yolo -- provision tunnel");
  if (deploy) {
    if (instance.workersDev && !instance.host) add("host", "No workers.dev host yet: the account's workers.dev subdomain is not known", "npm run yolo -- init (after npm run yolo -- auth)");
    if (!instance.d1.id) add("d1.id", "No D1 database id", "npm run yolo -- provision d1");
    if (!instance.kv.id) add("kv.id", "No KV namespace id", "npm run yolo -- provision kv");
    if (instance.transport === "vpc" && !instance.vpc.serviceId) add("vpc.serviceId", "No Workers VPC service id", "npm run yolo -- provision vpc");
    if (instance.transport === "tunnel" && !/^https:\/\//.test(instance.nodePublicOrigin)) add("nodePublicOrigin", "transport \"tunnel\" needs nodePublicOrigin, the tunnel's https hostname", "Set nodePublicOrigin, or use transport \"vpc\"");
  }
  return problems;
}

export function readInstance(path) {
  if (!existsSync(path)) return { exists: false, raw: null, instance: null, error: null };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { exists: true, raw, instance: withDefaults(raw), error: null };
  } catch (error) {
    return { exists: true, raw: null, instance: null, error: `Cannot read ${path}: ${error.message}` };
  }
}

export function writeInstance(path, raw) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

// Set `value` at a dotted `field` of `raw`, creating objects on the way.
// Returns true when the stored value changed.
export function setField(raw, field, value) {
  const keys = field.split(".");
  let target = raw;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(target[key])) target[key] = {};
    target = target[key];
  }
  const last = keys.at(-1);
  if (target[last] === value) return false;
  target[last] = value;
  return true;
}

// An instance from a wrangler config that still carries an owner's values,
// as service/control/wrangler.jsonc did before the template split.
export function instanceFromWranglerConfig(config) {
  const raw = { version: INSTANCE_VERSION };
  const route = (config.routes ?? []).find((entry) => entry?.custom_domain) ?? config.routes?.[0];
  const pattern = typeof route === "string" ? route : route?.pattern;
  const origin = config.vars?.PUBLIC_ORIGIN;
  if (pattern) raw.domain = String(pattern).replace(/\/.*$/, "");
  else if (origin) raw.domain = new URL(origin).hostname;
  if (origin && raw.domain && origin !== `https://${raw.domain}`) raw.publicOrigin = origin;
  if (config.account_id) raw.accountId = config.account_id;
  if (config.name && config.name !== "yolo-control") raw.worker = config.name;
  const db = (config.d1_databases ?? []).find((entry) => entry.binding === "DB");
  if (db) raw.d1 = { name: db.database_name, id: db.database_id };
  const kv = (config.kv_namespaces ?? []).find((entry) => entry.binding === "OAUTH_KV");
  if (kv) raw.kv = { id: kv.id };
  const vpc = (config.vpc_services ?? []).find((entry) => entry.binding === "NODE");
  if (vpc) raw.vpc = { serviceId: vpc.service_id };
  if (config.vars?.NODE_ORIGIN) {
    const port = Number(new URL(config.vars.NODE_ORIGIN).port || 80);
    if (port !== 9191) raw.node = { port };
  }
  if (config.vars?.NODE_TRANSPORT === "tunnel") {
    raw.transport = "tunnel";
    raw.nodePublicOrigin = config.vars.NODE_PUBLIC_ORIGIN || "";
  }
  return raw;
}
