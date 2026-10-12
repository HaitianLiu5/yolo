import { state } from "./state.js";
import { initRouter, parseRoute, navigate } from "./router.js";
import { initControls, updatePlayButton, updateVolumeButton } from "./controls.js";
import {
  applyTracks, leavePlayback, play, stop, seekToTime, togglePlayPause, showStatus, initMediaSession, updateMediaSession,
  reportProgress, setPlayerCallbacks, setRealtime,
} from "./player.js";
import { loadBrowseScreen, openEpisodes, renderPlaylists, renderQueue, updateSubsUI, updateAudioUI } from "./browse.js";
import { getCredential, saveCredential, setUnauthorizedHandler } from "./api.js";
import { pairDevice } from "./pairing.js";
import { buildFreshPlaybackSessionRequest } from "./playback-recovery.js";
import { requestStream, setPlaybackChannel } from "./playback.js";
import { createRealtime } from "./realtime.js";
import { disableExternalSubtitle, loadSubtitleTrack, renderSubtitle } from "./subtitles.js";
import { deviceEvents, installDeviceTelemetry, recordDeviceEvent } from "./telemetry/device-events.js";
import { createEnvironmentReporter } from "./telemetry/environment.js";

// The Tesla client's entry point: pairing, the realtime channel to Yolo's
// Hub (yolo-v1.md §7), and routing. Playback itself is player.js.

const connectionStatus = document.getElementById("connection-status");
const connectionStatusText = document.getElementById("connection-status-text");
const statusActions = document.getElementById("status-actions");
const btnTakeOver = document.getElementById("btn-take-over");
const btnRetryConnection = document.getElementById("btn-retry-connection");
// A reconnect within this long after the car lost its connection while
// playing continues playing; later, it resumes paused.
const RESUME_PLAYING_WITHIN_MS = 2 * 60_000;

// --- Player callbacks (break circular dep player↔browse) -------------

setPlayerCallbacks({ updateSubsUI, updateAudioUI });

initControls({
  onTogglePlayPause: togglePlayPause,
  onStop: stop,
  onSeekToTime: seekToTime,
  onSetVolume: (v) => { if (state.player) state.player.setVolume(v); },
});

// --- Router ----------------------------------------------------------

let routeTransitionGeneration = 0;

initRouter((route, navigation) => {
  const generation = ++routeTransitionGeneration;
  if (route.view === "browse") {
    void enterBrowseRoute(generation).catch((error) => {
      console.error("[router] Failed to enter browse route:", error);
      if (generation === routeTransitionGeneration) showStatus(`Failed to load home screen: ${error.message}`);
    });
    return;
  }
  if (route.view === "show" && navigation?.source === "popstate") {
    void enterShowRoute(route, generation).catch((error) => {
      console.error("[router] Failed to enter show route:", error);
      if (generation === routeTransitionGeneration) showStatus(`Failed to load show: ${error.message}`);
    });
    return;
  }
  if (route.view === "player" && navigation?.source === "popstate") {
    void resumeFromHub().catch((error) => {
      console.error("[router] Failed to resume playback:", error);
      if (generation === routeTransitionGeneration) showStatus(`Failed to resume playback: ${error.message}`);
    });
  }
  // Push navigation to player/show is completed by the action that initiated it.
});

async function enterBrowseRoute(generation) {
  await leavePlayback();
  const isCurrent = () => generation === routeTransitionGeneration && parseRoute().view === "browse";
  if (!isCurrent()) return;
  await loadBrowseScreen({ isCurrent });
}

async function enterShowRoute(route, generation) {
  await leavePlayback();
  const isCurrent = () => {
    const current = parseRoute();
    return generation === routeTransitionGeneration && current.view === "show" && current.itemId === route.itemId;
  };
  if (!isCurrent()) return;
  await loadBrowseScreen({ isCurrent, revealBrowse: false });
  if (!isCurrent()) return;
  await openEpisodes({ id: route.itemId }, { updateRoute: false, isCurrent });
}

// --- Audio unlock via user gesture -----------------------------------

