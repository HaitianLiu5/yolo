import { state } from "./state.js";
import { subtitlePictureBounds } from "./subtitle-layout.js";
import { fmt } from "./utils.js";

// The player's controls follow the YouTube app on a phone or tablet, since
// the car's screen is a touch screen (Agent Note
// 2026-07-13-in-car-design-principles). A tap on the picture shows one
// overlay over a soft scrim: the top bar, previous · play/pause · next over
// the picture's centre, and the time, the progress bar, and fullscreen on the
// bottom edge. Another tap, or 3 seconds of playing, hides it; while paused
// it stays. A tap never pauses by itself. A double tap on a side third seeks
// 10 seconds a tap, a press and hold plays at twice the speed where the
// engine can, and a swipe down goes Back. With a mouse, a click plays or
// pauses; keys do the rest.

// --- DOM elements ----------------------------------------------------

const app = document.getElementById("app");
const playerContainer = document.getElementById("player-container");
const overlay = document.getElementById("overlay");
const settingsDialog = document.getElementById("settings");
const btnCenterPlay = document.getElementById("btn-center-play");
const btnPrevious = document.getElementById("btn-previous");
const btnNext = document.getElementById("btn-next");
const btnVolume = document.getElementById("btn-volume");
const btnFullscreen = document.getElementById("btn-fullscreen");
const timeCurrent = document.getElementById("time-current");
const timeSep = document.getElementById("time-sep");
const timeDuration = document.getElementById("time-duration");
const btnLiveEdge = document.getElementById("btn-live-edge");
const progressWrap = document.getElementById("progress-wrap");
const progressPlayed = document.getElementById("progress-played");
const progressScrubber = document.getElementById("progress-scrubber");
const progressBubble = document.getElementById("progress-bubble");
const seekRipples = {
  left: document.getElementById("seek-ripple-left"),
  right: document.getElementById("seek-ripple-right"),
};
const speedChip = document.getElementById("speed-chip");
const centerGlyph = document.getElementById("center-glyph");
const playbackNotice = document.getElementById("playback-notice");
const btnTapSound = document.getElementById("btn-tap-sound");
const centerLoading = document.getElementById("center-loading");
const centerBuffer = document.getElementById("center-buffer");
const btnSubs = document.getElementById("btn-subs");
const subsPanel = document.getElementById("subs-panel");
const btnAudio = document.getElementById("btn-audio");
const audioPanel = document.getElementById("audio-panel");
export const mediaTitle = document.getElementById("media-title");

// What the controls ask of the player (initControls).
let actions = {
  onTogglePlayPause: () => {},
  onStop: () => {},
  onSeekToTime: () => {},
  onSetVolume: () => {},
  onPrevious: () => {},
  onNext: () => {},
  onHoldSpeed: () => false,
  isTouchScreen: () => false,
};

// --- Controls visibility (auto-hide) ---------------------------------

const HIDE_AFTER_MS = 3000;
let hideTimer = null;

export function showControls() {
  app.classList.add("controls-visible");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideControls, HIDE_AFTER_MS);
}

function hideControlsNow() {
  clearTimeout(hideTimer);
  hideTimer = null;
  app.classList.remove("controls-visible");
}

function toggleControls() {
  if (app.classList.contains("controls-visible")) hideControlsNow();
  else showControls();
}

const menuOpen = () => !subsPanel.classList.contains("hidden") || !audioPanel.classList.contains("hidden");

function closeMenus() {
  subsPanel.classList.add("hidden");
  audioPanel.classList.add("hidden");
}

// While paused, or while a drag, a seek, a menu, or the settings sheet holds
// the controls up, look again shortly instead of giving up: otherwise they
// stay up for good once that ends without another tap on the controls.
function hideControls() {
  const held = progressWrap.classList.contains("dragging")
    || progressWrap.classList.contains("seeking")
    || menuOpen()
    || settingsDialog?.open === true
    || (Boolean(state.player) && state.playbackIntent !== "playing");
  if (held) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideControls, 1000);
    return;
  }
  app.classList.remove("controls-visible");
}

// --- Time / progress display -----------------------------------------

