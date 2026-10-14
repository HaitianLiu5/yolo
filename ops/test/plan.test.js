import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyUsage, isolationCheck, usageCheck } from "../lib/plan.js";

// doctor's checks of what Workers Free limits
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

test("the player's page must be cross-origin isolated on any host", () => {
  const headers = (entries) => new Headers(entries);
  assert.equal(isolationCheck(200, headers({ "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "credentialless" })).status, "ok");
  const missing = isolationCheck(200, headers({ "cross-origin-opener-policy": "same-origin" }));
  assert.equal(missing.status, "fail");
  assert.match(missing.message, /COEP missing/);
});
