import assert from "node:assert/strict";
import test from "node:test";
import { createQualityController, QUALITY_POLICY } from "../../src/quality.js";

// Adaptive quality (Agent Note 2026-10-11-adaptive-quality).
const CAPPED = { maxVideoKbps: 1000, ceilingKbps: 4800, capped: true };

function harness({ videoKbps = 4000, limits = { maxVideoKbps: 4800, ceilingKbps: 4800, capped: false }, isLive = false } = {}) {
  let clock = 1_000_000;
  const quality = createQualityController({ now: () => clock });
  quality.load({ profile: { videoKbps, audioKbps: 128 }, limits, isLive, key: "ytdlp:v" });
  // Observe every 2 seconds for `ms`, returning the first decision.
  const run = (ms, sample) => {
    for (let elapsed = 0; elapsed <= ms; elapsed += 2_000) {
      const decision = quality.observe(sample);
      if (decision) return { decision, elapsed };
      clock += 2_000;
    }
    return { decision: null, elapsed: ms };
  };
  return { quality, run };
}

const stalled = (throughputKbps, sampleCount = 4) => ({ throughputKbps, sampleCount, bufferedAheadSeconds: 0, buffering: true });
const playing = (throughputKbps, bufferedAheadSeconds = 120) => ({ throughputKbps, sampleCount: 8, bufferedAheadSeconds, buffering: false });

test("a stall with too little throughput steps down after 8 seconds, leaving headroom; one decision at a time", () => {
  const { run } = harness({ videoKbps: 4000 });
  const { decision, elapsed } = run(30_000, stalled(2_000));
  assert.equal(elapsed, QUALITY_POLICY.downAfterBufferingMs);
  // 2000 × 0.75 − 128 = 1372 kbps, rounded down to the 1000 rung.
  assert.deepEqual([decision.direction, decision.maxVideoKbps, decision.why], ["down", 1000, "stalled"]);
  assert.equal(run(30_000, stalled(300)).decision, null, "nothing more until the new stream loads");
});

test("no step down for a fine network, one sample, a long buffer, live, near the end, or a stale estimate", () => {
  const none = (options, ms, sample) => assert.equal(harness(options).run(ms, sample).decision, null, JSON.stringify(sample));
  none({ videoKbps: 2000 }, 60_000, stalled(5_000));
  none({ videoKbps: 2000 }, 60_000, stalled(500, 1));
  none({ videoKbps: 2000 }, 30_000, playing(500, 60));
  none({ isLive: true }, 60_000, stalled(500));
  none({ videoKbps: 1023 }, 60_000, { ...stalled(408), remainingSeconds: 11 });
  none({ videoKbps: 1023 }, 120_000, { ...stalled(408), sampleAgeMs: 210_000, downloading: false });
});

test("faster than normal speed, the stream needs that much more throughput", () => {
  // 3000 kbps carries a 2000 kbps stream at normal speed, not at twice it.
  assert.equal(harness({ videoKbps: 2000 }).run(30_000, stalled(3_000)).decision, null);
  const { decision } = harness({ videoKbps: 2000 }).run(30_000, { ...stalled(3_000), playbackRate: 2 });
  // 3000 × 0.75 / 2 − 128 = 997 kbps, rounded down to the 700 rung.
  assert.deepEqual([decision.direction, decision.maxVideoKbps], ["down", 700]);
});

test("steps up one rung only after sustained headroom", () => {
  const { run } = harness({ videoKbps: 1000, limits: CAPPED });
  // The next rung is 1500: it needs (1500 + 128) × 1.6 ≈ 2605 kbps.
  assert.equal(run(300_000, playing(2_500)).decision, null);
  const { decision, elapsed } = run(300_000, playing(3_000));
  assert.equal(elapsed, QUALITY_POLICY.upSustainMs);
  assert.deepEqual([decision.direction, decision.maxVideoKbps], ["up", 1500]);
});
