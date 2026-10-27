import "./player-overlays.css";
import { state } from "./state.js";
import { PlaybackGeneration } from "./playback-generation.js";
import {
  showControls, updateTimeDisplay, updateProgress, updatePlayButton,
  updateVolumeButton, showBuffering, hideBuffering, isDraggingProgress,
  setSeekTransitionPending, setMediaTitle, mediaTitleText, showTapForSound, updateSpeedUI,
} from "./controls.js";
import { holdSpeed, MIN_SPEED, speedLimits } from "./playback-speed.js";
import { createKeptPlayer, planReopen, probeStreamSession, reopenPlan } from "./kept-player.js";
import { renderSubtitle, disableExternalSubtitle, clearSubtitles } from "./subtitles.js";
import { initTracks, loadSelectedSubtitles, NO_TRACKS, withTracks } from "./tracks.js";
import { updateAudioUI, updateSubsUI } from "./track-menus.js";
import { createDanmaku } from "./danmaku.js";
import { createDanmakuSettings } from "./danmaku-settings.js";
import { t } from "./i18n.js";
import { navigate } from "./router.js";
import { MediabunnyPlayer } from "./engine/mediabunny-player.js";
import { NativeVideoPlayer } from "./engine/native-video-player.js";
import { attachPictureControls, detachPictureControls, exitPictureModes } from "./picture-controls.js";
import { advanceAfterEnd, endedMessage, paintUpNext } from "./up-next.js";
import {
  endStarting, hideLoading, hidePlaybackError, initPlayerScreens, playbackErrorShown, showPlaybackError, showStarting,
} from "./player-screens.js";
import { artworkSource } from "./artwork.js";
import { physicalViewport } from "./display-scale.js";
import { streamRecoveryPending } from "./playback.js";
import { recordDeviceEvent } from "./telemetry/device-events.js";
import { bufferState, droppedFrames, readStats, summarizeStats } from "./telemetry/engine-stats.js";
import { watchMediaRequests } from "./telemetry/media-requests.js";
import { logPlayerEvent, setLoggedStream, setPlayerLogContext } from "./telemetry/player-log.js";
import * as telemetry from "./telemetry/playback-telemetry.js";
import { describeCanvas, describeVideo, describeViewport } from "./telemetry/screen.js";
import { createFreezeWatch } from "./video-freeze.js";
import {
  cancelSeekWatch, endSeekTransition, forgetSeekStream, holdSeekTransition, initSeek, seekCount,
  seekHere, seekStreamCount, seekStreamPending, seekStreamStart, seekToTime, seekTransitionHeld,
} from "./seek.js";
import {
  confirmRecovery, forgetLostLoads, forgetStream, initStreamRecovery, rebuildKept, recordStream, recover, recoveryScheduled, rejoinBuilt,
  replacedStream, requestNewStream, restoreStream, retryPlayback, streamRequest,
} from "./stream-recovery.js";
import { initQualityMonitor, lastQualitySample, quality, qualityChangePending, startQualityMonitor, stopQualityMonitor } from "./quality-monitor.js";
import {
  forgetFinished, forgetLeft, forgetPausedHere, leftStream, noteFinished, noteHeard, noteLeft, notePausedHere,
} from "./unheard.js";
import { pageFaults } from "./page-faults.js";
import { notePlaybackDiagnostics } from "./telemetry/playback-diagnostics.js";
import {
  resolvePlaybackPosition,
  shouldHoldOptimisticSeekTarget,
  shouldRestartSessionForSeek,
} from "./playback-recovery.js";

// --- Callbacks (set by main.js to avoid circular deps) ---------------

let onKeptChange = () => {};
let onOwnAction = () => {};
let realtime = null;

// `keptChanged` runs when a player is kept behind the home screen, its
// paused picture is ready, or it is shown again or let go (the
// now-playing bar, remote.js). `ownAction(kind)` hears what the owner did
// on this screen that a command a reconnect lost must not overrule: a
// pause or Back ("playback"), a seek ("seek") (missed-commands.js).
export function setPlayerCallbacks({ keptChanged = () => {}, ownAction = () => {} }) {
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
  mediaPaths.failed(error, { path: state.streamNetwork, position: getReportedCurrentTime(state.player) });
}

// The media path a stream request of this screen names (playback.js): the
// paths' choice, where none works the relay, which Yolo then takes.
const requestPath = () => (mediaPaths ? mediaPaths.network() ?? "relay" : undefined);

const sourceKeyOf = (source) => (source?.plugin && source.id != null ? `${source.plugin}:${source.id}` : null);

let lastUiPaintAt = 0;

const UI_PAINT_INTERVAL_MS = 250;
const PLAYER_AUDIO_GAIN = 12.0;
// Agent Note 2026-10-07-hub-and-realtime-channel: at least every 5 seconds, and
// on every status change.
const PROGRESS_REPORT_INTERVAL_MS = 5_000;
const MIN_REPORT_SPACING_MS = 750;

const playbackGeneration = new PlaybackGeneration();

