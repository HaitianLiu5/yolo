import assert from "node:assert/strict";
import test from "node:test";
import { createQualityController, QUALITY_POLICY } from "../../src/quality.js";

function harness({ videoKbps = 4000, audioKbps = 128, limits = { maxVideoKbps: 4800, ceilingKbps: 4800, capped: false }, isLive = false } = {}) {
  let clock = 1_000_000;
  const quality = createQualityController({ now: () => clock });
  quality.load({ profile: { videoKbps, audioKbps }, limits, isLive, key: "ytdlp:v" });
  return {
    quality,
    advance(ms) {
      clock += ms;
    },
    // Observe every 2 seconds for `ms`, returning the first decision.
    run(ms, sample) {
      for (let elapsed = 0; elapsed <= ms; elapsed += 2_000) {
        const decision = quality.observe(sample);
        if (decision) return { decision, elapsed };
        clock += 2_000;
      }
      return { decision: null, elapsed: ms };
    },
  };
}

const stalled = (throughputKbps, sampleCount = 4) => ({ throughputKbps, sampleCount, bufferedAheadSeconds: 0, buffering: true });
const playing = (throughputKbps, bufferedAheadSeconds = 120) => ({ throughputKbps, sampleCount: 8, bufferedAheadSeconds, buffering: false });

test("a stall with too little throughput steps down after 8 seconds, leaving headroom", () => {
  const { run } = harness({ videoKbps: 4000 });
  const { decision, elapsed } = run(30_000, stalled(2_000));
  assert.equal(elapsed, QUALITY_POLICY.downAfterBufferingMs);
  // 2000 × 0.75 − 128 = 1372 kbps, rounded down to the 1000 rung.
  assert.deepEqual(
    [decision.direction, decision.maxVideoKbps, decision.fromVideoKbps, decision.throughputKbps, decision.why],
    ["down", 1000, 4000, 2000, "stalled"],
  );
});

test("short stalls, enough throughput, or too few samples do not change quality", () => {
  const enough = harness({ videoKbps: 2000 });
  assert.equal(enough.run(60_000, stalled(5_000)).decision, null, "the network is fine; something else stalls");
  const unknown = harness({ videoKbps: 2000 });
  assert.equal(unknown.run(60_000, stalled(500, 1)).decision, null, "one sample is not a measurement");
  const brief = harness({ videoKbps: 2000 });
  assert.equal(brief.run(6_000, stalled(500)).decision, null);
  assert.equal(brief.run(30_000, playing(500, 60)).decision, null, "a long buffer absorbs a slow patch");
  const unknownBitrate = harness({ videoKbps: 0 });
  assert.equal(unknownBitrate.run(60_000, stalled(500)).decision, null);
  const live = harness({ isLive: true });
  assert.equal(live.run(60_000, stalled(500)).decision, null, "live streams are not rebuilt for quality");
});

test("a short buffer that keeps draining steps down before it stalls", () => {
  const { run } = harness({ videoKbps: 2200 });
  const { decision, elapsed } = run(60_000, playing(1_800, 12));
  assert.equal(elapsed, QUALITY_POLICY.downAfterDrainingMs);
  assert.deepEqual([decision.maxVideoKbps, decision.why], [1000, "draining"]);
});

test("where hls.js adapts between variants itself, only a stall steps the cap down", () => {
  const adaptive = (sample) => ({ ...sample, adaptive: true });
  const draining = harness({ videoKbps: 2200 });
  assert.equal(draining.run(60_000, adaptive(playing(1_800, 12))).decision, null, "a draining buffer is hls.js's to handle");
  const { run } = harness({ videoKbps: 4000 });
  const { decision, elapsed } = run(30_000, adaptive(stalled(2_000)));
  assert.equal(elapsed, QUALITY_POLICY.downAfterBufferingMs);
  assert.deepEqual([decision.maxVideoKbps, decision.why], [1000, "stalled"]);
});

test("one decision at a time: nothing more until the new stream loads", () => {
  const { quality, run } = harness({ videoKbps: 4000 });
  assert.ok(run(10_000, stalled(1_000)).decision);
  assert.equal(run(4_000, stalled(300)).decision, null, "the decision waits for its stream");
  quality.load({ profile: { videoKbps: 650, audioKbps: 128 }, limits: { maxVideoKbps: 700, ceilingKbps: 4800, capped: true }, key: "ytdlp:v" });
  assert.equal(quality.cap, 700);
  assert.equal(quality.requestCap(), 700);
  // Stalled for 8 seconds again, but 20 seconds must pass since the last step.
  const next = run(60_000, stalled(300));
  assert.equal(next.decision.maxVideoKbps, 400);
  assert.equal(next.elapsed, QUALITY_POLICY.downCooldownMs - 6_000);
});

