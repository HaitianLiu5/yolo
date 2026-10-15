import "./player-overlays.css";
import { state } from "./state.js";
import { PlaybackGeneration } from "./playback-generation.js";
import {
  showControls, updateTimeDisplay, updateProgress, updatePlayButton,
  updateVolumeButton, showBuffering, hideBuffering, isDraggingProgress,
  setSeekTransitionPending, showPlaybackNotice, mediaTitle, showTapForSound,
} from "./controls.js";
import { createKeptPlayer, planReopen, probeStreamSession, reopenPlan } from "./kept-player.js";
import { renderSubtitle, loadSubtitleTrack, disableExternalSubtitle, clearSubtitles, subtitleCues } from "./subtitles.js";
import { createDanmaku } from "./danmaku.js";
import { createDanmakuSettings } from "./danmaku-settings.js";
import { navigate } from "./router.js";
import { MediabunnyPlayer } from "./engine/mediabunny-player.js";
import { NativeVideoPlayer } from "./engine/native-video-player.js";
import { createLoadingScreen } from "./loading.js";
import { attachPictureControls, detachPictureControls, exitPictureModes } from "./picture-controls.js";
import { artworkSource } from "./artwork.js";
import { PageMemoryMonitor } from "./telemetry/page-memory-monitor.js";
import { createQualityController } from "./quality.js";
import { physicalViewport } from "./display-scale.js";
import { playOnThisDevice, requestStream, streamRecoveryPending } from "./playback.js";
import { mediaDeadEnd } from "./media-dead-end.js";
import { owner } from "./owner.js";
import { isNetworkFailure } from "./network.js";
import { deviceEvents, recordDeviceEvent } from "./telemetry/device-events.js";
import { notePlaybackDiagnostics } from "./telemetry/playback-diagnostics.js";
import {
  buildFreshPlaybackSessionRequest,
  hasNothingLeftToPlay,
  hasRecoveryPlaybackProgress,
  hasSeekPlaybackProgress,
  planRetry,
  playbackRecoveryDelayMs,
  resolvePlaybackPosition,
  shouldHoldOptimisticSeekTarget,
  shouldRestartSessionForSeek,
} from "./playback-recovery.js";

// --- Callbacks (set by main.js to avoid circular deps) ---------------

let onUpdateSubsUI = () => {};
let onUpdateAudioUI = () => {};
let onKeptChange = () => {};
let onOwnAction = () => {};
let realtime = null;

// `keptChanged` runs when a player is kept behind the home screen, its
// paused picture is ready, or it is shown again or let go (the
// now-playing bar, remote.js). `ownAction(kind)` hears what the owner did
// on this screen that a command a reconnect lost must not overrule: a
// pause or Back ("playback"), a seek ("seek") (missed-commands.js).
export function setPlayerCallbacks({ updateSubsUI, updateAudioUI, keptChanged = () => {}, ownAction = () => {} }) {
  onUpdateSubsUI = updateSubsUI;
  onUpdateAudioUI = updateAudioUI;
  onKeptChange = keptChanged;
  onOwnAction = ownAction;
}

// --- The playback engine -----------------------------------------------------
// One player (this module: lifecycle, recovery, reports, telemetry, quality,
// controls) over two engines with the same interface
// (Agent Note 2026-10-12-two-playback-engines): the canvas engine
// (engine/mediabunny-player.js), which the car needs because Tesla can
// freeze a <video> element while driving, and the browser's own <video>
// element (engine/native-video-player.js) for the web profile. The profile
// (profile.js, set by main.js) chooses one for each new stream.

let engineChoice = () => ({ engine: "canvas", native: null });

/** `choose()` returns { engine: "canvas" | "native", native: nativeVideoSupport() | null }. */
export function setPlaybackEngine(choose) {
  engineChoice = choose;
}

const ENGINES = Object.freeze({
  canvas: Object.freeze({ name: "canvas", decodePath: "mediabunny-webcodecs", stateEvent: "mediabunny_state", clock: "audio-consumed-samples", decodePreference: "webcodecs-hardware-with-yolo-coordinator" }),
  native: Object.freeze({ name: "native", decodePath: "native-video", stateEvent: "native_video_state", clock: "media-element", decodePreference: "browser-media-pipeline" }),
});

// The engine of the current player, for telemetry.
let currentEngine = ENGINES.canvas;

// The realtime channel to Yolo's Hub (realtime.js), set by main.js.
export function setRealtime(channel) {
  realtime = channel;
}

// --- The stream's origin (Agent Note 2026-10-13-media-off-the-worker) --------
// A stream on the `lan` or `wan` path names that listener's origin on the
// node; every one of its media URLs (delivery, playlists, segments,
// subtitles) resolves against it, and against this page's origin on the
// relay. Any recovery of a stream that has a path below its own (an engine
// error, a stalled seek, a frozen picture) first moves this screen down the
// order lan, wan, relay (media-paths.js), once per stream, so the recovery
// comes by the next path at the same position.

let mediaPaths = null;
let pathFailureNoted = false;

/** The screen's media paths (media-paths.js), set by main.js. */
export function setMediaPaths(controller) {
  mediaPaths = controller;
}

function mediaOriginOf(origin) {
  try {
    return origin ? new URL(origin).origin : location.origin;
  } catch {
    return location.origin;
  }
}

function resolveDelivery(delivery, origin) {
  if (!delivery || typeof delivery !== "object") return delivery;
  const resolved = { ...delivery };
  for (const key of ["url", "videoUrl", "audioUrl"]) {
    if (typeof delivery[key] === "string") resolved[key] = new URL(delivery[key], origin).href;
  }
  return resolved;
}

function notePathFailure(error) {
  if (!error || typeof error !== "object" || !mediaPaths) return;
  if (pathFailureNoted) {
    error.pathFallback = true;
    return;
  }
  if (!mediaPaths.canFallBack(state.streamNetwork)) return;
  pathFailureNoted = true;
  error.pathFallback = true;
  mediaPaths.failed(error, { path: state.streamNetwork, position: getPlaybackRecoveryPosition(state.player) });
}

const NO_TRACKS = Object.freeze({ subtitles: [], audio: [], selected: { subtitles: [], audio: null } });
const sourceKeyOf = (source) => (source?.plugin && source.id != null ? `${source.plugin}:${source.id}` : null);

let lastUiPaintAt = 0;

const UI_PAINT_INTERVAL_MS = 250;
const PLAYER_AUDIO_GAIN = 12.0;
const CAPABILITY_PROFILE = detectCapabilityProfile();
// Agent Note 2026-10-07-hub-and-realtime-channel: at least every 5 seconds, and
// on every status change.
const PROGRESS_REPORT_INTERVAL_MS = 5_000;
const MIN_REPORT_SPACING_MS = 750;
const RUNTIME_LOG_CAPACITY = 200;
const LIVE_SEEK_MAX_LEAD_SECONDS = 12;
const DECODE_HEALTH_INTERVAL_MS = 60_000;
const STUTTER_EVENT_CAPACITY = 100;
const STUTTER_REPORT_INTERVAL_MS = 30_000;
const STUTTER_LONG_TASK_THRESHOLD_MS = 50;
const STUTTER_MEMORY_SAMPLE_INTERVAL_MS = 15_000;
const STUTTER_FLUSH_IDLE_TIMEOUT_MS = 1_000;
const PLAYER_HEALTH_HEARTBEAT_INTERVAL_MS = 30_000;
const PLAYER_RECOVERY_STABLE_MS = 60_000;
const PLAYER_RECOVERY_CONFIRM_TIMEOUT_MS = 20_000;
// A car can be offline for minutes. Recovery stays active until playback is
// stable again or the user starts/stops something else; the capped backoff
// prevents a retry storm while still healing after connectivity returns.
const VIDEO_FREEZE_THRESHOLD_MS = 8_000;
const VIDEO_FREEZE_DRIFT_MS = 5_000;
const SEEK_STALL_TIMEOUT_MS = 5_000;
const SEEK_MAX_WAIT_MS = 30_000;
// How long a seek's new stream may take to arrive once Yolo has built it.
const SEEK_RESTART_LOAD_TIMEOUT_MS = 10_000;
const SLOW_SEGMENT_FETCH_MS = 3_000;
const MEMORY_PRESSURE_GROWTH_BYTES = 8 * 1024 * 1024;
const MEMORY_PRESSURE_GROWTH_RATIO = 0.15;
const PAGE_MEMORY_SAMPLE_INTERVAL_MS = 5 * 60_000;
const playerMetricsState = createPlayerMetricsState();
const stutterEventBuffer = Array.from({ length: STUTTER_EVENT_CAPACITY }, () => ({
  seq: 0,
  type: "",
  timestamp: 0,
  playbackPosition: 0,
  durationMs: 0,
  stallStartedAt: 0,
  usedJSHeapSize: 0,
  totalJSHeapSize: 0,
  jsHeapSizeLimit: 0,
  heapGrowthBytes: 0,
}));
const stutterTelemetryState = createStutterTelemetryState();
const decodeHealthState = createDecodeHealthState();
const playerRuntimeLogState = createPlayerRuntimeLogState();
let stutterReportInterval = null;
let stutterFlushTimer = null;
let stutterFlushIdleHandle = null;
let scheduledStutterFlushReason = "interval";
let longTaskObserver = null;
let decodeHealthInterval = null;
let playerHealthHeartbeatInterval = null;
let networkMonitorInterval = null;
// Adaptive quality (quality.js): one controller for the page, so a cap
// learned on one stream carries over to the next of this session.
const quality = createQualityController();
const networkState = { bufferingSince: 0, diagnosed: false, lastSample: null };
// The quality change in flight, which a recovery waits for.
let qualityRequest = null;
const playbackRecoveryState = {
  attempts: 0,
  retryTimer: null,
  confirmationTimer: null,
  pendingConfirmation: null,
  stableTimer: null,
  request: null,
};
const seekWatchdogState = {
  requestId: 0,
  timer: null,
  player: null,
  targetTime: 0,
  startedAt: 0,
  progressSnapshot: null,
};
const sessionRestartState = {
  requestId: 0,
  pending: false,
  transitionPending: false,
  // The seek that asked for the stream: { player, targetTime, asked,
  // expectedToPlay, fromTime, asking }, where `asked` is the target its
  // request went for and `targetTime` the last one the owner asked for.
  seek: null,
  // The Hub's new session for that seek, once Yolo built it.
  built: null,
  loadTimer: null,
};
// A stream Yolo built for this screen in place of the one on screen, whose
// `load` never came (rejoinHubStream): { onScreen, sessionId, asking }.
// Yolo sends each `load` once, over the connection it has then.
let lostLoad = null;

// The session a request for a new stream of what plays replaces: the one on
// screen, or the one Yolo built in its place whose `load` never came.
function replacedStream() {
  return lostLoad && lostLoad.onScreen === state.sessionId ? lostLoad.sessionId : state.sessionId;
}

// The request for another item a welcome named, on its way
// (rejoinHubItem): { onScreen, sessionId }.
let itemRejoin = null;

// A request in place of `lost` was refused (superseded) or no longer
// wanted: Yolo no longer has that stream for this screen.
function forgetLostLoad(lost) {
  if (lostLoad === lost) lostLoad = null;
}

// The stream this screen left without keeping its player (a plain `idle`),
// until a state from Yolo marks it left (`leftAt`) or names another
// stream: { sessionId, position }. A connection that died takes the
// report too, and the welcome after it would still show the stream playing
// here, which a returning page plays on (noteHubState, main.js). It is kept
// in the tab's sessionStorage too, so a page loaded again in the tab (a
// reload, a car's wake) still says `idle` again and does not resume it.
const LEFT_STREAM_KEY = "yolo.leftStream";

function storedLeftStream() {
  try {
    const value = JSON.parse(globalThis.sessionStorage?.getItem(LEFT_STREAM_KEY) ?? "null");
    return typeof value?.sessionId === "string" ? { sessionId: value.sessionId, position: Math.max(0, Number(value.position) || 0) } : null;
  } catch {
    return null;
  }
}

function setLeftStream(value) {
  leftStream = value;
  try {
    if (value) globalThis.sessionStorage?.setItem(LEFT_STREAM_KEY, JSON.stringify(value));
    else globalThis.sessionStorage?.removeItem(LEFT_STREAM_KEY);
  } catch {
    // Storage blocked or full: this page alone remembers it.
  }
}

let leftStream = storedLeftStream();

// The stream that played to its end on screen and told Yolo `ended`
// (finishPlayback), until anything plays, pauses, or seeks it again or
// another stream starts: { sessionId, player, heard }. `heard` once Yolo
// answered a ping sent after the `ended`, which then reached it. A welcome
// that still names the stream while it is unheard gets `ended` again
// (main.js), so the queue goes on as it would have.
let finished = null;

export function forgetFinished() {
  finished = null;
}

const originalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
const pageMemoryMonitor = new PageMemoryMonitor({ intervalMs: PAGE_MEMORY_SAMPLE_INTERVAL_MS });
let pageMemoryCapabilityLogged = false;
let lastPageMemoryError = null;
let lastPageMemorySessionId = null;
let lastPageMemoryCorrelationValid = false;
const playbackGeneration = new PlaybackGeneration();

function getMediabunnyFaultInjection() {
  const params = new URLSearchParams(location.search);
  const durationMs = Number(params.get("videoStallMs"));
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const atSeconds = Number(params.get("videoStallAt"));
  return {
    durationMs,
    atSeconds: Number.isFinite(atSeconds) && atSeconds >= 0 ? atSeconds : 10,
  };
}

function createPlayerMetricsState() {
  return {
    stallCount: 0,
    totalStallDurationMs: 0,
    stallStartedAt: 0,
    decodePath: ENGINES.canvas.decodePath,
    lastVideoCurrentTimeMs: 0,
    lastVideoProgressAt: 0,
    freezeRecoveryTriggered: false,
  };
}

function clearPlaybackRecoveryTimers() {
  if (playbackRecoveryState.retryTimer) {
    clearTimeout(playbackRecoveryState.retryTimer);
    playbackRecoveryState.retryTimer = null;
  }
  if (playbackRecoveryState.stableTimer) {
    clearTimeout(playbackRecoveryState.stableTimer);
    playbackRecoveryState.stableTimer = null;
  }
  if (playbackRecoveryState.confirmationTimer) {
    clearTimeout(playbackRecoveryState.confirmationTimer);
    playbackRecoveryState.confirmationTimer = null;
  }
  playbackRecoveryState.pendingConfirmation = null;
}

function resetPlaybackRecovery({ clearRequest = false } = {}) {
  clearPlaybackRecoveryTimers();
  playbackRecoveryState.attempts = 0;
  if (clearRequest) playbackRecoveryState.request = null;
}

function clearSeekWatchdog({ invalidate = true } = {}) {
  if (seekWatchdogState.timer) clearTimeout(seekWatchdogState.timer);
  seekWatchdogState.timer = null;
  seekWatchdogState.player = null;
  seekWatchdogState.progressSnapshot = null;
  if (invalidate) seekWatchdogState.requestId += 1;
}

function armSeekWatchdog(player, targetTime, expectedToPlay) {
  clearSeekWatchdog();
  const requestId = seekWatchdogState.requestId;
  if (!expectedToPlay) return requestId;

  seekWatchdogState.player = player;
  seekWatchdogState.targetTime = targetTime;
  seekWatchdogState.startedAt = performance.now();
  seekWatchdogState.progressSnapshot = summarizePlayerStats(player);

  const checkProgress = () => {
    seekWatchdogState.timer = null;
    if (
      requestId !== seekWatchdogState.requestId
      || seekWatchdogState.player !== player
      || state.player !== player
    ) return;

    const playbackState = player.getStatus?.();
    if (!["seeking", "buffering"].includes(playbackState)) {
      clearSeekWatchdog();
      return;
    }

    const nextSnapshot = summarizePlayerStats(player);
    if (hasSeekPlaybackProgress(
      seekWatchdogState.progressSnapshot,
      nextSnapshot,
      targetTime,
    )) {
      seekWatchdogState.progressSnapshot = nextSnapshot;
      postPlayerRuntimeLog("seek_progress_observed", {
        requestId,
        targetTime,
        elapsedMs: Math.round(performance.now() - seekWatchdogState.startedAt),
        playerStats: nextSnapshot,
      });
      seekWatchdogState.timer = setTimeout(checkProgress, SEEK_STALL_TIMEOUT_MS);
      return;
    }
    const networkStillWorking = [
      nextSnapshot?.hlsActiveDownloads,
      nextSnapshot?.hlsQueuedSegments,
      nextSnapshot?.hlsRetryWaitingSegments,
    ].some((value) => Number(value) > 0);
    const elapsedMs = Math.round(performance.now() - seekWatchdogState.startedAt);
    if (networkStillWorking && elapsedMs < SEEK_MAX_WAIT_MS) {
      postPlayerRuntimeLog("seek_waiting_for_network", {
        requestId,
        targetTime,
        elapsedMs: Math.round(performance.now() - seekWatchdogState.startedAt),
        playerStats: nextSnapshot,
      });
      seekWatchdogState.timer = setTimeout(checkProgress, SEEK_STALL_TIMEOUT_MS);
      return;
    }

    postPlayerRuntimeLog("seek_stall_detected", {
      requestId,
      targetTime,
      elapsedMs,
      playerStatus: playbackState,
      playerStats: nextSnapshot,
      buffer: collectBufferState(player),
    });
    const error = new Error(`seek made no playback progress for ${SEEK_STALL_TIMEOUT_MS}ms`);
    error.code = "SEEK_STALLED";
    clearSeekWatchdog();
    schedulePlaybackRecovery(player, error, { startTime: targetTime });
  };
  seekWatchdogState.timer = setTimeout(checkProgress, SEEK_STALL_TIMEOUT_MS);
  return requestId;
}

function getPlaybackRecoveryPosition(player) {
  return getReportedCurrentTime(player);
}

// --- Network: adaptive quality and its diagnosis ----------------------------

const NETWORK_MONITOR_INTERVAL_MS = 1_000;
// A wait this long is diagnosed in the logs (diagnoseNetwork).
const DIAGNOSE_AFTER_BUFFERING_MS = 8_000;
const REQUIRED_HEADROOM = 1.15;

function stopNetworkMonitor() {
  if (networkMonitorInterval) clearInterval(networkMonitorInterval);
  networkMonitorInterval = null;
  networkState.bufferingSince = 0;
  networkState.diagnosed = false;
  networkState.lastSample = null;
}

// Every second while a stream plays: the throughput the HLS prefetcher
// measured and its buffer go to the quality controller, which may ask Yolo
// for a stream at another bitrate. The numbers stay in telemetry (and
// /diag); the screen only ever shows the spinner.
function startNetworkMonitor(player, meta) {
  stopNetworkMonitor();
  const tick = () => {
    if (state.player !== player) {
      stopNetworkMonitor();
      return;
    }
    const stats = summarizePlayerStats(player);
    const sample = {
      throughputKbps: Math.round((Number(stats?.bandwidth) || 0) / 1000),
      sampleCount: Number(stats?.hlsThroughputSampleCount) || 0,
      bufferedAheadSeconds: Number(stats?.hlsBufferedAheadSeconds) || 0,
      buffering: Boolean(state.isBuffering),
      // hls.js switches between the stream's own variants by itself.
      adaptive: stats?.adaptsWithinStream === true,
    };
    networkState.lastSample = sample;
    diagnoseNetwork(meta, stats, sample);
    notePlaybackDiagnostics({ network: { ...sample, at: new Date().toISOString() }, quality: quality.snapshot() });
    // Something else is already replacing this stream.
    if (qualityRequest || sessionRestartState.pending || sessionRestartState.transitionPending || streamRecoveryPending() || playbackRecoveryState.retryTimer) return;
    if (state.playbackIntent !== "playing" && !sample.buffering) return;
    // A new stream ends the system's fullscreen player (iPhone): a step up
    // waits until the owner is back; a stall still steps down.
    if (player.nativeFullscreen && !sample.buffering) return;
    const decision = quality.observe(sample);
    if (decision) {
      qualityRequest = requestQualityChange(player, decision, sample).finally(() => {
        qualityRequest = null;
      });
    }
  };
  networkMonitorInterval = setInterval(tick, NETWORK_MONITOR_INTERVAL_MS);
}

