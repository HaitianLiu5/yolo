import { artworkSource, landscapeArtwork } from "./artwork.js";
import { hideBuffering, mediaTitleText, setMediaTitle, setSeekTransitionPending, showBuffering } from "./controls.js";
import { h } from "./dom.js";
import { endLaunch } from "./launch.js";
import { owner } from "./owner.js";
import { describePlaybackError } from "./playback-error.js";
import { navigate } from "./router.js";
import { state } from "./state.js";
import { notePlaybackDiagnostics } from "./telemetry/playback-diagnostics.js";
import { logPlayerEvent } from "./telemetry/player-log.js";

// What stands in for a moving picture on the player (Agent Note
// 2026-10-11-device-telemetry), one at a time: the loading screen from a
// press until the picture moves, and the error panel when playback gives
// up. Waiting is the item's own picture, lightly dimmed, under the one
// small spinner, and no words, however long it takes, as the YouTube and
// Netflix apps do; a seek or a recovery keeps the last picture under the
// spinner instead (player.js). Only an error nothing will fix by itself
// gets words, which playback-error.js chooses, and a way to try again.

const app = document.getElementById("app");
const overlay = document.getElementById("overlay");
const poster = document.getElementById("loading-poster");
const posterImage = poster.querySelector("img");
const panel = {
  root: document.getElementById("playback-error"),
  text: document.getElementById("playback-error-text"),
  detail: document.getElementById("playback-error-detail"),
  fixes: document.getElementById("playback-error-fixes"),
  relay: document.getElementById("btn-playback-relay"),
  retry: document.getElementById("btn-playback-retry"),
  back: document.getElementById("btn-playback-back"),
};

let fromPlayer = { retry: () => {}, back: () => {}, setRelayMode: async () => {} };

/**
 * `retry` and `back` are what the error panel's buttons do when the caller
 * gives none (player.js: the item again, and leaving it); `setRelayMode`
 * sets this screen's media paths (media-paths.js).
 */
export function initPlayerScreens({ retry, back, setRelayMode }) {
  fromPlayer = { retry, back, setRelayMode };
}

// --- Loading -----------------------------------------------------------------

// The picture shown, and a count that drops an earlier one still loading.
let loading = null;
let loadingGeneration = 0;

/**
 * A tap, a resume after a reload (also before the welcome, from what the
 * page kept: main.js), or a stream Yolo sent to the home screen: the
 * spinner, and the item's picture when it has one (its card already loaded
 * it). The same item's picture, already up (a start that showed it before
 * its welcome), stays as it is.
 */
export function showLoading({ artwork = null } = {}) {
  hidePlaybackError();
  overlay.classList.add("hidden");
  showBuffering();
  endLaunch();
  if (loading && loading.artwork === artwork) return;
  const mine = ++loadingGeneration;
  loading = { artwork };
  posterImage.classList.remove("ready");
  posterImage.removeAttribute("src");
  poster.classList.remove("hidden");
  if (!artwork) return;
  void Promise.resolve(artworkSource(landscapeArtwork(artwork))).then((url) => {
    if (!url || mine !== loadingGeneration) return;
    posterImage.onload = () => posterImage.classList.add("ready");
    posterImage.src = url;
  }, () => {});
}

/** The picture moves, an error shows, or the owner left. */
export function hideLoading() {
  loadingGeneration += 1;
  loading = null;
  poster.classList.add("hidden");
}

/** Yolo's stream arrived for this screen: its picture is awaited now. */
export function noteStreamArrived({ artwork = null } = {}) {
  if (!loading) showLoading({ artwork });
}

/**
 * The loading screen a start showed before its welcome, for an item the
 * welcome does not resume: it goes, and the home screen shows (main.js).
 */
export function clearStartLoading() {
  if (state.player || !loading) return;
  hideLoading();
  hideBuffering();
  overlay.classList.remove("hidden");
}

// --- A press that starts another item ----------------------------------------

// The press under way: { sessionId, title }, the stream and title it left.
let starting = null;

/**
 * A press that asks Yolo for another item to play here (next, previous,
 * Play now, an end screen's card), which Yolo answers with a `load` only
 * once the node has prepared the stream: the screen answers the press at
 * once, as a tap on a home card does, with the item's picture and title
 * under the spinner when the press knows the item (`item`, else null). The
 * `load` takes over from there (player.js). cancel() puts the screen back
 * when Yolo refuses, and says whether it did: not when a newer press took
 * over, or the `load` came first after all.
 */
export function showStarting(item = null) {
  const mine = { sessionId: state.sessionId, title: mediaTitleText() };
  starting = mine;
  // Over the <video> engine's last frame too, until the new stream's.
  app.classList.add("starting");
  if (item?.title) setMediaTitle(item.title);
  showLoading({ artwork: item?.thumbnail ?? null });
  return {
    cancel() {
      if (starting !== mine) return false;
      endStarting();
      if (state.sessionId !== mine.sessionId) return false;
      hideLoading();
      hideBuffering();
      setMediaTitle(mine.title);
      return true;
    },
  };
}

/** The new stream replaced the last item's picture, or nothing loads any more. */
export function endStarting() {
  starting = null;
  app.classList.remove("starting");
}

// --- The error panel ---------------------------------------------------------

// What the panel's buttons do for the error it shows.
let panelActions = null;

/**
 * @param {Error} error  Kept for telemetry; the panel says what playback-error.js chooses.
 * @param {{ retry?: () => void, back?: () => void }} [actions]  the buttons, when not the player's own
 */
export function showPlaybackError(error, { retry = fromPlayer.retry, back = fromPlayer.back } = {}) {
  // Nothing loads any more: no loading ring, a seek's included.
  endStarting();
  hideBuffering();
  setSeekTransitionPending(false);
  hideLoading();
  endLaunch();
  const shown = describePlaybackError(error, { share: document.documentElement.dataset.share !== undefined });
  const relay = shown.fixes.some((fix) => fix.action === "relay");
  panelActions = { retry: shown.retry ? retry : null, back, relay: relay ? () => void turnOnRelay(retry) : null };
  panel.text.textContent = shown.text;
  panel.detail.textContent = shown.reason;
  panel.detail.classList.toggle("hidden", !shown.reason);
  panel.fixes.replaceChildren(...shown.fixes.map((fix) => h("li", { text: fix.text })));
  panel.fixes.classList.toggle("hidden", !shown.fixes.length);
  panel.retry.classList.toggle("hidden", !shown.retry);
  panel.relay.classList.toggle("hidden", !relay);
  panel.root.classList.toggle("dead-end", shown.kind === "dead_end");
  panel.root.classList.remove("hidden");
  const detail = { code: error?.apiCode || error?.code || null, error: error?.message || String(error) };
  logPlayerEvent("playback_error_shown", detail);
  notePlaybackDiagnostics({ lastError: { ...detail, at: new Date().toISOString() } }, { event: { type: "playback_error_shown", ...detail }, now: true });
}

export const playbackErrorShown = () => !panel.root.classList.contains("hidden");

export function hidePlaybackError() {
  panel.root.classList.add("hidden");
  panelActions = null;
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
  logPlayerEvent("relay_turned_on", { from: "dead_end" });
  await fromPlayer.setRelayMode("auto");
  retry();
}

for (const action of ["relay", "retry", "back"]) {
  panel[action].addEventListener("click", (event) => {
    event.stopPropagation();
    const run = panelActions?.[action];
    hidePlaybackError();
    run?.();
  });
}