function unlockAudio(event) {
  if (state.audioUnlocked) return;
  state.audioUnlocked = true;
  if (event?.target?.closest?.("#btn-volume")) event.stopImmediatePropagation();
  document.removeEventListener("click", unlockAudio, true);
  document.removeEventListener("touchstart", unlockAudio, true);
  console.log("[player] Audio unlocked");

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().then(() => ctx.close()).catch(() => {});
  } catch {}

  if (state.player) {
    try {
      state.player.setVolume(1);
      state.isMuted = false;
      updateVolumeButton();
      state.player.resume().catch(() => {});
    } catch {}
  }

  // Sync Media Session after user gesture so Tesla car UI shows correct playback state
  if (state.isPlaying) updateMediaSession();
}

document.addEventListener("click", unlockAudio, true);
document.addEventListener("touchstart", unlockAudio, true);

initMediaSession();

// --- Connection status -----------------------------------------------

function showConnectionStatus(text = "Reconnecting…") {
  connectionStatusText.textContent = text;
  connectionStatus.classList.remove("hidden");
}

function hideConnectionStatus() {
  connectionStatus.classList.add("hidden");
}

function hideConnectionActions() {
  statusActions.classList.add("hidden");
}

// Another window of this screen said hello later and plays now; this one
// offers to take over (a new connection makes it the playing one again).
function showReplacedState() {
  document.getElementById("browse-screen").classList.add("hidden");
  showConnectionStatus("Playing in another window");
  showStatus("Yolo is open in another window");
  statusActions.classList.remove("hidden");
}

// --- Yolo's Hub --------------------------------------------------------

const realtime = createRealtime({
  onMessage: handleMessage,
  onStatus: (status) => {
    if (status === "online") {
      hideConnectionStatus();
      return;
    }
    showConnectionStatus(status === "connecting" ? "Connecting…" : "Reconnecting…");
    if (!state.player && !state.isPlaying) showStatus(status === "connecting" ? "Connecting…" : "Reconnecting…");
  },
  onRevoked: () => void repair(),
  onEvent: (type, fields) => {
    recordDeviceEvent(type, fields);
    // What this browser is, again, if a reconnect finds it changed (a
    // window resize, fullscreen).
    if (type === "realtime_welcome") void environment.report("reconnect");
  },
});
setRealtime(realtime);
// This device's own play requests wait until the channel is welcomed.
setPlaybackChannel(realtime);

// Device events to Yolo's logs (telemetry/device-events.js). A wake probes
// the realtime connection at once: it may have died while the page slept,
// and requests wait for the answer (realtime.whenReady).
installDeviceTelemetry({ onWake: () => realtime.probe() });
// What this browser is (`env`): the Tesla browser's user agent no longer
// says so, so its detection is designed from these reports.
const environment = createEnvironmentReporter({ record: recordDeviceEvent });
void environment.report("page_load");

// The owner removed this device: forget the credential and pair again.
async function repair() {
  realtime.stop();
  saveCredential(null);
  await leavePlayback();
  showStatus("This screen is no longer paired");
  await pairDevice();
  realtime.start();
}
setUnauthorizedHandler(() => void repair());

function handleMessage(message) {
  switch (message.type) {
    case "welcome":
      onWelcome(message);
      break;
    case "load":
      onLoad(message);
      break;
    case "pause":
      state.playbackIntent = "paused";
      state.player?.pause().catch(() => {});
      state.isPlaying = false;
      updatePlayButton();
      reportProgress({ force: true });
      break;
    case "resume":
      state.playbackIntent = "playing";
      state.player?.play().catch(() => {});
      updatePlayButton();
      break;
    case "stop":
      void stop().catch((error) => console.error("[playback] Stop transition failed:", error));
      break;
    case "seek":
      seekToTime(Number(message.position) || 0);
      break;
    case "tracks":
      applyTracks(message.tracks, message.selected);
      break;
    case "deactivate":
      if (message.reason === "replaced") {
        void leavePlayback({ report: false }).then(showReplacedState);
      } else {
        // Playback moved to another device; this one becomes a remote.
        void leavePlayback({ report: false }).then(() => navigate("/", true));
      }
      break;
    case "state":
      state.hub = message.state;
      break;
    case "queue":
      renderQueue(message.queue || []);
      break;
    case "playlists":
      renderPlaylists(message.playlists || []);
      break;
    default:
      break;
  }
}