// Why playback stalls, for the logs: once per stall that lasts 8 seconds.
function diagnoseNetwork(meta, stats, sample) {
  if (!sample.buffering) {
    networkState.bufferingSince = 0;
    networkState.diagnosed = false;
    return;
  }
  networkState.bufferingSince ||= performance.now();
  const bufferingMs = performance.now() - networkState.bufferingSince;
  if (networkState.diagnosed || bufferingMs < DIAGNOSE_AFTER_BUFFERING_MS) return;
  const profile = meta.streamProfile || {};
  const requiredKbps = Math.round(((Number(profile.videoKbps) || 0) + (Number(profile.audioKbps) || 0)) * REQUIRED_HEADROOM) || null;
  const failures = (Number(stats?.hlsTimeoutCount) || 0) + (Number(stats?.hlsFailureCount) || 0) + (Number(stats?.hlsRetryWaitingSegments) || 0);
  let diagnosis = null;
  if (requiredKbps && sample.sampleCount >= 2 && sample.throughputKbps && sample.throughputKbps < requiredKbps) diagnosis = "bandwidth_insufficient";
  else if (failures && sample.bufferedAheadSeconds < 2) diagnosis = "network_unstable";
  if (!diagnosis) return;
  networkState.diagnosed = true;
  notePlaybackDiagnostics({}, { event: { type: diagnosis, availableKbps: sample.throughputKbps || null, requiredKbps } });
  postPlayerRuntimeLog(diagnosis, {
    bufferingMs: Math.round(bufferingMs),
    availableKbps: sample.throughputKbps || null,
    requiredKbps,
    sampleCount: sample.sampleCount,
    bufferedAheadSeconds: sample.bufferedAheadSeconds,
    quality: quality.snapshot(),
  });
}

// A stream of the same item at another bitrate, from where playback is
// now. The current stream keeps playing until the new one arrives (a
// `load` with reason "quality", main.js).
async function requestQualityChange(player, decision, sample) {
  const playing = state.sessionId;
  const source = state.source;
  notePlaybackDiagnostics({}, { event: { type: "quality_change_requested", ...decision }, now: true });
  postPlayerRuntimeLog("quality_change_requested", {
    ...decision,
    bufferedAheadSeconds: sample.bufferedAheadSeconds,
    sampleCount: sample.sampleCount,
    buffering: sample.buffering,
  });
  if (!source || !playing) {
    quality.abandon();
    return;
  }
  try {
    const result = await requestStream(() => {
      if (state.sessionId !== playing || state.player !== player) return null;
      return buildFreshPlaybackSessionRequest({ meta: { source, sessionId: replacedStream() } }, getReportedCurrentTime(player), {
        autoplay: state.playbackIntent === "playing",
        reason: "quality",
        maxVideoKbps: decision.maxVideoKbps,
      })?.body ?? null;
    }, { label: "Quality", reason: "quality" });
    if (result === null) quality.abandon();
  } catch (error) {
    quality.abandon();
    postPlayerRuntimeLog("quality_change_failed", { error: error?.message || String(error), code: error?.code || null });
  }
}

function isRecoverablePlaybackError(error) {
  // Any failure of a stream with a path below its own: that path may play
  // what this one did not.
  if (error?.pathFallback === true) return true;
  if (error?.code === "UPSTREAM_ACCESS_DENIED" || error?.code === "MEDIA_UNSUPPORTED") return false;
  // Asking Yolo for a fresh stream already retried what can heal by itself
  // (stream-requests.js). Only a lost network or realtime connection is
  // worth another round later: the car can be offline for minutes.
  if (error?.code === STREAM_REQUEST_FAILED) return error.network === true || error.apiCode === "realtime_unavailable";
  if ([
    "SESSION_EXPIRED",
    "HLS_SEGMENT_FETCH_FAILED",
    "HLS_SEGMENT_INACTIVITY",
    "SEEK_FAILED",
    "SEEK_STALLED",
    "RECOVERY_NOT_CONFIRMED",
    // The <video> engine's: a network error, a stall without data, or a
    // decode error, all healed by a new stream.
    "MEDIA_NETWORK_ERROR",
    "MEDIA_STALLED",
    "MEDIA_DECODE_ERROR",
  ].includes(error?.code)) {
    return true;
  }
  const message = error?.message || String(error || "");
  return /demux error|decod|encodingerror|network|fetch|timeout|connection|video.*(stall|frozen)|stream.*(closed|ended)/i.test(message);
}

function markPlaybackStable(player) {
  if (playbackRecoveryState.stableTimer) clearTimeout(playbackRecoveryState.stableTimer);
  playbackRecoveryState.stableTimer = setTimeout(() => {
    playbackRecoveryState.stableTimer = null;
    if (state.player !== player || !state.isPlaying) return;
    playbackRecoveryState.attempts = 0;
    postPlayerRuntimeLog("playback_recovery_stable", {
      currentTime: getReportedCurrentTime(player),
    });
  }, PLAYER_RECOVERY_STABLE_MS);
}

function confirmPlaybackRecovery(player, currentTime) {
  const pending = playbackRecoveryState.pendingConfirmation;
  if (!pending || state.player !== player || player === pending.previousPlayer) return false;
  const status = player.getStatus?.();
  const pausedReady = state.playbackIntent === "paused" && status === "paused";
  if (!pausedReady && status !== "playing") return false;
  const stats = summarizePlayerStats(player);
  const hasVideo = Boolean(stats?.videoCodec);
  const presentationTime = hasVideo
    ? Number(stats?.videoCurrentTimeMs) / 1000
    : currentTime;
  if (!Number.isFinite(presentationTime)) return false;
  if (!pausedReady && !Number.isFinite(pending.baselineTime)) {
    pending.baselineTime = presentationTime;
    return false;
  }
  if (!pausedReady && !hasRecoveryPlaybackProgress({
    status,
    baselineTime: pending.baselineTime,
    currentTime: presentationTime,
    hasVideo,
    videoFrameRenderCount: stats?.videoFrameRenderCount,
  })) return false;

  if (playbackRecoveryState.confirmationTimer) {
    clearTimeout(playbackRecoveryState.confirmationTimer);
    playbackRecoveryState.confirmationTimer = null;
  }
  playbackRecoveryState.pendingConfirmation = null;
  postPlayerRuntimeLog("playback_recovery_confirmed", {
    attempt: pending.attempt,
    requestedStartTime: pending.startTime,
    baselineTime: pending.baselineTime,
    currentTime,
    presentationTime,
  });
  if (pausedReady) playbackRecoveryState.attempts = 0;
  else markPlaybackStable(player);
  return true;
}

function armPlaybackRecoveryConfirmation(attempt, startTime, previousPlayer) {
  if (playbackRecoveryState.confirmationTimer) {
    clearTimeout(playbackRecoveryState.confirmationTimer);
  }
  playbackRecoveryState.pendingConfirmation = {
    attempt,
    startTime,
    baselineTime: null,
    previousPlayer,
  };
  playbackRecoveryState.confirmationTimer = setTimeout(() => {
    playbackRecoveryState.confirmationTimer = null;
    const pending = playbackRecoveryState.pendingConfirmation;
    if (!pending || pending.attempt !== attempt) return;
    playbackRecoveryState.pendingConfirmation = null;
    const error = new Error(`recovery session made no playback progress for ${PLAYER_RECOVERY_CONFIRM_TIMEOUT_MS}ms`);
    error.code = "RECOVERY_NOT_CONFIRMED";
    postPlayerRuntimeLog("playback_recovery_unconfirmed", {
      attempt,
      startTime,
      playerStatus: state.player?.getStatus?.() || null,
      playerStats: summarizePlayerStats(state.player),
    });
    schedulePlaybackRecovery(state.player, error, { startTime: getPlaybackRecoveryPosition(state.player) });
  }, PLAYER_RECOVERY_CONFIRM_TIMEOUT_MS);
  confirmPlaybackRecovery(state.player, getReportedCurrentTime());
}

const STREAM_REQUEST_FAILED = "STREAM_REQUEST_FAILED";

// Ask Yolo for a new stream of the current item (the source resolves it
// again, so expired URLs and dropped transcodes are replaced). The stream
// arrives as a `load` message. The request waits until the realtime channel
// is welcomed, joins a recovery already on its way (the welcome after a wake
// may have started one), and retries what can heal (stream-requests.js).
// Returns false without a source, "skipped" when the stream to replace is
// gone already, true once Yolo accepted; `accepted` hears the Hub's new
// session then. `startTime` may be a function, read when the request goes.
// The request replaces the stream on screen (the one in `request`), or the
// one Yolo built in its place whose `load` never came (replacedStream());
// it goes only while that stream is still on screen.
async function requestFreshPlaybackSession(request, startTime, {
  label = "Playback recovery",
  recovery = true,
  reason,
  accepted = () => {},
} = {}) {
  if (!request?.meta?.source) return false;
  const playing = request.meta.sessionId ?? null;
  let result;
  try {
    result = await requestStream(() => {
      // Built once the channel is ready: the intent may have changed, and
      // another stream may have replaced this one meanwhile.
      if (state.sessionId !== playing) return null;
      const replaces = replacedStream();
      const at = typeof startTime === "function" ? startTime() : startTime;
      return buildFreshPlaybackSessionRequest({ ...request, meta: { ...request.meta, sessionId: replaces } }, at, {
        autoplay: state.playbackIntent === "playing",
        recovery,
        reason,
        // The same quality as now: a seek or a recovery is no reason to go
        // back to a bitrate that stalled. In place of a stream whose `load`
        // never came, what this screen asked for last, which Yolo keeps:
        // that stream may have been a quality change.
        maxVideoKbps: replaces === playing ? quality.requestCap() : undefined,
      })?.body ?? null;
    }, { label, reason: reason || (recovery ? "recovery" : "seek") });
  } catch (error) {
    // Another stream replaced this one first (a quality change, a seek, an
    // agent's play): its `load` is on the way over the realtime connection,
    // which the request pinged (playback.js), so there is nothing to
    // recover here.
    if (error?.code === "superseded") return "skipped";
    const failure = new Error(`${label} could not create a fresh stream: ${error.message}`, { cause: error });
    failure.code = STREAM_REQUEST_FAILED;
    failure.apiCode = error?.code || null;
    failure.network = error?.network === true || isNetworkFailure(error);
    throw failure;
  }
  if (result === null) return "skipped";
  if (result?.state?.sessionId) accepted(result.state.sessionId);
  return true;
}

function schedulePlaybackRecovery(player, error, { startTime: requestedStartTime } = {}) {
  const playerIsCurrent = player ? state.player === player : !state.player;
  if (playerIsCurrent && player && sessionRestartState.pending) {
    postPlayerRuntimeLog("playback_recovery_deferred_for_seek", {
      error: error?.message || String(error),
      targetTime: state.currentTime,
    });
    return true;
  }
  if (playerIsCurrent) notePathFailure(error);
  if (!playerIsCurrent || !playbackRecoveryState.request || !isRecoverablePlaybackError(error)) {
    return false;
  }
  if (playbackRecoveryState.retryTimer) return true;
  // A fresh stream is already being asked for (from here, or from the
  // welcome after a wake); a second request would supersede it.
  if (streamRecoveryPending()) {
    postPlayerRuntimeLog("playback_recovery_joined", { error: error?.message || String(error), code: error?.code || null });
    return true;
  }

  if (playbackRecoveryState.confirmationTimer) {
    clearTimeout(playbackRecoveryState.confirmationTimer);
    playbackRecoveryState.confirmationTimer = null;
  }
  playbackRecoveryState.pendingConfirmation = null;

  if (playbackRecoveryState.stableTimer) {
    clearTimeout(playbackRecoveryState.stableTimer);
    playbackRecoveryState.stableTimer = null;
  }
  const attempt = playbackRecoveryState.attempts + 1;
  const delayMs = playbackRecoveryDelayMs(attempt);
  const fallbackStartTime = getPlaybackRecoveryPosition(player);
  const startTime = Number.isFinite(requestedStartTime)
    ? Math.max(0, Math.min(state.duration || Infinity, requestedStartTime))
    : fallbackStartTime;
  // Nothing is left to play there: the item is over, as if it had ended
  // (Agent Note 2026-10-12-retry-at-stream-end). Yolo moves to the queue's
  // next item or stops; a stream at the end would wait forever.
  if (player && hasNothingLeftToPlay(startTime, state.duration, { isLive: state.isLive })) {
    postPlayerRuntimeLog("playback_recovery_finished", { error: error?.message || String(error), code: error?.code || null, startTime });
    clearSeekWatchdog();
    player.pause?.().catch(() => {});
    finishPlayback(player);
    return true;
  }
  playbackRecoveryState.attempts = attempt;
  clearSeekWatchdog();
  state.isPlaying = false;
  player?.pause?.().catch(() => {});
  // The last picture stays, with a spinner: no text, however many tries.
  showRecovering(player);
  postPlayerRuntimeLog("playback_recovery_scheduled", {
    error: error?.message || String(error),
    code: error?.code || null,
    attempt,
    delayMs,
    startTime,
  });

  const runRecovery = async () => {
    playbackRecoveryState.retryTimer = null;
    // A quality change already on its way may replace the stream.
    if (qualityRequest) await qualityRequest;
    if (player ? state.player !== player : state.player) return;
    const request = playbackRecoveryState.request;
    if (!request) return;
    try {
      const requested = await requestFreshPlaybackSession(request, startTime);
      if (requested === "skipped") {
        postPlayerRuntimeLog("playback_recovery_skipped", { attempt, startTime, sessionId: state.sessionId });
        return;
      }
      if (requested) {
        armPlaybackRecoveryConfirmation(attempt, startTime, player);
        return;
      }
      await play(request.url, request.title, {
        ...request.meta,
        startTime,
        __recovery: true,
      });
    } catch (recoveryError) {
      postPlayerRuntimeLog("playback_recovery_attempt_failed", {
        error: recoveryError?.message || String(recoveryError),
        code: recoveryError?.apiCode || recoveryError?.code || null,
        attempt,
        startTime,
      });
      if (!schedulePlaybackRecovery(state.player, recoveryError, { startTime })) {
        showPlaybackError(recoveryError);
      }
    }
  };
  playbackRecoveryState.retryTimer = setTimeout(runRecovery, delayMs);
  return true;
}

function createStutterTelemetryState() {
  return {
    nextSeq: 1,
    writeIndex: 0,
    lastReportedSeq: 0,
    playbackStartedAt: 0,
    lastMemorySampleAt: 0,
    memoryBaselineUsedJSHeapSize: 0,
    pendingStallStartedAt: 0,
    pendingStallPlaybackPosition: 0,
    memorySnapshot: {
      timestamp: 0,
      usedJSHeapSize: 0,
      totalJSHeapSize: 0,
      jsHeapSizeLimit: 0,
      heapGrowthBytes: 0,
    },
  };
}

function createDecodeHealthState() {
  return {
    lastJankReportAt: 0,
  };
}

function createPlayerRuntimeLogState() {
  return {
    playbackSessionId: 0,
    frameCount: 0,
    jankCount: 0,
    lastHeartbeatFrameCount: 0,
    lastHeartbeatJankCount: 0,
    lastDecodePath: null,
    networkTimingInstalled: false,
    observedResourceKeys: new Set(),
  };
}

function resetPlayerMetrics() {
  playerMetricsState.stallCount = 0;
  playerMetricsState.totalStallDurationMs = 0;
  playerMetricsState.stallStartedAt = 0;
  playerMetricsState.decodePath = currentEngine.decodePath;
  playerMetricsState.lastVideoCurrentTimeMs = 0;
  playerMetricsState.lastVideoProgressAt = 0;
  playerMetricsState.freezeRecoveryTriggered = false;
}

function resetStutterTelemetry() {
  stutterTelemetryState.lastReportedSeq = stutterTelemetryState.nextSeq - 1;
  stutterTelemetryState.playbackStartedAt = performance.now();
  stutterTelemetryState.lastMemorySampleAt = 0;
  stutterTelemetryState.memoryBaselineUsedJSHeapSize = 0;
  stutterTelemetryState.pendingStallStartedAt = 0;
  stutterTelemetryState.pendingStallPlaybackPosition = 0;
  stutterTelemetryState.memorySnapshot.timestamp = 0;
  stutterTelemetryState.memorySnapshot.usedJSHeapSize = 0;
  stutterTelemetryState.memorySnapshot.totalJSHeapSize = 0;
  stutterTelemetryState.memorySnapshot.jsHeapSizeLimit = 0;
  stutterTelemetryState.memorySnapshot.heapGrowthBytes = 0;
}

function resetDecodeHealthState() {
  decodeHealthState.lastJankReportAt = 0;
}

function resetPlayerRuntimeLogState() {
  playerRuntimeLogState.frameCount = 0;
  playerRuntimeLogState.jankCount = 0;
  playerRuntimeLogState.lastHeartbeatFrameCount = 0;
  playerRuntimeLogState.lastHeartbeatJankCount = 0;
  playerRuntimeLogState.lastDecodePath = null;
}

function recordStutterEvent(type, fields = {}) {
  const slot = stutterEventBuffer[stutterTelemetryState.writeIndex];
  slot.seq = stutterTelemetryState.nextSeq++;
  slot.type = type;
  slot.timestamp = fields.timestamp ?? Date.now();
  slot.playbackPosition = fields.playbackPosition ?? getReportedCurrentTime() ?? 0;
  slot.durationMs = fields.durationMs ?? 0;
  slot.stallStartedAt = fields.stallStartedAt ?? 0;
  slot.usedJSHeapSize = fields.usedJSHeapSize ?? 0;
  slot.totalJSHeapSize = fields.totalJSHeapSize ?? 0;
  slot.jsHeapSizeLimit = fields.jsHeapSizeLimit ?? 0;
  slot.heapGrowthBytes = fields.heapGrowthBytes ?? 0;
  stutterTelemetryState.writeIndex = (stutterTelemetryState.writeIndex + 1) % STUTTER_EVENT_CAPACITY;
}

// Stalls of the last half hour, across streams of the same item (a quality
// change or a recovery starts a new stream), for the reports' `health`.
const RECENT_STALLS_KEPT_MS = 30 * 60_000;
let recentStalls = [];
let recentStallsItem = null;
const playingItem = () => (state.source ? `${state.source.plugin}:${state.source.id}` : null);

// This item's recent stalls; another item starts with none.
function stallsOfThisItem() {
  if (recentStallsItem !== playingItem()) {
    recentStalls = [];
    recentStallsItem = playingItem();
  }
  return recentStalls;
}

function beginStall() {
  if (playerMetricsState.stallStartedAt) return;
  playerMetricsState.stallCount += 1;
  playerMetricsState.stallStartedAt = performance.now();
  recentStalls = [...stallsOfThisItem().filter((stall) => performance.now() - stall.startedAt < RECENT_STALLS_KEPT_MS), { startedAt: performance.now(), endedAt: 0 }].slice(-10);
  postPlayerRuntimeLog("stall_start", {
    buffer: collectBufferState(),
    memory: memorySnapshotForLog(false),
  });
  if (!stutterTelemetryState.pendingStallStartedAt) {
    stutterTelemetryState.pendingStallStartedAt = Date.now();
    stutterTelemetryState.pendingStallPlaybackPosition = getReportedCurrentTime();
  }
}