// --- Adaptive quality (quality-monitor.js) ---------------------------------------
initQualityMonitor({ position: getReportedCurrentTime, playbackRate });

// --- Recovery (stream-recovery.js) ------------------------------------------------
initStreamRecovery({
  position: getReportedCurrentTime,
  showRecovering,
  dropHeldPicture: () => removeTransitionFrame({ immediate: true }),
  finish: finishPlayback,
  replay: play,
  stop: () => void stop({ keep: false }),
  notePathFailure,
  qualityCap: () => quality.requestCap(requestPath()),
  qualityChange: qualityChangePending,
});

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
  recover(state.player, new Error(`video stalled for ${freeze.frozenForMs}ms with ${freeze.driftMs}ms A/V drift`));
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
  const sample = lastQualitySample();
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

// --- Seeking (seek.js) ---------------------------------------------------------
initSeek({
  requestStream: requestNewStream,
  recover,
  position: getReportedCurrentTime,
  reportProgress: () => reportProgress(),
  replay: play,
  streamRequest,
  seekKept: (timeSec) => {
    if (!keptPlayer.current) return false;
    keptPlayer.seek(timeSec);
    return true;
  },
  forgetFinished,
  ownAction: (kind) => onOwnAction(kind),
  realtime: () => realtime,
  replacedStream,
  rejoinBuilt,
});

// --- Toggle play/pause -----------------------------------------------

