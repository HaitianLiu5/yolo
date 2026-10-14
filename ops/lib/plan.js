// What `doctor` can check about the Cloudflare plan
// (Agent Note 2026-10-13-no-domain-deployment). Every binding Yolo uses
// deploys on Workers Free: Durable Objects on SQLite, D1, KV, the rate-limit
// bindings, one cron trigger, Workers Logs, and Workers VPC, which is free on
// every plan while in beta. What Free limits is daily usage, which the
// account's analytics show; the API wrangler signs in with cannot read the
// account's plan, so the levels below are Free's.

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

// One doctor check from dailyUsage(): the busier of the two days against
// Free's limits, warned from half a limit. Never a failure: doctor cannot
// tell the account's plan, and on Workers Paid these limits do not apply, so
// an upgrade must not report failure (and suggest a rollback) over them.
export function usageCheck(days) {
  const peak = {};
  for (const key of Object.keys(FREE_DAILY_LIMITS)) peak[key] = Math.max(0, ...Object.values(days).map((counts) => counts[key] ?? 0));
  const share = (key) => peak[key] / FREE_DAILY_LIMITS[key].limit;
  const worst = Object.keys(FREE_DAILY_LIMITS).sort((a, b) => share(b) - share(a))[0];
  const status = share(worst) >= 0.5 ? "warn" : "ok";
  const parts = Object.entries(FREE_DAILY_LIMITS).map(([key, { label, limit }]) => `${label} ${number(peak[key])} of ${number(limit)}`);
  const check = {
    id: "cloudflare.limits",
    status,
    message: `The account's busiest day of yesterday and today (UTC) against Workers Free's daily limits: ${parts.join("; ")}`,
  };
  if (status !== "ok") {
    check.fix = `${FREE_DAILY_LIMITS[worst].label} reached ${Math.round(share(worst) * 100)}% of Workers Free's limit; past it, that operation fails until 00:00 UTC. Workers Paid ($5 a month) lifts the daily limits; ignore this on Workers Paid`;
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