function endStall() {
  if (!playerMetricsState.stallStartedAt) return;
  const stallDurationMs = performance.now() - playerMetricsState.stallStartedAt;
  const open = recentStalls.at(-1);
  if (open && !open.endedAt) open.endedAt = performance.now();
  playerMetricsState.totalStallDurationMs += stallDurationMs;
  playerMetricsState.stallStartedAt = 0;
  postPlayerRuntimeLog("stall_end", {
    durationMs: Math.round(stallDurationMs),
    buffer: collectBufferState(),
    memory: memorySnapshotForLog(false),
  });
  if (stutterTelemetryState.pendingStallStartedAt) {
    recordStutterEvent("buffering_stall", {
      playbackPosition: stutterTelemetryState.pendingStallPlaybackPosition,
      stallStartedAt: stutterTelemetryState.pendingStallStartedAt,
      durationMs: stallDurationMs,
    });
    stutterTelemetryState.pendingStallStartedAt = 0;
    stutterTelemetryState.pendingStallPlaybackPosition = 0;
    queueStutterTelemetryReport("stall");
  }
}

function getPlaybackState() {
  if (!state.player) return "idle";
  if (state.isBuffering) return "buffering";
  return state.isPlaying ? "playing" : "paused";
}

function toMetricSeconds(value) {
  if (typeof value === "bigint") return Number(value) / 1000;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const maxKnownSeconds = Math.max(state.duration || 0, state.currentTime || 0);
  return value > maxKnownSeconds + 120 ? value / 1000 : value;
}

function normalizeBufferedSeconds(value) {
  if (value == null) return null;

  if (typeof value === "number" || typeof value === "bigint") {
    const endSeconds = toMetricSeconds(value);
    return endSeconds == null ? null : Math.max(0, endSeconds - state.currentTime);
  }

  if (Array.isArray(value)) {
    for (const range of value) {
      const normalized = normalizeBufferedSeconds(range);
      if (normalized != null) return normalized;
    }
    return null;
  }

  if (typeof value.length === "number" && typeof value.start === "function" && typeof value.end === "function") {
    for (let i = 0; i < value.length; i++) {
      const start = toMetricSeconds(value.start(i));
      const end = toMetricSeconds(value.end(i));
      if (start == null || end == null) continue;
      if (end >= state.currentTime && (start == null || start <= state.currentTime + 1)) {
        return Math.max(0, end - state.currentTime);
      }
    }
    return null;
  }

  if (typeof value === "object") {
    if ("hlsBufferedAheadSeconds" in value) {
      const seconds = normalizeMetricNumber(value.hlsBufferedAheadSeconds);
      return seconds == null ? null : Math.max(0, seconds);
    }
    if ("videoBufferedMs" in value) {
      const milliseconds = normalizeMetricNumber(value.videoBufferedMs);
      if (milliseconds != null) return Math.max(0, milliseconds / 1000);
    }
    for (const key of ["bufferHealthSeconds", "bufferedSeconds", "bufferedDuration", "seconds"]) {
      if (!(key in value)) continue;
      const seconds = normalizeMetricNumber(value[key]);
      return seconds == null ? null : Math.max(0, seconds);
    }
    if ("end" in value) {
      const end = toMetricSeconds(value.end);
      const start = "start" in value ? toMetricSeconds(value.start) : state.currentTime;
      if (end == null) return null;
      return Math.max(0, end - Math.max(start ?? state.currentTime, state.currentTime));
    }
  }

  return null;
}

function readBufferHealthSeconds(player) {
  const readers = [
    () => player?.getBuffered?.(),
    () => player?.getBufferedEnd?.(),
    () => player?.getBufferRange?.(),
    () => player?.getStats?.(),
    () => player?.buffered,
    () => player?.video?.buffered,
    () => player?.videoElement?.buffered,
  ];

  for (const read of readers) {
    try {
      const bufferedSeconds = normalizeBufferedSeconds(read());
      if (bufferedSeconds != null) return bufferedSeconds;
    } catch {}
  }

  return null;
}

function normalizeDroppedFrames(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "object") {
    for (const key of ["videoFrameDropCount", "droppedFrames", "droppedVideoFrames", "dropped", "droppedCount"]) {
      if (key in value) return normalizeDroppedFrames(value[key]);
    }
  }
  return null;
}

function readDroppedFrames(player) {
  const readers = [
    () => player?.getDroppedFrames?.(),
    () => player?.getStats?.(),
    () => player?.getVideoPlaybackQuality?.(),
    () => player?.video?.getVideoPlaybackQuality?.(),
    () => player?.videoElement?.getVideoPlaybackQuality?.(),
  ];

  for (const read of readers) {
    try {
      const droppedFrames = normalizeDroppedFrames(read());
      if (droppedFrames != null) return droppedFrames;
    } catch {}
  }

  return null;
}

function normalizeDurationMs(value) {
  if (typeof value === "bigint") value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value > 120) return value;
  return value * 1000;
}

function normalizeAudioBufferedMs(value) {
  if (value == null) return null;

  if (typeof value === "number" || typeof value === "bigint") {
    return normalizeDurationMs(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const bufferedAudioMs = normalizeAudioBufferedMs(item);
      if (bufferedAudioMs != null) return bufferedAudioMs;
    }
    return null;
  }

  if (typeof value === "object") {
    if ("audio" in value) {
      const nestedBufferedAudioMs = normalizeAudioBufferedMs(value.audio);
      if (nestedBufferedAudioMs != null) return nestedBufferedAudioMs;
    }
    for (const key of [
      "audioBufferMs",
      "audioBufferedMs",
      "audioBufferDurationMs",
      "audioBufferSeconds",
      "audioBufferedSeconds",
      "audioBufferHealthSeconds",
      "bufferedAudioSeconds",
      "bufferedAudioMs",
      "bufferHealthSeconds",
    ]) {
      if (key in value) {
        const bufferedAudioMs = normalizeAudioBufferedMs(value[key]);
        if (bufferedAudioMs != null) return bufferedAudioMs;
      }
    }
  }

  return null;
}

function normalizeUnderrunCount(value) {
  if (typeof value === "bigint") value = Number(value);
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "object" && value) {
    if ("audio" in value) {
      const nestedUnderrunCount = normalizeUnderrunCount(value.audio);
      if (nestedUnderrunCount != null) return nestedUnderrunCount;
    }
    for (const key of [
      "audioStutter",
      "audioUnderrunCount",
      "audioUnderflowCount",
      "underrunCount",
      "underflowCount",
      "underruns",
      "underflows",
    ]) {
      if (key in value) {
        const underrunCount = normalizeUnderrunCount(value[key]);
        if (underrunCount != null) return underrunCount;
      }
    }
  }
  return null;
}

function readAudioBufferStats(player) {
  const readers = [
    () => player?.getAudioStats?.(),
    () => player?.getStats?.(),
    () => player?.AudioPipelineProxy?.AudioRenderPipeline?.getStats?.(),
    () => player?.audio?.getStats?.(),
  ];

  let bufferedAudioMs = null;
  let underrunCount = null;

  for (const read of readers) {
    let stats;
    try {
      stats = read();
    } catch {
      continue;
    }
    if (stats == null) continue;

    if (bufferedAudioMs == null) bufferedAudioMs = normalizeAudioBufferedMs(stats);
    if (underrunCount == null) underrunCount = normalizeUnderrunCount(stats);
    if (bufferedAudioMs != null && underrunCount != null) break;
  }

  return { bufferedAudioMs, underrunCount };
}

function memorySnapshotForLog(force = true) {
  const snapshot = sampleMemoryUsage(performance.now(), force);
  const pageMemory = pageMemoryMonitor.lastSample;
  if (!snapshot && !pageMemory && !pageMemoryMonitor.supported) {
    return {
      pageMemorySupported: false,
      pageMemoryUnavailableReason: pageMemoryMonitor.unavailableReason,
    };
  }
  return {
    timestamp: snapshot?.timestamp ?? null,
    usedJSHeapSize: snapshot?.usedJSHeapSize ?? null,
    totalJSHeapSize: snapshot?.totalJSHeapSize ?? null,
    jsHeapSizeLimit: snapshot?.jsHeapSizeLimit ?? null,
    heapGrowthBytes: snapshot?.heapGrowthBytes ?? null,
    pageMemorySupported: pageMemoryMonitor.supported,
    pageMemoryBytes: pageMemory?.bytes ?? null,
    pageMemoryMeasuredAt: pageMemory?.timestamp ?? null,
    pageMemorySampleAgeMs: pageMemory ? Math.max(0, Date.now() - pageMemory.timestamp) : null,
    pageMemoryMeasurementDurationMs: pageMemory?.durationMs ?? null,
    pageMemoryPlaybackSessionId: lastPageMemorySessionId,
    pageMemoryCorrelationValid: pageMemory
      ? lastPageMemoryCorrelationValid
        && lastPageMemorySessionId === playerRuntimeLogState.playbackSessionId
      : null,
  };
}

function collectBufferState(player = state.player) {
  const { bufferedAudioMs, underrunCount } = readAudioBufferStats(player);
  const stats = readPlayerStats(player);
  return {
    bufferHealthSeconds: readBufferHealthSeconds(player),
    bufferedAudioMs,
    audioUnderrunCount: underrunCount,
    hlsBufferedAheadSeconds: normalizeMetricNumber(stats?.hlsBufferedAheadSeconds),
    hlsBufferedBytes: normalizeMetricNumber(stats?.hlsBufferedBytes),
    hlsCachedSegments: normalizeMetricNumber(stats?.hlsCachedSegments),
    hlsPendingSegments: normalizeMetricNumber(stats?.hlsPendingSegments),
    hlsActiveDownloads: normalizeMetricNumber(stats?.hlsActiveDownloads),
    hlsQueuedSegments: normalizeMetricNumber(stats?.hlsQueuedSegments),
    hlsRetryWaitingSegments: normalizeMetricNumber(stats?.hlsRetryWaitingSegments),
    hlsOldestActiveDownloadMs: normalizeMetricNumber(stats?.hlsOldestActiveDownloadMs),
    hlsNetworkRetryCount: normalizeMetricNumber(stats?.hlsNetworkRetryCount),
    hlsTimeoutCount: normalizeMetricNumber(stats?.hlsTimeoutCount),
    hlsFailureCount: normalizeMetricNumber(stats?.hlsFailureCount),
    hlsLastFailure: stats?.hlsLastFailure && typeof stats.hlsLastFailure === "object"
      ? stats.hlsLastFailure
      : null,
    hlsBufferMaxBytes: normalizeMetricNumber(stats?.hlsBufferMaxBytes),
    hlsBufferTargetSeconds: normalizeMetricNumber(stats?.hlsBufferTargetSeconds),
    hlsBufferCacheUtilization: safeRound(normalizeMetricNumber(stats?.hlsBufferCacheUtilization)),
    hlsPeakBufferedBytes: normalizeMetricNumber(stats?.hlsPeakBufferedBytes),
    hlsPeakBufferedAheadSeconds: normalizeMetricNumber(stats?.hlsPeakBufferedAheadSeconds),
    hlsManagedBytesEstimate: normalizeMetricNumber(stats?.hlsManagedBytesEstimate),
    hlsPeakManagedBytesEstimate: normalizeMetricNumber(stats?.hlsPeakManagedBytesEstimate),
    hlsBufferByteCapHitCount: normalizeMetricNumber(stats?.hlsBufferByteCapHitCount),
  };
}

async function maybeMeasurePageMemory() {
  if (!pageMemoryMonitor.supported) {
    if (!pageMemoryCapabilityLogged) {
      pageMemoryCapabilityLogged = true;
      postPlayerRuntimeLog("page_memory_measurement_unavailable", {
        reason: pageMemoryMonitor.unavailableReason,
        crossOriginIsolated: globalThis.crossOriginIsolated === true,
      });
    }
    return;
  }

  const measurementSessionId = playerRuntimeLogState.playbackSessionId;
  const measurementPlayer = state.player;
  try {
    const sample = await pageMemoryMonitor.measure();
    if (!sample) return;
    const correlationValid = measurementSessionId === playerRuntimeLogState.playbackSessionId
      && measurementPlayer === state.player;
    lastPageMemorySessionId = measurementSessionId;
    lastPageMemoryCorrelationValid = correlationValid;
    if (!correlationValid) pageMemoryMonitor.allowNextMeasurement();
    lastPageMemoryError = null;
    postPlayerRuntimeLog("page_memory_measurement", {
      measurementPlaybackSessionId: measurementSessionId,
      correlationValid,
      memory: sample,
      buffer: correlationValid ? collectBufferState(measurementPlayer) : null,
      playerStats: correlationValid ? summarizePlayerStats(measurementPlayer) : null,
      totalStallCount: correlationValid ? playerMetricsState.stallCount : null,
      totalStallDurationMs: correlationValid ? Math.round(playerMetricsState.totalStallDurationMs) : null,
    });
  } catch (error) {
    const message = error?.message || String(error);
    if (message === lastPageMemoryError) return;
    lastPageMemoryError = message;
    postPlayerRuntimeLog("page_memory_measurement_failed", {
      error: message,
      measurementPlaybackSessionId: measurementSessionId,
    });
  }
}

// Runtime events: a ring buffer for diagnostics (globalThis.__yoloPlayerLog),
// debug console lines, and device events sent to Yolo's logs
// (telemetry/device-events.js, which drops secrets and media tokens).
const runtimeLog = [];
globalThis.__yoloPlayerLog = runtimeLog;

function postPlayerRuntimeLog(type, fields = {}) {
  const payload = {
    type,
    timestamp: Date.now(),
    playbackPosition: Number(getReportedCurrentTime().toFixed(3)),
    playbackState: getPlaybackState(),
    duration: state.duration || 0,
    isPlaying: !!state.isPlaying,
    isBuffering: !!state.isBuffering,
    playbackSessionId: playerRuntimeLogState.playbackSessionId,
    ...fields,
  };
  runtimeLog.push(payload);
  if (runtimeLog.length > RUNTIME_LOG_CAPACITY) runtimeLog.shift();
  console.debug("[player]", type, payload);
  recordDeviceEvent(type, payload);
}

// How long a wake (the car, or the page, coming back from sleep) took until
// the picture moved again: the first report after the wake is the baseline,
// and playback a second past it counts.
let wakeBaseline = null;

function noteWakeProgress() {
  const events = deviceEvents();
  const wake = events.wakePending;
  if (!wake) {
    wakeBaseline = null;
    return;
  }
  const position = getReportedCurrentTime();
  if (!wakeBaseline || wakeBaseline.at !== wake.at) {
    wakeBaseline = { at: wake.at, position };
    return;
  }
  if (state.isPlaying && !state.isBuffering && position > wakeBaseline.position + 1) {
    events.markPlaybackRestored({ position: Number(position.toFixed(1)), baselinePosition: Number(wakeBaseline.position.toFixed(1)) });
    wakeBaseline = null;
  }
}

function isPlayerMediaResourceUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url, location.origin);
    const path = parsed.pathname;
    return path.startsWith("/m/")
      || /\.(m4s|mp4|m3u8|mpd|ts)(\?|$)/i.test(`${path}${parsed.search}`);
  } catch {
    return false;
  }
}

function logSlowPlayerFetch(url, durationMs, fields = {}) {
  if (durationMs <= SLOW_SEGMENT_FETCH_MS || !isPlayerMediaResourceUrl(url)) return;
  postPlayerRuntimeLog("network_segment_slow", {
    url,
    durationMs: Math.round(durationMs),
    ...fields,
  });
}

function installPlayerNetworkTiming() {
  if (playerRuntimeLogState.networkTimingInstalled || !originalFetch) return;
  playerRuntimeLogState.networkTimingInstalled = true;

  globalThis.fetch = async (...args) => {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    const startedAt = performance.now();
    try {
      const response = await originalFetch(...args);
      logSlowPlayerFetch(url, performance.now() - startedAt, {
        observer: "fetch",
        status: response.status,
        contentLength: Number(response.headers?.get?.("content-length")) || null,
      });
      return response;
    } catch (error) {
      if (isPlayerMediaResourceUrl(url)) {
        postPlayerRuntimeLog("network_segment_fetch_error", {
          url,
          durationMs: Math.round(performance.now() - startedAt),
          error: error.message || String(error),
        });
      }
      throw error;
    }
  };

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!isPlayerMediaResourceUrl(entry.name) || entry.duration <= SLOW_SEGMENT_FETCH_MS) continue;
        const key = `${entry.name}:${entry.startTime}`;
        if (playerRuntimeLogState.observedResourceKeys.has(key)) continue;
        playerRuntimeLogState.observedResourceKeys.add(key);
        if (playerRuntimeLogState.observedResourceKeys.size > 500) {
          playerRuntimeLogState.observedResourceKeys.clear();
        }
        postPlayerRuntimeLog("network_segment_slow", {
          observer: "performance-resource",
          url: entry.name,
          durationMs: Math.round(entry.duration),
          transferSize: entry.transferSize || 0,
          encodedBodySize: entry.encodedBodySize || 0,
          decodedBodySize: entry.decodedBodySize || 0,
        });
      }
    });
    try {
      observer.observe({ type: "resource", buffered: true });
    } catch {
      observer.observe({ entryTypes: ["resource"] });
    }
  } catch {}
}

installPlayerNetworkTiming();

