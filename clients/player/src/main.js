import { state } from "./state.js";
import { initRouter, parseRoute, navigate } from "./router.js";
import { initControls, noteInputMode, showPlaybackNotice, updatePlayButton, updateTransport, updateVolumeButton } from "./controls.js";
import {
  applyTracks, leavePlayback, play, stop, seekToTime, togglePlayPause, showStatus, showLoading, noteStreamArrived, initMediaSession, updateMediaSession,
  reportProgress, setPlayerCallbacks, setRealtime, getPlaybackPosition, showPlaybackError, noteStreamSelected, setPlaybackEngine, setMediaPaths,
  danmaku, danmakuSettings, setHoldSpeed, setPlaybackSpeed, keptView, noteHubState, reopenKept, rejoinHubStream, rejoinHubItem, streamLoadingFor,
  finishedOnScreen, forgetFinished, forgetPausedHere, pausedHereFor, streamLeftFor, remindKept, seekHere,
} from "./player.js";
import { createOwnActions, createSettledCommands, danmakuToApply, missedCommands, subtitlesToFollow } from "./missed-commands.js";
import {
  clearSearch, loadBrowseScreen, openEpisodes, renderPlaylists, renderQueue, setBrowseContext, startPlayback, updateSubsUI, updateAudioUI,
} from "./browse.js";
import { api, getCredential, saveCredential, setUnauthorizedHandler } from "./api.js";
import { pairDevice } from "./pairing.js";
import { warmAudioOutput } from "./audio-output.js";
import { importHls } from "./engine/native-video-player.js";
import { createProfile } from "./profile.js";
import { createAsk } from "./ask.js";
import { createRemote } from "./remote.js";
import { createSettings } from "./settings.js";
import { startShare } from "./share.js";
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

// What the owner did on this screen that Yolo may not have heard yet: a
// command a reconnect lost does not overrule it (missed-commands.js).
const ownActions = createOwnActions({ confirm: (heard) => realtime.confirm(heard) });

// A player kept behind the home screen, its picture, or its release: the
// now-playing bar shows it.
setPlayerCallbacks({ updateSubsUI, updateAudioUI, keptChanged: () => remote.update(), ownAction: (kind) => ownActions.note(kind) });

initControls({
  onTogglePlayPause: togglePlayPause,
  onStop: stop,
  onSeekToTime: seekHere,
  onSetVolume: (v) => { if (state.player) state.player.setVolume(v); },
  onPrevious: () => void playerCommand("/v1/playback/previous", "Previous"),
  onNext: () => void playerCommand("/v1/playback/next", "Next"),
  onHoldSpeed: setHoldSpeed,
  onSetSpeed: setPlaybackSpeed,
  // A car's screen is a touch screen, also when paired as a browser.
  isTouchScreen: () => profile.car || profile.fingerprint.tesla,
});

// --- Previous and next in the player -----------------------------------

// The Hub's `previous` walks back through Yolo's history and `next` forward
// again, then to the queue's head (Agent Note
// 2026-10-07-hub-and-realtime-channel); their buttons show only when there
// is one. While a walk is under way, the Hub's state says how many items
// lie each way; otherwise previous plays the latest other item in history.
let recentHistory = null;
let transportItem = null;

const sourceKeyOf = (source) => (source?.plugin && source.id != null ? `${source.plugin}:${source.id}` : null);

function updatePlayerTransport() {
  const current = sourceKeyOf(state.source);
  const walk = state.hub?.walk && sourceKeyOf(state.hub.item?.source) === current ? state.hub.walk : null;
  updateTransport({
    previous: walk ? walk.back > 0 : (recentHistory || []).some((key) => key !== current),
    next: walk?.forward > 0 || (state.queue || []).length > 0,
  });
}

// Asked once for each new item, not for its seeks and rebuilds; a share
// link's page has no history to ask for.
function noteTransportItem() {
  if (parseRoute().view === "share") return;
  const key = sourceKeyOf(state.source);
  if (key === transportItem) {
    updatePlayerTransport();
    return;
  }
  transportItem = key;
  void api("/v1/history?limit=5", { label: "History", retries: 0 }).then((history) => {
    recentHistory = (Array.isArray(history) ? history : []).map((entry) => entry.sourceKey);
  }, () => {}).finally(updatePlayerTransport);
}

// The player's own previous and next play on this screen, whichever screen
// Yolo counts as active (an offline one, say).
async function playerCommand(path, label) {
  try {
    await api(path, { method: "POST", body: { deviceId: state.deviceId }, label, retries: 0 });
  } catch (error) {
    showPlaybackNotice(error.message || `${label} failed`);
  }
}

