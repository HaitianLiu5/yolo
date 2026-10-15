import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudflareApi } from "../lib/cloudflare.js";
import { dailyUsage, isolationCheck, usageCheck, workersPlan } from "../lib/plan.js";

// doctor's checks of the Workers plan and what Workers Free limits
// (Agent Note 2026-10-13-no-domain-deployment).

test("the day's usage is read from the account's analytics and judged against Workers Free's limits", async () => {
  const asked = [];
  const api = {
    graphql: async (query, variables) => {
      asked.push(variables);
      return { viewer: { accounts: [{
        workers: [{ sum: { requests: 2_000 }, dimensions: { date: "2026-10-12" } }, { sum: { requests: 900 }, dimensions: { date: "2026-10-13" } }],
        kv: [
          { sum: { requests: 620 }, dimensions: { date: "2026-10-12", actionType: "write" } },
          { sum: { requests: 40 }, dimensions: { date: "2026-10-12", actionType: "delete" } },
          { sum: { requests: 5_000 }, dimensions: { date: "2026-10-12", actionType: "read" } },
        ],
        d1: [{ sum: { rowsRead: 800_000, rowsWritten: 3_000 }, dimensions: { date: "2026-10-13" } }],
        durableObjects: [],
      }] } };
    },
  };
  const days = await dailyUsage(api, "acc", new Date("2026-10-13T08:00:00Z"));
  assert.deepEqual(asked, [{ account: "acc", from: "2026-10-12", to: "2026-10-13" }]);
  assert.deepEqual(days["2026-10-12"], { workerRequests: 2_000, kvWrites: 620, kvDeletes: 40, d1RowsWritten: 0, d1RowsRead: 0, durableObjectRequests: 0 });
  const check = usageCheck(days);
  assert.equal(check.status, "warn");
  assert.match(check.message, /KV writes 620 of 1,000/);
  assert.match(check.fix, /^KV writes reached 62%/);
  assert.equal(usageCheck({ a: { kvWrites: 10 } }).status, "ok");
  assert.equal(usageCheck({ a: { kvWrites: 1_000 } }).status, "warn", "doctor cannot tell the plan, so a Free limit never fails an upgrade");
});

// Fake answers of GET /accounts/{id}/entitlements, through the same client
// doctor uses, so a refusal arrives as Cloudflare sends it.
const ACCOUNT = "c0ffee";
const entitlement = (id, value) => ({ id, feature: { key: id, name: id }, allocation: { type: "max_count", value } });
const answer = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result) => answer(200, { success: true, errors: [], messages: [], result });
const apiWith = (fetchImpl, asked = []) => cloudflareApi("token", {
  env: { CLOUDFLARE_API_BASE_URL: "https://api.test/client/v4" },
  fetchImpl: async (url, init) => {
    asked.push(`${init.method} ${url}`);
    return fetchImpl(url, init);
  },
});

test("the account's entitlements tell Workers Paid by D1's per-database storage, with one read that changes nothing", async () => {
  const asked = [];
  const paid = await workersPlan(apiWith(ok([entitlement("workers.enabled", true), entitlement("d1.max_storage_per_db_mb", 10_000)]), asked), ACCOUNT);
  assert.deepEqual(paid, { plan: "paid" });
  assert.deepEqual(asked, [`GET https://api.test/client/v4/accounts/${ACCOUNT}/entitlements`]);
});

test("Workers Free's 500 MB a database means Free", async () => {
  assert.deepEqual(await workersPlan(apiWith(ok([entitlement("d1.max_storage_per_db_mb", 500)])), ACCOUNT), { plan: "free" });
});

test("a credential that may not read the entitlements leaves the plan unknown, and says so", async () => {
  const forbidden = await workersPlan(apiWith(answer(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null })), ACCOUNT);
  assert.equal(forbidden.plan, null);
  assert.equal(forbidden.cause, "forbidden");
  assert.match(forbidden.reason, /Authentication error/);
});