test("when the source has nothing lower, it is not asked again for that item", () => {
  const { quality, run } = harness({ videoKbps: 900 });
  assert.equal(run(10_000, stalled(500)).decision.maxVideoKbps, 400);
  quality.load({ profile: { videoKbps: 900, audioKbps: 128 }, limits: { maxVideoKbps: 400, ceilingKbps: 4800, capped: true }, key: "ytdlp:v" });
  assert.equal(run(120_000, stalled(300)).decision, null);
  // A new item may have lower formats.
  quality.load({ profile: { videoKbps: 900, audioKbps: 128 }, limits: { maxVideoKbps: 400, ceilingKbps: 4800, capped: true }, key: "ytdlp:w" });
  assert.equal(run(120_000, stalled(300)).decision, null, "the cap is already at the lowest rung");
});

test("steps up one rung only after sustained headroom, never right after a step down", () => {
  const { quality, run, advance } = harness({ videoKbps: 1000, limits: { maxVideoKbps: 1000, ceilingKbps: 4800, capped: true } });
  // The next rung is 1500: it needs (1500 + 128) × 1.6 ≈ 2605 kbps.
  assert.equal(run(300_000, playing(2_500)).decision, null, "not comfortably above the next rung");
  const { decision, elapsed } = run(300_000, playing(3_000));
  assert.equal(elapsed, QUALITY_POLICY.upSustainMs);
  assert.deepEqual([decision.direction, decision.maxVideoKbps, decision.why], ["up", 1500, "headroom"]);
  // A dip in the middle restarts the wait.
  quality.load({ profile: { videoKbps: 1500, audioKbps: 128 }, limits: { maxVideoKbps: 1500, ceilingKbps: 4800, capped: true }, key: "ytdlp:v" });
  advance(200_000);
  assert.equal(run(60_000, playing(4_000)).decision, null);
  assert.equal(quality.observe({ ...playing(4_000), buffering: true }), null);
  const again = run(200_000, playing(4_000));
  assert.equal(again.elapsed, QUALITY_POLICY.upSustainMs);
  assert.equal(again.decision.maxVideoKbps, 2200);
});

test("a step up that is soon followed by a step down doubles the wait for the next", () => {
  const { quality, run } = harness({ videoKbps: 1000, limits: { maxVideoKbps: 1000, ceilingKbps: 4800, capped: true } });
  assert.equal(run(300_000, playing(3_000)).decision.maxVideoKbps, 1500);
  quality.load({ profile: { videoKbps: 1500, audioKbps: 128 }, limits: { maxVideoKbps: 1500, ceilingKbps: 4800, capped: true }, key: "ytdlp:v" });
  // The upgrade was too much: it stalls within a minute.
  const down = run(60_000, stalled(1_200));
  assert.equal(down.decision.maxVideoKbps, 700);
  quality.load({ profile: { videoKbps: 700, audioKbps: 128 }, limits: { maxVideoKbps: 700, ceilingKbps: 4800, capped: true }, key: "ytdlp:v" });
  assert.equal(quality.snapshot().upSustainMs, QUALITY_POLICY.upSustainMs * 2);
  const up = run(600_000, playing(3_000));
  // Two minutes after the step down at the earliest, and 180 s of headroom.
  assert.equal(up.decision.maxVideoKbps, 1000);
  assert.ok(up.elapsed >= QUALITY_POLICY.upSustainMs * 2, `stepped up after ${up.elapsed} ms`);
});

test("the top rung returns to the source's best; an uncapped device never steps up", () => {
  const top = harness({ videoKbps: 3800, limits: { maxVideoKbps: 4000, ceilingKbps: 4800, capped: true } });
  assert.equal(top.run(300_000, playing(10_000)).decision.maxVideoKbps, null);
  const uncapped = harness({ videoKbps: 3800 });
  assert.equal(uncapped.quality.requestCap(), null);
  assert.equal(uncapped.run(300_000, playing(10_000)).decision, null);
  const fresh = createQualityController();
  assert.equal(fresh.requestCap(), undefined, "a fresh page leaves the cap to Yolo's memory");
});

test("an abandoned request backs off before asking again", () => {
  const { quality, run } = harness({ videoKbps: 4000 });
  assert.ok(run(10_000, stalled(1_000)).decision);
  quality.abandon();
  const retry = run(60_000, stalled(1_000));
  assert.ok(retry.decision);
  assert.ok(retry.elapsed >= 8_000 && retry.elapsed <= 12_000, `asked again after ${retry.elapsed} ms`);
});
