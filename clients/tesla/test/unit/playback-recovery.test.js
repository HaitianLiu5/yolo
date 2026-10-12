import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFreshPlaybackSessionRequest,
  hasRecoveryPlaybackProgress,
  hasSeekPlaybackProgress,
  playbackRecoveryDelayMs,
  resolvePlaybackPosition,
  shouldHoldOptimisticSeekTarget,
  shouldRestartSessionForSeek,
} from "../../src/playback-recovery.js";

function firstRecoveryAfter(outageMs) {
  let elapsedMs = 0;
  let attempt = 0;
  while (elapsedMs < outageMs) {
    attempt += 1;
    elapsedMs += playbackRecoveryDelayMs(attempt);
  }
  return { attempt, elapsedMs, recoveryLagMs: elapsedMs - outageMs };
}

for (const outageSeconds of [30, 60, 180]) {
  test(`recovery keeps retrying through a ${outageSeconds}-second disconnect`, () => {
    const result = firstRecoveryAfter(outageSeconds * 1000);
    assert.ok(result.attempt > 0);
    assert.ok(result.recoveryLagMs >= 0);
    assert.ok(result.recoveryLagMs <= 60_000, "capped backoff must retry within one minute of reconnection");
  });
}

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
});

test("recovery preserves a paused user intent", () => {
  const request = buildFreshPlaybackSessionRequest({ meta: { source: { plugin: "plex", id: "99" } } }, 12, { autoplay: false });
  assert.equal(request.body.autoplay, false);
});

test("a seek outside the stream is a normal latest-wins request", () => {
  const request = buildFreshPlaybackSessionRequest({ meta: { source: { plugin: "plex", id: "99" }, sessionId: "ses_1" } }, 420, {
    autoplay: false,
    recovery: false,
    reason: "seek",
  });
  assert.deepEqual(request.body, { source: { plugin: "plex", id: "99" }, startTime: 420, reason: "seek", autoplay: false, sessionId: "ses_1" });
  assert.equal(buildFreshPlaybackSessionRequest({ meta: {} }, 1), null);
});

test("a new stream keeps the device's quality cap, or leaves it to Yolo's memory", () => {
  const request = { meta: { source: { plugin: "ytdlp", id: "v" }, sessionId: "ses_1" } };
  assert.equal(buildFreshPlaybackSessionRequest(request, 10, { reason: "quality", maxVideoKbps: 700 }).body.maxVideoKbps, 700);
  assert.equal(buildFreshPlaybackSessionRequest(request, 10, { reason: "quality", maxVideoKbps: null }).body.maxVideoKbps, null);
  assert.equal("maxVideoKbps" in buildFreshPlaybackSessionRequest(request, 10).body, false);
});

test("a seek before an offset stream's first segment restarts the session", () => {
  assert.equal(shouldRestartSessionForSeek({
    sessionId: "ses_1",
    targetTime: 7 * 60,
    seekableStartTime: 11_622,
  }), true);
});

test("a seek inside the current stream stays local", () => {
  assert.equal(shouldRestartSessionForSeek({
    sessionId: "ses_1",
    targetTime: 11_700,
    seekableStartTime: 11_622,
  }), false);
  assert.equal(shouldRestartSessionForSeek({
    sessionId: null,
    targetTime: 420,
    seekableStartTime: 11_622,
  }), false);
});

test("a pending session restart keeps later seeks latest-wins", () => {
  assert.equal(shouldRestartSessionForSeek({
    sessionId: "ses_1",
    targetTime: 11_700,
    seekableStartTime: 11_622,
    sessionRestartPending: true,
  }), true);
});

test("optimistic seek holds the target only for the current transition player", () => {
  assert.equal(shouldHoldOptimisticSeekTarget({
    transitionPending: true,
    playerIsCurrent: true,
  }), true);
  assert.equal(shouldHoldOptimisticSeekTarget({
    transitionPending: false,
    playerIsCurrent: true,
  }), false);
  assert.equal(shouldHoldOptimisticSeekTarget({
    transitionPending: true,
    playerIsCurrent: false,
  }), false);
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

test("recovery backoff remains capped during a prolonged outage", () => {
  assert.equal(playbackRecoveryDelayMs(1), 1_000);
  assert.equal(playbackRecoveryDelayMs(5), 60_000);
  assert.equal(playbackRecoveryDelayMs(50), 60_000);
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

test("seek watchdog rejects a fake buffering state with no producer progress", () => {
  const snapshot = {
    videoFrameDecodeCount: 100,
    audioFrameRenderCount: 200,
    videoCurrentTimeMs: 10_000,
    audioCurrentTimeMs: 10_000,
  };
  assert.equal(hasSeekPlaybackProgress(snapshot, { ...snapshot }, 10), false);
});
