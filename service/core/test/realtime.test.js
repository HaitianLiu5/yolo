import assert from "node:assert/strict";
import { test } from "node:test";
import { createRateLimit, HEARTBEAT_PING, HEARTBEAT_PONG } from "../src/index.js";

test("heartbeat strings are valid v1 envelopes", () => {
  assert.deepEqual(JSON.parse(HEARTBEAT_PING), { v: 1, type: "ping" });
  assert.deepEqual(JSON.parse(HEARTBEAT_PONG), { v: 1, type: "pong" });
});

test("rate limit allows max events per window, then resets", () => {
  let time = 1_000;
  const allow = createRateLimit({ max: 3, windowMs: 10_000 }, () => time);
  assert.deepEqual([allow(), allow(), allow(), allow()], [true, true, true, false]);
  time += 9_999;
  assert.equal(allow(), false);
  time += 1;
  assert.deepEqual([allow(), allow(), allow(), allow()], [true, true, true, false]);
});
