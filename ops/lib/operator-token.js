import { cfError, parseCf, tokenFailure } from "./cf.js";

// The account API token wrangler uses for an instance, made by `npm run yolo
// -- auth` with cf (Agent Note 2026-10-13-agent-deployment). It is owned by
// the account, not by a person, and holds exactly what the operator's
// commands do: nothing for Pages, R2, Access, billing, members, or other
// zones.
//
// Each permission group is listed with the OAuth scope that lets cf's "yolo"
// profile grant it: Cloudflare refuses a token with a group the creating
// login may not delegate (error 1001).

export const TOKEN_NAME = "Yolo operator";

export const ACCOUNT_PERMISSIONS = Object.freeze([
  { name: "Account Settings Read", scope: "account-settings.read", why: "wrangler whoami, the account's name and id, and doctor's reading of the Workers plan from the account's entitlements" },
  { name: "Workers Scripts Write", scope: "workers-scripts.write", why: "deploy, Worker secrets, versions, rollback, the cron trigger and Durable Object, and the workers.dev subdomain" },
  { name: "Workers KV Storage Write", scope: "workers-kv-storage.write", why: "provision kv" },
  { name: "D1 Write", scope: "d1.write", why: "provision d1, migrate, backups, Time Travel, image-links reset" },
  { name: "Cloudflare Tunnel Write", scope: "argotunnel.write", why: "provision tunnel creates the tunnel and reads its token" },
  { name: "Connectivity Directory Admin", scope: "connectivity-directory.admin", why: "provision vpc and the Worker's VPC binding" },
  { name: "Account Analytics Read", scope: "account-analytics.read", why: "doctor's daily usage against Workers Free's limits" },
]);
// Billing Read, which reads the account's subscriptions and so names its
// plan, is not here: no Cloudflare OAuth scope delegates it, so cf's login
// cannot grant it (Agent Note 2026-10-13-no-domain-deployment).

// On the instance's zone only, with a domain.
export const ZONE_PERMISSIONS = Object.freeze([
  { name: "Zone Read", scope: "zone.read", why: "finding the zone of the domain" },
  { name: "Workers Routes Write", scope: "workers-routes.write", why: "the Worker's custom domain on deploy" },
  { name: "DNS Write", scope: "dns.write", why: "the custom domain's DNS record" },
]);

// The profile's OAuth scopes: creating account tokens, reading the
// account and its zones for cf itself, and every group above, so the same
// consent covers both tiers and `provision media-dns`.
export const LOGIN_SCOPES = Object.freeze([
  "account_api_tokens:create",
  "account:read",
  "zone:read",
  ...ACCOUNT_PERMISSIONS.map((entry) => entry.scope),
  ...ZONE_PERMISSIONS.map((entry) => entry.scope),
]);

export const tokenName = (worker) => (worker ? `${TOKEN_NAME} (${worker})` : TOKEN_NAME);
export const permissionsFor = (zone) => [...ACCOUNT_PERMISSIONS, ...(zone ? ZONE_PERMISSIONS : [])].map((entry) => entry.name);

const accountResource = (accountId) => `com.cloudflare.api.account.${accountId}`;
const zoneResource = (zoneId) => `com.cloudflare.api.account.zone.${zoneId}`;

export function tokenPolicies({ accountId, zone, ids }) {
  const group = (entry) => ({ id: ids[entry.name] });
  const policies = [{ effect: "allow", resources: { [accountResource(accountId)]: "*" }, permission_groups: ACCOUNT_PERMISSIONS.map(group) }];
  if (zone) policies.push({ effect: "allow", resources: { [zoneResource(zone.id)]: "*" }, permission_groups: ZONE_PERMISSIONS.map(group) });
  return policies;
}

// Whether a token's policies grant exactly `wanted` (ids and resources).
const shape = (policies) => (policies ?? [])
  .map((policy) => `${policy.effect}|${Object.keys(policy.resources ?? {}).sort().join(",")}|${(policy.permission_groups ?? []).map((group) => group.id).sort().join(",")}`)
  .sort().join(";");
export const samePolicies = (a, b) => shape(a) === shape(b);

// The zone of `host` in the account, by the longest suffix, through cf.
export async function findZone(cf, accountId, host) {
  const labels = String(host).toLowerCase().split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    const name = labels.slice(index).join(".");
    const listed = await cf(["zones", "list", "--name", name, "--account-id", accountId]);
    if (listed.code !== 0) return { error: cfError(listed) };
    const zone = [parseCf(listed.stdout)].flat().find((entry) => entry?.name === name);
    if (zone?.id) return { zone: { id: zone.id, name: zone.name } };
  }
  return { zone: null };
}

