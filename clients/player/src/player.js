import "./player-overlays.css";
import { state } from "./state.js";
import { PlaybackGeneration } from "./playback-generation.js";
import {
  showControls, updateTimeDisplay, updateProgress, updatePlayButton,
  updateVolumeButton, showBuffering, hideBuffering, isDraggingProgress,
  setSeekTransitionPending, showPlaybackNotice, setMediaTitle, mediaTitleText, showTapForSound, updateSpeedUI,
} from "./controls.js";
import { holdSpeed, MIN_SPEED, speedLimits } from "./playback-speed.js";
import { createKeptPlayer, planReopen, probeStreamSession, reopenPlan } from "./kept-player.js";
import { renderSubtitle, loadSubtitleTrack, disableExternalSubtitle, clearSubtitles, subtitleCues, onGrowingSubtitleFailure } from "./subtitles.js";
import { loadSubtitleTracks, subtitleFailureNotice } from "./subtitle-loading.js";
import { createDanmaku } from "./danmaku.js";
import { createDanmakuSettings } from "./danmaku-settings.js";
import { navigate } from "./router.js";
import { MediabunnyPlayer } from "./engine/mediabunny-player.js";
import { NativeVideoPlayer } from "./engine/native-video-player.js";
import { attachPictureControls, detachPictureControls, exitPictureModes } from "./picture-controls.js";
import { advanceAfterEnd, endedMessage, paintUpNext } from "./up-next.js";
import {
  endStarting, hideLoading, hidePlaybackError, initPlayerScreens, playbackErrorShown, showPlaybackError, showStarting,
} from "./player-screens.js";
import { artworkSource } from "./artwork.js";
import { createQualityController, qualitySample } from "./quality.js";
import { physicalViewport } from "./display-scale.js";
import { playOnThisDevice, requestStream, streamRecoveryPending } from "./playback.js";
import { isNetworkFailure } from "./network.js";
import { recordDeviceEvent } from "./telemetry/device-events.js";
import { bufferState, droppedFrames, readStats, summarizeStats } from "./telemetry/engine-stats.js";
import { watchMediaRequests } from "./telemetry/media-requests.js";
import { logPlayerEvent, setLoggedStream, setPlayerLogContext } from "./telemetry/player-log.js";
import * as telemetry from "./telemetry/playback-telemetry.js";
import { describeCanvas, describeVideo, describeViewport } from "./telemetry/screen.js";
import { createFreezeWatch } from "./video-freeze.js";
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

// The media path a stream request of this screen names (playback.js): the
// paths' choice, where none works the relay, which Yolo then takes.
const requestPath = () => (mediaPaths ? mediaPaths.network() ?? "relay" : undefined);

const NO_TRACKS = Object.freeze({ subtitles: [], audio: [], selected: { subtitles: [], audio: null } });
const sourceKeyOf = (source) => (source?.plugin && source.id != null ? `${source.plugin}:${source.id}` : null);

let lastUiPaintAt = 0;

const UI_PAINT_INTERVAL_MS = 250;
const PLAYER_AUDIO_GAIN = 12.0;
// Agent Note 2026-10-07-hub-and-realtime-channel: at least every 5 seconds, and
// on every status change.
const PROGRESS_REPORT_INTERVAL_MS = 5_000;
const MIN_REPORT_SPACING_MS = 750;
const LIVE_SEEK_MAX_LEAD_SECONDS = 12;
// A car can be offline for minutes. Recovery stays active until playback is
// stable again or the user starts/stops something else; the capped backoff
// prevents a retry storm while still healing after connectivity returns.
const PLAYER_RECOVERY_STABLE_MS = 60_000;
const PLAYER_RECOVERY_CONFIRM_TIMEOUT_MS = 20_000;
const SEEK_STALL_TIMEOUT_MS = 5_000;
const SEEK_MAX_WAIT_MS = 30_000;
// How long a seek's new stream may take to arrive once Yolo has built it.
const SEEK_RESTART_LOAD_TIMEOUT_MS = 10_000;

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

// A { sessionId, position } record in the tab's sessionStorage, or null.
function storedStream(key) {
  try {
    const value = JSON.parse(globalThis.sessionStorage?.getItem(key) ?? "null");
    return typeof value?.sessionId === "string" ? { sessionId: value.sessionId, position: Math.max(0, Number(value.position) || 0) } : null;
  } catch {
    return null;
  }
}

function storeStream(key, value) {
  try {
    if (value) globalThis.sessionStorage?.setItem(key, JSON.stringify(value));
    else globalThis.sessionStorage?.removeItem(key);
  } catch {
    // Storage blocked or full: this page alone remembers it.
  }
}

function setLeftStream(value) {
  leftStream = value;
  storeStream(LEFT_STREAM_KEY, value);
}

let leftStream = storedStream(LEFT_STREAM_KEY);

