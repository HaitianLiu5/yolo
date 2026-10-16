import assert from "node:assert/strict";
import test from "node:test";
import { createQualityController, QUALITY_POLICY, qualitySample } from "../../src/quality.js";

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

test("under a higher ceiling (LAN or remote direct play), a stall steps down to a rung above 4000 and climbs back through them", () => {
  const remote = { maxVideoKbps: 20_000, ceilingKbps: 20_000, capped: false };
  const { quality, run } = harness({ videoKbps: 9_000, limits: remote });
  // 10000 × 0.75 − 128 = 7372 kbps, rounded down to the 6000 rung.
  assert.equal(run(30_000, stalled(10_000)).decision.maxVideoKbps, 6_000);
  quality.load({ profile: { videoKbps: 5_500, audioKbps: 128 }, limits: { maxVideoKbps: 6_000, ceilingKbps: 20_000, capped: true }, key: "ytdlp:v" });
  // The next rung is 9000: it needs (9000 + 128) × 1.6 ≈ 14605 kbps.
  assert.equal(run(600_000, playing(15_000)).decision.maxVideoKbps, 9_000);
});

test("an abandoned request backs off before asking again", () => {
  const { quality, run } = harness({ videoKbps: 4000 });
  assert.ok(run(10_000, stalled(1_000)).decision);
  quality.abandon();
  const retry = run(60_000, stalled(1_000));
  assert.ok(retry.decision);
  assert.ok(retry.elapsed >= 8_000 && retry.elapsed <= 12_000, `asked again after ${retry.elapsed} ms`);
});

// 2026-10-16, a car near the end of a 1835-second item: the read-ahead had
// stopped, so nothing was downloading and the newest throughput sample was
// 3.5 minutes old (408 kbps against 1151 kbps of media) while the buffer
// drained to nothing. The stale estimate stepped the stream down 11 seconds
// before the end (Agent Note 2026-10-11-adaptive-quality).
const idle = (sample) => ({ ...sample, sampleAgeMs: 210_000, downloading: false });

test("a buffer that drains while nothing is fetched does not step down: the estimate is stale", () => {
  assert.equal(harness({ videoKbps: 1023 }).run(120_000, idle(playing(408, 0))).decision, null, "draining");
  assert.equal(harness({ videoKbps: 1023 }).run(120_000, idle(stalled(408))).decision, null, "stalled");
  assert.equal(harness({ videoKbps: 1000, limits: { maxVideoKbps: 1000, ceilingKbps: 4800, capped: true } })
    .run(300_000, idle(playing(10_000))).decision, null, "no step up from a stale estimate either");
  // A slow download in flight is the link itself: the step down stays.
  const slow = harness({ videoKbps: 1023 }).run(60_000, { ...playing(408, 0), sampleAgeMs: 45_000, downloading: true });
  assert.deepEqual([slow.decision?.direction, slow.decision?.why, slow.elapsed], ["down", "draining", QUALITY_POLICY.downAfterDrainingMs]);
  // Between two downloads the newest sample is fresh.
  const between = harness({ videoKbps: 1023 }).run(60_000, { ...playing(408, 0), sampleAgeMs: QUALITY_POLICY.staleSampleMs, downloading: false });
  assert.equal(between.decision?.why, "draining");
});

test("near the end, or with the rest of the item buffered, quality is not rebuilt", () => {
  const left = (seconds, sample) => ({ ...sample, remainingSeconds: seconds });
  assert.equal(harness({ videoKbps: 1023 }).run(60_000, left(11, stalled(408))).decision, null, "11 seconds left, stalled");
  assert.equal(harness({ videoKbps: 1023 }).run(60_000, left(QUALITY_POLICY.minRemainingSeconds - 0.1, playing(408, 0))).decision, null, "draining");
  assert.equal(harness({ videoKbps: 1000, limits: { maxVideoKbps: 1000, ceilingKbps: 4800, capped: true } })
    .run(300_000, left(15, playing(3_000))).decision, null, "no step up either");
  assert.equal(harness({ videoKbps: 1023 }).run(60_000, { ...left(60, playing(408, 15)), restBuffered: true }).decision, null, "the rest is buffered");
  // With more time left, a stall still steps down.
  const enough = harness({ videoKbps: 1023 }).run(30_000, left(QUALITY_POLICY.minRemainingSeconds, stalled(408)));
  assert.deepEqual([enough.decision?.why, enough.elapsed], ["stalled", QUALITY_POLICY.downAfterBufferingMs]);
});

test("the sample says how old the estimate is, whether a download is in flight, and what is left", () => {
  const canvas = { bandwidth: 408_000, hlsThroughputSampleCount: 8, hlsBufferedAheadSeconds: 0, hlsThroughputSampleAgeMs: 210_000, hlsActiveDownloads: 0, hlsAllRemainingSegmentsCached: false };
  assert.deepEqual(qualitySample(canvas, { buffering: false, duration: 1835, currentTime: 1823.68 }), {
    throughputKbps: 408, sampleCount: 8, bufferedAheadSeconds: 0, buffering: false, adaptive: false,
    sampleAgeMs: 210_000, downloading: false, remainingSeconds: 1835 - 1823.68, restBuffered: false,
  });
  assert.equal(qualitySample({ ...canvas, hlsAllRemainingSegmentsCached: true }, { duration: 1835, currentTime: 1830 }).restBuffered, true);
  // The <video> engine knows no sample age; a live stream has no end.
  const native = qualitySample({ bandwidth: 3_000_000, hlsThroughputSampleCount: 4, hlsActiveDownloads: 1, adaptsWithinStream: true }, { duration: 0 });
  assert.deepEqual([native.sampleAgeMs, native.downloading, native.remainingSeconds, native.restBuffered, native.adaptive], [null, true, null, false, true]);
  assert.equal(qualitySample(canvas, { duration: 600, currentTime: 590, isLive: true }).remainingSeconds, null);
  assert.equal(qualitySample(null).sampleAgeMs, null);
});
