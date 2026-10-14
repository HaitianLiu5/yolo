import { zoneFor } from "./cloudflare.js";
import { describeCredential } from "./credentials.js";

// What doctor says about wrangler's credential (Agent Note
// 2026-10-13-agent-deployment): which one it is, and for each operation of
// the operator's commands whether the credential grants it. The stored
// token's permission groups are known from .yolo/cloudflare-token.json and
// wrangler's login lists its OAuth scopes; a harmless read in each area then
// shows that Cloudflare agrees. Nothing here writes.

export const OPERATIONS = Object.freeze([
  { id: "account", label: "read the account", groups: ["Account Settings Read"], oauth: ["account:read"], probe: (account) => `/accounts/${account}` },
  { id: "workers", label: "deploy the Worker, its secrets, and rollbacks", groups: ["Workers Scripts Write"], oauth: ["workers_scripts:write"], probe: (account) => `/accounts/${account}/workers/scripts` },
  { id: "d1", label: "provision, migrate, back up, and restore D1", groups: ["D1 Write"], oauth: ["d1:write"], probe: (account) => `/accounts/${account}/d1/database?per_page=1` },
  { id: "kv", label: "provision the KV namespace", groups: ["Workers KV Storage Write"], oauth: ["workers_kv:write"], probe: (account) => `/accounts/${account}/storage/kv/namespaces?per_page=1` },
  { id: "tunnel", label: "create the tunnel", groups: ["Cloudflare Tunnel Write"], oauth: null, probe: (account) => `/accounts/${account}/cfd_tunnel?per_page=1` },
  { id: "vpc", label: "provision the Workers VPC service", groups: ["Connectivity Directory Admin"], oauth: ["connectivity:admin"], probe: (account) => `/accounts/${account}/connectivity/directory/services` },
  { id: "analytics", label: "read the account's daily usage", groups: ["Account Analytics Read"], oauth: ["account:read"], probe: null },
  { id: "zone", label: "attach the custom domain and its DNS record", zone: true, groups: ["Zone Read", "Workers Routes Write", "DNS Write"], oauth: ["zone:read", "workers_routes:write"], probe: null },
]);

const AUTH = "npm run yolo -- auth";

async function read(api, path) {
  try {
    await api.call(path);
    return null;
  } catch (error) {
    return error.message || `HTTP ${error.status}`;
  }
}

/**
 * @param ctx { p, source: credentialSource(), instance (withDefaults) | null,
 *   accountId, scopes: wrangler's OAuth scopes or null, api: cloudflareApi()
 *   with wrangler's token, or null }
 * @returns checks: [{ id, status, message, fix? }] for doctor's Cloudflare group
 */
export async function credentialChecks({ p, source, instance, accountId, scopes = null, api = null }) {
  const checks = [];
  const add = (id, status, message, fix) => checks.push({ id, status, message, ...(fix ? { fix } : {}) });
  const what = describeCredential(p, source);
  if (source.kind === "login") add("cloudflare.credential", "info", `Wrangler acts with ${what}`, `${AUTH} replaces it with an account API token that can also create the tunnel, approved on any device`);
  else add("cloudflare.credential", "ok", `Wrangler acts with ${what}`);
  if (!accountId) return checks;

  const domain = instance && !instance.workersDev ? instance.domain : null;
  let zone = null;
  if (domain && api) {
    try {
      zone = await zoneFor(api, accountId, domain);
    } catch {
      // Reported by the zone check below.
    }
  }
  const record = source.kind === "file" ? source.record : null;
  const operations = OPERATIONS.filter((operation) => !operation.zone || domain);
  await Promise.all(operations.map(async (operation) => {
    const id = `cloudflare.can.${operation.id}`;
    const can = operation.label;
    if (record) {
      const missing = operation.groups.filter((group) => !(record.permissions ?? []).includes(group));
      if (missing.length) return add(id, "fail", `The token cannot ${can}: it lacks ${missing.join(", ")}`, `${AUTH} (sets the token's permissions; its value stays)`);
      if (operation.zone && record.zone?.id && zone && record.zone.id !== zone.id) return add(id, "fail", `The token covers the zone ${record.zone.name}, not ${zone.name}, which holds ${domain}`, AUTH);
      if (operation.zone && !record.zone) return add(id, "fail", `The token cannot ${can}: it has no zone permissions (it was made before the domain)`, AUTH);
    }
    if (source.kind === "login") {
      if (!operation.oauth) {
        const needed = operation.id === "tunnel" && !instance?.tunnel?.id;
        return add(id, needed ? "warn" : "info", `Wrangler's login cannot ${can}${needed ? "" : " (the instance has one)"}`, needed ? `${AUTH}, or create it in the dashboard (provision tunnel says how)` : null);
      }
      const missing = scopes ? operation.oauth.filter((scope) => !scopes.includes(scope)) : [];
      if (missing.length) return add(id, "fail", `Wrangler's login cannot ${can}: it lacks the scope ${missing.join(", ")}`, `${AUTH}, or npx wrangler login again`);
    }
    if (operation.zone) {
      if (!api) return add(id, "warn", `Cannot check that wrangler can ${can}: no API token`);
      if (!zone) return add(id, "fail", `Cannot find the zone of ${domain} with wrangler's credential`, record ? AUTH : "The credential needs Zone Read on the domain's zone");
      const error = await read(api, `/zones/${zone.id}/workers/routes`);
      return error ? add(id, "fail", `Wrangler cannot ${can}: reading the zone's Worker routes failed (${error})`, AUTH) : add(id, "ok", `Wrangler can ${can} on ${zone.name}`);
    }
    if (!operation.probe || !api) return add(id, "ok", `Wrangler can ${can}${record ? ` (${operation.groups.join(", ")})` : ""}`);
    const error = await read(api, operation.probe(accountId));
    if (error) return add(id, "fail", `Wrangler cannot ${can}: a read failed (${error})`, record || source.kind === "login" ? AUTH : `The token needs ${operation.groups.join(", ")}`);
    return add(id, "ok", `Wrangler can ${can}${record ? ` (${operation.groups.join(", ")})` : source.kind === "env" ? " (a read answers; its write permission is not checked)" : ""}`);
  }));
  const order = new Map(["cloudflare.credential", ...operations.map((operation) => `cloudflare.can.${operation.id}`)].map((id, index) => [id, index]));
  return checks.sort((a, b) => order.get(a.id) - order.get(b.id));
}
