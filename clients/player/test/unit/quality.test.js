import assert from "node:assert/strict";
import test from "node:test";
import { buildFreshPlaybackSessionRequest } from "../../src/playback-recovery.js";
import { createQualityController, QUALITY_POLICY } from "../../src/quality.js";

// Adaptive quality (Agent Note 2026-10-11-adaptive-quality).
const CAPPED = { maxVideoKbps: 1000, ceilingKbps: 4800, capped: true };

function harness({ videoKbps = 4000, limits = { maxVideoKbps: 4800, ceilingKbps: 4800, capped: false }, isLive = false, path = "relay" } = {}) {
  let clock = 1_000_000;
  const quality = createQualityController({ now: () => clock });
  quality.load({ profile: { videoKbps, audioKbps: 128 }, limits, isLive, key: "ytdlp:v", path });
  // Observe every 2 seconds for `ms`, returning the first decision.
  const run = (ms, sample) => {
    for (let elapsed = 0; elapsed <= ms; elapsed += 2_000) {
      const decision = quality.observe(sample);
      if (decision) return { decision, elapsed };
      clock += 2_000;
    }
    return { decision: null, elapsed: ms };
  };
  return { quality, run, wait: (ms) => { clock += ms; } };
}

const stalled = (throughputKbps, sampleCount = 4) => ({ throughputKbps, sampleCount, bufferedAheadSeconds: 0, buffering: true });
const playing = (throughputKbps, bufferedAheadSeconds = 120) => ({ throughputKbps, sampleCount: 8, bufferedAheadSeconds, buffering: false });

