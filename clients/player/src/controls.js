import { state } from "./state.js";
import { t } from "./i18n.js";
import { createMarquee } from "./marquee.js";
import { holdSpeed, MIN_SPEED, nudgeSpeed, PRESETS, speedAt, speedFraction, speedName, stepSpeed } from "./playback-speed.js";
import { trackScrollEdges } from "./scroll-edges.js";
import { subtitlePictureBounds } from "./subtitle-layout.js";
import { fmt } from "./utils.js";

// The player's controls follow the YouTube app on a phone or tablet, since
// the car's screen is a touch screen (Agent Note
// 2026-07-13-in-car-design-principles). A tap on the picture shows one
// overlay, with no scrim over the picture: the top bar, previous ·
// play/pause · next over the picture's centre, and on the bottom edge the
// progress bar with every other control in a row under it, on the left;
// each menu opens above its button. Another tap, 3 seconds of playing, or a
// mouse leaving hides it. A pause (the owner's, an agent's, or the
// system's) brings it up, and while paused it stays; waiting never does:
// a stall, a seek's or a quality change's stream, a recovery, or the first
// load leaves it as it was, with the small loading ring over the picture.
// A tap never pauses by itself. A double tap on a side third seeks 10
// seconds a tap, a press and hold plays at 2× until it lets go, and a
// swipe down goes Back. With a
// mouse, as on YouTube's desktop player, there is no centre row: previous
// and next sit beside play in the bottom row, a click plays or pauses, and
// keys do the rest.

// --- DOM elements ----------------------------------------------------

const app = document.getElementById("app");
const playerContainer = document.getElementById("player-container");
const overlay = document.getElementById("overlay");
const controlsBottom = document.getElementById("controls-bottom");
const settingsDialog = document.getElementById("settings");
const btnCenterPlay = document.getElementById("btn-center-play");
const btnPlay = document.getElementById("btn-play");

// On a narrow screen the second pill scrolls; its edges fade where more
// controls lie behind them.
trackScrollEdges(document.getElementById("controls-actions"));
const btnPrevious = document.getElementById("btn-previous");
const btnNext = document.getElementById("btn-next");
const btnBarPrevious = document.getElementById("btn-bar-previous");
const btnBarNext = document.getElementById("btn-bar-next");
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
const speedChipText = document.getElementById("speed-chip-text");
const centerGlyph = document.getElementById("center-glyph");
const playbackNotice = document.getElementById("playback-notice");
const btnTapSound = document.getElementById("btn-tap-sound");
const centerLoading = document.getElementById("center-loading");
const centerRing = document.getElementById("center-spinner");
const btnSubs = document.getElementById("btn-subs");
const subsPanel = document.getElementById("subs-panel");
const btnAudio = document.getElementById("btn-audio");
const audioPanel = document.getElementById("audio-panel");
const btnSpeed = document.getElementById("btn-speed");
const speedPanel = document.getElementById("speed-panel");
const speedCurrent = document.getElementById("speed-current");
const speedSlider = document.getElementById("speed-slider");
const speedFill = document.getElementById("speed-fill");
const speedThumb = document.getElementById("speed-thumb");
const speedPresets = document.getElementById("speed-presets");
const speedNote = document.getElementById("speed-note");
// The top bar's title: one line that scrolls when it is too long (marquee.js).
const mediaTitle = createMarquee(document.getElementById("media-title"));
export const setMediaTitle = (text) => mediaTitle.set(text);
export const mediaTitleText = () => mediaTitle.text;

// What the controls ask of the player (initControls).
let actions = {
  onTogglePlayPause: () => {},
  onStop: () => {},
  onSeekToTime: () => {},
  onSetVolume: () => {},
  onPrevious: () => {},
  onNext: () => {},
  onHoldSpeed: () => false,
  onSetSpeed: () => {},
  isTouchScreen: () => false,
};

// --- Mouse or touch ------------------------------------------------------

// A computer's mouse gets YouTube's desktop layout (style.css): no centre
// row, previous and next beside play. A car's screen is touch whatever
// pointer its browser reports. main.js asks again when the profile changes.
const finePointer = window.matchMedia?.("(hover: hover) and (pointer: fine)");
finePointer?.addEventListener?.("change", () => noteInputMode());