function normalizeMetricNumber(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function safeRound(value, digits = 3) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function readPlayerStats(player) {
  try {
    const stats = player?.getStats?.();
    return stats && typeof stats === "object" ? stats : null;
  } catch {
    return null;
  }
}

function summarizePlayerStats(player) {
  const stats = readPlayerStats(player);
  if (!stats) return null;

  const jitterBuffer = stats.jitterBuffer && typeof stats.jitterBuffer === "object"
    ? {
        minMs: normalizeMetricNumber(stats.jitterBuffer.min),
        maxMs: normalizeMetricNumber(stats.jitterBuffer.max),
      }
    : null;

  return {
    audioPacketQueueLength: normalizeMetricNumber(stats.audioPacketQueueLength),
    audioDropPacketCount: normalizeMetricNumber(stats.audioDropPacketCount),
    audioFrameDecodeCount: normalizeMetricNumber(stats.audioFrameDecodeCount),
    audioFrameRenderCount: normalizeMetricNumber(stats.audioFrameRenderCount),
    audioFrameRenderIntervalMax: normalizeMetricNumber(stats.audioFrameRenderIntervalMax),
    videoPacketQueueLength: normalizeMetricNumber(stats.videoPacketQueueLength),
    videoDropPacketCount: normalizeMetricNumber(stats.videoDropPacketCount),
    videoDecodeErrorPacketCount: normalizeMetricNumber(stats.videoDecodeErrorPacketCount),
    videoFrameDecodeCount: normalizeMetricNumber(stats.videoFrameDecodeCount),
    videoFrameRenderCount: normalizeMetricNumber(stats.videoFrameRenderCount),
    videoFrameDropCount: normalizeMetricNumber(stats.videoFrameDropCount),
    videoFrameDecodeIntervalMax: normalizeMetricNumber(stats.videoFrameDecodeIntervalMax),
    videoFrameRenderIntervalMax: normalizeMetricNumber(stats.videoFrameRenderIntervalMax),
    bandwidth: normalizeMetricNumber(stats.bandwidth),
    jitter: safeRound(normalizeMetricNumber(stats.jitter)),
    bufferReceiveBytes: normalizeMetricNumber(stats.bufferReceiveBytes),
    bufferOutputBytes: normalizeMetricNumber(stats.bufferOutputBytes),
    bufferDropBytes: normalizeMetricNumber(stats.bufferDropBytes),
    audioStutter: normalizeMetricNumber(stats.audioStutter),
    audioDiscontinuities: normalizeMetricNumber(stats.audioDiscontinuities),
    videoStutter: normalizeMetricNumber(stats.videoStutter),
    seekRequestCount: normalizeMetricNumber(stats.seekRequestCount),
    seekSupersededCount: normalizeMetricNumber(stats.seekSupersededCount),
    iteratorCloseTimeoutCount: normalizeMetricNumber(stats.iteratorCloseTimeoutCount),
    lastSeekTarget: normalizeMetricNumber(stats.lastSeekTarget),
    audioCurrentTimeMs: normalizeMetricNumber(stats.audioCurrentTime),
    audibleAudioCurrentTimeMs: normalizeMetricNumber(stats.audibleAudioCurrentTime),
    audioOutputLatencyMs: normalizeMetricNumber(stats.audioOutputLatencyMs),
    videoCurrentTimeMs: normalizeMetricNumber(stats.videoCurrentTime),
    audioNextTimeMs: normalizeMetricNumber(stats.audioNextTime),
    videoNextTimeMs: normalizeMetricNumber(stats.videoNextTime),
    audioSourceEnded: typeof stats.audioSourceEnded === "boolean" ? stats.audioSourceEnded : null,
    videoSourceEnded: typeof stats.videoSourceEnded === "boolean" ? stats.videoSourceEnded : null,
    durationDistanceMs: normalizeMetricNumber(stats.durationDistanceMs),
    audioCodec: typeof stats.audiocodec === "string" ? stats.audiocodec : null,
    videoCodec: typeof stats.videocodec === "string" ? stats.videocodec : null,
    width: normalizeMetricNumber(stats.width),
    height: normalizeMetricNumber(stats.height),
    hlsBufferedAheadSeconds: normalizeMetricNumber(stats.hlsBufferedAheadSeconds),
    hlsThroughputSampleCount: normalizeMetricNumber(stats.hlsThroughputSampleCount),
    hlsBufferedBytes: normalizeMetricNumber(stats.hlsBufferedBytes),
    hlsCachedSegments: normalizeMetricNumber(stats.hlsCachedSegments),
    hlsPendingSegments: normalizeMetricNumber(stats.hlsPendingSegments),
    hlsActiveDownloads: normalizeMetricNumber(stats.hlsActiveDownloads),
    hlsQueuedSegments: normalizeMetricNumber(stats.hlsQueuedSegments),
    hlsRetryWaitingSegments: normalizeMetricNumber(stats.hlsRetryWaitingSegments),
    hlsOldestActiveDownloadMs: normalizeMetricNumber(stats.hlsOldestActiveDownloadMs),
    hlsNetworkRetryCount: normalizeMetricNumber(stats.hlsNetworkRetryCount),
    hlsTimeoutCount: normalizeMetricNumber(stats.hlsTimeoutCount),
    hlsFailureCount: normalizeMetricNumber(stats.hlsFailureCount),
    hlsLastFailure: stats.hlsLastFailure && typeof stats.hlsLastFailure === "object"
      ? stats.hlsLastFailure
      : null,
    hlsBufferMaxBytes: normalizeMetricNumber(stats.hlsBufferMaxBytes),
    hlsBufferTargetSeconds: normalizeMetricNumber(stats.hlsBufferTargetSeconds),
    hlsBufferCacheUtilization: safeRound(normalizeMetricNumber(stats.hlsBufferCacheUtilization)),
    hlsPeakBufferedBytes: normalizeMetricNumber(stats.hlsPeakBufferedBytes),
    hlsPeakBufferedAheadSeconds: normalizeMetricNumber(stats.hlsPeakBufferedAheadSeconds),
    hlsManagedBytesEstimate: normalizeMetricNumber(stats.hlsManagedBytesEstimate),
    hlsPeakManagedBytesEstimate: normalizeMetricNumber(stats.hlsPeakManagedBytesEstimate),
    hlsBufferByteCapHitCount: normalizeMetricNumber(stats.hlsBufferByteCapHitCount),
    liveDvrStartTime: normalizeMetricNumber(stats.liveDvrStartTime),
    liveEdgeTime: normalizeMetricNumber(stats.liveEdgeTime),
    livePlayStartTime: normalizeMetricNumber(stats.livePlayStartTime),
    liveLatencyMs: normalizeMetricNumber(stats.liveLatencyMs),
    jitterBuffer,
    ...(stats.engine === "native" ? {
      engine: "native",
      mode: typeof stats.mode === "string" ? stats.mode : null,
      adaptsWithinStream: stats.adaptsWithinStream === true,
      hlsLevels: normalizeMetricNumber(stats.hlsLevels),
      hlsLevelKbps: normalizeMetricNumber(stats.hlsLevelKbps),
      timelineOffset: normalizeMetricNumber(stats.timelineOffset),
    } : {}),
  };
}

function describePlayerCanvas() {
  const canvas = container?.querySelector?.("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return null;

  return {
    width: canvas.width,
    height: canvas.height,
    clientWidth: canvas.clientWidth,
    clientHeight: canvas.clientHeight,
  };
}

// The <video> engine's picture: the decoded size and the box it fills.
function describePlayerVideo() {
  const video = container?.querySelector?.('video[data-engine="native"]');
  if (!(video instanceof HTMLVideoElement)) return null;
  return {
    width: video.videoWidth,
    height: video.videoHeight,
    clientWidth: video.clientWidth,
    clientHeight: video.clientHeight,
  };
}

const describeEnginePicture = () => (currentEngine.name === "native" ? { video: describePlayerVideo() } : {});

function describeViewport() {
  const dpr = Number(globalThis.devicePixelRatio) || 1;
  const innerWidth = Number(globalThis.innerWidth) || 0;
  const innerHeight = Number(globalThis.innerHeight) || 0;
  const visualViewport = globalThis.visualViewport;
  const physical = physicalViewport();
  return {
    innerWidth,
    innerHeight,
    devicePixelRatio: dpr,
    devicePixelWidth: Math.round(innerWidth * dpr),
    devicePixelHeight: Math.round(innerHeight * dpr),
    physicalWidth: physical.width,
    physicalHeight: physical.height,
    displayScale: globalThis.__yoloDisplayBoot?.scale ?? null,
    displayZoom: globalThis.__yoloDisplayBoot?.zoom ?? 1,
    visualViewport: visualViewport ? {
      width: Math.round(visualViewport.width * 100) / 100,
      height: Math.round(visualViewport.height * 100) / 100,
      scale: visualViewport.scale,
      offsetLeft: visualViewport.offsetLeft,
      offsetTop: visualViewport.offsetTop,
    } : null,
    screen: globalThis.screen ? {
      width: globalThis.screen.width,
      height: globalThis.screen.height,
      availWidth: globalThis.screen.availWidth,
      availHeight: globalThis.screen.availHeight,
    } : null,
  };
}

function sampleMemoryUsage(now = performance.now(), force = false) {
  if (!force && now - stutterTelemetryState.lastMemorySampleAt < STUTTER_MEMORY_SAMPLE_INTERVAL_MS) {
    return stutterTelemetryState.memorySnapshot.timestamp ? stutterTelemetryState.memorySnapshot : null;
  }

  const memory = performance?.memory;
  stutterTelemetryState.lastMemorySampleAt = now;
  if (!memory) return null;

  const usedJSHeapSize = Number(memory.usedJSHeapSize) || 0;
  const totalJSHeapSize = Number(memory.totalJSHeapSize) || 0;
  const jsHeapSizeLimit = Number(memory.jsHeapSizeLimit) || 0;
  const previousBaseline = stutterTelemetryState.memoryBaselineUsedJSHeapSize;
  const heapGrowthBytes = previousBaseline > 0 ? usedJSHeapSize - previousBaseline : 0;
  const snapshot = stutterTelemetryState.memorySnapshot;

  snapshot.timestamp = Date.now();
  snapshot.usedJSHeapSize = usedJSHeapSize;
  snapshot.totalJSHeapSize = totalJSHeapSize;
  snapshot.jsHeapSizeLimit = jsHeapSizeLimit;
  snapshot.heapGrowthBytes = heapGrowthBytes;

  if (!previousBaseline || usedJSHeapSize < previousBaseline * 0.9) {
    stutterTelemetryState.memoryBaselineUsedJSHeapSize = usedJSHeapSize;
  } else if (
    heapGrowthBytes >= MEMORY_PRESSURE_GROWTH_BYTES
    && heapGrowthBytes / Math.max(previousBaseline, 1) >= MEMORY_PRESSURE_GROWTH_RATIO
  ) {
    recordStutterEvent("memory_pressure", {
      usedJSHeapSize,
      totalJSHeapSize,
      jsHeapSizeLimit,
      heapGrowthBytes,
    });
    stutterTelemetryState.memoryBaselineUsedJSHeapSize = usedJSHeapSize;
  }

  return snapshot;
}

function serializeStutterEvent(slot) {
  const event = {
    type: slot.type,
    timestamp: slot.timestamp,
    playbackPosition: Number(slot.playbackPosition.toFixed(3)),
  };

  if (slot.type === "buffering_stall") {
    event.startTime = slot.stallStartedAt;
    event.durationMs = Math.round(slot.durationMs);
  }
  if (slot.type === "memory_pressure") {
    event.usedJSHeapSize = slot.usedJSHeapSize;
    event.totalJSHeapSize = slot.totalJSHeapSize;
    event.jsHeapSizeLimit = slot.jsHeapSizeLimit;
    event.heapGrowthBytes = slot.heapGrowthBytes;
  }
  if (slot.type === "long_task") {
    event.durationMs = Math.round(slot.durationMs);
  }

  return event;
}

function collectStutterEventsSinceLastReport() {
  const pending = [];
  let maxSeq = stutterTelemetryState.lastReportedSeq;

  for (const slot of stutterEventBuffer) {
    if (!slot.seq || slot.seq <= stutterTelemetryState.lastReportedSeq) continue;
    pending.push(slot);
    if (slot.seq > maxSeq) maxSeq = slot.seq;
  }

  pending.sort((a, b) => a.seq - b.seq);

  return {
    events: pending.map(serializeStutterEvent),
    maxSeq,
  };
}

function buildStutterReportPayload(reason) {
  const memorySnapshot = memorySnapshotForLog(true);
  const { events, maxSeq } = collectStutterEventsSinceLastReport();
  const activeStallDurationMs = playerMetricsState.stallStartedAt
    ? performance.now() - playerMetricsState.stallStartedAt
    : 0;

  return {
    maxSeq,
    payload: {
      reason,
      events,
      currentTime: getReportedCurrentTime(),
      duration: state.duration,
      memory: memorySnapshot,
      buffer: collectBufferState(),
      totalStallCount: playerMetricsState.stallCount,
      totalStallDurationMs: Math.round(playerMetricsState.totalStallDurationMs + activeStallDurationMs),
      timeSincePlaybackStartedMs: Math.round(Math.max(0, performance.now() - stutterTelemetryState.playbackStartedAt)),
    },
  };
}

function clearScheduledStutterTelemetryFlush() {
  if (stutterFlushTimer) {
    clearTimeout(stutterFlushTimer);
    stutterFlushTimer = null;
  }
  if (stutterFlushIdleHandle && typeof cancelIdleCallback === "function") {
    cancelIdleCallback(stutterFlushIdleHandle);
  }
  if (stutterFlushIdleHandle) {
    stutterFlushIdleHandle = null;
  }
  scheduledStutterFlushReason = "interval";
}

// A stutter report is one runtime-log event; the events it carries are not
// reported again.
function flushStutterTelemetry(reason = "interval") {
  if (!stutterTelemetryState.playbackStartedAt) return;
  const { payload, maxSeq } = buildStutterReportPayload(reason);
  if (payload.events.length === 0 && !playerMetricsState.stallStartedAt) return;
  postPlayerRuntimeLog("stutter_report", { stutter: payload });
  stutterTelemetryState.lastReportedSeq = maxSeq;
}

function queueStutterTelemetryReport(reason = "interval") {
  if (!stutterTelemetryState.playbackStartedAt) return;
  if (reason !== "interval" || scheduledStutterFlushReason === "interval") {
    scheduledStutterFlushReason = reason;
  }
  if (stutterFlushTimer || stutterFlushIdleHandle) return;

  const runFlush = () => {
    stutterFlushTimer = null;
    stutterFlushIdleHandle = null;
    const queuedReason = scheduledStutterFlushReason;
    scheduledStutterFlushReason = "interval";
    flushStutterTelemetry(queuedReason);
  };

  if (typeof requestIdleCallback === "function") {
    stutterFlushIdleHandle = requestIdleCallback(runFlush, { timeout: STUTTER_FLUSH_IDLE_TIMEOUT_MS });
    return;
  }

  stutterFlushTimer = setTimeout(runFlush, 0);
}

function startStutterTelemetryReporting() {
  stopStutterTelemetryReporting();
  stutterReportInterval = setInterval(() => {
    queueStutterTelemetryReport("interval");
  }, STUTTER_REPORT_INTERVAL_MS);
}

function stopStutterTelemetryReporting() {
  if (stutterReportInterval) {
    clearInterval(stutterReportInterval);
    stutterReportInterval = null;
  }
  clearScheduledStutterTelemetryFlush();
}

function sendPlayerHealthHeartbeat() {
  const frameCountSinceLastHeartbeat = playerRuntimeLogState.frameCount - playerRuntimeLogState.lastHeartbeatFrameCount;
  const jankCountSinceLastHeartbeat = playerRuntimeLogState.jankCount - playerRuntimeLogState.lastHeartbeatJankCount;
  playerRuntimeLogState.lastHeartbeatFrameCount = playerRuntimeLogState.frameCount;
  playerRuntimeLogState.lastHeartbeatJankCount = playerRuntimeLogState.jankCount;
  void maybeMeasurePageMemory();

  postPlayerRuntimeLog("health_heartbeat", {
    currentTime: getReportedCurrentTime(),
    viewport: describeViewport(),
    buffer: collectBufferState(),
    frameCountSinceLastHeartbeat,
    jankCountSinceLastHeartbeat,
    memory: memorySnapshotForLog(true),
    decodePath: playerMetricsState.decodePath,
    droppedFrames: readDroppedFrames(state.player),
    // The danmaku layer since the last heartbeat: frames drawn, draw time, comments on screen.
    danmaku: danmaku.stats(),
  });
}

function startPlayerHealthHeartbeat() {
  stopPlayerHealthHeartbeat();
  playerRuntimeLogState.lastHeartbeatFrameCount = playerRuntimeLogState.frameCount;
  playerRuntimeLogState.lastHeartbeatJankCount = playerRuntimeLogState.jankCount;
  playerHealthHeartbeatInterval = setInterval(() => {
    sendPlayerHealthHeartbeat();
  }, PLAYER_HEALTH_HEARTBEAT_INTERVAL_MS);
}

function stopPlayerHealthHeartbeat() {
  if (playerHealthHeartbeatInterval) {
    clearInterval(playerHealthHeartbeatInterval);
    playerHealthHeartbeatInterval = null;
  }
}

function ensureLongTaskObserver() {
  if (longTaskObserver || typeof PerformanceObserver !== "function") return;
  const supportedEntryTypes = PerformanceObserver.supportedEntryTypes;
  if (Array.isArray(supportedEntryTypes) && !supportedEntryTypes.includes("longtask")) return;

  try {
    longTaskObserver = new PerformanceObserver((list) => {
      if (!stutterTelemetryState.playbackStartedAt) return;

      let recordedLongTask = false;
      for (const entry of list.getEntries()) {
        if (entry.duration < STUTTER_LONG_TASK_THRESHOLD_MS) continue;
        recordedLongTask = true;
        playerRuntimeLogState.jankCount += 1;
        recordStutterEvent("long_task", {
          timestamp: Math.round(performance.timeOrigin + entry.startTime),
          playbackPosition: getReportedCurrentTime(),
          durationMs: entry.duration,
        });
      }

      if (recordedLongTask) {
        queueStutterTelemetryReport("longtask");
      }
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    longTaskObserver = null;
  }
}

function detectVideoFreeze(playerStats) {
  const now = performance.now();
  const videoCurrentTimeMs = playerStats?.videoCurrentTimeMs;
  const audioCurrentTimeMs = playerStats?.audioCurrentTimeMs;
  const hasRenderedVideo = (playerStats?.videoFrameRenderCount || 0) > 0;
  const hasVideo = Boolean(playerStats?.videoCodec);

  if (
    !state.isPlaying
    || !hasVideo
    || document.visibilityState === "hidden"
    || !Number.isFinite(videoCurrentTimeMs)
  ) {
    playerMetricsState.lastVideoCurrentTimeMs = videoCurrentTimeMs || 0;
    playerMetricsState.lastVideoProgressAt = now;
    playerMetricsState.freezeRecoveryTriggered = false;
    return;
  }

  if (hasRenderedVideo && videoCurrentTimeMs > playerMetricsState.lastVideoCurrentTimeMs + 50) {
    playerMetricsState.lastVideoCurrentTimeMs = videoCurrentTimeMs;
    playerMetricsState.lastVideoProgressAt = now;
    playerMetricsState.freezeRecoveryTriggered = false;
    return;
  }

  if (!playerMetricsState.lastVideoProgressAt) {
    playerMetricsState.lastVideoProgressAt = now;
    return;
  }

  const driftMs = Number.isFinite(audioCurrentTimeMs)
    ? audioCurrentTimeMs - videoCurrentTimeMs
    : 0;
  const frozenForMs = now - playerMetricsState.lastVideoProgressAt;
  if (
    driftMs >= VIDEO_FREEZE_DRIFT_MS
    && frozenForMs >= VIDEO_FREEZE_THRESHOLD_MS
    && !playerMetricsState.freezeRecoveryTriggered
  ) {
    playerMetricsState.freezeRecoveryTriggered = true;
    const error = new Error(`video stalled for ${Math.round(frozenForMs)}ms with ${Math.round(driftMs)}ms A/V drift`);
    postPlayerRuntimeLog("video_freeze_detected", {
      videoCurrentTimeMs,
      audioCurrentTimeMs,
      frozenForMs: Math.round(frozenForMs),
      driftMs: Math.round(driftMs),
    });
    schedulePlaybackRecovery(state.player, error);
  }
}

function checkVideoFreeze() {
  detectVideoFreeze(summarizePlayerStats(state.player));
}

function detectCapabilityProfile() {
  const userAgent = navigator.userAgent || "";
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  const hasVideoDecoder = typeof globalThis.VideoDecoder === "function";
  const hasAudioDecoder = typeof globalThis.AudioDecoder === "function";
  const hasAudioContext = typeof (globalThis.AudioContext || globalThis.webkitAudioContext) === "function";
  const hasAudioWorklet = hasAudioContext && typeof globalThis.AudioWorkletNode === "function";

  return {
    platform,
    userAgent,
    hasVideoDecoder,
    hasAudioDecoder,
    hasAudioWorklet,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  };
}

function reportDecodeInfo(data) {
  if (data?.path) {
    const previousPath = playerRuntimeLogState.lastDecodePath;
    if (previousPath && previousPath !== data.path) {
      postPlayerRuntimeLog("decode_path_change", {
        previousPath,
        nextPath: data.path,
        phase: data.phase || null,
        buffer: collectBufferState(),
      });
    }
    playerRuntimeLogState.lastDecodePath = data.path;
    playerMetricsState.decodePath = data.path;
  }
  postPlayerRuntimeLog("decode_info", { decode: data });
}

async function logDecodePath(player, phase, extra = {}) {
  const playerStats = summarizePlayerStats(player);
  const decodeInfo = {
    phase,
    path: currentEngine.decodePath,
    playbackState: getPlaybackState(),
    currentTime: getReportedCurrentTime(player),
    duration: state.duration,
    capabilities: CAPABILITY_PROFILE,
    stats: playerStats,
    bufferHealthSeconds: readBufferHealthSeconds(player),
    droppedFrames: readDroppedFrames(player),
    audio: readAudioBufferStats(player),
    canvas: describePlayerCanvas(),
    ...describeEnginePicture(),
    viewport: describeViewport(),
    ...extra,
  };
  console.log("[player] Decode health:", decodeInfo);
  reportDecodeInfo(decodeInfo);
  return decodeInfo;
}

function queueDecodeHealthCheck(player, phase, extra = {}, { jankCooldownMs = 0 } = {}) {
  if (!player) return;

  if (jankCooldownMs > 0) {
    const now = performance.now();
    if (now - decodeHealthState.lastJankReportAt < jankCooldownMs) return;
    decodeHealthState.lastJankReportAt = now;
  }

  logDecodePath(player, phase, extra).catch((error) => {
    console.warn("[player] Failed to report decode health:", error);
  });
}

function startDecodeHealthMonitoring(player) {
  stopDecodeHealthMonitoring();
  decodeHealthInterval = setInterval(() => {
    queueDecodeHealthCheck(state.player, "periodic-60s");
  }, DECODE_HEALTH_INTERVAL_MS);
}

function stopDecodeHealthMonitoring() {
  if (decodeHealthInterval) {
    clearInterval(decodeHealthInterval);
    decodeHealthInterval = null;
  }
}

// --- MediaSession (Tesla steering wheel / browser media keys) --------

// The stream's artwork for the system's media controls (the lock screen, a
// phone's notification): the web profile's <video> engine only.
let mediaArtwork = null;

export function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const native = currentEngine.name === "native";
  navigator.mediaSession.metadata = new MediaMetadata({
    title: mediaTitle.textContent || "Yolo",
    ...(native && mediaArtwork ? { artwork: [{ src: mediaArtwork }] } : {}),
  });
  navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
  if (state.duration > 0) {
    try {
      const currentTime = getReportedCurrentTime();
      navigator.mediaSession.setPositionState({
        duration: state.duration,
        playbackRate: 1,
        position: Math.min(currentTime, state.duration),
      });
    } catch {}
  }
}

// --- Progress reporting ----------------------------------------------

function getReportedCurrentTime(player = state.player) {
  const engineTime = Number(player?.getCurrentTime?.());
  if (Number.isFinite(engineTime)) {
    return resolvePlaybackPosition({
      engineTime,
      fallbackTime: state.currentTime,
      duration: state.duration,
    });
  }
  const stats = summarizePlayerStats(player);
  const videoSeconds = stats?.videoCurrentTimeMs != null ? stats.videoCurrentTimeMs / 1000 : null;
  const audioSeconds = stats?.audioCurrentTimeMs != null ? stats.audioCurrentTimeMs / 1000 : null;
  const hasRenderedVideo = (stats?.videoFrameRenderCount || 0) > 0;
  if (
    hasRenderedVideo
    && Number.isFinite(videoSeconds)
    && videoSeconds > 0
    && Number.isFinite(audioSeconds)
    && audioSeconds - videoSeconds > 2
  ) {
    return resolvePlaybackPosition({
      engineTime: videoSeconds,
      fallbackTime: state.currentTime,
      duration: state.duration,
    });
  }
  return resolvePlaybackPosition({
    fallbackTime: state.currentTime,
    duration: state.duration,
  });
}

export function getPlaybackPosition() {
  return getReportedCurrentTime();
}

let lastReportAt = 0;
let lastReportedStatus = null;

// The `health` a report carries for agents' playback health
// (Agent Note 2026-10-07-hub-and-realtime-channel): about every 15 seconds,
// and at once for a new stream or a new stall, to keep the Hub's writes few.
const HEALTH_REPORT_INTERVAL_MS = 15_000;
const healthReportState = { at: 0, key: "" };
const tenths = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

function playbackHealthReport(now) {
  const key = `${state.sessionId}:${playerMetricsState.stallCount}:${Boolean(state.isBuffering)}`;
  if (key === healthReportState.key && now - healthReportState.at < HEALTH_REPORT_INTERVAL_MS) return null;
  const sample = networkState.lastSample;
  const stalledMs = playerMetricsState.stallStartedAt ? now - playerMetricsState.stallStartedAt : 0;
  const native = currentEngine.name === "native";
  const picture = native ? describePlayerVideo() : state.player;
  return {
    key,
    health: {
      engine: currentEngine.name,
      bufferSeconds: sample ? tenths(Number(sample.bufferedAheadSeconds)) : null,
      throughputKbps: sample?.throughputKbps || null,
      buffering: Boolean(state.isBuffering),
      stalls: playerMetricsState.stallCount,
      stallSeconds: tenths((playerMetricsState.totalStallDurationMs + stalledMs) / 1000),
      recentStalls: stallsOfThisItem()
        .filter((stall) => now - stall.startedAt < RECENT_STALLS_KEPT_MS)
        .map((stall) => ({ ago: Math.round((now - stall.startedAt) / 1000), seconds: tenths(((stall.endedAt || now) - stall.startedAt) / 1000) }))
        .reverse()
        .slice(0, 5),
      width: Number(picture?.width) || null,
      height: Number(picture?.height) || null,
      videoCodec: native ? null : state.player?.videoCodec || null,
      droppedFrames: readDroppedFrames(state.player),
    },
  };
}

// Tell Yolo where playback is (`report`,
// Agent Note 2026-10-07-hub-and-realtime-channel). Yolo saves it as the resume
// position and forwards it to the source. Status changes are reported at once;
// repeats are spaced out to stay far below the Hub's message limit.
export function reportProgress({ force = false, status: statusOverride = null } = {}) {
  // A kept player only says that it is kept, when asked (a pause, a welcome).
  if (!state.player && keptPlayer.current) {
    if (force) keptPlayer.remind();
    return;
  }
  const status = statusOverride || getPlaybackState();
  const now = performance.now();
  const changed = status !== lastReportedStatus;
  if (state.sessionId && realtime && (force || changed || now - lastReportAt >= MIN_REPORT_SPACING_MS)) {
    // In physical pixels (devicePixelRatio 1): a display size widens the
    // CSS layout (a zoom), which must not look like a bigger screen to Yolo.
    const physical = physicalViewport();
    const health = state.player ? playbackHealthReport(now) : null;
    const sent = realtime.send({
      type: "report",
      sessionId: state.sessionId,
      status,
      position: Number(getReportedCurrentTime().toFixed(3)),
      duration: state.isLive ? null : state.duration || null,
      playing: state.isPlaying,
      viewport: { width: physical.width, height: physical.height, devicePixelRatio: 1 },
      ...(health ? { health: health.health } : {}),
    });
    if (sent) {
      lastReportAt = now;
      lastReportedStatus = status;
      if (health) Object.assign(healthReportState, { at: now, key: health.key });
    }
  }
  noteWakeProgress();
  checkVideoFreeze();
}

async function disposePlayer(player) {
  if (!player) return;
  try { await player.stop(); } catch {}
  try { await player.destroy(); } catch {}
  if (globalThis.__yoloPlayer?.player === player) delete globalThis.__yoloPlayer;
}

function startProgressReporting() {
  stopProgressReporting();
  state.progressInterval = setInterval(() => reportProgress(), PROGRESS_REPORT_INTERVAL_MS);
}

function stopProgressReporting() {
  if (state.progressInterval) {
    clearInterval(state.progressInterval);
    state.progressInterval = null;
  }
}

// --- Seek ------------------------------------------------------------

function invalidatePlexSeekSession({ preserveTransition = false } = {}) {
  sessionRestartState.requestId += 1;
  sessionRestartState.pending = false;
  sessionRestartState.seek = null;
  sessionRestartState.built = null;
  clearSeekRestartWatchdog();
  if (!preserveTransition) sessionRestartState.transitionPending = false;
}

// The stream starts at an offset (a transcode resumed part way) and cannot
// seek before it: ask Yolo for a new stream at the target, in place of the
// one on screen (or of the one Yolo built in its place whose `load` never
// came, replacedStream()). One such stream is asked for at a time: a seek
// while the request is on its way, or while the stream Yolo built for it
// is, only moves the target, and that stream starts there
// (seekStreamStart). A second request would race the first at the Hub, and
// come back superseded once Yolo had built the first one's stream, which
// then played at the first target. `again` asks anew even so, since the
// stream on its way is known lost (rejoinHubStream), unless the request
// still waits for the realtime connection: sent then, it replaces the lost
// stream (replacedStream()). `settled` hears how the request was answered
// (true, "skipped", or null for a failure).
function restartSessionForSeek(player, targetTime, expectedToPlay, { fromTime, again = false, settled = () => {} }) {
  if (!state.source) return false;

  const current = sessionRestartState.pending ? sessionRestartState.seek : null;
  const onItsWay = current?.player === player
    && (again ? current.asking && !current.sent : current.asking || Boolean(sessionRestartState.built));
  if (onItsWay) {
    current.targetTime = targetTime;
    current.expectedToPlay = expectedToPlay;
    current.settled.push(settled);
    postPlayerRuntimeLog("seek_session_restart_retargeted", { requestId: sessionRestartState.requestId, asked: current.asked, targetTime });
    return true;
  }
  const requestId = ++sessionRestartState.requestId;
  sessionRestartState.pending = true;
  sessionRestartState.transitionPending = true;
  const seek = { player, targetTime, asked: targetTime, expectedToPlay, fromTime, asking: true, sent: false, settled: [settled] };
  sessionRestartState.seek = seek;
  sessionRestartState.built = null;
  clearSeekRestartWatchdog();
  clearSeekWatchdog();
  void player.pause().catch(() => {});
  state.isPlaying = false;
  setSeekTransitionPending(true);
  postPlayerRuntimeLog("seek_session_restart_requested", {
    requestId,
    fromTime,
    targetTime,
    seekableRange: player.getSeekableRange?.() || null,
    sessionId: state.sessionId,
    replaces: replacedStream(),
  });

  const request = { meta: { source: state.source, sessionId: state.sessionId } };
  // Read when the request goes: a seek while it waited for the channel moved it.
  const askAt = () => {
    seek.sent = true;
    seek.asked = seek.targetTime;
    return seek.asked;
  };
  const answered = (created) => {
    seek.asking = false;
    for (const done of seek.settled) done(created);
  };
  void requestFreshPlaybackSession(request, askAt, {
    label: "Seek",
    recovery: false,
    reason: "seek",
    accepted: (sessionId) => {
      if (requestId === sessionRestartState.requestId) sessionRestartState.built = sessionId;
    },
  }).then((created) => {
    answered(created);
    if (requestId !== sessionRestartState.requestId || state.player !== player) return;
    // Yolo has this stream, or a newer one ("skipped"): its `load` is on the way.
    armSeekRestartWatchdog(requestId, player);
    if (created !== true) return;
    postPlayerRuntimeLog("seek_session_restart_created", {
      requestId,
      fromTime,
      targetTime: seek.asked,
      sessionId: sessionRestartState.built,
    });
  }).catch((error) => {
    answered(null);
    if (requestId !== sessionRestartState.requestId || state.player !== player) return;
    failSeekRestart(player, requestId, error?.message || String(error));
  });
  return true;
}

// Where the stream a seek asked for starts (play(), for a `load` with reason
// "seek"): at the last place the owner asked for, which a seek sent while
// that stream was on its way moved. A target before the stream's own start
// is another seek once it plays (`then`), which asks for a stream there.
function seekStreamStart(startTime) {
  const seek = sessionRestartState.pending ? sessionRestartState.seek : null;
  if (!seek || seek.player !== state.player || Math.abs(seek.targetTime - seek.asked) < 0.5) return { startTime, then: null };
  postPlayerRuntimeLog("seek_session_restart_moved", { asked: seek.asked, targetTime: seek.targetTime, streamStart: startTime });
  return seek.targetTime >= startTime ? { startTime: seek.targetTime, then: null } : { startTime, then: seek.targetTime };
}

// The seek did not get its stream: the player stays where it was. When Yolo
// built one whose `load` never came over a connection that answers, the
// stream on screen is one Yolo stopped: the screen asks for a new stream
// where it was, in place of the one Yolo built (rejoinInPlace).
function failSeekRestart(player, requestId, error) {
  const { targetTime = null, fromTime = null, expectedToPlay = false } = sessionRestartState.seek || {};
  const built = sessionRestartState.built && sessionRestartState.built !== state.sessionId ? sessionRestartState.built : null;
  sessionRestartState.pending = false;
  sessionRestartState.transitionPending = false;
  sessionRestartState.seek = null;
  sessionRestartState.built = null;
  clearSeekRestartWatchdog();
  setSeekTransitionPending(false);
  const rollbackTime = getReportedCurrentTime(player);
  state.currentTime = rollbackTime;
  updateTimeDisplay();
  updateProgress(state.duration > 0 ? rollbackTime / state.duration : 0);
  postPlayerRuntimeLog("seek_session_restart_failed", {
    requestId,
    fromTime,
    targetTime,
    built,
    error,
  });
  showPlaybackNotice("Couldn't skip there. Try again.");
  if (built) {
    lostLoad = { onScreen: state.sessionId, sessionId: built, asking: true };
    rejoinInPlace(player, rollbackTime, lostLoad);
  } else if (expectedToPlay && state.playbackIntent === "playing") {
    void player.resume().catch(() => {});
  }
}

// A new stream of the item on screen where it is, in place of the stream
// Yolo built for this screen whose `load` never came (`lost`, lostLoad): the
// stream on screen is one Yolo stopped. The picture stays, with the
// spinner, until the new one plays.
function rejoinInPlace(player, position, lost) {
  clearSeekWatchdog();
  state.isPlaying = false;
  void player.pause().catch(() => {});
  showRecovering(player);
  const request = playbackRecoveryState.request?.meta?.sessionId === state.sessionId
    ? playbackRecoveryState.request
    : { meta: { source: state.source, sessionId: state.sessionId } };
  void requestFreshPlaybackSession(request, position).then((requested) => {
    lost.asking = false;
    if (state.player !== player) return;
    if (requested === true) {
      armPlaybackRecoveryConfirmation(1, position, player);
      return;
    }
    // Refused, or no longer wanted: Yolo has moved on from that stream too
    // (a newer one's `load` is on its way), or the welcome that named it
    // was older than the stream on screen.
    forgetLostLoad(lost);
    postPlayerRuntimeLog("hub_stream_rejoin_skipped", { sessionId: state.sessionId, lost: lost.sessionId });
    playOnAfterRejoin(player, lost.onScreen);
  }).catch((error) => {
    lost.asking = false;
    if (state.player !== player) return;
    postPlayerRuntimeLog("hub_stream_rejoin_failed", { error: error?.message || String(error), code: error?.apiCode || error?.code || null });
    if (!schedulePlaybackRecovery(player, error, { startTime: position })) showPlaybackError(error);
  });
}

// A request in place of a stream whose `load` never came was refused or is
// no longer wanted: until a `load` says otherwise, the stream on screen
// plays on, unless a newer such request is on its way.
function playOnAfterRejoin(player, onScreen) {
  if (state.player !== player || state.sessionId !== onScreen || lostLoad?.asking || itemRejoin) return;
  removeTransitionFrame({ immediate: true });
  hideBuffering();
  if (state.playbackIntent === "playing") void player.resume().catch(() => {});
}

/**
 * The welcome after a reconnect (main.js) names the stream Yolo has for this
 * screen. Yolo sends each `load` once, over the connections the device has
 * then, and the welcome's state names every `load` sent before this
 * connection became the device's (Hub): a stream the welcome names that is
 * not the one on screen is one whose `load` went with the old connection (a
 * seek's, a quality change's, a recovery's, an agent's play of this item),
 * and the stream on screen is one Yolo stopped when it built that one. For
 * the same item this asks for a new stream in place of the Hub's: at a
 * pending seek's target, else where the screen is (not where an agent's
 * play of this item asked to start), with the picture held under the
 * spinner until it plays. True when it asked (or asked already); false when
 * the Hub names the stream on screen or another item (rejoinHubItem).
 */
export function rejoinHubStream(hub) {
  const player = state.player;
  if (!player || !hub?.sessionId || hub.deviceId !== state.deviceId || hub.sessionId === state.sessionId) return false;
  const key = sourceKeyOf(hub.item?.source);
  if (!key || key !== sourceKeyOf(state.source)) return false;
  // An earlier welcome named it, and that request is on its way.
  if (lostLoad?.onScreen === state.sessionId && lostLoad.sessionId === hub.sessionId && lostLoad.asking) return true;
  const lost = { onScreen: state.sessionId, sessionId: hub.sessionId, asking: true };
  lostLoad = lost;
  const seek = sessionRestartState.pending && sessionRestartState.seek?.player === player ? sessionRestartState.seek : null;
  postPlayerRuntimeLog("hub_stream_rejoined", { sessionId: state.sessionId, lost: hub.sessionId, seekTo: seek?.targetTime ?? null });
  if (seek) {
    restartSessionForSeek(player, seek.targetTime, seek.expectedToPlay, {
      fromTime: seek.fromTime,
      again: true,
      settled: (created) => {
        lost.asking = false;
        if (created === "skipped") forgetLostLoad(lost);
      },
    });
  } else {
    rejoinInPlace(player, getPlaybackRecoveryPosition(player), lost);
  }
  return true;
}

/**
 * The welcome names another item for this screen than the one it plays (an
 * agent's play here, whose `load` a reconnect lost), and `decision` says
 * where and whether it plays (resume-decision.js). Asks for it first, in
 * place of the Hub's stream, with the picture held under the spinner; its
 * `load` switches the screen over. Refused (the welcome was older than the
 * stream on screen, or Yolo moved on), the stream on screen plays on.
 * Resolves "asked" or "skipped"; rejects with the request's error, after
 * which the screen should leave the stream as a page that could not resume.
 */
export async function rejoinHubItem(hub, decision) {
  const player = state.player;
  if (!player || !decision?.sessionId || hub?.sessionId !== decision.sessionId) return "skipped";
  if (itemRejoin?.onScreen === state.sessionId && itemRejoin.sessionId === decision.sessionId) return "asked";
  const rejoin = { onScreen: state.sessionId, sessionId: decision.sessionId };
  itemRejoin = rejoin;
  postPlayerRuntimeLog("hub_item_rejoined", { sessionId: state.sessionId, lost: decision.sessionId, hubStatus: hub.status ?? null });
  clearSeekWatchdog();
  state.isPlaying = false;
  void player.pause().catch(() => {});
  showRecovering(player);
  const body = buildFreshPlaybackSessionRequest({ meta: { source: decision.source, sessionId: decision.sessionId } }, decision.position, {
    autoplay: decision.autoplay,
    reason: "recovery",
  })?.body ?? null;
  let result = null;
  try {
    result = await requestStream(() => (state.player === player && state.sessionId === rejoin.onScreen && itemRejoin === rejoin ? body : null), {
      label: "Resume", reason: "recovery",
    });
  } catch (error) {
    if (itemRejoin === rejoin) itemRejoin = null;
    if (error?.code !== "superseded") throw error;
  }
  if (itemRejoin === rejoin) itemRejoin = null;
  if (result !== null) return "asked";
  postPlayerRuntimeLog("hub_item_rejoin_skipped", { sessionId: state.sessionId, lost: decision.sessionId });
  playOnAfterRejoin(player, rejoin.onScreen);
  return "skipped";
}

// The backstop for a seek's stream that Yolo built but whose `load` has not
// come: the realtime connection may have died without the page noticing. It
// is made to prove itself; a dead one is replaced, and the welcome after it
// asks again (rejoinHubStream). While the connection is down the seek waits
// for that welcome. One that answers and still brings no stream ends the
// seek as failed, so the seek indicator never stays.
function armSeekRestartWatchdog(requestId, player) {
  clearSeekRestartWatchdog();
  const armedAt = performance.now();
  let probed = false;
  const check = () => {
    sessionRestartState.loadTimer = null;
    const seek = sessionRestartState.seek;
    if (requestId !== sessionRestartState.requestId || !sessionRestartState.pending || state.player !== player || !seek) return;
    const rearm = () => {
      sessionRestartState.loadTimer = setTimeout(check, SEEK_RESTART_LOAD_TIMEOUT_MS);
    };
    if (realtime?.running && !realtime.ready) {
      rearm();
      return;
    }
    if (!probed && realtime?.running) {
      probed = true;
      postPlayerRuntimeLog("seek_session_restart_load_missing", { requestId, targetTime: seek.targetTime, built: sessionRestartState.built });
      realtime.probe();
      rearm();
      return;
    }
    failSeekRestart(player, requestId, `no stream arrived ${Math.round(performance.now() - armedAt)} ms after Yolo built it`);
  };
  sessionRestartState.loadTimer = setTimeout(check, SEEK_RESTART_LOAD_TIMEOUT_MS);
}

function clearSeekRestartWatchdog() {
  clearTimeout(sessionRestartState.loadTimer);
  sessionRestartState.loadTimer = null;
}

// Every seek asked of the player counts (play() drops a seek it was to make
// once its stream loaded when the owner asked for another one meanwhile).
let seeksAsked = 0;

/** A seek the owner made on this screen (the controls, the system's media keys). */
export function seekHere(timeSec) {
  onOwnAction("seek");
  seekToTime(timeSec);
}

// `settled`: the stream on screen is loaded, even while its seek transition
// waits for a first picture (play(), for a seek the owner asked for while it
// was on its way): a target it can seek to is a seek in it.
export function seekToTime(timeSec, { settled = false } = {}) {
  forgetFinished();
  if (!state.player && keptPlayer.current) {
    // A seek while the player is kept (an agent's, the bar's skip back):
    // Yolo moved its position already; the player goes on there.
    keptPlayer.seek(timeSec);
    return;
  }
  if (!state.player) return;
  seeksAsked += 1;
  if (state.isLive && state.player.seeksLiveInPlace) {
    // The <video> engine keeps the live window the browser can seek in.
    const timeline = state.player.getLiveTimeline();
    const requestedTime = Number(timeSec);
    if (!timeline || !Number.isFinite(requestedTime)) return;
    const fromTime = state.currentTime;
    const target = Math.max(timeline.startTime, Math.min(timeline.edgeTime, requestedTime));
    state.currentTime = target;
    updateTimeDisplay();
    updateProgress(timeline.edgeTime > timeline.startTime ? (target - timeline.startTime) / (timeline.edgeTime - timeline.startTime) : 1);
    runPlayerSeek(state.player, target, state.playbackIntent === "playing", { fromTime, label: "live" });
    return;
  }
  if (state.isLive) {
    const request = playbackRecoveryState.request;
    if (!request || !state.liveDvrAvailable) return;
    const requestedTime = Number(timeSec) || 0;
    const lowLatency = requestedTime >= state.liveEdgeTime - 6;
    const target = Math.max(
      state.liveStartTime,
      Math.min(
        lowLatency ? state.liveEdgeTime + LIVE_SEEK_MAX_LEAD_SECONDS : state.liveEdgeTime,
        requestedTime,
      ),
    );
    const wasPlaying = state.playbackIntent === "playing";
    if (lowLatency) {
      const fromTime = state.currentTime;
      state.currentTime = target;
      state.player.hlsStartSeconds = 2;
      updateTimeDisplay();
      updateProgress(1);
      runPlayerSeek(state.player, target, wasPlaying, {
        preserveHlsBuffer: true,
        fromTime,
        label: "live-edge",
      });
      return;
    }
    const mediaSource = request.meta.mediaSource;
    const sourceUrl = typeof mediaSource === "object" ? mediaSource?.url : null;
    if (!sourceUrl) return;
    const positionedUrl = new URL(sourceUrl, location.origin);
    positionedUrl.searchParams.set("at", String(target));
    const positionedSource = {
      ...mediaSource,
      url: `${positionedUrl.pathname}${positionedUrl.search}`,
    };
    void play(request.url, request.title, {
      ...request.meta,
      mediaSource: positionedSource,
      startTime: target,
      autoplay: wasPlaying,
      __recovery: true,
      __liveSeek: true,
    }).catch((err) => console.error("[player] Live seek error:", err));
    return;
  }
  if (state.duration <= 0) return;
  const requestedTime = Number(timeSec);
  if (!Number.isFinite(requestedTime)) return;
  const player = state.player;
  const fromTime = state.currentTime;
  const target = Math.max(0, Math.min(state.duration, requestedTime));
  const wasPlaying = state.playbackIntent === "playing";
  const seekableRange = player.getSeekableRange?.() || null;
  const restartSession = shouldRestartSessionForSeek({
    sessionId: state.source ? state.sessionId : null,
    targetTime: target,
    seekableStartTime: seekableRange?.start,
    sessionRestartPending: sessionRestartState.pending || (sessionRestartState.transitionPending && !settled),
  });
  if (restartSession) setSeekTransitionPending(true);
  state.currentTime = target;
  updateTimeDisplay();
  updateProgress(state.currentTime / state.duration);
  if (restartSession) {
    restartSessionForSeek(player, target, wasPlaying, { fromTime });
    return;
  }
  runPlayerSeek(player, target, wasPlaying, { fromTime, label: "vod" });
  reportProgress();
}

function runPlayerSeek(player, targetTime, expectedToPlay, {
  fromTime = state.currentTime,
  preserveHlsBuffer = false,
  label = "seek",
} = {}) {
  const startedAt = performance.now();
  const requestId = armSeekWatchdog(player, targetTime, expectedToPlay);
  postPlayerRuntimeLog("seek_requested", {
    requestId,
    label,
    fromTime,
    targetTime,
    expectedToPlay,
    preserveHlsBuffer,
    playerStats: summarizePlayerStats(player),
  });

  void player.seek(BigInt(Math.floor(targetTime * 1000)), { preserveHlsBuffer }).then((applied) => {
    const current = requestId === seekWatchdogState.requestId && state.player === player;
    postPlayerRuntimeLog("seek_completed", {
      requestId,
      label,
      targetTime,
      applied: applied !== false,
      current,
      durationMs: Math.round(performance.now() - startedAt),
      playerStats: summarizePlayerStats(player),
    });
    if (!current || applied === false) return;
    if (expectedToPlay && state.playbackIntent === "playing") player.resume().catch(() => {});
  }).catch((error) => {
    const seekError = error instanceof Error ? error : new Error(String(error));
    const current = requestId === seekWatchdogState.requestId && state.player === player;
    postPlayerRuntimeLog("seek_failed", {
      requestId,
      label,
      targetTime,
      current,
      durationMs: Math.round(performance.now() - startedAt),
      error: seekError.message,
      playerStats: summarizePlayerStats(player),
    });
    if (!current) return;
    seekError.code ||= "SEEK_FAILED";
    clearSeekWatchdog();
    if (!schedulePlaybackRecovery(player, seekError, { startTime: targetTime })) {
      console.error("[player] Seek error:", seekError);
    }
  });
}

// --- Toggle play/pause -----------------------------------------------

export async function togglePlayPause() {
  if (!state.player) return;
  forgetFinished();
  try {
    if (state.playbackIntent === "playing") {
      state.playbackIntent = "paused";
      onOwnAction("playback");
      await state.player.pause();
      state.isPlaying = false;
    } else {
      state.playbackIntent = "playing";
      await state.player.play();
    }
    updatePlayButton();
  } catch (e) {
    console.error("[player] Toggle error:", e);
  }
}

// Press and hold on the picture (controls.js): twice the speed while held,
// where the engine has a rate of its own. The canvas engine's frames follow
// its audio clock, which plays at 1x; there the press stays a tap.
export function setHoldSpeed(on) {
  const player = state.player;
  if (typeof player?.setPlaybackRate !== "function") return false;
  if (on && state.playbackIntent !== "playing") return false;
  player.setPlaybackRate(on ? 2 : 1);
  return true;
}

// --- Which stream, and what it looks like ----------------------------------

// stream_selected: one per load or rebuild (play, recovery, seek, quality,
// tracks), with what the source chose and why, so a picture that changes
// after a seek or a recovery can be traced to the stream behind it.
export function noteStreamSelected({ reason = null, stream = {}, source = null, startTime = null, autoplay = null } = {}) {
  const profile = stream.profile || {};
  const limits = stream.limits || {};
  const viewport = describeViewport();
  let mediaHost = null;
  try {
    mediaHost = stream.origin ? new URL(stream.origin).host : null;
  } catch {
    // Not a URL: none.
  }
  const fields = {
    reason,
    engine: engineChoice().engine,
    plugin: source?.plugin || null,
    // Which path the stream came by: "lan" or "wan" from that listener on
    // the node (mediaHost), or "relay" through Yolo's /m/* passthrough.
    network: (stream.network === "lan" || stream.network === "wan") && mediaHost ? stream.network : "relay",
    mediaHost,
    original: profile.original === true,
    deliveryType: stream.delivery?.type || null,
    width: profile.width ?? null,
    height: profile.height ?? null,
    fps: profile.fps ?? null,
    videoCodec: profile.videoCodec ?? null,
    audioCodec: profile.audioCodec ?? null,
    videoKbps: profile.videoKbps ?? null,
    audioKbps: profile.audioKbps ?? null,
    formatId: profile.formatId ?? null,
    split: profile.split ?? null,
    maxVideoKbps: limits.maxVideoKbps ?? null,
    ceilingKbps: limits.ceilingKbps ?? null,
    capped: limits.capped ?? null,
    startTime,
    autoplay,
    viewport: {
      width: viewport.innerWidth,
      height: viewport.innerHeight,
      devicePixelRatio: viewport.devicePixelRatio,
      physicalWidth: viewport.physicalWidth,
      physicalHeight: viewport.physicalHeight,
      displayScale: viewport.displayScale,
      displayZoom: viewport.displayZoom,
    },
  };
  recordDeviceEvent("stream_selected", fields);
  notePlaybackDiagnostics({ stream: fields }, {
    event: { type: "stream_selected", reason, height: fields.height, videoKbps: fields.videoKbps, maxVideoKbps: fields.maxVideoKbps },
    now: true,
  });
}

// stream_first_frame: the picture the decoder really gives, next to what the
// source said, once per stream and again after each seek inside it.
function noteFirstFrame(player, meta, startedAt) {
  const profile = meta.streamProfile || {};
  const canvas = describePlayerCanvas();
  const fields = {
    reason: meta.__loadReason || null,
    engine: currentEngine.name,
    seeks: player.seekRequestCount || 0,
    width: player.width || null,
    height: player.height || null,
    videoCodec: player.videoCodec || null,
    profileWidth: profile.width ?? null,
    profileHeight: profile.height ?? null,
    matchesProfile: !profile.height || !player.height || profile.height === player.height,
    canvas,
    ...describeEnginePicture(),
    sinceLoadMs: Math.round(performance.now() - startedAt),
  };
  postPlayerRuntimeLog("stream_first_frame", fields);
  notePlaybackDiagnostics({ picture: fields });
}

// --- Sound ----------------------------------------------------------------

// Like Spotify in a car, playback starts by itself (after a wake, a reload,
// or an agent's play) and tries to start with sound. Chromium allows that
// after a gesture on the page or for a site with high media engagement;
// otherwise the engine plays muted and the page shows one small "tap for
// sound" hint until the first tap anywhere (main.js).
let audioBlockedAt = 0;

function handleAudioOutput(player, output, { hasVideo }) {
  if (state.player && state.player !== player) return;
  const blocked = output === "blocked";
  const wasBlocked = state.audioBlocked;
  state.audioBlocked = blocked;
  updateVolumeButton();
  showTapForSound(blocked && hasVideo);
  if (blocked && !wasBlocked) audioBlockedAt = performance.now();
  if (!blocked && wasBlocked) {
    postPlayerRuntimeLog("audio_unlocked", { afterMs: Math.round(performance.now() - audioBlockedAt) });
  }
  if (blocked && !hasVideo) {
    // Muted audio shows nothing: wait for a tap on play instead.
    state.playbackIntent = "paused";
    state.isPlaying = false;
    updatePlayButton();
    showControls();
  }
}

// autoplay_result: whether a playback that started without being asked by
// a tap got sound ("sound"), had to play muted ("muted"), or could not play
// at all until a tap ("blocked": audio only).
function recordAutoplayResult(player, meta) {
  const output = player.audioOutputState;
  const result = output === "blocked" ? (player.videoTrack ? "muted" : "blocked") : "sound";
  console.info(`[player] Autoplay: ${result}`);
  postPlayerRuntimeLog("autoplay_result", {
    result,
    audioOutput: output,
    reason: meta.__loadReason || null,
    userActivated: navigator.userActivation?.hasBeenActive ?? null,
    audioContextState: player.audioContext?.state ?? null,
    volume: state.isMuted ? 0 : 1,
  });
}

// --- Player event bindings -------------------------------------------

// The item played to its end (or a recovery found nothing left to play):
// tell Yolo, which plays the queue's next item or stops.
function finishPlayback(player) {
  if (state.player !== player) return;
  stopNetworkMonitor();
  endStall();
  hideBuffering();
  state.isPlaying = false;
  state.playbackIntent = "paused";
  reportProgress({ force: true, status: "paused" });
  state.currentTime = 0;
  const end = { sessionId: state.sessionId, player, heard: false };
  finished = end;
  realtime?.send({ type: "ended", sessionId: state.sessionId });
  realtime?.confirm?.(() => {
    end.heard = true;
  });
  updatePlayButton();
  updateMediaSession();
  showControls();
}

function createEnginePlayer(meta, { engine, native, overtaken = () => false }) {
  // A stream that replaces what plays (a seek, a track or a quality change)
  // is a seek transition until its first picture: the progress bar's seek
  // indicator, not the spinner. Then it is a player like any other, and a
  // stall on it shows the spinner. When a newer seek asked for a stream of
  // its own while this one loaded (`overtaken`), that seek is still on its
  // way: its first picture only replaces the old picture.
  let seekTransition = meta.__optimisticSeek === true;
  const endSeekTransition = (options) => {
    if (!seekTransition) return;
    seekTransition = false;
    if (overtaken()) removeTransitionFrame(options);
    else completeOptimisticSeekTransition(options);
  };
  const createdAt = performance.now();
  const info = ENGINES[engine];
  let player = null;
  // A kept player is hidden: its position moves nothing on screen.
  const kept = () => keptPlayer.current?.player === player;
  const updateTime = (seconds) => {
    if (kept()) return;
    if (shouldHoldOptimisticSeekTarget({
      transitionPending: sessionRestartState.transitionPending,
      playerIsCurrent: state.player === player,
    })) {
      return;
    }
    state.currentTime = Math.max(
      0,
      state.isLive ? seconds : Math.min(state.duration || Infinity, seconds),
    );
    confirmPlaybackRecovery(player, state.currentTime);
    if (state.isLive) {
      const timeline = player.getLiveTimeline();
      if (timeline) {
        state.liveDvrAvailable = true;
        state.liveStartTime = timeline.startTime;
        state.liveEdgeTime = Math.max(timeline.edgeTime, state.currentTime);
      }
    }
    if (isDraggingProgress()) return;
    const now = performance.now();
    if (now - lastUiPaintAt >= UI_PAINT_INTERVAL_MS) {
      if (state.isLive && state.liveEdgeTime > state.liveStartTime) {
        updateProgress((state.currentTime - state.liveStartTime) / (state.liveEdgeTime - state.liveStartTime));
      } else if (state.duration > 0) {
        updateProgress(state.currentTime / state.duration);
      }
      updateTimeDisplay();
      lastUiPaintAt = now;
    }
    renderSubtitle(state.isLive
      ? Math.max(0, state.currentTime - state.liveStartTime)
      : state.currentTime);
    if (!state.isLive) danmaku.sync(state.currentTime);
  };

  const callbacks = {
    container,
    onStateChange: (nextState, detail) => {
      if (state.player !== player) return;
      if (["playing", "paused", "stopped", "ended", "error"].includes(nextState)) {
        clearSeekWatchdog();
      }
      // Played or paused outside Yolo's controls (Picture-in-Picture, the
      // system's media controls, a call): that is the owner's intent now,
      // and a pause is the owner's, as one in Yolo's controls is.
      if (detail.reason === "external") {
        state.playbackIntent = nextState === "playing" ? "playing" : "paused";
        forgetFinished();
        if (nextState !== "playing") onOwnAction("playback");
      }
      if (["loading", "seeking", "buffering"].includes(nextState)) {
        beginStall();
        if (seekTransition) setSeekTransitionPending(true);
        else showBuffering();
        state.isPlaying = false;
      } else if (nextState === "playing") {
        loading.hide();
        endStall();
        hideBuffering();
        state.isPlaying = true;
        updatePlayButton();
        updateMediaSession();
        confirmPlaybackRecovery(player, getReportedCurrentTime(player));
        if (!player.videoTrack) endSeekTransition();
        reportProgress();
      } else if (nextState === "paused") {
        endStall();
        hideBuffering();
        state.isPlaying = false;
        updatePlayButton();
        updateMediaSession();
        confirmPlaybackRecovery(player, getReportedCurrentTime(player));
        reportProgress();
      }
      danmaku.sync();
      postPlayerRuntimeLog(info.stateEvent, {
        state: nextState,
        reason: detail.reason || null,
        buffer: collectBufferState(player),
      });
    },
    onTime: updateTime,
    onFirstVideo: () => {
      loading.hide();
      if (seekTransition) endSeekTransition();
      else removeTransitionFrame();
      noteFirstFrame(player, meta, createdAt);
    },
    onAudioOutput: (output, detail) => {
      if (!kept()) handleAudioOutput(player, output, detail);
    },
    onEnded: () => finishPlayback(player),
    onError: (error) => {
      // Hidden, it says nothing: shown again, it is rebuilt where it was.
      if (kept()) {
        keptPlayer.fail(player, error);
        postPlayerRuntimeLog("kept_player_failed", { code: error?.code || null, error: error?.message || String(error) });
        return;
      }
      stopNetworkMonitor();
      endStall();
      console.error(`[${engine === "native" ? "native" : "mediabunny"}] Playback error:`, error);
      // The node answered 410: the stream ended while the page slept, or
      // the source dropped it. Recovery asks Yolo for a new one.
      if (error?.code === "SESSION_EXPIRED") postPlayerRuntimeLog("session_expired", { code: error.code, error: error.message });
      if (!schedulePlaybackRecovery(player, error)) {
        endSeekTransition({ immediate: true });
        showPlaybackError(error);
        realtime?.send({ type: "error", sessionId: state.sessionId, code: error.code || "PLAYBACK_FAILED", message: error.message });
      }
    },
  };

  if (engine === "native") {
    player = new NativeVideoPlayer({
      ...callbacks,
      hlsPath: native?.hls || "hls.js",
      // Audio renditions inside the stream can change the audio menu.
      onTracks: () => {
        if (state.player === player) onUpdateAudioUI();
      },
      // The sound turned off or on in the system's fullscreen player.
      onVolume: (volume) => {
        if (state.player !== player) return;
        state.isMuted = volume === 0;
        updateVolumeButton();
      },
      // Back from the system's fullscreen player (iPhone): the engine took
      // over its pause, play, or seek; the controls, subtitles, danmaku, and
      // the Hub follow at once.
      onPresentation: ({ fullscreen }) => {
        if (state.player !== player || fullscreen) return;
        lastUiPaintAt = 0;
        updateTime(player.getCurrentTime());
        danmaku.resize();
        updatePlayButton();
        updateMediaSession();
        reportProgress({ force: true });
        showControls();
      },
    });
  } else {
    player = new MediabunnyPlayer({
      ...callbacks,
      hlsStartSeconds: meta.__liveSeek ? 2 : undefined,
      faultInjection: getMediabunnyFaultInjection(),
    });
    player.setAudioGain(PLAYER_AUDIO_GAIN);
  }
  // Either engine, for diagnostics and end-to-end tests. In-car fault checks
  // call __yoloPlayer.player.injectVideoStall(ms) on the canvas engine.
  globalThis.__yoloPlayer = { player, engine };
  return player;
}

// --- Play / Stop -----------------------------------------------------

const container = document.getElementById("player-container");
const overlay = document.getElementById("overlay");
const controlsLayer = document.getElementById("controls");
const centerPlayButton = document.getElementById("btn-center-play");
const statusScreen = document.getElementById("status-screen");
const statusText = document.getElementById("status-text");
const subsPanel = document.getElementById("subs-panel");
const audioPanel = document.getElementById("audio-panel");

// --- Danmaku (Agent Note 2026-10-13-danmaku) ---------------------------

// This screen's settings, which the settings sheet and the Hub's `danmaku`
// message change too.
export const danmakuSettings = createDanmakuSettings();
const danmakuButton = document.getElementById("btn-danmaku");
export const danmaku = createDanmaku({
  canvas: document.getElementById("danmaku-layer"),
  playerContainer: container,
  // The playing engine's own position, read each animation frame.
  getTime: () => (state.player && !state.isLive ? state.player.getCurrentTime() : null),
  getFrames: () => state.player?.presentedFrames ?? null,
  settings: danmakuSettings,
  onAvailability: () => updateDanmakuButton(),
});

// The quick toggle, shown while the item has comments.
function updateDanmakuButton() {
  const on = danmakuSettings.get().enabled;
  danmakuButton.classList.toggle("hidden", !danmaku.available);
  danmakuButton.classList.toggle("active", on);
  danmakuButton.setAttribute("aria-pressed", String(on));
  danmakuButton.setAttribute("aria-label", on ? "Hide danmaku" : "Show danmaku");
}
danmakuSettings.subscribe(updateDanmakuButton);
danmakuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  danmakuSettings.update({ enabled: !danmakuSettings.get().enabled });
  showControls();
});

function setPlaybackControlsEnabled(enabled) {
  controlsLayer.inert = !enabled;
  controlsLayer.setAttribute("aria-hidden", String(!enabled));
  centerPlayButton.disabled = !enabled;
  centerPlayButton.setAttribute("aria-hidden", String(!enabled));
}

function capturePlaybackTransitionFrame(player) {
  const existing = container.querySelector(".playback-transition-frame");
  if (existing) return existing;
  // The canvas engine's canvas, or the <video> engine's current frame.
  const source = player?.canvas || player?.video;
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source?.width;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source?.height;
  if (!(source instanceof HTMLCanvasElement || source instanceof HTMLVideoElement) || !width || !height) return null;
  if (source instanceof HTMLVideoElement && source.readyState < 2) return null;

  const snapshot = document.createElement("canvas");
  snapshot.className = "playback-transition-frame";
  snapshot.width = width;
  snapshot.height = height;
  try {
    snapshot.getContext("2d", { alpha: false })?.drawImage(source, 0, 0);
  } catch {
    return null;
  }
  container.appendChild(snapshot);
  return snapshot;
}

function completeOptimisticSeekTransition({ immediate = false, keepFrame = false } = {}) {
  sessionRestartState.pending = false;
  sessionRestartState.transitionPending = false;
  setSeekTransitionPending(false);
  if (!keepFrame) removeTransitionFrame({ immediate });
}

function removeTransitionFrame({ immediate = false } = {}) {
  const snapshot = container.querySelector(".playback-transition-frame");
  if (!snapshot) return;
  if (immediate) {
    snapshot.remove();
    return;
  }
  snapshot.classList.add("leaving");
  const remove = () => snapshot.remove();
  snapshot.addEventListener("transitionend", remove, { once: true });
  setTimeout(remove, 250);
}

// Resize canvas when fullscreen or window size changes (debounced to avoid perf impact)
let resizeTimer = null;
function handleResize() {
  if (resizeTimer) return;
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    if (state.player?.resize) {
      try {
        state.player.resize(container.clientWidth, container.clientHeight);
      } catch {}
    }
    danmaku.resize();
    reportProgress();
  }, 150);
}
window.addEventListener("resize", handleResize, { passive: true });
globalThis.visualViewport?.addEventListener("resize", handleResize, { passive: true });
document.addEventListener("fullscreenchange", handleResize);
document.addEventListener("webkitfullscreenchange", handleResize);

