import { requestStream, streamRecoveryPending } from "./playback.js";
import { buildFreshPlaybackSessionRequest } from "./playback-recovery.js";
import { createQualityController, qualitySample } from "./quality.js";
import { seekStreamPending } from "./seek.js";
import { state } from "./state.js";
import { recoveryScheduled, replacedStream } from "./stream-recovery.js";
import { readStats, summarizeStats } from "./telemetry/engine-stats.js";
import { notePlaybackDiagnostics } from "./telemetry/playback-diagnostics.js";
import { logPlayerEvent } from "./telemetry/player-log.js";

// Every second while a stream plays: the throughput the stream's downloads
// measured and its buffer go to the quality controller (quality.js), which
// may ask Yolo for a stream at a lower bitrate, or keep a higher one for
// the next stream (Agent Note 2026-10-21-smooth-playback-first). The
// numbers stay in telemetry (and /diag); the screen only ever shows the
// spinner. A stall of 8 seconds is diagnosed in the logs.

const INTERVAL_MS = 1_000;
const DIAGNOSE_AFTER_BUFFERING_MS = 8_000;
// The bitrate a stream needs, over its own, to play without stalls.
const REQUIRED_HEADROOM = 1.15;

/** Adaptive quality: one controller for the page, so a cap learned on one stream carries over to the next of this session. */
export const quality = createQualityController();

let fromPlayer = null;

/** `position(player)` is where playback is, `playbackRate()` the speed it plays at (player.js). */
export function initQualityMonitor(deps) {
  fromPlayer = deps;
}

let interval = null;
const watch = { bufferingSince: 0, diagnosed: false, lastSample: null };
// The quality change in flight, which a recovery waits for.
let change = null;

/** The quality change on its way, as a promise, or null. */
export const qualityChangePending = () => change;
/** The last second's sample (quality.js), for the reports' `health`, or null. */
export const lastQualitySample = () => watch.lastSample;

export function stopQualityMonitor() {
  clearInterval(interval);
  interval = null;
  Object.assign(watch, { bufferingSince: 0, diagnosed: false, lastSample: null });
}

/** Watches `player`, the stream on screen, of `meta` (play()), until another stream or stopQualityMonitor(). */
export function startQualityMonitor(player, meta) {
  stopQualityMonitor();
  interval = setInterval(() => {
    if (state.player !== player) {
      stopQualityMonitor();
      return;
    }
    // One read of the engine's stats serves both the summary the logs carry
    // and the quality sample, which needs fields the summary leaves out.
    const engineStats = readStats(player);
    const sample = qualitySample(engineStats, {
      buffering: state.isBuffering,
      duration: state.duration,
      currentTime: state.currentTime,
      isLive: state.isLive,
      playbackRate: fromPlayer.playbackRate(),
    });
    watch.lastSample = sample;
    diagnose(meta, summarizeStats(engineStats), sample);
    notePlaybackDiagnostics({ network: { ...sample, at: new Date().toISOString() }, quality: quality.snapshot() });
    // Something else is already replacing this stream.
    if (change || seekStreamPending() || streamRecoveryPending() || recoveryScheduled()) return;
    if (state.playbackIntent !== "playing" && !sample.buffering) return;
    // A new stream ends the system's fullscreen player (iPhone): there only a
    // stall steps down. A step up makes no new stream.
    const decision = quality.observe({ ...sample, stallsOnly: Boolean(player.nativeFullscreen) });
    if (decision?.rebuild) {
      change = stepDown(player, decision, sample).finally(() => {
        change = null;
      });
    } else if (decision) {
      keepRate(decision, sample);
    }
  }, INTERVAL_MS);
}

// Why playback stalls, for the logs: once per stall that lasts 8 seconds.
function diagnose(meta, stats, sample) {
  if (!sample.buffering) {
    watch.bufferingSince = 0;
    watch.diagnosed = false;
    return;
  }
  watch.bufferingSince ||= performance.now();
  const bufferingMs = performance.now() - watch.bufferingSince;
  if (watch.diagnosed || bufferingMs < DIAGNOSE_AFTER_BUFFERING_MS) return;
  const profile = meta.streamProfile || {};
  const requiredKbps = Math.round(((Number(profile.videoKbps) || 0) + (Number(profile.audioKbps) || 0)) * REQUIRED_HEADROOM) || null;
  const failures = (Number(stats?.hlsTimeoutCount) || 0) + (Number(stats?.hlsFailureCount) || 0) + (Number(stats?.hlsRetryWaitingSegments) || 0);
  let diagnosis = null;
  if (requiredKbps && sample.sampleCount >= 2 && sample.throughputKbps && sample.throughputKbps < requiredKbps) diagnosis = "bandwidth_insufficient";
  else if (failures && sample.bufferedAheadSeconds < 2) diagnosis = "network_unstable";
  if (!diagnosis) return;
  watch.diagnosed = true;
  notePlaybackDiagnostics({}, { event: { type: diagnosis, availableKbps: sample.throughputKbps || null, requiredKbps } });
  logPlayerEvent(diagnosis, {
    bufferingMs: Math.round(bufferingMs),
    availableKbps: sample.throughputKbps || null,
    requiredKbps,
    sampleCount: sample.sampleCount,
    bufferedAheadSeconds: sample.bufferedAheadSeconds,
    quality: quality.snapshot(),
  });
}

// A step up never replaces the stream that plays, which would throw its
// buffer away: the rate becomes where this screen's next stream on this
// path starts. The next report's `health.rate` tells Yolo, which keeps it
// for the screen and path.
function keepRate(decision, sample) {
  notePlaybackDiagnostics({}, { event: { type: "quality_rate_kept", ...decision }, now: true });
  logPlayerEvent("quality_rate_kept", {
    ...decision,
    bufferedAheadSeconds: sample.bufferedAheadSeconds,
    sampleCount: sample.sampleCount,
    sampleAgeMs: sample.sampleAgeMs,
  });
}

// A stream of the same item at a lower bitrate, from where playback is
// now. The current stream keeps playing until the new one arrives (a
// `load` with reason "quality", main.js).
async function stepDown(player, decision, sample) {
  const playing = state.sessionId;
  const source = state.source;
  notePlaybackDiagnostics({}, { event: { type: "quality_change_requested", ...decision }, now: true });
  logPlayerEvent("quality_change_requested", {
    ...decision,
    bufferedAheadSeconds: sample.bufferedAheadSeconds,
    sampleCount: sample.sampleCount,
    sampleAgeMs: sample.sampleAgeMs,
    downloading: sample.downloading,
    remainingSeconds: sample.remainingSeconds == null ? null : Math.round(sample.remainingSeconds),
    buffering: sample.buffering,
  });
  if (!source || !playing) {
    quality.abandon();
    return;
  }
  try {
    const result = await requestStream(() => {
      if (state.sessionId !== playing || state.player !== player) return null;
      return buildFreshPlaybackSessionRequest({ meta: { source, sessionId: replacedStream() } }, fromPlayer.position(player), {
        autoplay: state.playbackIntent === "playing",
        reason: "quality",
        maxVideoKbps: decision.maxVideoKbps,
      })?.body ?? null;
    }, { label: "Quality", reason: "quality" });
    if (result === null) quality.abandon();
  } catch (error) {
    quality.abandon();
    logPlayerEvent("quality_change_failed", { error: error?.message || String(error), code: error?.code || null });
  }
}
