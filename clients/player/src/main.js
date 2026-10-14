import { state } from "./state.js";
import { initRouter, parseRoute, navigate } from "./router.js";
import { initControls, updatePlayButton, updateVolumeButton } from "./controls.js";
import {
  applyTracks, leavePlayback, play, stop, seekToTime, togglePlayPause, showStatus, initMediaSession, updateMediaSession,
  reportProgress, setPlayerCallbacks, setRealtime, getPlaybackPosition, showPlaybackError, noteStreamSelected, setPlaybackEngine, setMediaPaths,
} from "./player.js";
import {
  clearSearch, loadBrowseScreen, openEpisodes, renderPlaylists, renderQueue, setBrowseContext, startPlayback, updateSubsUI, updateAudioUI,
} from "./browse.js";
import { api, getCredential, saveCredential, setUnauthorizedHandler } from "./api.js";
import { pairDevice } from "./pairing.js";
import { createProfile } from "./profile.js";
import { createRemote } from "./remote.js";
import { createSettings } from "./settings.js";
import { createMediaPaths } from "./media-paths.js";
import { buildFreshPlaybackSessionRequest } from "./playback-recovery.js";
import { requestStream, setPlaybackChannel, setPlaybackNetwork } from "./playback.js";
import { createRealtime, describeDevice } from "./realtime.js";
import { resumeDecision } from "./resume-decision.js";
import { createDisplayScale, isEligible } from "./display-scale.js";
import { disableExternalSubtitle, loadSubtitleTrack, renderSubtitle } from "./subtitles.js";
import { deviceEvents, installDeviceTelemetry, recordDeviceEvent } from "./telemetry/device-events.js";
import { createEnvironmentReporter } from "./telemetry/environment.js";

// The player's entry point, for the car profile and for the web profile in a
// computer's or phone's browser (Agent Note 2026-10-11-yolo-web-client):
// the device profile, pairing, the realtime channel to Yolo's Hub
// (Agent Note 2026-10-07-hub-and-realtime-channel), routing, settings, and
// the remote. Playback itself is player.js.

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
let currentView = parseRoute().view;
// Settings opened from the home screen pushed /settings: closing goes back.
let settingsPushed = false;
let settingsByKeyboard = false;

const homeShown = () => !document.getElementById("overlay").classList.contains("hidden")
  && !document.getElementById("browse-screen").classList.contains("hidden");