export function showStatus(text) {
  statusText.textContent = text;
  statusScreen.style.display = "";
  overlay.classList.remove("hidden");
}

// --- Loading and errors on screen ----------------------------------------
// Waiting is a spinner over the last picture; what went wrong stays in the
// device events and /diag. Only an error nothing will fix by itself gets
// words: one sentence and a way to try again. A screen that no media path
// reaches gets the reason and each fix, and a button that turns the relay
// to automatic (media-dead-end.js).

// From a tap until the picture moves: the item's picture, dimmed, under the
// spinner, and no words unless the wait is long (loading.js). A seek or a
// recovery keeps the last picture under the spinner instead.
const loading = createLoadingScreen({
  poster: document.getElementById("loading-poster"),
  image: document.querySelector("#loading-poster img"),
  line: document.getElementById("loading-line"),
  showSpinner: showBuffering,
});

/** A tap, a resume after a reload, or a stream Yolo sent to the home screen. */
export function showLoading({ artwork = null } = {}) {
  hidePlaybackError();
  overlay.classList.add("hidden");
  loading.show({ artwork });
}

/** Yolo's stream arrived for this screen: its picture is awaited now. */
export function noteStreamArrived({ artwork = null } = {}) {
  if (!loading.active) showLoading({ artwork });
  loading.streaming();
}