let lastCurrentTimeText = "";
let lastDurationText = "";
let lastProgressPct = "";
// Compensate for WebCodecs seek warm-up by targeting a real segment from the
// bounded future runway exposed by the HLS proxy.
const LIVE_SEEK_LEAD_SECONDS = 11;

export function updateTimeDisplay(currentTime = state.currentTime) {
  const hasLiveTimeline = state.isLive
    && state.liveDvrAvailable
    && state.liveEdgeTime > state.liveStartTime;
  const liveLatency = hasLiveTimeline ? state.liveEdgeTime - currentTime : Infinity;
  const atLiveEdge = liveLatency <= 10;
  const nextCurrentTimeText = state.isLive
    ? hasLiveTimeline && !atLiveEdge
      ? fmt(Math.max(0, currentTime - state.liveStartTime))
      : ""
    : fmt(currentTime);
  const nextDurationText = state.isLive ? "" : fmt(state.duration);

  if (nextCurrentTimeText !== lastCurrentTimeText || timeCurrent.textContent !== nextCurrentTimeText) {
    lastCurrentTimeText = nextCurrentTimeText;
    timeCurrent.textContent = nextCurrentTimeText;
  }
  if (nextDurationText !== lastDurationText || timeDuration.textContent !== nextDurationText) {
    lastDurationText = nextDurationText;
    timeDuration.textContent = nextDurationText;
  }
  timeSep.classList.toggle("hidden", state.isLive);
  btnLiveEdge.classList.toggle("hidden", !state.isLive);
  btnLiveEdge.disabled = atLiveEdge;
  btnLiveEdge.classList.toggle("at-edge", atLiveEdge);

  const seekStart = hasLiveTimeline ? state.liveStartTime : 0;
  const seekEnd = hasLiveTimeline ? state.liveEdgeTime : state.duration;
  progressWrap.setAttribute("aria-valuemin", "0");
  progressWrap.setAttribute("aria-valuemax", String(Math.max(0, Math.round(seekEnd - seekStart))));
  progressWrap.setAttribute("aria-valuenow", String(Math.max(0, Math.round(currentTime - seekStart))));
  progressWrap.setAttribute("aria-valuetext", state.isLive
    ? atLiveEdge ? "Live" : `${fmt(Math.max(0, currentTime - seekStart))} from start`
    : `${fmt(currentTime)} of ${fmt(state.duration)}`);
}

export function updateProgress(fraction) {
  const clampedFraction = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const pct = `${(clampedFraction * 100).toFixed(3)}%`;
  if (pct === lastProgressPct) return;
  lastProgressPct = pct;
  progressPlayed.style.width = pct;
  progressScrubber.style.left = pct;
}

export function setSeekTransitionPending(pending) {
  const isPending = pending === true;
  const wasPending = progressWrap.classList.contains("seeking");
  progressWrap.classList.toggle("seeking", isPending);
  if (isPending) progressWrap.setAttribute("aria-busy", "true");
  else progressWrap.removeAttribute("aria-busy");
  // A seek transition owns the progress indicator; clear any spinner left by
  // the previous player's startup or underrun before it is disposed.
  if (isPending) hideBuffering();
  if (isPending || wasPending) showControls();
}

// --- Play button state -----------------------------------------------

let shownPlaying = null;

// Paused, the overlay comes up and stays; playing again, it hides 3 seconds
// later, whoever paused or resumed (a tap, an agent, the system's controls).
export function updatePlayButton() {
  const playing = state.playbackIntent === "playing";
  btnCenterPlay.classList.toggle("paused", !playing);
  btnCenterPlay.setAttribute("aria-label", playing ? "Pause" : "Play");
  const changed = playing !== shownPlaying;
  shownPlaying = playing;
  if (changed && state.player && (!playing || app.classList.contains("controls-visible"))) showControls();
}

// Previous (an earlier item in Yolo's history) and next (the queue's head).
// The buttons keep their place when absent, so play/pause stays centred.
export function updateTransport({ previous = false, next = false } = {}) {
  btnPrevious.disabled = !previous;
  btnNext.disabled = !next;
}

// --- Volume button state ---------------------------------------------

export function updateVolumeButton() {
  btnVolume.classList.toggle("muted", state.isMuted || state.audioBlocked);
}