// --- Router ----------------------------------------------------------

let routeTransitionGeneration = 0;
let currentView = parseRoute().view;
// Settings opened from the home screen pushed /settings: closing goes back.
let settingsPushed = false;
// Settings opened from the player's top bar sit over the playing item.
let settingsOverPlayer = false;
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
  settingsOverPlayer = false;
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
    // Forward to the player kept behind the home screen: it shows again.
    if (reopenKept({ reason: "history" })) return;
    void resumeFromHub().catch((error) => {
      console.error("[router] Failed to resume playback:", error);
      if (generation === routeTransitionGeneration) showStatus(`Failed to resume playback: ${error.message}`);
    });
  }
  // Push navigation to player/show is completed by the action that initiated it.
});

// Back to the home screen, a show, or settings keeps the player behind it
// for the now-playing bar (player.js).
async function enterBrowseRoute(generation) {
  await leavePlayback({ keep: true });
  const isCurrent = () => generation === routeTransitionGeneration && parseRoute().view === "browse";
  if (!isCurrent()) return;
  await loadBrowseScreen({ isCurrent });
}

async function enterSettingsRoute(generation) {
  if (!homeShown()) {
    await leavePlayback({ keep: true });
    await loadBrowseScreen({ isCurrent: () => generation === routeTransitionGeneration });
  }
  if (generation !== routeTransitionGeneration) return;
  await settings.show({ instant: settingsByKeyboard });
  settingsByKeyboard = false;
}

async function enterShowRoute(route, generation) {
  await leavePlayback({ keep: true });
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
    warmAudioOutput({ engine: profile.engine });
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
    noteInputMode();
  },
});
// A computer's mouse gets the desktop player's controls; the car never does.
noteInputMode();
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
  // The car plays away from home: no home network unless the owner turns it on.
  lanByDefault: () => !(profile.car || profile.fingerprint.tesla),
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
  kept: keptView,
  reopen: (sessionId) => reopenKept({ sessionId }),
});
setBrowseContext({ profile, remote, notify });

const settings = createSettings({
  dialog: document.getElementById("settings"),
  profile,
  displayScale,
  paths: mediaPaths,
  danmaku: danmakuSettings,
  onForget: (options) => forgetThisScreen(options),
  onRequestClose: () => {
    if (settingsOverPlayer) {
      settingsOverPlayer = false;
      settings.close();
      return;
    }
    if (settingsPushed) {
      settingsPushed = false;
      history.back();
    } else {
      navigate("/", true);
    }
  },
});

danmakuSettings.subscribe((_settings, reason, changes) => {
  settings.danmakuChanged();
  if (reason !== "agent") for (const name of Object.keys(changes || {})) ownActions.note(`danmaku:${name}`);
});

// Asking the owner's agent from the home screen (ask.js).
const ask = createAsk();

document.getElementById("btn-settings").addEventListener("click", (event) => {
  settingsPushed = true;
  settingsByKeyboard = event.detail === 0;
  navigate("/settings");
});

// The player's gear opens the same sheet over the item, which plays on.
document.getElementById("btn-player-settings").addEventListener("click", (event) => {
  event.stopPropagation();
  settingsOverPlayer = true;
  void settings.show({ instant: event.detail === 0 });
});

// A link for a friend to watch what plays (Agent Note 2026-10-20-share-links),
// for 7 days: through the browser's share sheet where it has one, else
// copied, else shown to copy by hand. The sheet and the clipboard need the
// tap still fresh, which Yolo's answer may outlast.
document.getElementById("btn-share").addEventListener("click", (event) => {
  event.stopPropagation();
  void shareWithFriend();
});