initRouter((route, navigation) => {
  const previous = currentView;
  currentView = route.view;
  const generation = ++routeTransitionGeneration;
  if (route.view === "settings") {
    void enterSettingsRoute(generation).catch((error) => console.error("[router] Failed to open settings:", error));
    return;
  }
  settings.close();
  if (previous === "settings") settingsPushed = false;
  // Leaving settings over the home screen keeps the home screen as it was.
  if (previous === "settings" && route.view === "browse" && homeShown()) return;
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

async function enterSettingsRoute(generation) {
  if (!homeShown()) {
    await leavePlayback();
    await loadBrowseScreen({ isCurrent: () => generation === routeTransitionGeneration });
  }
  if (generation !== routeTransitionGeneration) return;
  await settings.show({ instant: settingsByKeyboard });
  settingsByKeyboard = false;
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

// --- This device: car or web ------------------------------------------

// The profile (profile.js) decides the layout, the display size, where a
// tap plays, and the capabilities in `hello`. Yolo's type for this device
// can change it later (the owner's choice wins over the fingerprint).
const profile = createProfile({
  onChange: () => {
    displayScale.setEligible(displayEligible());
    settings.displayChanged();
    remote.update();
  },
});
// Each new stream plays with the profile's engine: canvas in a Tesla, whatever
// its type, and the browser's <video> element on the web
// (Agent Note 2026-10-12-two-playback-engines).
setPlaybackEngine(() => ({ engine: profile.engine, native: profile.native }));

// --- Yolo's Hub --------------------------------------------------------

const realtime = createRealtime({
  describe: () => ({ ...describeDevice(), capabilities: profile.capabilities() }),
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

// Media paths (media-paths.js): which of the paths the welcome lists this
// screen's media takes. Play requests and recoveries name it.
const mediaPaths = createMediaPaths({
  send: (message) => realtime.send(message),
  record: recordDeviceEvent,
  onChange: () => settings.pathsChanged(),
});
setMediaPaths(mediaPaths);
setPlaybackNetwork(mediaPaths);

// Device events to Yolo's logs (telemetry/device-events.js). A wake probes
// the realtime connection at once: it may have died while the page slept,
// and requests wait for the answer (realtime.whenReady).
installDeviceTelemetry({ onWake: () => realtime.probe() });
// What this browser is (`env`): the Tesla browser's user agent no longer
// says so, so its detection is designed from these reports.
const environment = createEnvironmentReporter({ record: recordDeviceEvent });
void environment.report("page_load");

// --- Display size --------------------------------------------------------

// How big everything looks (display-scale.js), in the car only, chosen in
// settings. A change re-lays out the page and is reported, with what the
// browser made of it.
const displayEligible = () => isEligible({ car: profile.car, devicePixelRatio: window.__yoloDisplayBoot?.devicePixelRatio ?? window.devicePixelRatio });
const displayScale = createDisplayScale({
  eligible: displayEligible(),
  record: recordDeviceEvent,
  onChange: (reason) => void environment.report(`display_scale:${reason}`),
});
displayScale.init();

// --- Home notices, the remote, settings ------------------------------------

const homeNotice = document.getElementById("home-notice");
let homeNoticeTimer = null;
function notify(text) {
  homeNotice.textContent = text;
  homeNotice.classList.remove("hidden");
  clearTimeout(homeNoticeTimer);
  homeNoticeTimer = setTimeout(() => homeNotice.classList.add("hidden"), 4_000);
}

const remote = createRemote({
  bar: document.getElementById("now-playing"),
  picker: document.getElementById("device-picker"),
  profile,
  notify,
  play: startPlayback,
});
setBrowseContext({ profile, remote, notify });

const settings = createSettings({
  dialog: document.getElementById("settings"),
  profile,
  displayScale,
  paths: mediaPaths,
  onForget: (options) => forgetThisScreen(options),
  onRequestClose: () => {
    if (settingsPushed) {
      settingsPushed = false;
      history.back();
    } else {
      navigate("/", true);
    }
  },
});

document.getElementById("btn-settings").addEventListener("click", (event) => {
  settingsPushed = true;
  settingsByKeyboard = event.detail === 0;
  navigate("/settings");
});

// Yolo's device list: names for the remote and settings, and this device's
// type, which may change the profile.
function applyDevices(devices) {
  state.devices = Array.isArray(devices) ? devices : [];
  const mine = state.devices.find((device) => device.id === state.deviceId);
  if (mine) profile.setKind(mine.kind);
  remote.update();
  settings.devicesChanged();
}

async function refreshDevices() {
  try {
    applyDevices((await api("/v1/devices", { label: "Devices", retries: 0 })).devices);
  } catch {
    // The `devices` broadcast after this hello brings them too.
  }
}

// The owner removed this device, or it forgot itself: drop the credential
// and pair again. One repair at a time (the 4003 close and a 401 both ask).
let repairing = null;
function repair() {
  repairing ??= (async () => {
    realtime.stop();
    saveCredential(null);
    settings.close();
    remote.closePicker();
    await leavePlayback();
    if (parseRoute().view !== "browse") history.replaceState(null, "", "/");
    currentView = "browse";
    showStatus("This screen is no longer paired");
    await pairDevice({ self: !profile.car });
    realtime.start();
  })().finally(() => {
    repairing = null;
  });
  return repairing;
}
setUnauthorizedHandler(() => void repair());

// "Forget this screen" in settings: Yolo deletes this device and its
// credential (DELETE /v1/devices/self), then the screen pairs again.
async function forgetThisScreen({ removed = false } = {}) {
  if (!removed) await api("/v1/devices/self", { method: "DELETE", label: "Forget this screen", retries: 0 });
  settingsPushed = false;
  profile.forget();
  await repair();
}

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
      // This device's item, left paused by Back: it plays here again.
      if (!state.player && remote.resumeHere()) break;
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
      remote.update();
      break;
    case "queue":
      renderQueue(message.queue || []);
      remote.update();
      break;
    case "devices":
      applyDevices(message.devices);
      break;
    case "playlists":
      renderPlaylists(message.playlists || []);
      break;
    // The media paths changed (a new home address without a domain): probe them again.
    case "media":
      void mediaPaths.setPaths({ media: message.media }, "paths");
      break;
    default:
      break;
  }
}

function onWelcome(message) {
  state.deviceId = message.deviceId;
  state.hub = message.state;
  void mediaPaths.setPaths(message);
  hideConnectionActions();
  renderQueue(message.queue || []);
  renderPlaylists(message.playlists || []);
  remote.update();
  void refreshDevices();
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
// route, where an item left with Back waits in the now-playing bar. The
// request is a recovery: if the player is already asking for one, this
// joins it instead of superseding it.
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
  if (route.view === "settings" && isCurrent()) await settings.show();
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
    origin: stream.origin || null,
    network: stream.network || "relay",
    streamProfile: stream.profile || null,
    limits: stream.limits || null,
    trimToStart: stream.trimToStart === true,
    thumbnail: stream.thumbnail || message.item?.thumbnail || null,
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
  if (!getCredential()) await pairDevice({ self: !profile.car });
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
window.addEventListener("online", () => void mediaPaths.probe("online"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") verifyConnection();
});

// For diagnostics and end-to-end tests.
globalThis.__yolo = {
  state, realtime, applyTracks, subtitles: { loadSubtitleTrack, renderSubtitle, disableExternalSubtitle }, updateSubsUI, updateAudioUI, deviceEvents, displayScale,
  profile, settings, remote, clearSearch, paths: mediaPaths,
};