// The stream the owner paused on this screen (in Yolo's controls, the
// system's, or outside them), until a state from Yolo shows it paused,
// names another stream, or it plays again here or by a resume Yolo sent:
// { sessionId, position }. Kept in the tab's sessionStorage too: a page
// loaded again in the tab (a reload, a car's wake) before Yolo heard the
// pause finds Yolo still has the stream playing here, or interrupted, and
// tells Yolo it is paused and loads it paused instead of playing it on
// (pausedHereFor(), main.js).
const PAUSED_HERE_KEY = "yolo.pausedHere";
let pausedHere = storedStream(PAUSED_HERE_KEY);

function setPausedHere(value) {
  pausedHere = value;
  storeStream(PAUSED_HERE_KEY, value);
}

function notePausedHere() {
  if (state.sessionId) setPausedHere({ sessionId: state.sessionId, position: Number(getReportedCurrentTime().toFixed(3)) });
}

/** The owner played the stream again, or Yolo resumed it: no pause stands. */
export function forgetPausedHere() {
  if (pausedHere) setPausedHere(null);
}

/**
 * The owner's pause of the stream the Hub's state names on this device, when
 * that state still has it playing or interrupted: Yolo never heard it.
 */
export function pausedHereFor(hub) {
  if (!pausedHere || !hub || hub.deviceId !== state.deviceId || hub.sessionId !== pausedHere.sessionId) return null;
  const playing = ["playing", "buffering", "loading"].includes(hub.status) || Boolean(hub.interruptedAt);
  return playing ? pausedHere : null;
}

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

const playbackGeneration = new PlaybackGeneration();

