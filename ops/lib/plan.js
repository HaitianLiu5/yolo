// What `doctor` can check about the Cloudflare plan
// (Agent Note 2026-10-13-no-domain-deployment). Every binding Yolo uses
// deploys on Workers Free: Durable Objects on SQLite, D1, KV, the rate-limit
// bindings, one cron trigger, Workers Logs, and Workers VPC, which is free on
// every plan while in beta. What Free limits is daily usage, which the
// account's analytics show; Workers Paid has no daily limits. The API that
// names the plan, the account's subscriptions, needs Billing Read, which no
// Cloudflare OAuth scope delegates, so neither the token `auth` makes nor
// wrangler's login can hold it. doctor reads the plan from the account's
// entitlements instead: D1's largest database is 10 GB on Workers Paid and
// 500 MB on Free.

// Workers Free's daily limits, per account, reset at 00:00 UTC.
export const FREE_DAILY_LIMITS = Object.freeze({
  workerRequests: { label: "Worker requests", limit: 100_000 },
  kvWrites: { label: "KV writes", limit: 1_000 },
  kvDeletes: { label: "KV deletes", limit: 1_000 },
  d1RowsWritten: { label: "D1 rows written", limit: 100_000 },
  d1RowsRead: { label: "D1 rows read", limit: 5_000_000 },
  durableObjectRequests: { label: "Durable Object requests", limit: 100_000 },
});

const USAGE_QUERY = `query($account: String!, $from: Date!, $to: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workers: workersInvocationsAdaptive(limit: 100, filter: { date_geq: $from, date_leq: $to }) { sum { requests } dimensions { date } }
    kv: kvOperationsAdaptiveGroups(limit: 100, filter: { date_geq: $from, date_leq: $to }) { sum { requests } dimensions { date actionType } }
    d1: d1AnalyticsAdaptiveGroups(limit: 100, filter: { date_geq: $from, date_leq: $to }) { sum { rowsRead rowsWritten } dimensions { date } }
    durableObjects: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { date_geq: $from, date_leq: $to }) { sum { requests } dimensions { date } }
  } }
}`;

const day = (date) => date.toISOString().slice(0, 10);

// { [date]: { workerRequests, kvWrites, … } } for yesterday and today (UTC).
export async function dailyUsage(api, accountId, now = new Date()) {
  const today = day(now);
  const yesterday = day(new Date(now.getTime() - 86_400_000));
  const data = await api.graphql(USAGE_QUERY, { account: accountId, from: yesterday, to: today });
  const account = data?.viewer?.accounts?.[0] ?? {};
  const days = Object.fromEntries([yesterday, today].map((date) => [date, Object.fromEntries(Object.keys(FREE_DAILY_LIMITS).map((key) => [key, 0]))]));
  const add = (date, key, value) => {
    if (days[date]) days[date][key] += Number(value) || 0;
  };
  for (const row of account.workers ?? []) add(row.dimensions.date, "workerRequests", row.sum.requests);
  for (const row of account.kv ?? []) {
    if (row.dimensions.actionType === "write") add(row.dimensions.date, "kvWrites", row.sum.requests);
    if (row.dimensions.actionType === "delete") add(row.dimensions.date, "kvDeletes", row.sum.requests);
  }
  for (const row of account.d1 ?? []) {
    add(row.dimensions.date, "d1RowsWritten", row.sum.rowsWritten);
    add(row.dimensions.date, "d1RowsRead", row.sum.rowsRead);
  }
  for (const row of account.durableObjects ?? []) add(row.dimensions.date, "durableObjectRequests", row.sum.requests);
  return days;
}

const number = (value) => value.toLocaleString("en-US");

// D1's largest database on each plan, in MB, as the entitlement
// `d1.max_storage_per_db_mb` carries it and D1's limits page documents it.
const D1_DATABASE_MB = Object.freeze({ paid: 10_000, free: 500 });

/**
 * The account's Workers plan, from one read of its entitlements that changes
 * nothing. Never throws.
 *
 * @returns { plan: "paid" | "free" }, or { plan: null, cause, reason } where
 *   cause is "forbidden" (the credential may not read the entitlements),
 *   "error" (the read failed), or "unrecognized" (no D1 size of either plan)
 */