export function noteInputMode() {
  app.classList.toggle("mouse-controls", Boolean(finePointer?.matches) && !actions.isTouchScreen());
}

// --- Where the picture is ----------------------------------------------

// The picture's rectangle (object-fit: contain, centred in the container),
// in the container's CSS pixels, as the subtitles and danmaku lay it out.
function pictureBounds() {
  const picture = playerContainer.querySelector("[data-engine]");
  const native = picture && "videoWidth" in picture;
  return subtitlePictureBounds(
    playerContainer.clientWidth,
    playerContainer.clientHeight,
    native ? picture.videoWidth : picture?.width || 0,
    native ? picture.videoHeight : picture?.height || 0,
  );
}

// A phone held upright lays the overlay's rows on the picture (style.css):
// the band above and below it, and whether the band below holds subtitles.
// Read when the window or the picture changes, never per frame.
const PICTURE_BAND_PX = 72;

function notePicture() {
  const { bottom } = pictureBounds();
  app.style.setProperty("--picture-inset", `${Math.max(0, Math.floor(bottom))}px`);
  app.classList.toggle("picture-band", bottom >= PICTURE_BAND_PX);
}

function watchPicture() {
  new ResizeObserver(notePicture).observe(playerContainer);
  new MutationObserver(notePicture).observe(playerContainer, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["width", "height"],
  });
  // A <video> element announces its picture size with events that do not
  // bubble but reach the container while capturing.
  for (const type of ["loadedmetadata", "resize"]) playerContainer.addEventListener(type, notePicture, true);
  notePicture();
}

// --- Controls visibility (auto-hide) ---------------------------------

const HIDE_AFTER_MS = 3000;
let hideTimer = null;

export function showControls() {
  app.classList.add("controls-visible");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideControls, HIDE_AFTER_MS);
}

// The pointer hides with the controls; while a stream loads, with no
// controls to show, a mouse's movement shows it alone for as long.
let cursorTimer = null;

function showCursor() {
  app.classList.add("cursor-visible");
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => app.classList.remove("cursor-visible"), HIDE_AFTER_MS);
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

const menuButtons = new Map([[subsPanel, btnSubs], [audioPanel, btnAudio], [speedPanel, btnSpeed]]);
const menus = [...menuButtons.keys()];
const menuOpen = () => menus.some((menu) => !menu.classList.contains("hidden"));

function closeMenus() {
  for (const menu of menus) menu.classList.add("hidden");
}

// A menu sits over the bottom row, centred above the button that opened it
// and kept inside the gutters; how high is style.css's (a phone held
// upright lays the row on the picture). In the zoomed page's pixels, which
// the window's are not (Agent Note 2026-10-11-display-size).
function placeMenu(menu) {
  if (menu.classList.contains("hidden")) return;
  const button = menuButtons.get(menu);
  const box = app.getBoundingClientRect();
  if (!box.width || !button.offsetWidth) return;
  const scale = app.offsetWidth / box.width;
  const target = button.getBoundingClientRect();
  const centre = (target.left + target.width / 2 - box.left) * scale;
  // The gutter as the bottom row has it.
  const gutter = parseFloat(getComputedStyle(controlsBottom).paddingLeft) || 0;
  const left = Math.max(gutter, Math.min(centre - menu.offsetWidth / 2, app.offsetWidth - gutter - menu.offsetWidth));
  menu.style.setProperty("--menu-left", `${Math.round(left)}px`);
}

function placeMenus() {
  for (const menu of menus) placeMenu(menu);
}

// Again when the window, a menu's contents, or the scrolling pill moves it.
function watchMenus() {
  const resized = new ResizeObserver(placeMenus);
  for (const element of [app, ...menus]) resized.observe(element);
  document.getElementById("controls-actions").addEventListener("scroll", placeMenus, { passive: true });
}

// One menu at a time over the bottom row.
function toggleMenu(menu) {
  for (const other of menus) if (other !== menu) other.classList.add("hidden");
  menu.classList.toggle("hidden");
  placeMenu(menu);
  showControls();
}