// Faults for in-car checks and end-to-end tests, read once from the
// address the page opened at, since the player's route drops the query
// (Agent Note 2026-04-04-canvas-playback-engine). `videoStallMs` (with
// `videoStallAt`, default 10 s) holds the canvas engine's picture decoder;
// `decodeErrorAt` makes its decoders fail at that media time, as a broken
// hardware decoder does, `decodeErrorCount` times (default 1) over every
// stream the page plays, on the `decodeErrorTrack` (`video` or `audio`).
function readPageFaults(search) {
  const params = new URLSearchParams(search);
  const durationMs = Number(params.get("videoStallMs"));
  const stallAt = Number(params.get("videoStallAt"));
  const decodeAt = params.has("decodeErrorAt") ? Number(params.get("decodeErrorAt")) : NaN;
  const decodeCount = Number(params.get("decodeErrorCount"));
  return {
    videoStall: Number.isFinite(durationMs) && durationMs > 0
      ? { durationMs, atSeconds: Number.isFinite(stallAt) && stallAt >= 0 ? stallAt : 10 }
      : null,
    decodeError: Number.isFinite(decodeAt) && decodeAt >= 0
      ? {
        atSeconds: decodeAt,
        remaining: Number.isInteger(decodeCount) && decodeCount > 0 ? decodeCount : 1,
        track: params.get("decodeErrorTrack") === "audio" ? "audio" : "video",
      }
      : null,
  };
}
const pageFaults = readPageFaults(location.search);

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
  seekWatchdogState.progressSnapshot = summarizeStats(readStats(player));

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

    const nextSnapshot = summarizeStats(readStats(player));
    if (hasSeekPlaybackProgress(
      seekWatchdogState.progressSnapshot,
      nextSnapshot,
      targetTime,
    )) {
      seekWatchdogState.progressSnapshot = nextSnapshot;
      logPlayerEvent("seek_progress_observed", {
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
      logPlayerEvent("seek_waiting_for_network", {
        requestId,
        targetTime,
        elapsedMs: Math.round(performance.now() - seekWatchdogState.startedAt),
        playerStats: nextSnapshot,
      });
      seekWatchdogState.timer = setTimeout(checkProgress, SEEK_STALL_TIMEOUT_MS);
      return;
    }

    logPlayerEvent("seek_stall_detected", {
      requestId,
      targetTime,
      elapsedMs,
      playerStatus: playbackState,
      playerStats: nextSnapshot,
      buffer: bufferState(readStats(player)),
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
// for a stream at a lower bitrate, or keep a higher one for the next stream
// (Agent Note 2026-10-21-smooth-playback-first). The numbers stay in
// telemetry (and /diag); the screen only ever shows the spinner.
function startNetworkMonitor(player, meta) {
  stopNetworkMonitor();
  const tick = () => {
    if (state.player !== player) {
      stopNetworkMonitor();
      return;
    }
    // One read of the engine's stats serves both the summary the logs carry
    // and the quality sample, which needs fields the summary leaves out.
    const engineStats = readStats(player);
    const stats = summarizeStats(engineStats);
    const sample = qualitySample(engineStats, {
      buffering: state.isBuffering,
      duration: state.duration,
      currentTime: state.currentTime,
      isLive: state.isLive,
      playbackRate: playbackRate(),
    });
    networkState.lastSample = sample;
    diagnoseNetwork(meta, stats, sample);
    notePlaybackDiagnostics({ network: { ...sample, at: new Date().toISOString() }, quality: quality.snapshot() });
    // Something else is already replacing this stream.
    if (qualityRequest || sessionRestartState.pending || sessionRestartState.transitionPending || streamRecoveryPending() || playbackRecoveryState.retryTimer) return;
    if (state.playbackIntent !== "playing" && !sample.buffering) return;
    // A new stream ends the system's fullscreen player (iPhone): there only a
    // stall steps down. A step up makes no new stream.
    const decision = quality.observe({ ...sample, stallsOnly: Boolean(player.nativeFullscreen) });
    if (decision?.rebuild) {
      qualityRequest = requestQualityChange(player, decision, sample).finally(() => {
        qualityRequest = null;
      });
    } else if (decision) {
      keepQualityRate(decision, sample);
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
// for the screen and path (Agent Note 2026-10-21-smooth-playback-first).
function keepQualityRate(decision, sample) {
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
async function requestQualityChange(player, decision, sample) {
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
      return buildFreshPlaybackSessionRequest({ meta: { source, sessionId: replacedStream() } }, getReportedCurrentTime(player), {
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
    // The canvas engine's decoder failed and recovering it in place did
    // not heal it (decoder-recovery.js): the last step is a new stream.
    "DECODER_FAILED",
    // The <video> engine's: a network error, a stall without data, or a
    // decode error, all healed by a new stream.
    "MEDIA_NETWORK_ERROR",
    "MEDIA_STALLED",
    "MEDIA_DECODE_ERROR",
  ].includes(error?.code)) {
    return true;
  }
  // A message about decoding is no reason for a new stream: the canvas
  // engine recovers a failed decoder in place and ends with DECODER_FAILED,
  // and the <video> engine's decode error is coded.
  const message = error?.message || String(error || "");
  return /demux error|network|fetch|timeout|connection|video.*(stall|frozen)|stream.*(closed|ended)/i.test(message);
}

function markPlaybackStable(player) {
  if (playbackRecoveryState.stableTimer) clearTimeout(playbackRecoveryState.stableTimer);
  playbackRecoveryState.stableTimer = setTimeout(() => {
    playbackRecoveryState.stableTimer = null;
    if (state.player !== player || !state.isPlaying) return;
    playbackRecoveryState.attempts = 0;
    logPlayerEvent("playback_recovery_stable", {
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
  const stats = summarizeStats(readStats(player));
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
  logPlayerEvent("playback_recovery_confirmed", {
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
    logPlayerEvent("playback_recovery_unconfirmed", {
      attempt,
      startTime,
      playerStatus: state.player?.getStatus?.() || null,
      playerStats: summarizeStats(readStats(state.player)),
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
        // The same quality as now, or a step up kept for the next stream: a
        // seek or a recovery is no reason to go back to a bitrate that
        // stalled. In place of a stream whose `load` never came, or on
        // another media path, what Yolo keeps for this screen and the path:
        // that stream may have been a quality change.
        maxVideoKbps: replaces === playing ? quality.requestCap(requestPath()) : undefined,
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
    logPlayerEvent("playback_recovery_deferred_for_seek", {
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
    logPlayerEvent("playback_recovery_joined", { error: error?.message || String(error), code: error?.code || null });
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
    logPlayerEvent("playback_recovery_finished", { error: error?.message || String(error), code: error?.code || null, startTime });
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
  const failure = player?.getFailure?.(error) ?? null;
  logPlayerEvent("playback_recovery_scheduled", {
    error: error?.message || String(error),
    code: error?.code || null,
    attempt,
    delayMs,
    startTime,
    ...(failure ? { failure } : {}),
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
        logPlayerEvent("playback_recovery_skipped", { attempt, startTime, sessionId: state.sessionId });
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
      logPlayerEvent("playback_recovery_attempt_failed", {
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

function getPlaybackState() {
  if (!state.player) return "idle";
  if (state.isBuffering) return "buffering";
  return state.isPlaying ? "playing" : "paused";
}

// --- Telemetry ---------------------------------------------------------------
// The runtime log and each stream's telemetry are telemetry/'s; every event
// carries where playback is.
setPlayerLogContext(() => ({
  playbackPosition: Number(getReportedCurrentTime().toFixed(3)),
  playbackState: getPlaybackState(),
  duration: state.duration || 0,
  isPlaying: !!state.isPlaying,
  isBuffering: !!state.isBuffering,
}));
watchMediaRequests();

// The canvas engine's picture stopping while its sound plays on: a new stream.
const freezeWatch = createFreezeWatch();

function checkVideoFreeze() {
  const freeze = freezeWatch.check(summarizeStats(readStats(state.player)), {
    watching: state.isPlaying && document.visibilityState !== "hidden",
    now: performance.now(),
  });
  if (!freeze) return;
  logPlayerEvent("video_freeze_detected", freeze);
  schedulePlaybackRecovery(state.player, new Error(`video stalled for ${freeze.frozenForMs}ms with ${freeze.driftMs}ms A/V drift`));
}

// --- MediaSession (Tesla steering wheel / browser media keys) --------

// The stream's artwork for the system's media controls (the lock screen, a
// phone's notification): the web profile's <video> engine only.
let mediaArtwork = null;

export function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const native = currentEngine.name === "native";
  navigator.mediaSession.metadata = new MediaMetadata({
    title: mediaTitleText() || "Yolo",
    ...(native && mediaArtwork ? { artwork: [{ src: mediaArtwork }] } : {}),
  });
  navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
  if (state.duration > 0) {
    try {
      const currentTime = getReportedCurrentTime();
      navigator.mediaSession.setPositionState({
        duration: state.duration,
        playbackRate: playbackRate(),
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
  const stats = summarizeStats(readStats(player));
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
// and at once for a new stream, a new stall, or a step up kept for the next
// stream, to keep the Hub's writes few. `rate` is that step up: the Hub
// keeps it as where this screen's next stream on the path starts
// (Agent Note 2026-10-21-smooth-playback-first).
const HEALTH_REPORT_INTERVAL_MS = 15_000;
const healthReportState = { at: 0, key: "" };
const tenths = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

function playbackHealthReport(now) {
  const rate = quality.rate();
  const stalls = telemetry.playbackHealth(now);
  const key = `${state.sessionId}:${stalls.stalls}:${Boolean(state.isBuffering)}:${rate ? `${rate.path}=${rate.kbps}` : ""}`;
  if (key === healthReportState.key && now - healthReportState.at < HEALTH_REPORT_INTERVAL_MS) return null;
  const sample = networkState.lastSample;
  const native = currentEngine.name === "native";
  const picture = native ? describeVideo(container) : state.player;
  return {
    key,
    health: {
      engine: currentEngine.name,
      bufferSeconds: sample ? tenths(Number(sample.bufferedAheadSeconds)) : null,
      throughputKbps: sample?.throughputKbps || null,
      buffering: Boolean(state.isBuffering),
      ...stalls,
      width: Number(picture?.width) || null,
      height: Number(picture?.height) || null,
      videoCodec: native ? null : state.player?.videoCodec || null,
      droppedFrames: droppedFrames(readStats(state.player)),
      ...(rate ? { rate } : {}),
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
  telemetry.noteWakeProgress();
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
    logPlayerEvent("seek_session_restart_retargeted", { requestId: sessionRestartState.requestId, asked: current.asked, targetTime });
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
  logPlayerEvent("seek_session_restart_requested", {
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
    logPlayerEvent("seek_session_restart_created", {
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
  logPlayerEvent("seek_session_restart_moved", { asked: seek.asked, targetTime: seek.targetTime, streamStart: startTime });
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
  logPlayerEvent("seek_session_restart_failed", {
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
    logPlayerEvent("hub_stream_rejoin_skipped", { sessionId: state.sessionId, lost: lost.sessionId });
    playOnAfterRejoin(player, lost.onScreen);
  }).catch((error) => {
    lost.asking = false;
    if (state.player !== player) return;
    logPlayerEvent("hub_stream_rejoin_failed", { error: error?.message || String(error), code: error?.apiCode || error?.code || null });
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
 * the same item this asks for a new stream in place of the Hub's: at
 * `seekTo`, a seek Yolo sent for the Hub's stream that the screen left for
 * it, else at a pending seek's target, else where the screen is (not where
 * an agent's play of this item asked to start), with the picture held under
 * the spinner until it plays. True when it asked (or asked already); false
 * when the Hub names the stream on screen or another item (rejoinHubItem).
 */
export function rejoinHubStream(hub, { seekTo = null } = {}) {
  const player = state.player;
  if (!player || !hub?.sessionId || hub.deviceId !== state.deviceId || hub.sessionId === state.sessionId) return false;
  const key = sourceKeyOf(hub.item?.source);
  if (!key || key !== sourceKeyOf(state.source)) return false;
  // An earlier welcome named it, and that request is on its way.
  if (lostLoad?.onScreen === state.sessionId && lostLoad.sessionId === hub.sessionId && lostLoad.asking) return true;
  const lost = { onScreen: state.sessionId, sessionId: hub.sessionId, asking: true };
  lostLoad = lost;
  const seek = sessionRestartState.pending && sessionRestartState.seek?.player === player ? sessionRestartState.seek : null;
  logPlayerEvent("hub_stream_rejoined", { sessionId: state.sessionId, lost: hub.sessionId, seekTo: seekTo ?? seek?.targetTime ?? null });
  if (seekTo != null && !seek) {
    // A seek Yolo sent for the stream whose `load` was lost, which the
    // screen left for that stream (main.js): the new stream starts there.
    rejoinInPlace(player, seekTo, lost);
  } else if (seek) {
    restartSessionForSeek(player, seekTo ?? seek.targetTime, seek.expectedToPlay, {
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
  logPlayerEvent("hub_item_rejoined", { sessionId: state.sessionId, lost: decision.sessionId, hubStatus: hub.status ?? null });
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
  logPlayerEvent("hub_item_rejoin_skipped", { sessionId: state.sessionId, lost: decision.sessionId });
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
      logPlayerEvent("seek_session_restart_load_missing", { requestId, targetTime: seek.targetTime, built: sessionRestartState.built });
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
  logPlayerEvent("seek_requested", {
    requestId,
    label,
    fromTime,
    targetTime,
    expectedToPlay,
    preserveHlsBuffer,
    playerStats: summarizeStats(readStats(player)),
  });

  void player.seek(BigInt(Math.floor(targetTime * 1000)), { preserveHlsBuffer }).then((applied) => {
    const current = requestId === seekWatchdogState.requestId && state.player === player;
    logPlayerEvent("seek_completed", {
      requestId,
      label,
      targetTime,
      applied: applied !== false,
      current,
      durationMs: Math.round(performance.now() - startedAt),
      playerStats: summarizeStats(readStats(player)),
    });
    if (!current || applied === false) return;
    if (expectedToPlay && state.playbackIntent === "playing") player.resume().catch(() => {});
  }).catch((error) => {
    const seekError = error instanceof Error ? error : new Error(String(error));
    const current = requestId === seekWatchdogState.requestId && state.player === player;
    logPlayerEvent("seek_failed", {
      requestId,
      label,
      targetTime,
      current,
      durationMs: Math.round(performance.now() - startedAt),
      error: seekError.message,
      playerStats: summarizeStats(readStats(player)),
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
      notePausedHere();
      await state.player.pause();
      state.isPlaying = false;
    } else {
      state.playbackIntent = "playing";
      forgetPausedHere();
      await state.player.play();
    }
    updatePlayButton();
  } catch (e) {
    console.error("[player] Toggle error:", e);
  }
}

// --- Playback speed ----------------------------------------------------

// The owner's speed (state.playbackSpeed, playback-speed.js) for every
// stream this page plays: both engines take it when they are made, so it
// holds through recovery, seeks, quality changes, and the next item. Up to
// the engine's fastest: 3× on the canvas engine, 5× on the <video> engine.
// A press and hold below 2× plays at 2× until it lets go. A live stream
// plays at the speed it is made. Positions stay the media's own, so
// progress, subtitles, and danmaku follow by themselves; the Hub, which
// counts a playing item's time between reports at the normal speed, hears
// no speed (Agent Note 2026-10-12-two-playback-engines).
let speedHeld = false;

function playbackRate() {
  if (state.isLive) return 1;
  return (speedHeld && holdSpeed(state.playbackSpeed)) || state.playbackSpeed;
}

function applyPlaybackRate(player = state.player) {
  player?.setPlaybackRate?.(playbackRate());
}

// The speeds the engine about to play plays; a speed past its fastest (a
// page whose profile changed to the car's) comes down to it.
function noteSpeedLimits(engine) {
  state.speedLimits = speedLimits(engine, engineChoice().native);
  state.playbackSpeed = Math.min(state.playbackSpeed, state.speedLimits.max);
}

export function setPlaybackSpeed(speed) {
  const value = Number(speed);
  if (!(value > 0)) return;
  state.playbackSpeed = Math.min(Math.max(value, MIN_SPEED), state.speedLimits.max);
  applyPlaybackRate();
  updateSpeedUI();
  updateMediaSession();
}

// Press and hold on the picture (controls.js): false when it cannot speed
// up (live, or not playing), and the press stays a tap. At 2× or faster it
// is a hold that changes nothing.
export function setHoldSpeed(on) {
  if (!on) {
    if (!speedHeld) return true;
    speedHeld = false;
  } else {
    if (!state.player || state.isLive || state.playbackIntent !== "playing") return false;
    if (holdSpeed(state.playbackSpeed) == null) return true;
    speedHeld = true;
  }
  applyPlaybackRate();
  updateMediaSession();
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
  const canvas = describeCanvas(container);
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
    ...(currentEngine.name === "native" ? { video: describeVideo(container) } : {}),
    sinceLoadMs: Math.round(performance.now() - startedAt),
  };
  logPlayerEvent("stream_first_frame", fields);
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
    logPlayerEvent("audio_unlocked", { afterMs: Math.round(performance.now() - audioBlockedAt) });
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
  logPlayerEvent("autoplay_result", {
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
  telemetry.stallEnded();
  hideBuffering();
  state.isPlaying = false;
  state.playbackIntent = "paused";
  reportProgress({ force: true, status: "paused" });
  state.currentTime = 0;
  const end = { sessionId: state.sessionId, player, heard: false };
  finished = end;
  realtime?.send(endedMessage(state.sessionId));
  realtime?.confirm?.(() => {
    end.heard = true;
  });
  advanceAfterEnd(state.sessionId);
  updatePlayButton();
  updateMediaSession();
  showControls();
}

// How the screen waits for a stream that replaces the one on screen: the
// last picture under the loading ring. One the owner asked for (a seek, a
// track) also shows the progress bar's seek indicator; a quality change,
// which the owner did not ask for, does not. Neither raises the controls
// (Agent Note 2026-07-13-in-car-design-principles): raised by a quality
// change, they put the progress bar under a tap meant for pause, which in
// the car on 2026-10-21 sought 5 minutes back (Agent Note
// 2026-10-11-adaptive-quality).
function showStreamChange(meta) {
  if (meta.__loadReason === "quality") showBuffering();
  else setSeekTransitionPending(true);
}

function createEnginePlayer(meta, { engine, native, overtaken = () => false }) {
  // A stream that replaces what plays (a seek, a track or a quality change)
  // is a seek transition until its first picture (showStreamChange()). Then
  // it is a player like any other, and a stall on it shows the spinner.
  // When a newer seek asked for a stream of its own while this one loaded
  // (`overtaken`), that seek is still on its way: its first picture only
  // replaces the old picture.
  let seekTransition = meta.__optimisticSeek === true;
  const endSeekTransition = (options) => {
    if (!seekTransition) return;
    seekTransition = false;
    if (overtaken()) {
      removeTransitionFrame(options);
      return;
    }
    completeOptimisticSeekTransition(options);
    // Still waiting after its first picture: the stall began in the
    // transition, so no state change will show the spinner.
    if (state.player === player && ["loading", "seeking", "buffering"].includes(player.getStatus())) showBuffering();
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
      paintUpNext();
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
        if (nextState !== "playing") {
          onOwnAction("playback");
          notePausedHere();
        } else {
          forgetPausedHere();
        }
      }
      if (["loading", "seeking", "buffering"].includes(nextState)) {
        telemetry.stallBegan();
        if (seekTransition) showStreamChange(meta);
        else showBuffering();
        state.isPlaying = false;
      } else if (nextState === "playing") {
        hideLoading();
        telemetry.stallEnded();
        hideBuffering();
        state.isPlaying = true;
        updatePlayButton();
        updateMediaSession();
        confirmPlaybackRecovery(player, getReportedCurrentTime(player));
        if (!player.videoTrack) endSeekTransition();
        reportProgress();
      } else if (nextState === "paused") {
        telemetry.stallEnded();
        hideBuffering();
        state.isPlaying = false;
        updatePlayButton();
        updateMediaSession();
        confirmPlaybackRecovery(player, getReportedCurrentTime(player));
        reportProgress();
      }
      danmaku.sync();
      logPlayerEvent(info.stateEvent, {
        state: nextState,
        reason: detail.reason || null,
        // The canvas engine's failure: its message, and what failed
        // (Agent Note 2026-10-11-device-telemetry).
        ...(detail.error ? { error: detail.error } : {}),
        ...(detail.failure ? { failure: detail.failure } : {}),
        buffer: bufferState(readStats(player)),
      });
    },
    onTime: updateTime,
    onFirstVideo: () => {
      hideLoading();
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
        logPlayerEvent("kept_player_failed", { code: error?.code || null, error: error?.message || String(error) });
        return;
      }
      stopNetworkMonitor();
      telemetry.stallEnded();
      console.error(`[${engine === "native" ? "native" : "mediabunny"}] Playback error:`, error);
      // The node answered 410: the stream ended while the page slept, or
      // the source dropped it. Recovery asks Yolo for a new one.
      if (error?.code === "SESSION_EXPIRED") logPlayerEvent("session_expired", { code: error.code, error: error.message });
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
      // Another speed chosen there: the owner's speed now.
      onRate: (rate) => {
        if (state.player !== player || speedHeld) return;
        state.playbackSpeed = rate;
        updateSpeedUI();
        updateMediaSession();
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
      faultInjection: pageFaults.videoStall,
      decodeFault: pageFaults.decodeError,
      // Each step of a failed decoder's recovery in place (Agent Note
      // 2026-10-11-device-telemetry); its last step is a new stream, which
      // onError schedules.
      onDecoderRecovery: (event) => logPlayerEvent("decoder_recovery", event),
    });
    player.setAudioGain(PLAYER_AUDIO_GAIN);
  }
  // Either engine, for diagnostics and end-to-end tests. In-car fault checks
  // call __yoloPlayer.player.injectVideoStall(ms) or
  // injectDecodeError(seconds, { count }) on the canvas engine.
  globalThis.__yoloPlayer = { player, engine };
  return player;
}

// --- Play / Stop -----------------------------------------------------

const container = document.getElementById("player-container");
const overlay = document.getElementById("overlay");
const controlsLayer = document.getElementById("controls");
const centerPlayButton = document.getElementById("btn-center-play");
const subsPanel = document.getElementById("subs-panel");
const audioPanel = document.getElementById("audio-panel");
const speedPanel = document.getElementById("speed-panel");

telemetry.init({
  position: () => getReportedCurrentTime(),
  playbackState: getPlaybackState,
  engine: () => currentEngine,
  danmakuStats: () => danmaku.stats(),
  container,
});

// --- Danmaku (Agent Note 2026-10-13-danmaku) ---------------------------

// This screen's settings, which the settings sheet and the Hub's `danmaku`
// message change too.
export const danmakuSettings = createDanmakuSettings();
const danmakuButton = document.getElementById("btn-danmaku");
export const danmaku = createDanmaku({
  canvas: document.getElementById("danmaku-layer"),
  playerContainer: container,
  // The playing engine's own position, read each animation frame, and how
  // fast it moves.
  getTime: () => (state.player && !state.isLive ? state.player.getCurrentTime() : null),
  getRate: () => (state.player && state.isPlaying ? playbackRate() : 0),
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

// --- What stands in for the picture ------------------------------------------
// The loading screen, a press's start, and the error panel are
// player-screens.js's; its panel tries the item again or leaves it.
initPlayerScreens({
  retry: () => void retryPlayback(),
  back: () => void stop({ keep: false }),
  setRelayMode: (mode) => mediaPaths?.setRelayMode(mode),
});

// A press on the player that asks Yolo for another item to play here
// (main.js, up-next.js): the screen shows the item starting at once
// (showStarting), and the item on screen pauses. cancel() puts both back
// when Yolo refuses, unless a newer press or the `load` took over.
export function beginStarting(item = null) {
  const player = state.player;
  const resume = Boolean(player) && state.playbackIntent === "playing";
  if (resume) {
    state.playbackIntent = "paused";
    state.isPlaying = false;
    void Promise.resolve(player.pause()).catch(() => {});
    updatePlayButton();
  }
  const shown = showStarting(item);
  return {
    cancel() {
      if (!shown.cancel() || !resume || state.player !== player) return;
      state.playbackIntent = "playing";
      void Promise.resolve(player.play()).catch(() => {});
      updatePlayButton();
    },
  };
}

// A recovery or a retry: the spinner over the last picture, kept as a still
// until the new stream's first frame.
function showRecovering(player) {
  if (player) capturePlaybackTransitionFrame(player);
  overlay.classList.add("hidden");
  showBuffering();
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
  logPlayerEvent("playback_retry_requested", plan);
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

// Each call supersedes the previous one's second round and notice.
let subtitleLoads = 0;

// An AI track that stops reading says why once per stream, not on every poll.
const growingFailures = new Set();
onGrowingSubtitleFailure((trackId, message) => {
  const key = `${state.sessionId}:${trackId}`;
  if (growingFailures.has(key)) return;
  growingFailures.add(key);
  showPlaybackNotice(message);
});

// The stream waits for the first round only; a track the node asked to try
// again later loads in the background, and the notice names the tracks that
// never loaded (subtitle-loading.js).
async function loadSelectedSubtitles() {
  const selected = new Set(state.tracks.selected?.subtitles || []);
  const tracks = state.tracks.subtitles.filter((track) => selected.has(track.id) && track.url);
  const origin = state.mediaOrigin || location.origin;
  danmaku.setSubtitles(tracks.length > 0);
  const load = subtitleLoads += 1;
  const { player, sessionId } = state;
  const current = () => load === subtitleLoads && state.sessionId === sessionId && (!player || state.player === player);
  // The same subtitles for the system's fullscreen player (the <video>
  // engine on iPhone), where Yolo's overlay cannot show. A burned-in track is
  // in the picture already.
  const setCaptions = () => state.player?.setCaptions?.(state.tracks.subtitles
    .filter((track) => selected.has(track.id) && track.delivery !== "burn")
    .map((track) => ({ id: track.id, label: track.name || track.language || "", language: track.language || "", cues: subtitleCues(track.id) })));
  const { later } = await loadSubtitleTracks(tracks, {
    load: (track) => loadSubtitleTrack(track.id, new URL(track.url, origin).href, { growing: track.growing === true }),
    wait: (ms) => new Promise((done) => setTimeout(done, ms)),
    current,
    loadedLater: setCaptions,
  });
  setCaptions();
  void later.then((never) => {
    const notice = current() ? subtitleFailureNotice(never) : null;
    if (notice) showPlaybackNotice(notice);
  });
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
  forgetPausedHere();
  finished = null;
  if (isOptimisticSeek) {
    sessionRestartState.transitionPending = true;
    showStreamChange(meta);
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
    currentEngine = ENGINES[engine];
    noteSpeedLimits(engine);
    setLoggedStream(playbackSessionId);
    telemetry.begin();
    freezeWatch.reset();

    stopProgressReporting();
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
    // The last item's picture is gone: a press's poster goes back under the
    // new stream's <video> (beginStarting).
    endStarting();
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
    updateSpeedUI();
    subsPanel.classList.add("hidden");
    audioPanel.classList.add("hidden");
    speedPanel.classList.add("hidden");
    setMediaTitle(title || "");

    setPlaybackControlsEnabled(true);
    overlay.classList.add("hidden");
    if (isOptimisticSeek) showStreamChange(meta);
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
    applyPlaybackRate(player);
    if (streamLoading?.generation === playbackSessionId) streamLoading = null;
    currentStream = { player, url: absUrl, meta, settled: false };
    if (engine === "native") attachPictureControls(player);
    else detachPictureControls();
    setSeekActions(engine === "native");
    noteMediaArtwork(engine === "native" ? meta.thumbnail : null, isCurrentPlayback);
    quality.load({ profile: meta.streamProfile, limits: meta.limits, isLive: meta.isLive, key: sourceKeyOf(meta.source), path: state.streamNetwork });
    startNetworkMonitor(player, meta);
    startProgressReporting();
    telemetry.start();

    console.log(`[player] Loading with ${engine === "native" ? "<video>" : "Mediabunny"}:`, absUrl);
    const { crossOriginIsolated, hasVideoDecoder, hasAudioDecoder, hasAudioWorklet } = telemetry.capabilities();
    telemetry.noteDecodeInfo({
      options: { engine: engine === "native" ? `native-video:${player.hlsPath}` : "mediabunny", clock: currentEngine.clock },
      capabilities: { crossOriginIsolated, hasVideoDecoder, hasAudioDecoder, hasAudioWorklet },
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
    // An item that starts paused brings the controls up, as a pause does.
    // One that plays, and every stream that replaces one on screen (a seek,
    // a track, a quality change, a recovery), leaves them as they were:
    // loading never raises them (Agent Note 2026-07-13-in-car-design-principles).
    if (state.playbackIntent !== "playing" && !isOptimisticSeek && !isRecovery) showControls();
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
    telemetry.stop();
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
  speedPanel.classList.add("hidden");
  speedHeld = false;
  onUpdateAudioUI();
  updatePlayButton();
  updateTimeDisplay();
  updateProgress(0);
  setMediaTitle("");
  setPlaybackControlsEnabled(false);
  overlay.classList.remove("hidden");
  document.getElementById("app").classList.remove("controls-visible");
  endStarting();
  hideBuffering();
  setSeekTransitionPending(false);
  hideLoading();
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
  telemetry.end();
  // Leaving the video stops it in Yolo too, at the position reached, also
  // when the connection loses the report (leftStream).
  if (report && state.sessionId) {
    setLeftStream({ sessionId: state.sessionId, position: Number(getReportedCurrentTime().toFixed(3)) });
    reportProgress({ force: true, status: "idle" });
  }
  stopProgressReporting();
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
  logPlayerEvent("kept_player_released", { reason, hiddenMs: Date.now() - record.keptAt });
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
    && !playbackErrorShown()
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
  telemetry.end();
  stopProgressReporting();
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
    title: mediaTitleText(),
    position,
    duration: state.duration,
    tracks: state.tracks,
    mediaOrigin: state.mediaOrigin,
    network: state.streamNetwork,
    url: currentStream.url,
    meta: currentStream.meta,
    request,
  });
  logPlayerEvent("player_kept", { position, engine: currentEngine.name, frame: Boolean(frame) });
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

/** The stream on screen played to its end here, heard by Yolo or not (up-next.js). */
export function finishedHere() {
  return Boolean(finished) && finished.player === state.player && finished.sessionId === state.sessionId;
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
  // Yolo heard the owner's pause (it has the stream paused, not by a
  // dropped connection), or moved on.
  if (pausedHere && (!hub || hub.deviceId !== state.deviceId || hub.sessionId !== pausedHere.sessionId || (hub.status === "paused" && !hub.interruptedAt))) {
    setPausedHere(null);
  }
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
  noteSpeedLimits(currentEngine.name);
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
  applyPlaybackRate(player);
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
  setMediaTitle(record.title);
  setPlaybackControlsEnabled(true);
  overlay.classList.add("hidden");
  navigate("/play");
  updateTimeDisplay();
  updateProgress(state.duration > 0 ? state.currentTime / state.duration : 0);
  onUpdateSubsUI();
  onUpdateAudioUI();
  updateSpeedUI();
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
  telemetry.start();
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
  logPlayerEvent("kept_player_shown", { reason, hiddenMs: Date.now() - record.keptAt, plan: plan.action, why: plan.why ?? null });
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
    logPlayerEvent("seek_requested", { label: "kept", fromTime: at, targetTime: startTime, expectedToPlay: state.playbackIntent === "playing" });
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
  logPlayerEvent("kept_player_rebuild", { why: plan.why, startTime: plan.startTime });
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
      forgetPausedHere();
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
      notePausedHere();
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