async function shareWithFriend() {
  if (!state.source) return;
  let link;
  try {
    link = await api("/v1/shares", { method: "POST", body: { source: state.source }, timeoutMs: 30_000, retries: 0, label: "Share" });
  } catch (error) {
    showPlaybackNotice(`Could not share: ${error.message}`);
    return;
  }
  if (navigator.share) {
    try {
      await navigator.share({ title: link.title, url: link.url });
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(link.url);
    showPlaybackNotice("Link copied: a friend can watch this for 7 days");
  } catch {
    window.prompt("A friend can watch this for 7 days at", link.url);
  }
}

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

// The last pause or resume and seek this page dealt with for the stream on
// screen or kept, whether heard or named by a welcome: a welcome naming
// them again changes nothing (missed-commands.js).
const settledCommands = createSettledCommands();
// Per danmaku setting, the id of the last change from Yolo applied to it;
// and what the owner did here unheard before the last welcome, against
// which the Hub's danmaku changes sent again after it are read.
const danmakuHeard = {};
let ownAtWelcome = new Set();

// The stream a pause, resume, or seek is for: the one the Hub names on it,
// whatever this screen shows when it arrives (between two streams, none);
// from a Hub that names none, the stream this screen has or is starting
// (onLoad sets it before the player changes), or the kept one.
const commandStream = (message) => (typeof message.sessionId === "string" ? message.sessionId : state.sessionId || keptView()?.sessionId || null);

// A resume or seek that comes ahead of its connection's welcome for another
// stream than the one this screen has, is starting, or keeps: that
// stream's `load` went with the connection before, and the welcome
// switches the screen to it. Done here, it would play or move the stream
// on screen meanwhile. Over a welcomed connection, a stream's `load` comes
// ahead of its commands, so they go (a seek then moves a seek's stream on
// its way). A pause always goes; with no stream here, a resume plays the
// item this screen left (applyResume).
function forAnotherStream(message, { welcomed }) {
  if (welcomed) return false;
  const here = state.sessionId || keptView()?.sessionId || null;
  return typeof message.sessionId === "string" && Boolean(here) && message.sessionId !== here;
}

// The last seek left for another stream, { sessionId, position }: when the
// welcome switches this screen to that stream, it starts there.
let seekForAnother = null;

// `report: false` when a welcome reports once, after everything it changed.
function applyPause({ report = true } = {}) {
  forgetFinished();
  state.playbackIntent = "paused";
  state.player?.pause().catch(() => {});
  state.isPlaying = false;
  updatePlayButton();
  if (report) reportProgress({ force: true });
}

function applyResume() {
  // This device's item, left paused by Back: the kept player shows and
  // plays on, or a new stream plays it here again.
  forgetPausedHere();
  if (!state.player && (reopenKept({ reason: "resume" }) || remote.resumeHere())) return;
  forgetFinished();
  state.playbackIntent = "playing";
  state.player?.play().catch(() => {});
  updatePlayButton();
}

function handleMessage(message, { welcomed = true } = {}) {
  switch (message.type) {
    case "welcome":
      onWelcome(message);
      break;
    case "load":
      onLoad(message);
      break;
    case "pause":
      settledCommands.settle(commandStream(message), "playback", message.id);
      applyPause();
      break;
    case "resume":
      settledCommands.settle(commandStream(message), "playback", message.id);
      if (!forAnotherStream(message, { welcomed })) applyResume();
      break;
    case "stop":
      void stop({ keep: false }).catch((error) => console.error("[playback] Stop transition failed:", error));
      break;
    case "seek":
      settledCommands.settle(commandStream(message), "seek", message.id);
      if (forAnotherStream(message, { welcomed })) seekForAnother = { sessionId: message.sessionId, position: Number(message.position) || 0 };
      else seekToTime(Number(message.position) || 0);
      break;
    case "tracks":
      applyTracks(message.tracks, message.selected);
      break;
    // An agent changed this screen's danmaku settings (Agent Note 2026-10-13-danmaku),
    // or the Hub sends one again that this screen never acknowledged (`again`).
    case "danmaku": {
      const patch = danmakuToApply(message, { heard: danmakuHeard, own: ownAtWelcome });
      if (typeof message.id === "string") for (const name of Object.keys(message.settings || {})) danmakuHeard[name] = message.id;
      if (Object.keys(patch).length) danmakuSettings.update(patch, "agent");
      break;
    }
    case "deactivate":
      if (message.reason === "replaced") {
        void leavePlayback({ report: false, release: "moved" }).then(showReplacedState);
      } else {
        // Playback moved to another device; this one becomes a remote.
        void leavePlayback({ report: false, release: "moved" }).then(() => navigate("/", true));
      }
      break;
    case "state":
      state.hub = message.state;
      noteHubState(message.state);
      remote.update();
      updatePlayerTransport();
      break;
    case "queue":
      renderQueue(message.queue || []);
      remote.update();
      updatePlayerTransport();
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

// A welcome with `upgrade: true`: the Hub no longer serves this page's
// client protocol, so the page loads the release the Worker serves now
// (Agent Note 2026-10-19-client-protocol). Once a minute at most, so a page
// that is itself refused does not reload without end.
const UPGRADE_RELOAD_KEY = "yolo.upgradeReloadAt";
function reloadForUpgrade() {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(UPGRADE_RELOAD_KEY)) || 0;
    sessionStorage.setItem(UPGRADE_RELOAD_KEY, String(Date.now()));
  } catch {
    // Private mode: reload anyway.
  }
  if (Date.now() - last > 60_000) location.reload();
}

function onWelcome(message) {
  if (message.upgrade) {
    reloadForUpgrade();
    return;
  }
  state.deviceId = message.deviceId;
  state.hub = message.state;
  const hub = message.state || {};
  // What Yolo commanded the stream on screen, or kept, that went with the
  // old connection, read against what the owner did here that Yolo may not
  // have heard (missed-commands.js). Either way, the welcome settles them:
  // the next welcome naming them again changes nothing. From this welcome
  // on, what Yolo sends is newer than anything the owner did before it.
  const kept = state.player ? null : keptView();
  const onScreen = state.player ? state.sessionId : kept?.sessionId ?? null;
  ownAtWelcome = ownActions.take();
  const skippedSeek = seekForAnother;
  seekForAnother = null;
  const missed = missedCommands(message, { deviceId: state.deviceId, sessionId: onScreen, settled: settledCommands, own: ownAtWelcome });
  settledCommands.settleWelcome(message, onScreen);
  noteHubState(message.state, { welcome: true });
  void mediaPaths.setPaths(message);
  hideConnectionActions();
  renderQueue(message.queue || []);
  updatePlayerTransport();
  renderPlaylists(message.playlists || []);
  remote.update();
  void refreshDevices();
  void ask.refresh();
  // Kept still (the state did not release it): it takes the subtitles and
  // the seek it missed, and a resume it missed shows it again; otherwise
  // it tells the Hub again that it is kept, where it now is.
  if (kept && keptView()?.sessionId === kept.sessionId) {
    const subtitles = followSubtitles(hub, kept);
    if (missed.seek != null) seekToTime(missed.seek);
    noteMissed(missed, { subtitles }, { kept: true });
    if (missed.resume && reopenKept({ sessionId: kept.sessionId, reason: "resume" })) return;
    remindKept();
  }
  if (state.player) {
    // Reconnected while playing: keep going if Yolo still has this device
    // playing this stream; otherwise something changed while offline.
    if (hub.deviceId !== state.deviceId || !hub.sessionId) {
      void leavePlayback({ report: false }).then(() => navigate("/", true));
      return;
    }
    // Yolo has another stream for this screen than the one it plays: that
    // stream's `load` went with the old connection (Yolo sends each once),
    // and the one on screen is one Yolo stopped. The screen asks for it
    // first, in place of the Hub's stream, and its `load` switches over: the
    // same item where the screen is, another item (an agent's play here) as
    // a page that just opened would play it (player.js). Only when that
    // request fails does the screen leave the stream on screen.
    if (hub.sessionId !== state.sessionId) {
      const seekTo = skippedSeek?.sessionId === hub.sessionId ? skippedSeek.position : null;
      if (rejoinHubStream(hub, { seekTo })) return;
      const decision = resumeDecision(hub, state.deviceId);
      if (decision?.finished) {
        realtime.send({ type: "ended", sessionId: decision.sessionId });
      } else if (decision) {
        void rejoinHubItem(hub, decision).catch((error) => {
          console.error("[ws] Failed to play what Yolo has for this screen:", error);
          void leavePlayback({ report: false }).then(() => {
            navigate("/", true);
            showPlaybackError(error, {
              retry: () => void resumeFromHub().catch((retryError) => console.error("[playback] Resume failed:", retryError)),
              back: () => {},
            });
          });
        });
      } else {
        reportProgress({ force: true });
      }
      return;
    }
    // The stream on screen is Yolo's: what Yolo has for it wins over what
    // the screen kept doing while its commands went with the connection.
    // The pause or resume, then the seek, then one report of where that
    // left it.
    const subtitles = followSubtitles(hub, { sessionId: state.sessionId, tracks: state.tracks });
    if (missed.pause) applyPause({ report: false });
    else if (missed.resume) applyResume();
    if (missed.seek != null) seekToTime(missed.seek);
    reportProgress({ force: true });
    // It played to its end here and the `ended` may not have reached Yolo:
    // Yolo plays the queue's next item here now, or stops. Not when Yolo
    // said to pause, or a missed seek moved it off its end.
    const ended = !missed.pause && missed.seek == null && finishedOnScreen();
    if (ended) realtime.send({ type: "ended", sessionId: state.sessionId });
    noteMissed(missed, { subtitles, ended });
    return;
  }
  // noteHubState said `idle` again for a stream this screen left.
  if (streamLeftFor(hub.sessionId)) noteMissed(missed, { idle: true });
  void resumeFromHub().catch((error) => {
    console.error("[ws] Failed to restore playback:", error);
    showStatus(`Connection restored, but the page failed to load: ${error.message}`);
  });
}

// The subtitles Yolo chose for the stream on screen, or kept, when a
// `tracks` message that went with the old connection would have switched
// them in place. True when it switched them.
function followSubtitles(hub, { sessionId, tracks }) {
  const subtitles = subtitlesToFollow(hub, { deviceId: state.deviceId, sessionId, tracks });
  if (subtitles) applyTracks(null, { ...tracks?.selected, subtitles });
  return Boolean(subtitles);
}

// `hub_missed` (device telemetry): what a welcome made this screen do, or
// leave out, that a dead connection had kept from it; nothing when it made
// it do nothing. `context` only describes it (`kept`).
function noteMissed(missed, done = {}, context = {}) {
  const fields = {
    pause: missed.pause, resume: missed.resume, resumeHeld: missed.resumeHeld, seek: missed.seek, seekHeld: missed.seekHeld, ...done,
  };
  if (Object.values(fields).some((value) => value === true || typeof value === "number")) recordDeviceEvent("hub_missed", { ...fields, ...context });
}

// The web profile's <video> engine plays HLS through hls.js, a chunk of its
// own: once the home screen shows, the page fetches it while the owner
// chooses, so the first tap does not wait for it. The car never loads it.
function preloadEngine() {
  if (profile.engine !== "native" || profile.native?.hls !== "hls.js") return;
  const whenIdle = window.requestIdleCallback ?? ((task) => setTimeout(task, 500));
  whenIdle(() => void importHls().catch(() => {}), { timeout: 2_000 });
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
  // That session's `load` came already (just before the welcome), and its
  // stream is starting while the old player goes away: nothing to resume.
  if (streamLoadingFor(hub?.sessionId)) return;
  // A player kept behind the home screen waits for the now-playing bar,
  // also when the Hub saw this screen drop while it was playing; so does a
  // stream this screen left whose `idle` Yolo has not heard yet (sent again
  // by noteHubState).
  // The owner paused that stream here before the page went away, and Yolo
  // never heard it (it has the stream playing, or interrupted): Yolo hears
  // it now, and the stream comes back paused where the owner paused it.
  const pausedHere = pausedHereFor(hub);
  const seen = pausedHere ? { ...hub, status: "paused", interruptedAt: undefined, position: pausedHere.position } : hub;
  const decision = keptView() || streamLeftFor(hub?.sessionId) ? null : resumeDecision(seen, state.deviceId);
  if (decision && pausedHere) realtime.send({ type: "report", sessionId: hub.sessionId, status: "paused", position: pausedHere.position });
  if (decision) {
    recordDeviceEvent("resume_decision", {
      pausedHere: Boolean(pausedHere),
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
    showLoading({ artwork: hub.item?.thumbnail ?? null });
    const request = buildFreshPlaybackSessionRequest({ meta: { source: decision.source, sessionId: decision.sessionId } }, decision.position, {
      autoplay: decision.autoplay,
      reason: "recovery",
    });
    try {
      // Nothing to send if a stream arrived meanwhile or Yolo moved on.
      const wanted = () => !state.player && !streamLoadingFor(decision.sessionId) && state.hub?.sessionId === decision.sessionId;
      await requestStream(() => (wanted() ? request.body : null), {
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
  preloadEngine();
  if (route.view === "show") await openEpisodes({ id: route.itemId }, { updateRoute: false, isCurrent });
  if (route.view === "settings" && isCurrent()) await settings.show();
}

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
  noteTransportItem();
  // A new stream of what already plays keeps the picture and a spinner.
  if (!optimistic && !state.player) noteStreamArrived({ artwork: stream.thumbnail || message.item?.thumbnail || null });
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
    autoplay: message.autoplay !== false,
    sessionId: state.sessionId,
    source: state.source,
    tracks: stream.tracks || null,
    comments: stream.comments || null,
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

// A share link's page plays its one item for a friend, unpaired and with
// no realtime channel (share.js); every other page is a paired screen.
async function boot() {
  const route = parseRoute();
  if (route.view === "share") {
    // Nothing here holds a credential to lose: a 401 never pairs this page.
    setUnauthorizedHandler(() => {});
    await startShare({ token: route.token, profile, paths: mediaPaths, onLoad });
    return;
  }
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
  profile, settings, remote, clearSearch, paths: mediaPaths, danmaku, danmakuSettings,
};