export async function workersPlan(api, accountId) {
  let entitlements;
  try {
    entitlements = await api.call(`/accounts/${accountId}/entitlements`);
  } catch (error) {
    const forbidden = error.status === 401 || error.status === 403;
    return { plan: null, cause: forbidden ? "forbidden" : "error", reason: error.message || `HTTP ${error.status}` };
  }
  const entry = (Array.isArray(entitlements) ? entitlements : []).find((item) => item?.id === "d1.max_storage_per_db_mb");
  const mb = Number(entry?.allocation?.value);
  if (mb >= D1_DATABASE_MB.paid) return { plan: "paid" };
  if (mb > 0 && mb <= D1_DATABASE_MB.free) return { plan: "free" };
  const reason = entry && Number.isFinite(mb) ? `D1's largest database is ${number(mb)} MB, which is neither plan's size` : "the account's entitlements carry no D1 database size";
  return { plan: null, cause: "unrecognized", reason };
}

// How doctor gets to read the plan, by why it could not.
const PLAN_FIX = {
  forbidden: (reason) => `Doctor reads the plan from the account's entitlements, which wrangler's credential may not read (${reason}): they need Account Settings Read, which the token of npm run yolo -- auth has`,
  error: (reason) => `Doctor could not read the account's entitlements, where it finds the plan (${reason}): run doctor again`,
  unrecognized: (reason) => `Doctor could not tell the plan from the account's entitlements: ${reason}`,
};

// One doctor check: on Workers Paid, information that there are no daily
// limits; otherwise dailyUsage()'s busier day against Free's limits, warned
// from half a limit. Never a failure: an unknown plan may be Paid, and a Free
// limit resets at midnight, so an upgrade must not report failure (and
// suggest a rollback) over it.
export function usageCheck(days, { plan = null, cause = "error", reason = "not read" } = {}) {
  if (plan === "paid") return { id: "cloudflare.limits", status: "info", message: "The account is on Workers Paid, which has no daily limits" };
  const peak = {};
  for (const key of Object.keys(FREE_DAILY_LIMITS)) peak[key] = Math.max(0, ...Object.values(days).map((counts) => counts[key] ?? 0));
  const share = (key) => peak[key] / FREE_DAILY_LIMITS[key].limit;
  const worst = Object.keys(FREE_DAILY_LIMITS).sort((a, b) => share(b) - share(a))[0];
  const status = share(worst) >= 0.5 ? "warn" : "ok";
  const parts = Object.entries(FREE_DAILY_LIMITS).map(([key, { label, limit }]) => `${label} ${number(peak[key])} of ${number(limit)}`);
  const usage = `busiest day of yesterday and today (UTC) against Workers Free's daily limits: ${parts.join("; ")}`;
  const check = {
    id: "cloudflare.limits",
    status,
    message: plan === "free" ? `The account's ${usage}` : `The account's plan is unknown, so doctor judges its ${usage}`,
  };
  if (status !== "ok") {
    const reached = `${FREE_DAILY_LIMITS[worst].label} reached ${Math.round(share(worst) * 100)}% of Workers Free's limit`;
    check.fix = plan === "free"
      ? `${reached}; past it, that operation fails until 00:00 UTC. Workers Paid ($5 a month) lifts the daily limits`
      : `${reached}; on Free, past it, that operation fails until 00:00 UTC, and Workers Paid ($5 a month) lifts the daily limits. ${(PLAN_FIX[cause] ?? PLAN_FIX.error)(reason)}`;
  }
  return check;
}

// Whether the player's page is cross-origin isolated, which the canvas
// engine's SharedArrayBuffer audio clock needs (clients/player/public/_headers).
export function isolationCheck(status, headers) {
  const coop = headers.get("cross-origin-opener-policy");
  const coep = headers.get("cross-origin-embedder-policy");
  const ok = status === 200 && coop === "same-origin" && ["credentialless", "require-corp"].includes(coep);
  return {
    id: "worker.isolation",
    status: ok ? "ok" : "fail",
    message: ok ? `The player's page is cross-origin isolated (COOP ${coop}, COEP ${coep})` : `The player's page answered ${status} with COOP ${coop ?? "missing"} and COEP ${coep ?? "missing"}: the car's player cannot start`,
    ...(ok ? {} : { fix: "npm run yolo -- deploy (it builds the player, whose _headers file adds both)" }),
  };
}