const playbackErrorPanel = document.getElementById("playback-error");
const playbackErrorText = document.getElementById("playback-error-text");
const playbackErrorDetail = document.getElementById("playback-error-detail");
const playbackErrorFixes = document.getElementById("playback-error-fixes");
const playbackRelayButton = document.getElementById("btn-playback-relay");
const PLAYBACK_ERROR_TEXT = "This video can't play right now.";
const DEAD_END_TEXT = "No media path reaches this screen.";
let playbackErrorActions = null;

function showRecovering(player) {
  if (player) capturePlaybackTransitionFrame(player);
  overlay.classList.add("hidden");
  showBuffering();
}

/**
 * @param {Error} error  Kept for telemetry; the screen shows one sentence.
 * @param {{ retry?: () => void, back?: () => void }} [actions]
 */
export function showPlaybackError(error, { retry = () => void retryPlayback(), back = () => void stop({ keep: false }) } = {}) {
  hideBuffering();
  loading.hide();
  const deadEnd = mediaDeadEnd(error);
  playbackErrorActions = { retry, back, relay: deadEnd ? () => void turnOnRelay(retry) : null };
  playbackErrorText.textContent = deadEnd ? DEAD_END_TEXT : PLAYBACK_ERROR_TEXT;
  playbackErrorDetail.textContent = deadEnd?.reason ?? "";
  playbackErrorFixes.replaceChildren(...(deadEnd?.fixes ?? []).map((fix) => Object.assign(document.createElement("li"), { textContent: fix.text })));
  playbackErrorDetail.classList.toggle("hidden", !deadEnd?.reason);
  playbackErrorFixes.classList.toggle("hidden", !deadEnd);
  playbackRelayButton.classList.toggle("hidden", !deadEnd?.fixes.some((fix) => fix.action === "relay"));
  playbackErrorPanel.classList.toggle("dead-end", Boolean(deadEnd));
  playbackErrorPanel.classList.remove("hidden");
  const detail = { code: error?.apiCode || error?.code || null, error: error?.message || String(error) };
  postPlayerRuntimeLog("playback_error_shown", detail);
  notePlaybackDiagnostics({ lastError: { ...detail, at: new Date().toISOString() } }, { event: { type: "playback_error_shown", ...detail }, now: true });
}