// While paused, or while a drag, a menu, or the settings sheet holds the
// controls up, look again shortly instead of giving up: otherwise they stay
// up for good once that ends without another tap on the controls. Waiting
// holds nothing: a seek's stream keeps the usual 3 seconds, and the loading
// ring shows over the picture once they hide.
function hideControls() {
  const held = progressWrap.classList.contains("dragging")
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
    ? atLiveEdge ? t("Live") : t("{time} from start", { time: fmt(Math.max(0, currentTime - seekStart)) })
    : t("{time} of {duration}", { time: fmt(currentTime), duration: fmt(state.duration) }));
}

export function updateProgress(fraction) {
  const clampedFraction = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const pct = `${(clampedFraction * 100).toFixed(3)}%`;
  if (pct === lastProgressPct) return;
  lastProgressPct = pct;
  progressPlayed.style.width = pct;
  progressScrubber.style.left = pct;
}

// A seek's or a track's stream on its way: the progress bar's seek
// indicator, seen while the controls show, and the loading ring. It leaves
// the controls as they were, as every wait does.
export function setSeekTransitionPending(pending) {
  const isPending = pending === true;
  progressWrap.classList.toggle("seeking", isPending);
  if (isPending) progressWrap.setAttribute("aria-busy", "true");
  else progressWrap.removeAttribute("aria-busy");
  // The previous player's startup or underrun goes with it: the seek is the
  // wait now.
  if (isPending) state.isBuffering = false;
  seekWaiting = isPending;
  showWaiting();
}

// --- Play button state -----------------------------------------------

let shownPlaying = null;

// Paused, the overlay comes up and stays; playing again, it hides 3 seconds
// later, whoever paused or resumed (a tap, an agent, the system's controls).
// It follows the playback intent, never the engine's state: a stall is not
// a pause, so waiting leaves the overlay as it was.
export function updatePlayButton() {
  const playing = state.playbackIntent === "playing";
  for (const button of [btnCenterPlay, btnPlay]) {
    button.classList.toggle("paused", !playing);
    button.setAttribute("aria-label", playing ? t("Pause") : t("Play"));
  }
  const changed = playing !== shownPlaying;
  shownPlaying = playing;
  if (changed && state.player && (!playing || app.classList.contains("controls-visible"))) showControls();
}

// Previous (back through Yolo's history) and next (forward again, or the
// queue's head). The centre row's keep their place when absent, so
// play/pause stays centred; the bottom row's, with a mouse, show only when
// there is one.
export function updateTransport({ previous = false, next = false } = {}) {
  btnPrevious.disabled = !previous;
  btnNext.disabled = !next;
  btnBarPrevious.classList.toggle("hidden", !previous);
  btnBarNext.classList.toggle("hidden", !next);
}

// --- Volume button state ---------------------------------------------

