import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudflareApi } from "../lib/cloudflare.js";
import { usageCheck, workersPlan } from "../lib/plan.js";

// doctor's Workers plan, from the account's entitlements through the client
// doctor uses, and its check of Workers Free's limits
// (Agent Note 2026-10-13-no-domain-deployment).

const entitlements = (status, result) => cloudflareApi("token", {
  env: { CLOUDFLARE_API_BASE_URL: "https://api.test/client/v4" },
  fetchImpl: async () => Response.json({ success: status === 200, errors: status === 200 ? [] : [{ code: 10000, message: "Authentication error" }], messages: [], result }, { status }),
});
const d1 = (value) => [{ id: "d1.max_storage_per_db_mb", feature: { key: "d1.max_storage_per_db_mb" }, allocation: { type: "max_count", value } }];

test("D1's per-database storage tells Paid from Free, anything else leaves the plan unknown, and only Free's limits warn", async () => {
  assert.deepEqual(await workersPlan(entitlements(200, d1(10_000)), "acc"), { plan: "paid" });
  assert.deepEqual(await workersPlan(entitlements(200, d1(500)), "acc"), { plan: "free" });
  assert.equal((await workersPlan(entitlements(200, d1(2_000)), "acc")).cause, "unrecognized");
  assert.equal((await workersPlan(entitlements(403, null), "acc")).cause, "forbidden");

  const days = { a: { d1RowsWritten: 121_000 } };
  assert.equal(usageCheck(days, { plan: "paid" }).status, "info");
  assert.match(usageCheck(days, { plan: "free" }).fix, /^D1 rows written reached 121% of Workers Free's limit/);
  assert.equal(usageCheck(days, { plan: null, cause: "forbidden", reason: "Authentication error" }).status, "warn", "an unknown plan keeps the warning");
  assert.equal(usageCheck({ a: { d1RowsWritten: 10 } }, { plan: "free" }).status, "ok");
});