function toggleMute() {
  state.isMuted = !state.isMuted;
  actions.onSetVolume(state.isMuted ? 0 : 1);
  updateVolumeButton();
}

// One small hint while the browser keeps playback muted; any tap on the
// page unlocks sound (main.js), this one included.
export function showTapForSound(visible) {
  btnTapSound?.classList.toggle("hidden", !visible);
}

// --- Buffering state -------------------------------------------------

// The spinner shows over the picture whether or not the overlay does; with
// the overlay, it takes the place of the play/pause sign.
export function showBuffering() {
  state.isBuffering = true;
  centerLoading.classList.add("buffering");
  btnCenterPlay.classList.add("buffering");
}

export function hideBuffering() {
  state.isBuffering = false;
  centerLoading.classList.remove("buffering");
  btnCenterPlay.classList.remove("buffering");
  setBufferProgress(null);
}

// How full the startup buffer is, as a quiet percentage inside the spinner;
// null hides it.
export function setBufferProgress(fraction) {
  if (!centerBuffer) return;
  const text = Number.isFinite(fraction) && fraction > 0 && fraction < 1 ? `${Math.floor(fraction * 100)}%` : "";
  if (centerBuffer.textContent !== text) centerBuffer.textContent = text;
}

let noticeTimer = null;

// A short, human line that goes away by itself.
export function showPlaybackNotice(text, { durationMs = 6_000 } = {}) {
  if (!playbackNotice || !text) return;
  playbackNotice.textContent = text;
  playbackNotice.classList.remove("hidden");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(hidePlaybackNotice, durationMs);
}

export function hidePlaybackNotice() {
  if (!playbackNotice) return;
  clearTimeout(noticeTimer);
  playbackNotice.textContent = "";
  playbackNotice.classList.add("hidden");
}

// --- Play / pause from a click or a key ------------------------------