test("a stall with too little throughput steps down after 8 seconds, leaving headroom; one decision at a time", () => {
  const { run } = harness({ videoKbps: 4000 });
  const { decision, elapsed } = run(30_000, stalled(2_000));
  assert.equal(elapsed, QUALITY_POLICY.downAfterBufferingMs);
  // 2000 × 0.75 − 128 = 1372 kbps, rounded down to the 1000 rung.
  assert.deepEqual([decision.direction, decision.rebuild, decision.maxVideoKbps, decision.why], ["down", true, 1000, "stalled"]);
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

test("a step up never rebuilds: after sustained headroom it keeps one rung for the next stream on this path, then the next", () => {
  const { quality, run } = harness({ videoKbps: 1000, limits: CAPPED, path: "relay" });
  // The next rung is 1500: it needs (1500 + 128) × 1.6 ≈ 2605 kbps.
  assert.equal(run(300_000, playing(2_500)).decision, null);
  const { decision, elapsed } = run(300_000, playing(3_000));
  assert.equal(elapsed, QUALITY_POLICY.upSustainMs);
  assert.deepEqual([decision.direction, decision.rebuild, decision.maxVideoKbps, decision.path], ["up", false, 1500, "relay"]);
  assert.deepEqual(quality.rate(), { path: "relay", kbps: 1500 }, "the report's health.rate");
  assert.deepEqual([quality.requestCap("relay"), quality.requestCap(), quality.requestCap("lan")], [1500, 1500, undefined]);
  assert.equal(quality.cap, 1000, "the stream that plays is untouched");
  // No pending request: 90 more seconds over 2200's need keep 2200.
  const again = run(300_000, playing(4_000)).decision;
  assert.deepEqual([again.direction, again.rebuild, again.maxVideoKbps], ["up", false, 2200]);

  // A step down after it still rebuilds, and drops what was kept.
  const down = run(60_000, stalled(1_000)).decision;
  assert.deepEqual([down.direction, down.rebuild, down.maxVideoKbps], ["down", true, 400]);
  assert.deepEqual([quality.rate(), quality.requestCap("relay")], [null, 1000]);

  // The next stream started where Yolo kept the rate: nothing more to report.
  quality.load({ profile: { videoKbps: 1500, audioKbps: 128 }, limits: { maxVideoKbps: 1500, ceilingKbps: 4800, capped: true }, key: "plex:7", path: "relay" });
  assert.deepEqual([quality.rate(), quality.requestCap("relay")], [null, 1500]);
});

test("at the node's ceiling a kept step up lifts the cap; a stream the browser adapts is never rebuilt, and in the system's fullscreen only a stall steps down", () => {
  const top = harness({ videoKbps: 3000, limits: { maxVideoKbps: 4000, ceilingKbps: 4800, capped: true }, path: "wan" });
  const lifted = top.run(300_000, playing(12_000)).decision;
  assert.deepEqual([lifted.rebuild, lifted.maxVideoKbps, top.quality.rate()], [false, null, { path: "wan", kbps: null }]);

  // hls.js chooses the variant: no step down, even after a long stall.
  const adaptive = harness({ videoKbps: 2000, limits: CAPPED });
  assert.equal(adaptive.run(60_000, { ...stalled(500), adaptive: true }).decision, null);
  assert.equal(adaptive.run(300_000, { ...playing(3_000), adaptive: true }).decision.rebuild, false, "a step up is still kept");

  const fullscreen = harness({ videoKbps: 2000 });
  assert.equal(fullscreen.run(60_000, { ...playing(1_000, 10), stallsOnly: true }).decision, null, "a draining buffer waits");
  assert.equal(fullscreen.run(30_000, { ...stalled(1_000), stallsOnly: true }).decision.rebuild, true);
});

// A dead spot should not decide where the next day's streams start: the car
// on the relay found its start at 400 kbps with 3.7 Mbps measured.
test("a step down's rate is for its item until it has played: only 90 seconds without a stall keep it for later streams", () => {
  const { quality, run, wait } = harness({ videoKbps: 1500, limits: { maxVideoKbps: 1500, ceilingKbps: 4800, capped: true } });
  // 1000 × 0.75 − 128 = 622 kbps: the bottom rung, from one bad moment.
  const down = run(30_000, stalled(1_000)).decision;
  assert.deepEqual([down.direction, down.rebuild, down.maxVideoKbps], ["down", true, 400]);
  assert.equal(quality.stepDownCap, 400, "a request in place of its stream, whose load a reconnect lost");
  const trying = { profile: { videoKbps: 350, audioKbps: 128 }, limits: { maxVideoKbps: 400, ceilingKbps: 4800, capped: true }, key: "ytdlp:v", path: "relay" };
  quality.load(trying);
  assert.deepEqual([quality.rate(), quality.requestCap("relay"), quality.stepDownCap], [null, 400, undefined], "this item's new streams stay at it; Yolo keeps nothing yet");

  // Time in a stall or a pause proves nothing.
  assert.equal(run(60_000, playing(700, 10)).decision, null);
  run(4_000, { ...stalled(700), sampleCount: 0 });
  assert.equal(run(60_000, playing(700, 10)).decision, null, "a stall starts the wait over");
  wait(600_000);
  assert.equal(run(60_000, playing(700, 10)).decision, null, "so does a pause");

  // A recovery's stream at the same rate goes on trying it, from the start.
  quality.load(trying);
  const { decision: kept, elapsed } = run(120_000, playing(700, 10));
  assert.equal(elapsed, QUALITY_POLICY.keepDownAfterMs);
  assert.deepEqual([kept.direction, kept.rebuild, kept.maxVideoKbps, kept.why, kept.path], ["down", false, 400, "sustained", "relay"]);
  assert.deepEqual(quality.rate(), { path: "relay", kbps: 400 }, "the report's health.rate");
  assert.equal(run(30_000, playing(700, 10)).decision, null, "once");
});

test("a page names a stream's rate for that stream only: Yolo keeps what its reports say worked", () => {
  const body = (options) => buildFreshPlaybackSessionRequest({ meta: { source: { plugin: "plex", id: "7" }, sessionId: "ses_1" } }, 10, options).body;
  assert.deepEqual([body({ reason: "quality", maxVideoKbps: 400 }).maxVideoKbps, body({ reason: "quality", maxVideoKbps: 400 }).keepRate], [400, false]);
  assert.deepEqual([body({ reason: "seek", maxVideoKbps: null }).maxVideoKbps, body({ reason: "seek", maxVideoKbps: null }).keepRate], [null, false]);
  assert.equal("keepRate" in body({ reason: "seek" }), false, "no rate named: Yolo uses what it keeps");
});

test("a step down that never played, or whose source had nothing lower, is not kept", () => {
  // Another item came before the 90 seconds: it starts where Yolo kept the rate.
  const left = harness({ videoKbps: 1500, limits: { maxVideoKbps: 1500, ceilingKbps: 4800, capped: true } });
  left.run(30_000, stalled(1_000));
  left.quality.load({ profile: { videoKbps: 350, audioKbps: 128 }, limits: { maxVideoKbps: 400, ceilingKbps: 4800, capped: true }, key: "ytdlp:v", path: "relay" });
  left.quality.load({ profile: { videoKbps: 1400, audioKbps: 128 }, limits: { maxVideoKbps: 1500, ceilingKbps: 4800, capped: true }, key: "plex:7", path: "relay" });
  assert.equal(left.run(120_000, playing(2_000)).decision, null);
  assert.equal(left.quality.rate(), null);

  // Asked for 400, the source's lowest is what played: 400 never did.
  const floor = harness({ videoKbps: 700, limits: { maxVideoKbps: 700, ceilingKbps: 4800, capped: true } });
  assert.equal(floor.run(30_000, stalled(600)).decision.maxVideoKbps, 400);
  floor.quality.load({ profile: { videoKbps: 700, audioKbps: 128 }, limits: { maxVideoKbps: 400, ceilingKbps: 4800, capped: true }, key: "ytdlp:v", path: "relay" });
  assert.equal(floor.run(120_000, playing(1_000)).decision, null);
  assert.equal(floor.quality.rate(), null);
});

test("any stream teaches a step up, since nothing is rebuilt: a live one, and one whose bitrate its source does not name", () => {
  const AT_THE_BOTTOM = { maxVideoKbps: 400, ceilingKbps: 4800, capped: true };
  // The car's live game: 3748 kbps measured, 720p whatever the cap, which
  // climbs to 2200 for the next stream: (2200 + 128) × 1.6 ≈ 3725 kbps.
  const live = harness({ videoKbps: null, limits: AT_THE_BOTTOM, isLive: true });
  // A live stream's buffer ends at the live edge: no stall is its health.
  const climb = [700, 1000, 1500, 2200].map(() => live.run(120_000, playing(3_748, 12)));
  assert.deepEqual(climb.map(({ decision }) => [decision.direction, decision.rebuild, decision.maxVideoKbps]), [
    ["up", false, 700], ["up", false, 1000], ["up", false, 1500], ["up", false, 2200],
  ]);
  assert.deepEqual(live.quality.rate(), { path: "relay", kbps: 2200 });
  assert.equal(live.run(300_000, playing(3_748, 12)).decision, null, "3000 needs 5005 kbps");
  assert.equal(harness({ videoKbps: null, limits: AT_THE_BOTTOM, isLive: true }).run(300_000, { ...stalled(3_748), sampleCount: 8 }).decision, null, "not through a stall");

  // A replay whose source names no bitrate: never a step down, and a step
  // up with a healthy buffer as any stream.
  const unnamed = harness({ videoKbps: null, limits: AT_THE_BOTTOM });
  assert.equal(unnamed.run(60_000, stalled(300)).decision, null);
  assert.equal(unnamed.run(300_000, playing(3_748, 12)).decision, null, "12 seconds is short for a stream that can fill");
  const { decision } = unnamed.run(120_000, playing(3_748));
  assert.deepEqual([decision.direction, decision.rebuild, decision.maxVideoKbps], ["up", false, 700]);
});

// The owner's car on 2026-10-21, on the relay over LTE (Agent Note
// 2026-10-21-smooth-playback-first, "What happened on 2026-10-21"), from its
// device events. Seconds after 19:03:45 UTC: [at, estimate kbps], the
// prefetcher's estimate as the car logged it, held until the next; and
// [at, seconds buffered ahead], in a straight line between heartbeats.
// From 19:12:24 the car replaced its full 1500 kbps stream; the estimates
// after it are those it logged on the stream that replaced it, and the
// stream that would have played on is taken to stay full, as it was for the
// four minutes before.
const DRIVE = {
  first: { loaded: 0, until: 34, estimates: [[9, 2713]], buffer: [[9, 0], [30, 3], [33, 6]], stalls: [[0, 9], [11, 17], [19, 20]] },
  second: {
    loaded: 41, until: 847, stalls: [[41, 56]],
    estimates: [[82, 1470], [161, 1653], [221, 1514], [281, 1716], [341, 2345], [401, 2799], [461, 4443], [519, 4787], [640, 2671], [700, 4916], [741, 5381], [820, 3125]],
    buffer: [[56, 0], [71, 32], [82, 40], [131, 96], [161, 136], [191, 168], [221, 192], [251, 208], [281, 216], [847, 216]],
  },
};

function replay(quality, setClock, { loaded, until, estimates, buffer, stalls }) {
  const decisions = [];
  for (let at = loaded; at <= until; at += 1) {
    setClock(at);
    const estimate = estimates.findLast(([from]) => from <= at)?.[1] ?? 0;
    const after = buffer.findIndex(([from]) => from > at);
    const [a, b] = after <= 0 ? [buffer.at(after === 0 ? 0 : -1), null] : [buffer[after - 1], buffer[after]];
    const ahead = b ? a[1] + ((b[1] - a[1]) * (at - a[0])) / (b[0] - a[0]) : a[1];
    const decision = quality.observe({
      throughputKbps: estimate, sampleCount: estimate ? 8 : 0, bufferedAheadSeconds: ahead,
      buffering: stalls.some(([from, to]) => at >= from && at < to), remainingSeconds: 3000,
    });
    if (decision) decisions.push({ at, ...decision });
  }
  return decisions;
}

test("the car's 2026-10-21 drive: the step down still rebuilds, the step up keeps the full buffer and is where the next stream starts", () => {
  let clock = 0;
  const setClock = (at) => { clock = 1_792_609_425_000 + at * 1000; };
  const quality = createQualityController({ now: () => clock });

  // 4800 kbps at the relay's ceiling: the buffer drains, and the step down
  // is a new stream at 1500, as on the day.
  setClock(DRIVE.first.loaded);
  quality.load({ profile: { videoKbps: 4800, audioKbps: 128 }, limits: { maxVideoKbps: 4800, ceilingKbps: 4800, capped: false }, key: "plex:film", path: "relay" });
  const [down, ...more] = replay(quality, setClock, DRIVE.first);
  assert.deepEqual([down.direction, down.rebuild, down.maxVideoKbps, down.why, more.length], ["down", true, 1500, "draining", 0]);

  // 1500 kbps until the decoder failed at 19:17:52: no new stream. 90 seconds
  // after its one stall ended, the step down's rate has worked and is kept;
  // the headroom from 19:11:26 keeps 2200 for the relay. On the day the step
  // up at 19:12:24 threw 216 buffered seconds away.
  setClock(DRIVE.second.loaded);
  quality.load({ profile: { videoKbps: 1500, audioKbps: 128 }, limits: { maxVideoKbps: 1500, ceilingKbps: 4800, capped: true }, key: "plex:film", path: "relay" });
  const kept = replay(quality, setClock, DRIVE.second);
  assert.deepEqual(kept.map(({ at, direction, rebuild, maxVideoKbps }) => [at, direction, rebuild, maxVideoKbps]), [[145, "down", false, 1500], [551, "up", false, 2200]]);
  assert.deepEqual(quality.rate(), { path: "relay", kbps: 2200 });
  assert.equal(quality.requestCap("relay"), 2200, "the recovery after the decoder error asks for 2200, which Plex serves at 480p");
});