test("an error, or an answer without D1's allowance, leaves the plan unknown", async () => {
  const failed = await workersPlan(apiWith(answer(500, { success: false, errors: [{ code: 10002, message: "Internal error" }], result: null })), ACCOUNT);
  assert.equal(failed.plan, null);
  assert.equal(failed.cause, "error");
  assert.match(failed.reason, /Internal error/);
  const offline = await workersPlan(apiWith(async () => {
    throw new TypeError("fetch failed");
  }), ACCOUNT);
  assert.equal(offline.plan, null);
  assert.equal(offline.cause, "error");
  assert.match(offline.reason, /fetch failed/);
  const silent = await workersPlan(apiWith(ok([entitlement("workers.enabled", true)])), ACCOUNT);
  assert.equal(silent.plan, null);
  assert.equal(silent.cause, "unrecognized");
  assert.match(silent.reason, /D1/);
  const between = await workersPlan(apiWith(ok([entitlement("d1.max_storage_per_db_mb", 2_000)])), ACCOUNT);
  assert.equal(between.plan, null, "an allowance that is neither plan's is not guessed at");
  assert.equal(between.cause, "unrecognized");
});

test("on Workers Paid the daily limits are information, not a warning", () => {
  const check = usageCheck(null, { plan: "paid" });
  assert.equal(check.id, "cloudflare.limits");
  assert.equal(check.status, "info");
  assert.match(check.message, /Workers Paid/);
  assert.match(check.message, /no daily limits/);
  assert.equal(check.fix, undefined);
});

test("on Workers Free the warning stays, without telling the owner to ignore it", () => {
  const check = usageCheck({ a: { d1RowsWritten: 121_000 } }, { plan: "free" });
  assert.equal(check.status, "warn");
  assert.match(check.fix, /^D1 rows written reached 121% of Workers Free's limit/);
  assert.match(check.fix, /Workers Paid \(\$5 a month\)/);
  assert.doesNotMatch(check.fix, /ignore/i);
  assert.equal(usageCheck({ a: { d1RowsWritten: 10 } }, { plan: "free" }).status, "ok");
});

test("an unknown plan keeps the warning and says how to let doctor read the plan", () => {
  const days = { a: { d1RowsWritten: 121_000 } };
  const forbidden = usageCheck(days, { plan: null, cause: "forbidden", reason: "Authentication error" });
  assert.equal(forbidden.status, "warn");
  assert.match(forbidden.fix, /^D1 rows written reached 121% of Workers Free's limit/);
  assert.doesNotMatch(forbidden.fix, /ignore/i);
  assert.match(forbidden.fix, /Authentication error/);
  assert.match(forbidden.fix, /Account Settings Read/);
  assert.match(forbidden.fix, /npm run yolo -- auth/);
  const failed = usageCheck(days, { plan: null, cause: "error", reason: "fetch failed" });
  assert.match(failed.fix, /fetch failed/);
  assert.match(failed.fix, /doctor again/);
  assert.doesNotMatch(failed.fix, /ignore/i);
  const unrecognized = usageCheck(days, { plan: null, cause: "unrecognized", reason: "the account's entitlements carry no D1 database size" });
  assert.match(unrecognized.fix, /carry no D1 database size/);
  assert.doesNotMatch(unrecognized.fix, /ignore/i);
  const quiet = usageCheck({ a: { d1RowsWritten: 10 } }, { plan: null, cause: "forbidden", reason: "Authentication error" });
  assert.equal(quiet.status, "ok");
  assert.match(quiet.message, /plan/);
});

test("the player's page must be cross-origin isolated on any host", () => {
  const headers = (entries) => new Headers(entries);
  assert.equal(isolationCheck(200, headers({ "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "credentialless" })).status, "ok");
  const missing = isolationCheck(200, headers({ "cross-origin-opener-policy": "same-origin" }));
  assert.equal(missing.status, "fail");
  assert.match(missing.message, /COEP missing/);
});