export function hidePlaybackError() {
  playbackErrorPanel.classList.add("hidden");
  playbackErrorActions = null;
}

// "Turn on the relay": with the owner's passkey session on this browser,
// the relay becomes automatic and the same item plays again by the relay;
// without one, settings open, where the owner signs in (or, in the car,
// scans the code to do it on a phone).
async function turnOnRelay(retry) {
  showBuffering();
  try {
    await owner.setMedia({ relay: "auto" });
  } catch (error) {
    hideBuffering();
    if (error?.status === 401 || error?.status === 403) {
      navigate("/settings");
      return;
    }
    showPlaybackError(error, { retry });
    return;
  }
  postPlayerRuntimeLog("relay_turned_on", { from: "dead_end" });
  await mediaPaths?.setRelayMode("auto");
  retry();
}

for (const [id, action] of [["btn-playback-relay", "relay"], ["btn-playback-retry", "retry"], ["btn-playback-back", "back"]]) {
  document.getElementById(id)?.addEventListener("click", (event) => {
    event.stopPropagation();
    const run = playbackErrorActions?.[action];
    hidePlaybackError();
    run?.();
  });
}

// "Try again": the same item again, never a stream with nothing left to
// play (planRetry). A rebuild of the failed session while Yolo holds it;
// otherwise, or when Yolo refuses the rebuild because it ended that session
// meanwhile, a new play of the item on this device.
async function retryPlayback() {
  const request = playbackRecoveryState.request
    || (state.source ? { meta: { source: state.source, sessionId: state.sessionId } } : null);
  if (!request?.meta?.source) {
    void stop({ keep: false });
    return;
  }
  resetPlaybackRecovery();
  state.playbackIntent = "playing";
  updatePlayButton();
  showRecovering(state.player);
  const plan = planRetry({
    position: getPlaybackRecoveryPosition(state.player),
    duration: state.duration,
    isLive: state.isLive,
    sessionId: request.meta.sessionId ?? null,
    hubSessionId: state.hub?.sessionId ?? null,
  });
  postPlayerRuntimeLog("playback_retry_requested", plan);
  try {
    if (plan.rebuild) {
      const requested = await requestFreshPlaybackSession(request, plan.startTime, { label: "Retry" });
      if (requested === true) {
        armPlaybackRecoveryConfirmation(1, plan.startTime, state.player);
        return;
      }
      // Skipped: another stream replaced this one (its `load` is here or on
      // the way), unless Yolo has no session left to replace it with.
      if (state.sessionId !== request.meta.sessionId || state.hub?.sessionId) return;
    }
    await playOnThisDevice({ source: request.meta.source }, { startTime: plan.startTime });
  } catch (error) {
    showPlaybackError(error);
  }
}

// --- Tracks ------------------------------------------------------------

async function loadSelectedSubtitles() {
  const selected = new Set(state.tracks.selected?.subtitles || []);
  const tracks = state.tracks.subtitles.filter((track) => selected.has(track.id) && track.url);
  const origin = state.mediaOrigin || location.origin;
  danmaku.setSubtitles(tracks.length > 0);
  const results = await Promise.all(tracks.map((track) => loadSubtitleTrack(track.id, new URL(track.url, origin).href)));
  if (results.includes(false)) showPlaybackNotice("A subtitle could not be loaded");
  // The same subtitles for the system's fullscreen player (the <video>
  // engine on iPhone), where Yolo's overlay cannot show. A burned-in track is
  // in the picture already.
  state.player?.setCaptions?.(state.tracks.subtitles
    .filter((track) => selected.has(track.id) && track.delivery !== "burn")
    .map((track) => ({ id: track.id, label: track.name || track.language || "", language: track.language || "", cues: subtitleCues(track.id) })));
}

// Yolo changed the subtitles without a new stream (a `tracks` message).
export function applyTracks(tracks, selected) {
  const record = state.player ? null : keptPlayer.current;
  if (record) {
    // Hidden: they go with the kept player, and load when it shows again.
    if (tracks) record.tracks = { ...tracks, selected: selected || tracks.selected || NO_TRACKS.selected };
    else if (selected) record.tracks = { ...record.tracks, selected };
    record.reloadSubtitles = true;
    return;
  }
  if (tracks) state.tracks = { ...tracks, selected: selected || tracks.selected || NO_TRACKS.selected };
  else if (selected) state.tracks = { ...state.tracks, selected };
  disableExternalSubtitle();
  void loadSelectedSubtitles();
  onUpdateSubsUI();
  onUpdateAudioUI();
}

export async function play(url, title, meta = {}) {
  const isOptimisticSeek = meta.__optimisticSeek === true;
  const isRecovery = meta.__recovery === true;
  hidePlaybackError();
  // A seek's stream starts where the owner asked last (a later seek may
  // have moved the target while it was on its way).
  const seekTo = meta.__loadReason === "seek" ? seekStreamStart(Math.max(0, Number(meta.startTime) || 0)) : null;
  const seeksBefore = seeksAsked;
  if (seekTo) meta = { ...meta, startTime: seekTo.startTime };
  invalidatePlexSeekSession({ preserveTransition: isOptimisticSeek });
  // A seek that asks for a stream of its own while this one loads overtakes
  // it: this stream neither plays nor ends that seek's transition, and the
  // seeks after it move that stream's target (restartSessionForSeek).
  const restartsBefore = sessionRestartState.requestId;
  const overtaken = () => sessionRestartState.requestId !== restartsBefore;
  lostLoad = null;
  itemRejoin = null;
  setLeftStream(null);
  finished = null;
  if (isOptimisticSeek) {
    sessionRestartState.transitionPending = true;
    setSeekTransitionPending(true);
  } else {
    setSeekTransitionPending(false);
    // A recovery keeps the last picture until the new stream shows one.
    completeOptimisticSeekTransition({ immediate: true, keepFrame: isRecovery });
  }
  const playbackSessionId = playbackGeneration.begin();
  streamLoading = { sessionId: meta.sessionId ?? null, generation: playbackSessionId };
  // Another stream on this screen replaces a kept player.
  const keptRecord = keptPlayer.take();
  disableExternalSubtitle();
  clearSeekWatchdog();
  const isCurrentPlayback = () => playbackGeneration.isCurrent(playbackSessionId);
  state.playbackIntent = meta.autoplay === false ? "paused" : "playing";
  if (!isRecovery) {
    resetPlaybackRecovery();
    const requestMeta = { ...meta };
    delete requestMeta.__recovery;
    playbackRecoveryState.request = { url, title, meta: requestMeta };
  } else if (playbackRecoveryState.request && meta.sessionId) {
    // The recovered stream is the one to rebuild next time.
    playbackRecoveryState.request = {
      ...playbackRecoveryState.request,
      url,
      meta: {
        ...playbackRecoveryState.request.meta,
        sessionId: meta.sessionId, mediaSource: meta.mediaSource, tracks: meta.tracks, origin: meta.origin ?? null, network: meta.network ?? null,
      },
    };
  }

  let player = null;
  // The engine for this stream: the profile's choice now (profile.js).
  const choice = engineChoice();
  const engine = ENGINES[choice.engine] ? choice.engine : "canvas";
  try {
    stopNetworkMonitor();
    ensureLongTaskObserver();
    currentEngine = ENGINES[engine];
    resetPlayerMetrics();
    resetStutterTelemetry();
    resetDecodeHealthState();
    resetPlayerRuntimeLogState();
    playerRuntimeLogState.playbackSessionId = playbackSessionId;

    stopProgressReporting();
    stopStutterTelemetryReporting();
    stopPlayerHealthHeartbeat();
    stopDecodeHealthMonitoring();
    const previousPlayer = state.player;
    const transitionFrame = isOptimisticSeek || isRecovery
      ? capturePlaybackTransitionFrame(previousPlayer)
      : null;
    state.player = null;
    state.isPlaying = false;
    await disposePlayer(previousPlayer);
    if (keptRecord) await discardKept(keptRecord, "another_stream");
    if (!isCurrentPlayback()) return;

    if (transitionFrame) {
      for (const child of [...container.children]) {
        if (child !== transitionFrame) child.remove();
      }
    } else {
      container.innerHTML = "";
    }
    state.currentTime = meta.startTime || 0;
    state.isLive = Boolean(meta.isLive);
    state.liveDvrAvailable = Boolean(meta.liveDvr?.available);
    state.liveStartTime = 0;
    state.liveEdgeTime = 0;
    state.duration = state.isLive ? 0 : meta.duration || 0;
    state.sessionId = meta.sessionId || null;
    state.source = meta.source || null;
    state.tracks = meta.tracks || NO_TRACKS;
    const direct = (meta.network === "lan" || meta.network === "wan") && meta.origin;
    state.mediaOrigin = mediaOriginOf(direct ? meta.origin : null);
    state.streamNetwork = direct ? meta.network : "relay";
    danmaku.load({
      key: sourceKeyOf(meta.source),
      url: meta.comments ? new URL(meta.comments, state.mediaOrigin).href : null,
      live: state.isLive,
      start: state.currentTime,
    });
    pathFailureNoted = false;
    lastUiPaintAt = 0;
    updateTimeDisplay();
    updateProgress(state.duration > 0 ? state.currentTime / state.duration : 0);
    onUpdateSubsUI();
    subsPanel.classList.add("hidden");
    audioPanel.classList.add("hidden");
    mediaTitle.textContent = title || "";

    setPlaybackControlsEnabled(true);
    overlay.classList.add("hidden");
    if (isOptimisticSeek) setSeekTransitionPending(true);
    else showBuffering();
    // A reload on /play asks Yolo what this device was playing.
    navigate("/play");

    const absUrl = new URL(url, state.mediaOrigin).href;
    player = createEnginePlayer(meta, { engine, native: choice.native, overtaken });
    if (!isCurrentPlayback()) {
      await disposePlayer(player);
      return;
    }
    state.player = player;
    if (streamLoading?.generation === playbackSessionId) streamLoading = null;
    currentStream = { player, url: absUrl, meta, settled: false };
    if (engine === "native") attachPictureControls(player);
    else detachPictureControls();
    setSeekActions(engine === "native");
    noteMediaArtwork(engine === "native" ? meta.thumbnail : null, isCurrentPlayback);
    quality.load({ profile: meta.streamProfile, limits: meta.limits, isLive: meta.isLive, key: sourceKeyOf(meta.source) });
    startNetworkMonitor(player, meta);
    startProgressReporting();
    startStutterTelemetryReporting();
    startPlayerHealthHeartbeat();
    startDecodeHealthMonitoring(player);

    console.log(`[player] Loading with ${engine === "native" ? "<video>" : "Mediabunny"}:`, absUrl);
    reportDecodeInfo({
      options: { engine: engine === "native" ? `native-video:${player.hlsPath}` : "mediabunny", clock: currentEngine.clock },
      capabilities: {
        crossOriginIsolated: globalThis.crossOriginIsolated,
        hasVideoDecoder: CAPABILITY_PROFILE.hasVideoDecoder,
        hasAudioDecoder: CAPABILITY_PROFILE.hasAudioDecoder,
        hasAudioWorklet: typeof AudioWorkletNode === "function",
      },
      decodePreference: currentEngine.decodePreference,
    });
    const profile = meta.streamProfile || {};
    await player.load(resolveDelivery(meta.mediaSource, state.mediaOrigin) || absUrl, {
      isLive: meta.isLive || false,
      startTime: state.currentTime,
      duration: state.duration,
      // For the <video> engine: where a trimmed stream begins, and the
      // stream's bitrate to turn buffer growth into throughput.
      trimToStart: meta.trimToStart === true,
      mediaKbps: (Number(profile.videoKbps) || 0) + (Number(profile.audioKbps) || 0),
    });
    if (!isCurrentPlayback() || state.player !== player) {
      await disposePlayer(player);
      return;
    }

    if (!state.isLive && !state.duration) {
      const duration = player.getDuration();
      if (duration > 0n) state.duration = Number(duration) / 1000;
    }
    if (state.isLive) {
      const timeline = player.getLiveTimeline();
      if (timeline) {
        state.liveDvrAvailable = true;
        state.liveStartTime = timeline.startTime;
        state.liveEdgeTime = timeline.edgeTime;
        if (!state.currentTime) state.currentTime = player.getCurrentTime();
        updateProgress((state.currentTime - state.liveStartTime) / (state.liveEdgeTime - state.liveStartTime));
      }
    }
    updateTimeDisplay();

    // Text subtitles Yolo selected for this stream (saved preferences).
    await loadSelectedSubtitles();
    if (!isCurrentPlayback() || state.player !== player) {
      await disposePlayer(player);
      return;
    }

    // The volume is the owner's choice; whether the browser lets the page
    // make sound at all is the engine's audio output (handleAudioOutput).
    player.setVolume(state.isMuted ? 0 : 1);
    updateVolumeButton();

    // Overtaken by a newer seek, it waits paused for that seek's stream
    // (which, if it never comes, plays this one on: failSeekRestart).
    if (state.playbackIntent === "playing" && !overtaken()) {
      await player.play();
      if (!isCurrentPlayback() || state.player !== player) {
        await disposePlayer(player);
        return;
      }
      recordAutoplayResult(player, meta);
    } else {
      state.isPlaying = false;
      hideBuffering();
    }
    onUpdateAudioUI();
    updatePlayButton();
    showControls();
    updateMediaSession();
    if (currentStream?.player === player) currentStream.settled = true;
    // The owner's last seek went before where this stream starts, unless
    // the owner (or an agent) asked for another place while it loaded.
    if (seekTo?.then != null && state.player === player && seeksAsked === seeksBefore) seekToTime(seekTo.then, { settled: true });

  } catch (e) {
    console.error("[player] Playback error:", e);
    if (streamLoading?.generation === playbackSessionId) streamLoading = null;
    await disposePlayer(player);
    if (!isCurrentPlayback()) return;
    stopProgressReporting();
    stopStutterTelemetryReporting();
    stopPlayerHealthHeartbeat();
    // Tear down partially initialized players so retry loops do not retain decoders or canvases.
    stopDecodeHealthMonitoring();
    if (state.player === player) state.player = null;
    state.isPlaying = false;
    hideBuffering();
    updatePlayButton();
    if (!schedulePlaybackRecovery(null, e)) {
      removeTransitionFrame({ immediate: true });
      showPlaybackError(e);
    }
  }
}