export function updateVolumeButton() {
  const muted = state.isMuted || state.audioBlocked;
  btnVolume.classList.toggle("muted", muted);
  btnVolume.setAttribute("aria-label", muted ? t("Unmute") : t("Mute"));
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

// The loading ring (style.css's .loading-ring) shows over the picture's
// centre whether or not the overlay does, for a stall or a load
// (`state.isBuffering`) and for a seek's stream (setSeekTransitionPending);
// with the overlay, it takes the place of the play/pause sign. It fades in
// only after a short wait, so a brief one shows nothing.
let seekWaiting = false;

function showWaiting() {
  const waiting = state.isBuffering || seekWaiting;
  centerLoading.classList.toggle("buffering", waiting);
  centerRing.classList.toggle("on", waiting);
  btnCenterPlay.classList.toggle("buffering", waiting);
}

export function showBuffering() {
  state.isBuffering = true;
  showWaiting();
}

export function hideBuffering() {
  state.isBuffering = false;
  showWaiting();
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

// On the picture's own rectangle (object-fit: contain in the container).
function placeRipple(ripple, side) {
  const bounds = pictureBounds();
  ripple.style.top = `${bounds.bottom}px`;
  ripple.style.height = `${bounds.height}px`;
  ripple.style.width = `${bounds.width * 0.36}px`;
  ripple.style[side] = `${(playerContainer.clientWidth - bounds.width) / 2}px`;
}

// YouTube's ripple: the side lights up with its arrows and the seconds so
// far, and a tap leaves a wave where the finger was.
function showRipple(side, seconds, at) {
  const ripple = seekRipples[side];
  if (!ripple.classList.contains("active")) placeRipple(ripple, side);
  seekRipples[side === "left" ? "right" : "left"].classList.remove("active");
  ripple.querySelector(".seek-label").textContent = t("{seconds} seconds", { seconds });
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

// --- Playback speed ------------------------------------------------------

// A panel as on YouTube: the speed, a slider from 0.5× to the engine's
// fastest (5× on the <video> engine, 3× on the canvas engine) on a
// logarithmic scale, and a row of presets (playback-speed.js). Dragging
// plays the speed as it goes, a few times a second. The button shows the
// speed while it is not 1×. A live stream plays at the speed it is made,
// so it has none.
const SPEED_APPLY_MS = 150;
let speedDrag = null; // { id, speed }
const speedApplied = { at: 0, timer: null };

// The speed shown: the slider's while it is dragged, else the owner's.
const shownSpeed = () => speedDrag?.speed ?? state.playbackSpeed;

function applySpeed(speed, { now = false } = {}) {
  clearTimeout(speedApplied.timer);
  speedApplied.timer = null;
  const wait = SPEED_APPLY_MS - (performance.now() - speedApplied.at);
  if (now || wait <= 0) {
    speedApplied.at = performance.now();
    if (speed !== state.playbackSpeed) actions.onSetSpeed(speed);
    else updateSpeedUI();
    return;
  }
  speedApplied.timer = setTimeout(() => applySpeed(speed, { now: true }), wait);
  updateSpeedUI();
}

function sliderSpeed(event) {
  const box = speedSlider.getBoundingClientRect();
  return speedAt(box.width > 0 ? (event.clientX - box.left) / box.width : 0, state.speedLimits.max);
}

function initSpeedPanel() {
  for (const speed of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.speed = String(speed);
    button.innerHTML = `<span>${speedName(speed)}</span>`;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      applySpeed(speed, { now: true });
      showControls();
    });
    speedPresets.appendChild(button);
  }

  speedSlider.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    speedSlider.setPointerCapture(event.pointerId);
    speedDrag = { id: event.pointerId, speed: sliderSpeed(event) };
    speedSlider.classList.add("dragging");
    applySpeed(speedDrag.speed);
    showControls();
  });
  speedSlider.addEventListener("pointermove", (event) => {
    if (speedDrag?.id !== event.pointerId) return;
    const speed = sliderSpeed(event);
    showControls();
    if (speed === speedDrag.speed) return;
    speedDrag.speed = speed;
    applySpeed(speed);
  });
  // Let go: the speed where it was let go, a preset within 0.05 of it.
  const release = (event) => {
    if (speedDrag?.id !== event.pointerId) return;
    const speed = event.type === "pointerup" ? sliderSpeed(event) : speedDrag.speed;
    speedDrag = null;
    speedSlider.classList.remove("dragging");
    applySpeed(speed, { now: true });
  };
  speedSlider.addEventListener("pointerup", release);
  speedSlider.addEventListener("pointercancel", release);
  speedSlider.addEventListener("keydown", (event) => {
    const max = state.speedLimits.max;
    const speed = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
    const to = speed ? nudgeSpeed(state.playbackSpeed, speed, max)
      : event.key === "Home" ? MIN_SPEED : event.key === "End" ? max : null;
    if (to == null) return;
    event.preventDefault();
    applySpeed(to, { now: true });
    showControls();
  });

  btnSpeed.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu(speedPanel);
  });
}