function onWelcome(message) {
  state.deviceId = message.deviceId;
  state.hub = message.state;
  hideConnectionActions();
  renderQueue(message.queue || []);
  renderPlaylists(message.playlists || []);
  const hub = message.state || {};
  if (state.player) {
    // Reconnected while playing: keep going if Yolo still has this device
    // playing this stream; otherwise something changed while offline.
    if (hub.deviceId !== state.deviceId || !hub.sessionId) {
      void leavePlayback({ report: false }).then(() => navigate("/", true));
      return;
    }
    reportProgress({ force: true });
    return;
  }
  void resumeFromHub().catch((error) => {
    console.error("[ws] Failed to restore playback:", error);
    showStatus(`Connection restored, but the page failed to load: ${error.message}`);
  });
}

// A fresh page (reload, the car waking up) while Yolo has this device
// playing: ask for a new stream at the saved position. Otherwise show the
// home or show route. The request is a recovery: if the player is already
// asking for one, this joins it instead of superseding it.
async function resumeFromHub() {
  const hub = state.hub;
  const interrupted = hub?.interruptedAt && Date.now() - hub.interruptedAt < RESUME_PLAYING_WITHIN_MS;
  if (hub && hub.deviceId === state.deviceId && hub.item && hub.sessionId && hub.status !== "idle") {
    showStatus("Resuming playback…");
    const request = buildFreshPlaybackSessionRequest({ meta: { source: hub.item.source, sessionId: hub.sessionId } }, hub.position, {
      autoplay: hub.status === "playing" || hub.status === "buffering" || hub.status === "loading" || Boolean(interrupted),
      reason: "recovery",
    });
    try {
      // Nothing to send if a stream arrived meanwhile or Yolo moved on.
      await requestStream(() => (!state.player && state.hub?.sessionId === hub.sessionId ? request.body : null), {
        label: "Resume", reason: "recovery",
      });
    } catch (error) {
      console.error("[playback] Resume failed:", error);
      showStatus(`Playback error: ${error.message}`);
      navigate("/", true);
    }
    return;
  }
  const route = parseRoute();
  if (route.view === "player") {
    navigate("/", true);
    return;
  }
  const isCurrent = () => parseRoute().view === route.view;
  await loadBrowseScreen({ isCurrent, revealBrowse: route.view !== "show" });
  if (route.view === "show") await openEpisodes({ id: route.itemId }, { updateRoute: false, isCurrent });
}

function onLoad(message) {
  const stream = message.stream || {};
  const delivery = stream.delivery || {};
  const optimistic = Boolean(state.player) && ["seek", "tracks", "quality"].includes(message.reason);
  state.sessionId = stream.sessionId || null;
  state.source = message.item?.source || state.hub?.item?.source || null;
  if (!optimistic) showStatus(`Loading: ${stream.title || "…"}`);
  void play(delivery.url || delivery.videoUrl, stream.title, {
    isLive: stream.isLive,
    liveDvr: stream.liveDvr || null,
    duration: stream.duration || 0,
    startTime: message.startTime ?? stream.startTime ?? 0,
    mediaSource: delivery,
    streamProfile: stream.profile || null,
    autoplay: message.autoplay !== false,
    sessionId: state.sessionId,
    source: state.source,
    tracks: stream.tracks || null,
    __recovery: message.reason === "recovery",
    __optimisticSeek: optimistic,
  }).catch((error) => console.error("[playback] Play transition failed:", error));
}

btnTakeOver.addEventListener("click", () => {
  hideConnectionActions();
  showConnectionStatus("Taking over…");
  showStatus("Taking over playback…");
  realtime.reconnect();
});
btnRetryConnection.addEventListener("click", () => {
  hideConnectionActions();
  showStatus("Connecting…");
  realtime.reconnect();
});

async function boot() {
  if (!getCredential()) await pairDevice();
  realtime.start();
}
void boot();

function verifyConnection() {
  if (document.visibilityState === "hidden") return;
  realtime.verify();
}

setInterval(verifyConnection, 15_000);
window.addEventListener("pageshow", verifyConnection);
window.addEventListener("online", verifyConnection);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") verifyConnection();
});

// For diagnostics and end-to-end tests.
globalThis.__yolo = {
  state, realtime, applyTracks, subtitles: { loadSubtitleTrack, renderSubtitle, disableExternalSubtitle }, updateSubsUI, deviceEvents,
};