function restartAnimation(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

function togglePlayback({ glyph = false } = {}) {
  if (!state.player) return;
  // The sign of what the press did: play when playback starts, pause when it stops.
  if (glyph) {
    centerGlyph.classList.toggle("paused", state.playbackIntent === "playing");
    restartAnimation(centerGlyph, "flash");
  }
  actions.onTogglePlayPause();
}

// --- Seeking by taps and keys ----------------------------------------

const SEEK_STEP_SECONDS = 10;
const KEY_SEEK_SECONDS = 5;
// A second tap on the same side within this is a double tap.
const DOUBLE_TAP_MS = 300;
// Once seeking, each further tap on a side within this adds another step.
const SEEK_RUN_MS = 700;
// One seek for a burst of taps, so the canvas engine is not flushed on each.
const SEEK_SETTLE_MS = 350;

let seekRun = null; // { side, from, seconds, lastAt, settle }
let rippleTimer = null;

function canSeek() {
  if (!state.player) return false;
  if (state.isLive) return state.liveDvrAvailable;
  return state.duration > 0;
}

function settleSeek(run) {
  clearTimeout(run.settle);
  run.settle = null;
  actions.onSeekToTime(run.from + (run.side === "right" ? run.seconds : -run.seconds));
}

function seekBy(side, step, at = null) {
  if (!canSeek()) return;
  const now = performance.now();
  if (!seekRun || seekRun.side !== side || now - seekRun.lastAt > SEEK_RUN_MS) {
    if (seekRun?.settle) settleSeek(seekRun);
    seekRun = { side, from: state.currentTime, seconds: 0, lastAt: now, settle: null };
  }
  const run = seekRun;
  run.seconds += step;
  run.lastAt = now;
  showRipple(side, run.seconds, at);
  clearTimeout(run.settle);
  run.settle = setTimeout(() => settleSeek(run), SEEK_SETTLE_MS);
}

// On the picture's own rectangle (object-fit: contain in the container), in
// the container's CSS pixels, as the subtitles are laid out.
function placeRipple(ripple, side) {
  const picture = playerContainer.querySelector("[data-engine]");
  const native = picture && "videoWidth" in picture;
  const width = playerContainer.clientWidth;
  const height = playerContainer.clientHeight;
  const bounds = subtitlePictureBounds(width, height, native ? picture.videoWidth : picture?.width || 0, native ? picture.videoHeight : picture?.height || 0);
  ripple.style.top = `${bounds.bottom}px`;
  ripple.style.height = `${bounds.height}px`;
  ripple.style.width = `${bounds.width * 0.36}px`;
  ripple.style[side] = `${(width - bounds.width) / 2}px`;
}

// YouTube's ripple: the side lights up with its arrows and the seconds so
// far, and a tap leaves a wave where the finger was.
function showRipple(side, seconds, at) {
  const ripple = seekRipples[side];
  if (!ripple.classList.contains("active")) placeRipple(ripple, side);
  seekRipples[side === "left" ? "right" : "left"].classList.remove("active");
  ripple.querySelector(".seek-label").textContent = `${seconds} seconds`;
  ripple.classList.add("active");
  if (at) {
    // Pointer coordinates are the window's CSS pixels; the ripple's own are
    // those of the zoomed page (Agent Note 2026-10-11-display-size).
    const box = ripple.getBoundingClientRect();
    const scale = box.width > 0 ? ripple.offsetWidth / box.width : 1;
    const wave = document.createElement("span");
    wave.className = "seek-wave";
    wave.style.left = `${(at.x - box.left) * scale}px`;
    wave.style.top = `${(at.y - box.top) * scale}px`;
    ripple.appendChild(wave);
    setTimeout(() => wave.remove(), 700);
  }
  clearTimeout(rippleTimer);
  rippleTimer = setTimeout(() => ripple.classList.remove("active"), SEEK_RUN_MS + 100);
}

// --- Press and hold: twice the speed ----------------------------------

const HOLD_MS = 500;

function startHold(gesture) {
  // The canvas engine plays at its audio clock's rate only: there a long
  // press stays a tap.
  if (!actions.onHoldSpeed(true)) return;
  gesture.hold = true;
  speedChip.classList.remove("hidden");
  hideControlsNow();
}

function endHold(gesture) {
  if (!gesture.hold) return;
  gesture.hold = false;
  actions.onHoldSpeed(false);
  speedChip.classList.add("hidden");
}

// --- Swipe down: Back --------------------------------------------------

const MOVE_SLOP_PX = 10;
const SWIPE_BACK_PX = 80;

function pull(distance) {
  app.classList.add("pulling");
  app.style.setProperty("--pull", `${Math.round(Math.min(distance, 240) * 0.5)}px`);
}

function releasePull() {
  app.classList.remove("pulling");
  app.style.removeProperty("--pull");
}

// --- Gestures on the picture -----------------------------------------

let gesture = null;
let pendingTap = null; // { side, at, timer }

// A car's screen is touch whatever its pointer events say, so a tap there
// never pauses; a mouse elsewhere clicks.
const touchLike = (event) => event.pointerType !== "mouse" || actions.isTouchScreen();

// The picture, or the overlay's empty space over it; not a control, a menu,
// the error panel, or the home screen.
function onPicture(target) {
  return Boolean(state.player) && overlay.classList.contains("hidden")
    && !target.closest("button, a, input, select, textarea, [role='slider'], #subs-panel, #audio-panel, #playback-error, dialog");
}

function cancelGesture() {
  const current = gesture;
  gesture = null;
  if (!current) return;
  clearTimeout(current.holdTimer);
  endHold(current);
  if (current.pull) releasePull();
}

function tap(event, current) {
  // The tap that closes a menu does only that.
  if (current.menu) {
    closeMenus();
    showControls();
    return;
  }
  if (!current.touch) {
    // The click that brings sound back does not also pause.
    if (!current.muted) togglePlayback({ glyph: true });
    return;
  }
  const now = performance.now();
  const box = app.getBoundingClientRect();
  const x = (event.clientX - box.left) / box.width;
  const side = x < 1 / 3 ? "left" : x > 2 / 3 ? "right" : null;
  const at = { x: event.clientX, y: event.clientY };
  if (side && seekRun && now - seekRun.lastAt <= SEEK_RUN_MS) {
    seekBy(side, SEEK_STEP_SECONDS, at);
    return;
  }
  if (side && pendingTap?.side === side && now - pendingTap.at <= DOUBLE_TAP_MS) {
    clearTimeout(pendingTap.timer);
    pendingTap = null;
    seekBy(side, SEEK_STEP_SECONDS, at);
    return;
  }
  clearTimeout(pendingTap?.timer);
  pendingTap = null;
  if (!side || !canSeek()) {
    toggleControls();
    return;
  }
  // On a side, wait a moment for a second tap before showing or hiding.
  const timer = setTimeout(() => {
    pendingTap = null;
    if (state.player) toggleControls();
  }, DOUBLE_TAP_MS);
  pendingTap = { side, at: now, timer };
}

function initGestures() {
  app.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) {
      cancelGesture();
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!onPicture(event.target)) {
      // A press on a control keeps the overlay up.
      if (event.target.closest("#controls") && app.classList.contains("controls-visible")) showControls();
      return;
    }
    cancelGesture();
    const current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      touch: touchLike(event),
      menu: menuOpen(),
      muted: state.audioBlocked,
      moved: false,
      pull: 0,
      hold: false,
      holdTimer: null,
    };
    current.holdTimer = setTimeout(() => {
      if (gesture === current && !current.moved && !current.menu) startHold(current);
    }, HOLD_MS);
    gesture = current;
  });

  app.addEventListener("pointermove", (event) => {
    const current = gesture;
    if (!current || event.pointerId !== current.id) {
      // A mouse over the player shows the controls; on a touch screen a tap does.
      if (!current && event.pointerType === "mouse" && !actions.isTouchScreen() && state.player) showControls();
      return;
    }
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) > MOVE_SLOP_PX) {
      current.moved = true;
      clearTimeout(current.holdTimer);
    }
    if (current.hold || !current.moved) return;
    if (current.touch && !current.menu && dy > Math.abs(dx)) {
      current.pull = dy;
      pull(dy);
    } else if (current.pull) {
      current.pull = 0;
      releasePull();
    }
  });

  app.addEventListener("pointerup", (event) => {
    const current = gesture;
    if (!current || event.pointerId !== current.id) return;
    gesture = null;
    clearTimeout(current.holdTimer);
    if (current.hold) {
      endHold(current);
      return;
    }
    if (current.pull) {
      releasePull();
      // The same Back as the back button.
      if (current.pull >= SWIPE_BACK_PX) actions.onStop();
      return;
    }
    if (current.moved) return;
    tap(event, current);
  });

  app.addEventListener("pointercancel", (event) => {
    if (gesture && event.pointerId === gesture.id) cancelGesture();
  });
  window.addEventListener("blur", cancelGesture);

  // A long press on the picture is the hold, not the browser's menu.
  app.addEventListener("contextmenu", (event) => {
    if (gesture?.touch && onPicture(event.target)) event.preventDefault();
  });
}

