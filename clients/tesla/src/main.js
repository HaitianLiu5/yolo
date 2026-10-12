import { state } from "./state.js";
import { initRouter, parseRoute, navigate } from "./router.js";
import { initControls, updatePlayButton, updateVolumeButton } from "./controls.js";
import {
  applyTracks, leavePlayback, play, stop, seekToTime, togglePlayPause, showStatus, initMediaSession, updateMediaSession,
  reportProgress, setPlayerCallbacks, setRealtime, getPlaybackPosition, showPlaybackError, noteStreamSelected,
} from "./player.js";
import { loadBrowseScreen, openEpisodes, renderPlaylists, renderQueue, updateSubsUI, updateAudioUI } from "./browse.js";
import { getCredential, saveCredential, setUnauthorizedHandler } from "./api.js";
import { pairDevice } from "./pairing.js";
import { buildFreshPlaybackSessionRequest } from "./playback-recovery.js";
import { requestStream, setPlaybackChannel } from "./playback.js";
import { createRealtime } from "./realtime.js";
import { resumeDecision } from "./resume-decision.js";
import { createDisplayScale } from "./display-scale.js";
import { disableExternalSubtitle, loadSubtitleTrack, renderSubtitle } from "./subtitles.js";
import { deviceEvents, installDeviceTelemetry, recordDeviceEvent } from "./telemetry/device-events.js";
import { createEnvironmentReporter } from "./telemetry/environment.js";

// The Tesla client's entry point: pairing, the realtime channel to Yolo's Hub
// (Agent Note 2026-10-07-hub-and-realtime-channel), and routing. Playback
// itself is player.js.

const connectionStatus = document.getElementById("connection-status");
const connectionStatusText = document.getElementById("connection-status-text");
const statusActions = document.getElementById("status-actions");
const btnTakeOver = document.getElementById("btn-take-over");
const btnRetryConnection = document.getElementById("btn-retry-connection");

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

// --- Sound via user gesture -------------------------------------------

// Playback tries to start with sound by itself (player.js). When the browser
// blocks that, it plays muted with a "tap for sound" hint; the first tap
// anywhere on the page unlocks sound, and while a player is still muted by
// the browser, every tap tries again. A tap never starts or stops playback
// by itself here.
function unlockAudio(event) {
  const firstGesture = !state.audioUnlocked;
  if (!firstGesture && !state.audioBlocked) return;
  state.audioUnlocked = true;
  // The tap that brings sound back should not also mute it.
  if (state.audioBlocked && event?.target?.closest?.("#btn-volume")) event.stopImmediatePropagation();
  if (firstGesture) {
    console.log("[player] Audio unlocked");
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume().then(() => ctx.close()).catch(() => {});
    } catch {}
  }
  // resume() must start inside the gesture: enableAudioOutput calls it
  // before awaiting anything.
  if (state.player?.enableAudioOutput) {
    void state.player.enableAudioOutput().catch(() => {});
    updateVolumeButton();
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
    // Said once: the pill over the player or the home screen, the centre
    // line on the boot screen (where the pill would repeat it).
    const text = status === "connecting" ? "Connecting…" : "Reconnecting…";
    const onContent = Boolean(state.player || state.isPlaying) || !document.getElementById("browse-screen").classList.contains("hidden");
    if (onContent) {
      showConnectionStatus(text);
    } else {
      hideConnectionStatus();
      showStatus(text);
    }
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

// --- Display size --------------------------------------------------------

// How big everything looks (display-scale.js): a quiet section at the end
// of the home screen. A change re-lays out the page and is reported, with
// what the browser made of it.
const displayScale = createDisplayScale({
  record: recordDeviceEvent,
  onChange: (reason) => {
    renderDisplayScale();
    void environment.report(`display_scale:${reason}`);
  },
});
const displayScaleControl = document.getElementById("display-scale");

function renderDisplayScale() {
  if (!displayScaleControl) return;
  displayScaleControl.replaceChildren(...displayScale.options().map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(option.active));
    button.classList.toggle("active", option.active);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      displayScale.choose(option.value);
      renderDisplayScale();
    });
    return button;
  }));
}

