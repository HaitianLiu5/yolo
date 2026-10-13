import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFreshPlaybackSessionRequest,
  hasNothingLeftToPlay,
  hasRecoveryPlaybackProgress,
  hasSeekPlaybackProgress,
  planRetry,
  playbackRecoveryDelayMs,
  resolvePlaybackPosition,
  shouldRestartSessionForSeek,
} from "../../src/playback-recovery.js";

test("recovery asks Yolo to resolve the item again instead of reusing a stale stream", () => {
  const source = { plugin: "ytdlp", id: "https://youtube.com/watch?v=source-id", url: "https://youtu.be/source-id" };
  const request = buildFreshPlaybackSessionRequest({
    url: "/m/token/dash/master.m3u8",
    meta: { source, sessionId: "ses_old" },
  }, 42.5, { deviceId: "dev_car" });
  assert.deepEqual(request, {
    endpoint: "/v1/playback/play",
    body: { source, startTime: 42.5, reason: "recovery", autoplay: true, sessionId: "ses_old", deviceId: "dev_car" },
  });
  // A paused player stays paused; a seek outside the stream is a normal
  // latest-wins request; without a source there is nothing to ask for.
  const plex = { plugin: "plex", id: "99" };
  assert.equal(buildFreshPlaybackSessionRequest({ meta: { source: plex } }, 12, { autoplay: false }).body.autoplay, false);
  assert.deepEqual(buildFreshPlaybackSessionRequest({ meta: { source: plex, sessionId: "ses_1" } }, 420, { autoplay: false, recovery: false, reason: "seek" }).body,
    { source: plex, startTime: 420, reason: "seek", autoplay: false, sessionId: "ses_1" });
  assert.equal(buildFreshPlaybackSessionRequest({ meta: {} }, 1), null);
});

test("a new stream keeps the device's quality cap, or leaves it to Yolo's memory", () => {
  const request = { meta: { source: { plugin: "ytdlp", id: "v" }, sessionId: "ses_1" } };
  assert.equal(buildFreshPlaybackSessionRequest(request, 10, { reason: "quality", maxVideoKbps: 700 }).body.maxVideoKbps, 700);
  assert.equal(buildFreshPlaybackSessionRequest(request, 10, { reason: "quality", maxVideoKbps: null }).body.maxVideoKbps, null);
  assert.equal("maxVideoKbps" in buildFreshPlaybackSessionRequest(request, 10).body, false);
});

test("a seek before an offset stream's first segment restarts the session; one inside it stays local", () => {
  const seek = (fields) => shouldRestartSessionForSeek({ sessionId: "ses_1", seekableStartTime: 11_622, ...fields });
  assert.equal(seek({ targetTime: 7 * 60 }), true);
  assert.equal(seek({ targetTime: 11_700 }), false);
  assert.equal(seek({ targetTime: 420, sessionId: null }), false);
  // While a restart is pending, later seeks join it: the latest target wins.
  assert.equal(seek({ targetTime: 11_700, sessionRestartPending: true }), true);
});

test("recovery is confirmed only by advancing presentation time", () => {
  assert.equal(hasRecoveryPlaybackProgress({
    status: "buffering",
    baselineTime: 10,
    currentTime: 20,
  }), false);
  assert.equal(hasRecoveryPlaybackProgress({
    status: "playing",
    baselineTime: 10,
    currentTime: 10.1,
  }), false);
  assert.equal(hasRecoveryPlaybackProgress({
    status: "playing",
    baselineTime: 10,
    currentTime: 10.3,
  }), true);
  assert.equal(hasRecoveryPlaybackProgress({
    status: "playing",
    baselineTime: 10,
    currentTime: 20,
    hasVideo: true,
    videoFrameRenderCount: 0,
  }), false);
  assert.equal(hasRecoveryPlaybackProgress({
    status: "playing",
    baselineTime: 10,
    currentTime: 10.3,
    hasVideo: true,
    videoFrameRenderCount: 1,
  }), true);
});

test("recovery backs off 1, 3, 10 and 30 seconds, then every 60 however long the outage", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(playbackRecoveryDelayMs), [1_000, 3_000, 10_000, 30_000, 60_000, 60_000, 60_000]);
});

test("the engine presentation clock wins over a stale UI snapshot", () => {
  assert.equal(resolvePlaybackPosition({
    engineTime: 397.6,
    fallbackTime: 303,
    duration: 815,
  }), 397.6);
  assert.equal(resolvePlaybackPosition({
    engineTime: Number.NaN,
    fallbackTime: 303,
    duration: 815,
  }), 303);
});

test("seek watchdog requires presentation progress beyond the target", () => {
  const before = {
    videoFrameDecodeCount: 100,
    audioFrameRenderCount: 200,
    videoCurrentTimeMs: 10_000,
    audioCurrentTimeMs: 10_000,
  };
  assert.equal(hasSeekPlaybackProgress(before, {
    ...before,
    videoFrameDecodeCount: 101,
  }, 10, 250), false);
  assert.equal(hasSeekPlaybackProgress(before, {
    ...before,
    audioFrameRenderCount: 201,
  }, 10, 250), false);
  assert.equal(hasSeekPlaybackProgress(before, {
    ...before,
    videoCurrentTimeMs: 10_300,
    audioCurrentTimeMs: 10_300,
  }, 10, 250), true);
});

test("a stream asked for in an item's last second has nothing left to play", () => {
  assert.equal(hasNothingLeftToPlay(59.2, 60), true);
  assert.equal(hasNothingLeftToPlay(60, 60), true);
  assert.equal(hasNothingLeftToPlay(75, 60), true);
  assert.equal(hasNothingLeftToPlay(58.9, 60), false);
  assert.equal(hasNothingLeftToPlay(59.5, 60, { isLive: true }), false);
  assert.equal(hasNothingLeftToPlay(59.5, 0), false);
  assert.equal(hasNothingLeftToPlay(59.5, null), false);
});

test("Try again restarts an item that reached its end, and plays it anew once Yolo ended its session", () => {
  // In the middle, while Yolo still holds the session: rebuild it there.
  assert.deepEqual(planRetry({ position: 42.5, duration: 60, sessionId: "ses_1", hubSessionId: "ses_1" }),
    { startTime: 42.5, restart: false, rebuild: true });
  // At the end, Yolo still holding the session: rebuild it from the start.
  assert.deepEqual(planRetry({ position: 59.99, duration: 60, sessionId: "ses_1", hubSessionId: "ses_1" }),
    { startTime: 0, restart: true, rebuild: true });
  // The stream ran out and Yolo ended the session (an `ended` reached it):
  // a rebuild would be superseded, so the item plays anew from the start.
  assert.deepEqual(planRetry({ position: 59.99, duration: 60, sessionId: "ses_1", hubSessionId: null }),
    { startTime: 0, restart: true, rebuild: false });
  // A live stream retries where it is.
  assert.deepEqual(planRetry({ position: 600, duration: 600, isLive: true, sessionId: "ses_1", hubSessionId: "ses_1" }),
    { startTime: 600, restart: false, rebuild: true });
});