// --- Keys (computers) --------------------------------------------------

function initKeys() {
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!state.player || !overlay.classList.contains("hidden") || document.querySelector("dialog[open]")) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    // Space presses a control that has keyboard focus.
    const onFocusedControl = Boolean(target?.closest("button, a, [role='slider']")) && target.matches(":focus-visible");
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === " " && onFocusedControl) return;
    switch (key) {
      case " ":
      case "k":
        togglePlayback({ glyph: true });
        break;
      case "j":
        seekBy("left", SEEK_STEP_SECONDS);
        break;
      case "l":
        seekBy("right", SEEK_STEP_SECONDS);
        break;
      case "ArrowLeft":
        seekBy("left", KEY_SEEK_SECONDS);
        break;
      case "ArrowRight":
        seekBy("right", KEY_SEEK_SECONDS);
        break;
      case "f":
        if (!btnFullscreen.classList.contains("hidden")) btnFullscreen.click();
        break;
      case "m":
        toggleMute();
        break;
      default:
        return;
    }
    event.preventDefault();
  });
}

// --- Init (wires up event listeners with callbacks) ------------------

let isDragging = false;
let dragPreviewTime = null;

export function isDraggingProgress() {
  return isDragging;
}

/**
 * @param {object} callbacks
 * @param {() => void} callbacks.onTogglePlayPause
 * @param {() => void} callbacks.onStop  Back
 * @param {(seconds: number) => void} callbacks.onSeekToTime
 * @param {(volume: number) => void} callbacks.onSetVolume
 * @param {() => void} [callbacks.onPrevious]
 * @param {() => void} [callbacks.onNext]
 * @param {(on: boolean) => boolean} [callbacks.onHoldSpeed]  false where the engine cannot
 * @param {() => boolean} [callbacks.isTouchScreen]  a car's screen
 */