export function updateSpeedUI() {
  const speed = state.playbackSpeed;
  const { max, quietAbove } = state.speedLimits;
  btnSpeed.classList.toggle("hidden", state.isLive);
  if (state.isLive) speedPanel.classList.add("hidden");
  btnSpeed.classList.toggle("active", speed !== 1);
  btnSpeed.querySelector(".speed-value").textContent = speed === 1 ? "" : speedName(speed);
  btnSpeed.setAttribute("aria-label", speed === 1 ? t("Playback speed") : t("Playback speed {speed}", { speed: speedName(speed) }));

  const shown = shownSpeed();
  const at = `${(speedFraction(shown, max) * 100).toFixed(2)}%`;
  speedCurrent.textContent = speedName(shown);
  speedFill.style.width = at;
  speedThumb.style.left = at;
  speedSlider.setAttribute("aria-valuemax", String(max));
  speedSlider.setAttribute("aria-valuenow", String(shown));
  speedSlider.setAttribute("aria-valuetext", speedName(shown));
  for (const button of speedPresets.querySelectorAll("button")) {
    const preset = Number(button.dataset.speed);
    button.classList.toggle("hidden", preset > max);
    button.classList.toggle("active", preset === shown);
    button.setAttribute("aria-pressed", String(preset === shown));
  }
  // A browser that plays no sound this fast says so, rather than seeming to.
  const quiet = quietAbove != null && shown > quietAbove;
  speedNote.classList.toggle("hidden", !quiet);
  speedNote.textContent = quiet ? t("No sound above {speed} in this browser", { speed: speedName(quietAbove) }) : "";
}

// The speed over the picture: while a press is held, or for a moment after
// a key changed it.
let speedChipTimer = null;

function showSpeedChip(speed, { forMs = 0 } = {}) {
  speedChipText.textContent = speedName(speed);
  speedChip.classList.remove("hidden");
  clearTimeout(speedChipTimer);
  if (forMs) speedChipTimer = setTimeout(hideSpeedChip, forMs);
}

function hideSpeedChip() {
  clearTimeout(speedChipTimer);
  speedChip.classList.add("hidden");
}

function stepPlaybackSpeed(direction) {
  if (!state.player || state.isLive) return;
  const speed = stepSpeed(state.playbackSpeed, direction, state.speedLimits.max);
  actions.onSetSpeed(speed);
  showSpeedChip(speed, { forMs: 1_000 });
}

// --- Press and hold: 2× ------------------------------------------------

const HOLD_MS = 500;

function startHold(gesture) {
  // Live, or not playing: there a long press stays a tap.
  if (!actions.onHoldSpeed(true)) return;
  gesture.hold = true;
  // At 2× or faster the hold changes nothing and shows nothing.
  const speed = holdSpeed(state.playbackSpeed);
  if (speed == null) return;
  showSpeedChip(speed);
  hideControlsNow();
}

// Back to the owner's speed.
function endHold(gesture) {
  if (!gesture.hold) return;
  gesture.hold = false;
  actions.onHoldSpeed(false);
  hideSpeedChip();
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
    && !target.closest("button, a, input, select, textarea, [role='slider'], #subs-panel, #audio-panel, #speed-panel, #playback-error, dialog");
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
      // A mouse over the player shows the controls; on a touch screen a tap
      // does. Before the player exists (a stream still loading), it shows
      // only the pointer.
      if (!current && event.pointerType === "mouse" && !actions.isTouchScreen()) {
        if (state.player) showControls();
        else showCursor();
      }
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

  // A mouse leaving the player hides the controls at once, as on YouTube,
  // unless something holds them up.
  app.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && !actions.isTouchScreen() && app.classList.contains("controls-visible")) hideControls();
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
      // Shift+. and Shift+, as on YouTube.
      case ">":
        stepPlaybackSpeed(1);
        break;
      case "<":
        stepPlaybackSpeed(-1);
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
 * @param {(on: boolean) => boolean} [callbacks.onHoldSpeed]  false when a hold cannot speed up
 * @param {(speed: number) => void} [callbacks.onSetSpeed]  the owner's playback speed
 * @param {() => boolean} [callbacks.isTouchScreen]  a car's screen
 */
export function initControls(callbacks) {
  actions = { ...actions, ...callbacks };
  watchPicture();
  watchMenus();
  initGestures();
  initKeys();
  initSpeedPanel();
  updateSpeedUI();

  // Play/pause buttons: the centre's and the bottom row's
  for (const button of [btnCenterPlay, btnPlay]) {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlayback();
    });
  }

  for (const button of [btnPrevious, btnBarPrevious]) {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      actions.onPrevious();
    });
  }

  for (const button of [btnNext, btnBarNext]) {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      actions.onNext();
    });
  }

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

  // Subtitle and audio panel toggles
  btnSubs.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(subsPanel);
  });

  btnAudio.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(audioPanel);
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