displayScale.init();
renderDisplayScale();

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

// A fresh page (reload, the car waking up) while Yolo has this device's
// item: ask for a new stream at the saved position, playing if it was
// playing or was interrupted while playing, however long ago; paused if the
// owner paused it (resume-decision.js). Otherwise show the home or show
// route. The request is a recovery: if the player is already asking for
// one, this joins it instead of superseding it.
async function resumeFromHub() {
  const hub = state.hub;
  const decision = resumeDecision(hub, state.deviceId);
  if (decision) {
    recordDeviceEvent("resume_decision", {
      why: decision.why,
      autoplay: decision.autoplay,
      finished: decision.finished,
      position: Math.round(decision.position * 10) / 10,
      hubStatus: hub.status,
      interruptedForMs: hub.interruptedAt ? Math.max(0, Date.now() - hub.interruptedAt) : null,
    });
  }
  if (decision?.finished) {
    // It played to its end before the page went away: Yolo plays the
    // queue's next item here, or stops, as for any finished item.
    realtime.send({ type: "ended", sessionId: decision.sessionId });
  } else if (decision) {
    showStatus("Resuming playback…");
    const request = buildFreshPlaybackSessionRequest({ meta: { source: decision.source, sessionId: decision.sessionId } }, decision.position, {
      autoplay: decision.autoplay,
      reason: "recovery",
    });
    try {
      // Nothing to send if a stream arrived meanwhile or Yolo moved on.
      await requestStream(() => (!state.player && state.hub?.sessionId === decision.sessionId ? request.body : null), {
        label: "Resume", reason: "recovery",
      });
    } catch (error) {
      console.error("[playback] Resume failed:", error);
      navigate("/", true);
      showPlaybackError(error, {
        retry: () => void resumeFromHub().catch((retryError) => console.error("[playback] Resume failed:", retryError)),
        back: () => {},
      });
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

// A stream at another bitrate starts while the old one keeps playing:
// begin with a shorter buffer, since the throughput was just measured.
const QUALITY_START_SECONDS = 8;

function onLoad(message) {
  const stream = message.stream || {};
  const delivery = stream.delivery || {};
  const optimistic = Boolean(state.player) && ["seek", "tracks", "quality"].includes(message.reason);
  // The old stream played on while the new one was prepared: continue from
  // where it is now, not where it was when the change was asked for.
  const quality = message.reason === "quality" && state.player;
  const startTime = quality ? Math.max(getPlaybackPosition(), Number(message.startTime) || 0) : message.startTime ?? stream.startTime ?? 0;
  state.sessionId = stream.sessionId || null;
  state.source = message.item?.source || state.hub?.item?.source || null;
  // A new stream of what already plays keeps the picture and a spinner.
  if (!optimistic && !state.player) showStatus(`Loading: ${stream.title || "…"}`);
  noteStreamSelected({ reason: message.reason || null, stream, source: state.source, startTime, autoplay: message.autoplay !== false });
  void play(delivery.url || delivery.videoUrl, stream.title, {
    isLive: stream.isLive,
    liveDvr: stream.liveDvr || null,
    duration: stream.duration || 0,
    startTime,
    mediaSource: delivery,
    streamProfile: stream.profile || null,
    limits: stream.limits || null,
    ...(quality ? { __hlsStartSeconds: QUALITY_START_SECONDS } : {}),
    autoplay: message.autoplay !== false,
    sessionId: state.sessionId,
    source: state.source,
    tracks: stream.tracks || null,
    __loadReason: message.reason || null,
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
  state, realtime, applyTracks, subtitles: { loadSubtitleTrack, renderSubtitle, disableExternalSubtitle }, updateSubsUI, updateAudioUI, deviceEvents, displayScale,
};