/**
 * Creates the token, points the stored one at what the instance needs, or
 * rolls it, through cf; never prints its value.
 *
 * @param ctx { accountId, zone: { id, name } | null, worker, stored, rotate }
 *   stored is the record in .yolo/cloudflare-token.json, or null
 * @param deps { cf(args) → { code, stdout, stderr } }
 * @returns { step: { status, message, fix? }, record? } where record, when
 *   the value changed or the policies did, is what to store
 */
export async function ensureOperatorToken({ accountId, zone, worker, stored, rotate = false }, { cf }) {
  // The API's name filter takes a URL-encoded value, which cf encodes again;
  // a name the filter misses is looked up in the whole list.
  const ids = {};
  let all = null;
  for (const entry of [...ACCOUNT_PERMISSIONS, ...(zone ? ZONE_PERMISSIONS : [])]) {
    const found = await cf(["accounts", "tokens", "permission-groups", "list", "--name", encodeURIComponent(entry.name)]);
    const named = (result) => [parseCf(result.stdout)].flat().find((candidate) => candidate?.name === entry.name);
    let group = found.code === 0 ? named(found) : null;
    if (!group && found.code === 0) {
      all ??= await cf(["accounts", "tokens", "permission-groups", "list"]);
      group = named(all);
    }
    if (!group?.id) return { step: { status: "fail", message: `Cannot find the permission group "${entry.name}": ${found.code === 0 ? "not listed" : cfError(found)}`, fix: "npm run yolo -- auth again; if it persists, npx wrangler login --device is the fallback (skills/yolo-deploy)" } };
    ids[entry.name] = group.id;
  }
  const policies = tokenPolicies({ accountId, zone, ids });
  const name = tokenName(worker);
  const permissions = permissionsFor(zone);
  const record = (fields) => ({ ...fields, name, accountId, zone: zone ?? null, permissions });
  const what = `${permissions.join(", ")}${zone ? ` (the last three on ${zone.name} only)` : ""}`;

  // The stored token, if it still exists in this account.
  let existing = null;
  if (stored?.id && stored.accountId === accountId) {
    const got = await cf(["accounts", "tokens", "get", stored.id]);
    const value = parseCf(got.stdout);
    if (got.code === 0 && value?.id) existing = value;
  }

  if (existing) {
    let changed = false;
    if (!samePolicies(existing.policies, policies) || existing.name !== name) {
      const updated = await cf(["accounts", "tokens", "update", existing.id, "--name", name, "--policies", JSON.stringify(policies)]);
      if (updated.code !== 0) return { step: { status: "fail", message: `Cannot update the token "${existing.name}": ${cfError(updated)}`, fix: "npm run yolo -- auth --rotate" } };
      changed = true;
    }
    if (rotate) {
      const rolled = await cf(["accounts", "tokens", "roll", existing.id, "--force"]);
      const result = parseCf(rolled.stdout);
      const value = typeof result === "string" ? result : result?.value;
      if (rolled.code !== 0 || !value) return { step: { status: "fail", message: `Cannot roll the token "${name}": ${tokenFailure(rolled)}`, fix: "npm run yolo -- auth --rotate" } };
      return { step: { status: "done", message: `Rolled the account API token "${name}"${changed ? " and set its permissions" : ""}: ${what}` }, record: record({ token: value, id: existing.id }) };
    }
    if (changed) return { step: { status: "done", message: `Set the permissions of the account API token "${name}": ${what}; its value is unchanged` }, record: record({ token: stored.token, id: existing.id }) };
    return { step: { status: "unchanged", message: `The account API token "${name}" has what the instance needs: ${what}` } };
  }

  const created = await cf(["accounts", "tokens", "create", "--name", name, "--policies", JSON.stringify(policies)]);
  const result = parseCf(created.stdout);
  if (created.code !== 0 || !result?.value || !result?.id) {
    return { step: { status: "fail", message: `Cannot create the account API token "${name}": ${tokenFailure(created)}`, fix: "npm run yolo -- auth (it signs the profile in again if a scope is missing)" } };
  }
  const replaced = stored?.id ? `; the earlier token ${stored.id} is no longer used, and the owner may delete it in the dashboard (Manage Account > Account API Tokens)` : "";
  return { step: { status: "done", message: `Created the account API token "${name}": ${what}${replaced}` }, record: record({ token: result.value, id: result.id }) };
}