export async function togglePlayPause() {
  if (!state.player) return;
  forgetFinished();
  try {
    if (state.playbackIntent === "playing") {
      state.playbackIntent = "paused";
      onOwnAction("playback");
      notePausedHere(Number(getReportedCurrentTime().toFixed(3)));
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
  stopQualityMonitor();
  telemetry.stallEnded();
  hideBuffering();
  state.isPlaying = false;
  state.playbackIntent = "paused";
  reportProgress({ force: true, status: "paused" });
  state.currentTime = 0;
  const end = noteFinished(player);
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
      transitionPending: seekTransitionHeld(),
      playerIsCurrent: state.player === player,
    })) {
      return;
    }
    state.currentTime = Math.max(
      0,
      state.isLive ? seconds : Math.min(state.duration || Infinity, seconds),
    );
    confirmRecovery(player, state.currentTime);
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
        cancelSeekWatch();
      }
      // Played or paused outside Yolo's controls (Picture-in-Picture, the
      // system's media controls, a call): that is the owner's intent now,
      // and a pause is the owner's, as one in Yolo's controls is.
      if (detail.reason === "external") {
        state.playbackIntent = nextState === "playing" ? "playing" : "paused";
        forgetFinished();
        if (nextState !== "playing") {
          onOwnAction("playback");
          notePausedHere(Number(getReportedCurrentTime().toFixed(3)));
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
        confirmRecovery(player, getReportedCurrentTime(player));
        if (!player.videoTrack) endSeekTransition();
        reportProgress();
      } else if (nextState === "paused") {
        telemetry.stallEnded();
        hideBuffering();
        state.isPlaying = false;
        updatePlayButton();
        updateMediaSession();
        confirmRecovery(player, getReportedCurrentTime(player));
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
      stopQualityMonitor();
      telemetry.stallEnded();
      console.error(`[${engine === "native" ? "native" : "mediabunny"}] Playback error:`, error);
      // The node answered 410: the stream ended while the page slept, or
      // the source dropped it. Recovery asks Yolo for a new one.
      if (error?.code === "SESSION_EXPIRED") logPlayerEvent("session_expired", { code: error.code, error: error.message });
      if (!recover(player, error)) {
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
        if (state.player === player) updateAudioUI();
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
  danmakuButton.setAttribute("aria-label", on ? t("Hide danmaku") : t("Show danmaku"));
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

// A still of the picture `player` shows (the canvas engine's canvas, or the
// <video> engine's current frame), at most `maxWidth` wide, with no
// request; null before the picture has a frame.
function snapshotPicture(player, className, { maxWidth = Infinity } = {}) {
  const source = player?.canvas || player?.video;
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source?.width;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source?.height;
  if (!(source instanceof HTMLCanvasElement || source instanceof HTMLVideoElement) || !width || !height) return null;
  if (source instanceof HTMLVideoElement && source.readyState < 2) return null;
  const scale = Math.min(1, maxWidth / width);
  const still = document.createElement("canvas");
  still.className = className;
  still.width = Math.max(1, Math.round(width * scale));
  still.height = Math.max(1, Math.round(height * scale));
  try {
    still.getContext("2d", { alpha: false })?.drawImage(source, 0, 0, still.width, still.height);
  } catch {
    return null;
  }
  return still;
}

// The picture held while a new stream replaces this one (a seek's, a
// recovery's), over the engine's element until the new stream's first frame.
function capturePlaybackTransitionFrame(player) {
  const existing = container.querySelector(".playback-transition-frame");
  if (existing) return existing;
  const still = snapshotPicture(player, "playback-transition-frame");
  if (still) container.appendChild(still);
  return still;
}

function completeOptimisticSeekTransition({ immediate = false, keepFrame = false } = {}) {
  endSeekTransition();
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

// --- Tracks ------------------------------------------------------------

initTracks({ subtitlesShown: (shown) => danmaku.setSubtitles(shown) });

// Yolo changed the subtitles without a new stream (a `tracks` message).
export function applyTracks(tracks, selected) {
  const record = state.player ? null : keptPlayer.current;
  if (record) {
    // Hidden: they go with the kept player, and load when it shows again.
    record.tracks = withTracks(record.tracks, tracks, selected);
    record.reloadSubtitles = true;
    return;
  }
  state.tracks = withTracks(state.tracks, tracks, selected);
  disableExternalSubtitle();
  void loadSelectedSubtitles();
  updateSubsUI();
  updateAudioUI();
}

// --- Playing a stream --------------------------------------------------------

export async function play(url, title, meta = {}) {
  const isOptimisticSeek = meta.__optimisticSeek === true;
  const isRecovery = meta.__recovery === true;
  hidePlaybackError();
  // A seek's stream starts where the owner asked last (a later seek may
  // have moved the target while it was on its way).
  const seekTo = meta.__loadReason === "seek" ? seekStreamStart(Math.max(0, Number(meta.startTime) || 0)) : null;
  const seeksBefore = seekCount();
  if (seekTo) meta = { ...meta, startTime: seekTo.startTime };
  forgetSeekStream({ keepTransition: isOptimisticSeek });
  // A seek that asks for a stream of its own while this one loads overtakes
  // it: this stream neither plays nor ends that seek's transition, and the
  // seeks after it move that stream's target (seekWithNewStream).
  const restartsBefore = seekStreamCount();
  const overtaken = () => seekStreamCount() !== restartsBefore;
  forgetLostLoads();
  forgetLeft();
  forgetPausedHere();
  forgetFinished();
  if (isOptimisticSeek) {
    holdSeekTransition();
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
  cancelSeekWatch();
  const isCurrentPlayback = () => playbackGeneration.isCurrent(playbackSessionId);
  state.playbackIntent = meta.autoplay === false ? "paused" : "playing";
  recordStream({ url, title, meta, recovered: isRecovery });

  let player = null;
  // The engine for this stream: the profile's choice now (profile.js).
  const choice = engineChoice();
  const engine = ENGINES[choice.engine] ? choice.engine : "canvas";
  try {
    stopQualityMonitor();
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
    updateSubsUI();
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
    startQualityMonitor(player, meta);
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
    // (which, if it never comes, plays this one on: seek.js).
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
    updateAudioUI();
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
    if (seekTo?.then != null && state.player === player && seekCount() === seeksBefore) seekToTime(seekTo.then, { settled: true });

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
    if (!recover(null, e)) {
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
  updateAudioUI();
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
  cancelSeekWatch();
  forgetSeekStream();
  forgetLostLoads();
  completeOptimisticSeekTransition({ immediate: true });
  forgetStream();
  telemetry.end();
  // Leaving the video stops it in Yolo too, at the position reached, also
  // when the connection loses the report (leftStream).
  if (report && state.sessionId) {
    noteLeft(state.sessionId, Number(getReportedCurrentTime().toFixed(3)));
    reportProgress({ force: true, status: "idle" });
  }
  stopProgressReporting();
  stopQualityMonitor();
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
    && !recoveryScheduled() && !streamRecoveryPending() && !qualityChangePending()
    && !seekStreamPending();
}

// The paused picture for the now-playing bar, small: drawn from the engine's
// own canvas or <video> as it leaves, with no request.
function captureKeptFrame(player) {
  const frame = snapshotPicture(player, "np-frame", { maxWidth: KEPT_FRAME_WIDTH });
  if (!frame) return null;
  frame.dataset.source = "local";
  frame.setAttribute("aria-hidden", "true");
  return frame;
}

function keepPlayer(player) {
  onOwnAction("playback");
  forgetFinished();
  playbackGeneration.cancel();
  cancelSeekWatch();
  forgetSeekStream();
  completeOptimisticSeekTransition({ immediate: true });
  const request = forgetStream();
  telemetry.end();
  stopProgressReporting();
  stopQualityMonitor();
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
  noteHeard(hub);
  if (!welcome || keptPlayer.current) return;
  const left = leftStream();
  if (left && !state.player) {
    realtime?.send({ type: "report", sessionId: left.sessionId, status: "idle", position: left.position });
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
  restoreStream(record.request);
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
  updateSubsUI();
  updateAudioUI();
  updateSpeedUI();
  updateVolumeButton();
  if (record.reloadSubtitles) {
    disableExternalSubtitle();
    void loadSelectedSubtitles();
  } else {
    renderSubtitle(state.currentTime);
  }
  danmaku.sync(state.currentTime);
  startQualityMonitor(player, record.meta);
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
      if (!recover(player, seekError, { startTime })) showPlaybackError(seekError);
    });
  }
  reportProgress({ force: true });
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
      notePausedHere(Number(getReportedCurrentTime().toFixed(3)));
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