export function initControls(callbacks) {
  actions = { ...actions, ...callbacks };
  initGestures();
  initKeys();

  // Play/pause button
  btnCenterPlay.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlayback();
  });

  btnPrevious.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.onPrevious();
  });

  btnNext.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.onNext();
  });

  // Its tap already unlocked sound (main.js, capture phase); nothing else.
  btnTapSound?.addEventListener("click", (e) => e.stopPropagation());

  // Back button
  document.getElementById("btn-back").addEventListener("click", (e) => {
    e.stopPropagation();
    actions.onStop();
  });

  // Volume button
  btnVolume.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMute();
  });

  btnLiveEdge.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!state.isLive || btnLiveEdge.disabled) return;
    actions.onSeekToTime(state.liveEdgeTime + LIVE_SEEK_LEAD_SECONDS);
  });

  progressWrap.addEventListener("keydown", (e) => {
    if (state.isLive && !state.liveDvrAvailable) return;
    let target = null;
    if (e.key === "ArrowLeft") target = state.currentTime - 5;
    if (e.key === "ArrowRight") target = state.currentTime + 5;
    if (e.key === "Home") target = state.isLive ? state.liveStartTime : 0;
    if (e.key === "End") target = state.isLive
      ? state.liveEdgeTime + LIVE_SEEK_LEAD_SECONDS
      : state.duration;
    if (target == null) return;
    e.preventDefault();
    actions.onSeekToTime(Math.max(state.isLive ? state.liveStartTime : 0, target));
  });

  // Subtitle panel toggle
  btnSubs.addEventListener("click", (e) => {
    e.stopPropagation();
    audioPanel.classList.add("hidden");
    subsPanel.classList.toggle("hidden");
    showControls();
  });

  // Audio panel toggle
  btnAudio.addEventListener("click", (e) => {
    e.stopPropagation();
    subsPanel.classList.add("hidden");
    audioPanel.classList.toggle("hidden");
    showControls();
  });

  // Progress bar drag: the thumb grows and a bubble shows the time under it.
  function getSeekFraction(e) {
    const rect = progressWrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function previewDrag(fraction) {
    updateProgress(fraction);
    dragPreviewTime = state.isLive
      ? state.liveStartTime + fraction * (state.liveEdgeTime - state.liveStartTime)
      : fraction * state.duration;
    updateTimeDisplay(dragPreviewTime);
    progressBubble.textContent = fmt(state.isLive ? Math.max(0, dragPreviewTime - state.liveStartTime) : dragPreviewTime);
    progressBubble.style.setProperty("--at", `${(fraction * 100).toFixed(3)}%`);
  }

  progressWrap.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.isLive && !state.liveDvrAvailable) return;
    isDragging = true;
    progressWrap.classList.add("dragging");
    progressWrap.setPointerCapture(e.pointerId);
    previewDrag(getSeekFraction(e));
    showControls();
  });

  progressWrap.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    previewDrag(getSeekFraction(e));
    showControls();
  });

  progressWrap.addEventListener("pointerup", (e) => {
    if (!isDragging) return;
    isDragging = false;
    progressWrap.classList.remove("dragging");
    const fraction = getSeekFraction(e);
    dragPreviewTime = null;
    actions.onSeekToTime(state.isLive
      ? state.liveStartTime + fraction * (state.liveEdgeTime - state.liveStartTime)
      : fraction * state.duration);
  });

  progressWrap.addEventListener("pointercancel", () => {
    isDragging = false;
    dragPreviewTime = null;
    progressWrap.classList.remove("dragging");
    updateTimeDisplay();
    updateProgress(state.isLive && state.liveEdgeTime > state.liveStartTime
      ? (state.currentTime - state.liveStartTime) / (state.liveEdgeTime - state.liveStartTime)
      : state.duration > 0 ? state.currentTime / state.duration : 0);
  });

}