let leavePlaybackPromise = null;

// The stream play() is starting, until its player is the screen's: the old
// player may still be going away meanwhile, so `state.player` is null.
let streamLoading = null;

/**
 * True while play() starts a stream of `sessionId` (a `load` for it came)
 * and its player is not on screen yet: a welcome that names that session
 * has nothing to resume (main.js).
 */
export function streamLoadingFor(sessionId) {
  return Boolean(sessionId) && !state.player && streamLoading?.sessionId === sessionId && playbackGeneration.isCurrent(streamLoading.generation);
}

// What leaving the player and keeping it both clear from the screen.
function clearPlayerScreen() {
  state.player = null;
  state.isPlaying = false;
  state.playbackIntent = "paused";
  state.audioBlocked = false;
  showTapForSound(false);
  updateVolumeButton();
  state.isLive = false;
  state.liveDvrAvailable = false;
  state.liveStartTime = 0;
  state.liveEdgeTime = 0;
  state.sessionId = null;
  state.source = null;
  state.tracks = NO_TRACKS;
  state.currentTime = 0;
  state.duration = 0;
  currentStream = null;
  lastUiPaintAt = 0;
  subsPanel.classList.add("hidden");
  audioPanel.classList.add("hidden");
  onUpdateAudioUI();
  updatePlayButton();
  updateTimeDisplay();
  updateProgress(0);
  mediaTitle.textContent = "";
  setPlaybackControlsEnabled(false);
  overlay.classList.remove("hidden");
  document.getElementById("app").classList.remove("controls-visible");
  hideBuffering();
  loading.hide();
}

// `keep`: Back, which keeps a player that can go on behind the home screen
// (kept-player.js); otherwise, and for any other way out, the stream stops.
// `release` says why a kept player goes too.
async function leavePlaybackNow({ report = true, keep = false, release = "stopped" } = {}) {
  const player = state.player;
  // Back with the player kept already: nothing else is on screen.
  if (keep && !player && keptPlayer.current) return;
  if (keep && player && canKeep(player)) {
    keepPlayer(player);
    return;
  }
  keptPlayer.release(release);
  playbackGeneration.cancel();
  clearSeekWatchdog();
  invalidatePlexSeekSession();
  lostLoad = null;
  itemRejoin = null;
  completeOptimisticSeekTransition({ immediate: true });
  resetPlaybackRecovery({ clearRequest: true });
  endStall();
  clearScheduledStutterTelemetryFlush();
  flushStutterTelemetry("stop");
  // Leaving the video stops it in Yolo too, at the position reached, also
  // when the connection loses the report (leftStream).
  if (report && state.sessionId) {
    setLeftStream({ sessionId: state.sessionId, position: Number(getReportedCurrentTime().toFixed(3)) });
    reportProgress({ force: true, status: "idle" });
  }
  stopProgressReporting();
  stopStutterTelemetryReporting();
  stopPlayerHealthHeartbeat();
  stopDecodeHealthMonitoring();
  stopNetworkMonitor();
  // An error about this player goes with it; one shown without a player (a
  // resume that failed) stays over the home screen.
  if (player) hidePlaybackError();
  detachPictureControls();
  exitPictureModes();
  container.innerHTML = "";
  clearPlayerScreen();
  // Clear subtitle cues on stop so large parsed VTT arrays are released as soon as playback ends.
  disableExternalSubtitle();
  danmaku.setSubtitles(false);
  danmaku.unload();
  await disposePlayer(player);
}

export function leavePlayback(options) {
  if (leavePlaybackPromise) return leavePlaybackPromise;
  leavePlaybackPromise = leavePlaybackNow(options).finally(() => {
    leavePlaybackPromise = null;
  });
  return leavePlaybackPromise;
}

// Back (the button, a swipe down, the browser's): home, with the player
// kept for the now-playing bar; the router leaves the player (main.js).
// `keep: false` stops the stream (an error's Back, a stop): the item still
// waits in the bar, and plays again with a new stream.
export async function stop({ keep = true } = {}) {
  if (!keep) await leavePlayback();
  if (!navigate("/")) await leavePlayback({ keep });
}

// --- The kept player (Agent Note 2026-10-11-yolo-owns-progress-and-resume) --
// Back pauses and hides the player but keeps the engine, its buffers, and
// the node's session, as YouTube keeps a video in its miniplayer; the
// now-playing bar shows it again and it plays on in place, with no new
// stream. kept-player.js decides when it goes.

let currentStream = null; // { player, url, meta, settled }: the stream on screen
const KEPT_FRAME_WIDTH = 320;

const keptPlayer = createKeptPlayer({
  // `idle` with `keep` while kept: the Hub keeps the item paused here,
  // marked left, and leaves the node's session running. Plain `idle` when
  // this page lets it go: the Hub stops the session.
  report: (record, { keep }) => realtime?.send({
    type: "report",
    sessionId: record.sessionId,
    status: "idle",
    position: Number((Number.isFinite(record.seekTo) ? record.seekTo : record.position).toFixed(3)),
    ...(keep ? { keep: true } : {}),
  }),
  dispose: (record, reason) => void discardKept(record, reason),
});

function discardKept(record, reason) {
  postPlayerRuntimeLog("kept_player_released", { reason, hiddenMs: Date.now() - record.keptAt });
  record.frame = null;
  // A page going away paints nothing more.
  if (reason !== "unload") onKeptChange();
  return disposePlayer(record.player);
}

// A player that can go on in place: loaded and settled, not live (a live
// window moves on), and nothing on its way to replace its stream.
function canKeep(player) {
  return currentStream?.player === player && currentStream.settled
    && Boolean(state.sessionId) && !state.isLive
    && typeof player.suspend === "function"
    && !["error", "ended", "stopped"].includes(player.getStatus?.())
    && playbackErrorPanel.classList.contains("hidden")
    && !playbackRecoveryState.retryTimer && !streamRecoveryPending() && !qualityRequest
    && !sessionRestartState.pending && !sessionRestartState.transitionPending;
}

// The paused picture for the now-playing bar, small: drawn from the engine's
// own canvas or <video> as it leaves, with no request.
function captureKeptFrame(player) {
  const source = player?.canvas || player?.video;
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source?.width;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source?.height;
  if (!(source instanceof HTMLCanvasElement || source instanceof HTMLVideoElement) || !width || !height) return null;
  if (source instanceof HTMLVideoElement && source.readyState < 2) return null;
  const scale = Math.min(1, KEPT_FRAME_WIDTH / width);
  const frame = document.createElement("canvas");
  frame.className = "np-frame";
  frame.dataset.source = "local";
  frame.setAttribute("aria-hidden", "true");
  frame.width = Math.max(1, Math.round(width * scale));
  frame.height = Math.max(1, Math.round(height * scale));
  try {
    frame.getContext("2d", { alpha: false })?.drawImage(source, 0, 0, frame.width, frame.height);
  } catch {
    return null;
  }
  return frame;
}

function keepPlayer(player) {
  onOwnAction("playback");
  forgetFinished();
  playbackGeneration.cancel();
  clearSeekWatchdog();
  invalidatePlexSeekSession();
  completeOptimisticSeekTransition({ immediate: true });
  const request = playbackRecoveryState.request;
  resetPlaybackRecovery({ clearRequest: true });
  endStall();
  clearScheduledStutterTelemetryFlush();
  flushStutterTelemetry("stop");
  stopProgressReporting();
  stopStutterTelemetryReporting();
  stopPlayerHealthHeartbeat();
  stopDecodeHealthMonitoring();
  stopNetworkMonitor();
  const position = getReportedCurrentTime(player);
  const frame = captureKeptFrame(player);
  // Paused, then hidden: no frame drawn or decoded, nothing fetched.
  void player.pause().catch(() => {});
  player.suspend();
  detachPictureControls();
  exitPictureModes();
  // The engine's element stays in place, hidden: WebKit tears down a
  // detached <video>'s native HLS and buffers it again when it returns.
  const element = container.querySelector("[data-engine]");
  container.replaceChildren(...(element ? [element] : []));
  element?.setAttribute("data-kept", "");
  clearSubtitles();
  danmaku.hide();
  const diagnostics = globalThis.__yoloPlayer?.player === player ? globalThis.__yoloPlayer : { player, engine: currentEngine.name };
  delete globalThis.__yoloPlayer;
  keptPlayer.keep({
    player,
    element,
    diagnostics,
    frame,
    engine: currentEngine.name,
    sessionId: state.sessionId,
    source: state.source,
    title: mediaTitle.textContent,
    position,
    duration: state.duration,
    tracks: state.tracks,
    mediaOrigin: state.mediaOrigin,
    network: state.streamNetwork,
    url: currentStream.url,
    meta: currentStream.meta,
    request,
  });
  postPlayerRuntimeLog("player_kept", { position, engine: currentEngine.name, frame: Boolean(frame) });
  clearPlayerScreen();
  onKeptChange();
}

/**
 * The kept player for the now-playing bar (remote.js): its session, where
 * it was left, and its paused picture; null when none is kept.
 */
export function keptView() {
  const record = keptPlayer.current;
  return record ? { sessionId: record.sessionId, position: record.position, frame: record.frame, tracks: record.tracks } : null;
}

/**
 * True while this screen has left `sessionId` without keeping its player
 * and Yolo has not yet said so: a welcome naming it has nothing to resume.
 */
export function streamLeftFor(sessionId) {
  return Boolean(sessionId) && leftStream?.sessionId === sessionId;
}

/**
 * The stream on screen played to its end here and its `ended` may not have
 * reached Yolo, and nothing played, paused, or sought it since (`finished`):
 * the welcome still naming it means Yolo never heard `ended`.
 */
export function finishedOnScreen() {
  return Boolean(finished) && !finished.heard && finished.player === state.player && finished.sessionId === state.sessionId;
}

/** A welcome tells the Hub again that this screen keeps its player. */
export function remindKept() {
  keptPlayer.remind();
}

/**
 * The Hub's playback state, from a broadcast or a welcome: a kept player
 * that playback left behind (another item, another screen, a stop) goes.
 * A welcome (a reconnect, never a broadcast) also, when the Hub still marks
 * this screen's item kept but this page has no player (it was reloaded),
 * lets the node's session go; and it says again that this screen left a
 * stream, when the Hub still has it playing here. The welcome tells the Hub
 * again that a player is kept itself (remindKept, main.js), after what the
 * welcome changed in it.
 */
export function noteHubState(hub, { welcome = false } = {}) {
  keptPlayer.note({ type: "state", hub, self: state.deviceId });
  if (leftStream && (!hub || hub.deviceId !== state.deviceId || hub.sessionId !== leftStream.sessionId || hub.leftAt)) setLeftStream(null);
  if (!welcome || keptPlayer.current) return;
  if (leftStream && !state.player) {
    realtime?.send({ type: "report", sessionId: leftStream.sessionId, status: "idle", position: leftStream.position });
  } else if (hub?.kept && hub.deviceId === state.deviceId && hub.sessionId && !state.player) {
    realtime?.send({ type: "report", sessionId: hub.sessionId, status: "idle", position: Math.max(0, Number(hub.position) || 0) });
  }
}

/** Playback moved to another screen, or stopped: a kept player goes. */
export function releaseKept(reason) {
  keptPlayer.release(reason);
}

/**
 * Shows the kept player again and plays on in place: the now-playing bar,
 * or a remote's or an agent's resume. False when none is kept (for
 * `sessionId`). Called inside the tap where there is one: the canvas
 * engine's audio output starts again before anything is awaited.
 */
export function reopenKept({ sessionId = null, autoplay = true, reason = "bar" } = {}) {
  const current = keptPlayer.current;
  if (!current || state.player || (sessionId && current.sessionId !== sessionId)) return false;
  const record = keptPlayer.take();
  const { player } = record;
  player.wake();
  currentEngine = ENGINES[record.engine] || ENGINES.canvas;
  state.player = player;
  state.sessionId = record.sessionId;
  state.source = record.source;
  state.tracks = record.tracks;
  state.duration = record.duration;
  state.currentTime = record.position;
  state.isLive = false;
  state.mediaOrigin = record.mediaOrigin;
  state.streamNetwork = record.network;
  state.playbackIntent = autoplay ? "playing" : "paused";
  playbackRecoveryState.request = record.request;
  currentStream = { player, url: record.url, meta: record.meta, settled: true };
  pathFailureNoted = false;
  lastUiPaintAt = 0;
  globalThis.__yoloPlayer = record.diagnostics;
  hidePlaybackError();
  if (record.element) {
    record.element.removeAttribute("data-kept");
    container.replaceChildren(record.element);
  }
  if (record.engine === "native") attachPictureControls(player);
  setSeekActions(record.engine === "native");
  mediaTitle.textContent = record.title;
  setPlaybackControlsEnabled(true);
  overlay.classList.add("hidden");
  navigate("/play");
  updateTimeDisplay();
  updateProgress(state.duration > 0 ? state.currentTime / state.duration : 0);
  onUpdateSubsUI();
  onUpdateAudioUI();
  updateVolumeButton();
  if (record.reloadSubtitles) {
    disableExternalSubtitle();
    void loadSelectedSubtitles();
  } else {
    renderSubtitle(state.currentTime);
  }
  danmaku.sync(state.currentTime);
  startNetworkMonitor(player, record.meta);
  startProgressReporting();
  startStutterTelemetryReporting();
  startPlayerHealthHeartbeat();
  startDecodeHealthMonitoring(player);
  // The sound as the engine has it: muted by the browser, "Tap for sound"
  // shows, and the tap that showed the player unmutes it.
  handleAudioOutput(player, player.audioOutputState, { hasVideo: Boolean(player.videoTrack) });
  if (state.audioBlocked && navigator.userActivation?.isActive) void player.enableAudioOutput?.().catch(() => {});
  updatePlayButton();
  // The controls show for a moment, then fade as they do while playing.
  showControls();
  updateMediaSession();
  onKeptChange();

  const path = () => mediaPaths?.network() ?? null;
  const plan = reopenPlan(record, { now: Date.now(), path: path() });
  postPlayerRuntimeLog("kept_player_shown", { reason, hiddenMs: Date.now() - record.keptAt, plan: plan.action, why: plan.why ?? null });
  if (plan.action === "resume") {
    goOnInPlace(player, plan.startTime);
    return true;
  }
  void (async () => {
    let next = plan;
    if (plan.action === "check") {
      // Hidden a while: ask the node whether the stream still answers.
      showBuffering();
      next = await planReopen(record, { now: Date.now(), path: path(), probe: () => probeStreamSession(record.url) });
      if (state.player !== player) return;
      hideBuffering();
    }
    if (next.action === "resume") goOnInPlace(player, next.startTime);
    else await rebuildKept(player, next);
  })();
  return true;
}

// In place: the same engine and buffers, at the same position, or where a
// seek while hidden moved it (there first, then on).
function goOnInPlace(player, startTime) {
  const playOn = () => {
    if (state.player === player && state.playbackIntent === "playing") void player.play().catch(() => {});
  };
  const at = getReportedCurrentTime(player);
  const range = player.getSeekableRange?.() || null;
  if (Math.abs(startTime - at) <= 0.5) {
    playOn();
  } else if (shouldRestartSessionForSeek({ sessionId: state.sessionId, targetTime: startTime, seekableStartTime: range?.start })) {
    // Before what this stream can seek to: a new session there.
    seekToTime(startTime);
  } else {
    state.currentTime = startTime;
    updateTimeDisplay();
    if (state.duration > 0) updateProgress(startTime / state.duration);
    postPlayerRuntimeLog("seek_requested", { label: "kept", fromTime: at, targetTime: startTime, expectedToPlay: state.playbackIntent === "playing" });
    player.seek(BigInt(Math.floor(startTime * 1000))).then(playOn, (error) => {
      if (state.player !== player) return;
      const seekError = error instanceof Error ? error : new Error(String(error));
      seekError.code ||= "SEEK_FAILED";
      if (!schedulePlaybackRecovery(player, seekError, { startTime })) showPlaybackError(seekError);
    });
  }
  reportProgress({ force: true });
}

// The kept stream cannot go on (its session ended while hidden, the screen
// left its path, or its engine failed): the recovery's request for a new
// stream of the same item at the same position, with the picture kept
// until the new stream plays. The tracks are the item's saved ones.
async function rebuildKept(player, plan) {
  postPlayerRuntimeLog("kept_player_rebuild", { why: plan.why, startTime: plan.startTime });
  showRecovering(player);
  try {
    const requested = await requestFreshPlaybackSession(playbackRecoveryState.request, plan.startTime);
    if (requested === true) {
      armPlaybackRecoveryConfirmation(1, plan.startTime, player);
      return;
    }
    if (requested === "skipped" || state.player !== player) return;
    await playOnThisDevice({ source: state.source }, { startTime: plan.startTime });
  } catch (error) {
    if (state.player !== player) return;
    if (!schedulePlaybackRecovery(player, error, { startTime: plan.startTime })) showPlaybackError(error);
  }
}

// The page goes away (not into the back-forward cache): the kept player
// goes, and the Hub stops the node's session.
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) keptPlayer.note({ type: "unload" });
});

// --- MediaSession action handlers ------------------------------------

// Seeking from the lock screen or a phone's notification, for the web
// profile's <video> engine; the car's media keys keep play, pause, and stop.
let seekActionsSet = false;

function setSeekActions(enabled) {
  if (!("mediaSession" in navigator) || enabled === seekActionsSet) return;
  seekActionsSet = enabled;
  const handlers = {
    seekbackward: (details) => seekHere(getReportedCurrentTime() - (Number(details?.seekOffset) || 10)),
    seekforward: (details) => seekHere(getReportedCurrentTime() + (Number(details?.seekOffset) || 10)),
    seekto: (details) => {
      if (Number.isFinite(details?.seekTime)) seekHere(details.seekTime);
    },
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, enabled ? handler : null);
    } catch {
      // The browser does not offer this action.
    }
  }
}

function noteMediaArtwork(url, isCurrent) {
  mediaArtwork = null;
  if (!url) return;
  artworkSource(url).then((source) => {
    if (!isCurrent()) return;
    mediaArtwork = source;
    updateMediaSession();
  }, () => {});
}

export function initMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", () => {
    if (state.player && state.playbackIntent !== "playing") {
      forgetFinished();
      state.playbackIntent = "playing";
      state.player.play().catch(() => {});
      updatePlayButton();
      updateMediaSession();
    }
  });
  navigator.mediaSession.setActionHandler("pause", () => {
    if (state.player && state.playbackIntent === "playing") {
      forgetFinished();
      state.playbackIntent = "paused";
      onOwnAction("playback");
      state.player.pause().catch(() => {});
      state.isPlaying = false;
      updatePlayButton();
      updateMediaSession();
    }
  });
  navigator.mediaSession.setActionHandler("stop", () => {
    void stop({ keep: false }).catch((error) => console.error("[player] Stop failed:", error));
  });
}
