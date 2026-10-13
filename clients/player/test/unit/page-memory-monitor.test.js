import assert from "node:assert/strict";
import test from "node:test";

import { PageMemoryMonitor } from "../../src/telemetry/page-memory-monitor.js";

test("page memory monitor samples once per interval", async () => {
  let now = 1_000;
  let wallNow = 10_000;
  let calls = 0;
  const monitor = new PageMemoryMonitor({
    crossOriginIsolated: true,
    intervalMs: 300_000,
    monotonicNow: () => now,
    wallNow: () => {
      const value = wallNow;
      wallNow += 25;
      return value;
    },
    performanceApi: {
      measureUserAgentSpecificMemory: async () => {
        calls += 1;
        now += 25;
        return { bytes: 42, breakdown: [] };
      },
    },
  });

  assert.equal((await monitor.measure()).bytes, 42);
  assert.equal(await monitor.measure(), null);
  now += 300_000;
  assert.equal((await monitor.measure()).bytes, 42);
  assert.equal(calls, 2);
  assert.equal(monitor.lastSample.durationMs, 25);
  assert.equal(monitor.lastSample.startedAt, 10_050);
  assert.equal(monitor.lastSample.timestamp, 10_075);

  monitor.allowNextMeasurement();
  assert.equal((await monitor.measure()).bytes, 42);
  assert.equal(calls, 3);
});
