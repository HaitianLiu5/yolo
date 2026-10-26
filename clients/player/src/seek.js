import { setSeekTransitionPending, showPlaybackNotice, updateProgress, updateTimeDisplay } from "./controls.js";
import { hasSeekPlaybackProgress, shouldRestartSessionForSeek } from "./playback-recovery.js";
import { state } from "./state.js";
import { bufferState, readStats, summarizeStats } from "./telemetry/engine-stats.js";
import { logPlayerEvent } from "./telemetry/player-log.js";

// Seeking on this screen. A seek the stream on screen can make is the
// engine's own, watched until playback moves again. A target before where
// the stream can seek (a transcode resumed part way) takes a new stream
// from Yolo that starts there, which arrives as a `load` (play(),
// player.js); the screen holds the picture with the seek indicator until
// it does. A live stream seeks in the window it keeps, or plays a new
// stream positioned in its DVR window.

// A seek that moves nothing for this long stalls, unless its segments are
// still coming, for up to NETWORK_WAIT_MAX_MS.
const STALL_CHECK_MS = 5_000;
const NETWORK_WAIT_MAX_MS = 30_000;
// How long a seek's new stream may take to arrive once Yolo has built it.
const STREAM_LOAD_WAIT_MS = 10_000;
// How far past a live stream's edge a seek to it may aim.
const LIVE_EDGE_LEAD_SECONDS = 12;

let fromPlayer = null;

/**
 * What seeking needs from the player (player.js):
 * - `requestStream(request, startTime, options)` asks Yolo for a new stream
 *   of what plays, in place of the one on screen (requestFreshPlaybackSession);
 * - `recover(player, error, options)` recovers with a new stream, or says it cannot;
 * - `position(player)` is where playback is; `reportProgress()` reports it;
 * - `replay(url, title, meta)` plays a stream (a live seek's);
 * - `streamRequest()` is the request the stream on screen came from;
 * - `seekKept(time)` seeks the player kept behind the home screen, if any,
 *   and says whether there was one;
 * - `forgetFinished()` and `ownAction(kind)` hear that the owner moved on;
 * - `realtime()` is the realtime connection;
 * - `replacedStream()` is the session a new stream replaces, and
 *   `rejoinBuilt(player, sessionId, position)` asks again, in place of a
 *   stream Yolo built for a seek whose `load` never came.
 */
export function initSeek(deps) {
  fromPlayer = deps;
}

// --- A seek inside the stream ---------------------------------------------------

// The seek being watched; `requestId` counts seeks, so a later one makes an
// earlier one's answer stale.
const watch = { requestId: 0, timer: null, player: null, startedAt: 0, snapshot: null };

/** No seek is watched any more: the stream changed, recovered, or left. */
export function cancelSeekWatch({ invalidate = true } = {}) {
  clearTimeout(watch.timer);
  watch.timer = null;
  watch.player = null;
  watch.snapshot = null;
  if (invalidate) watch.requestId += 1;
}

// A seek that was to play is watched: progress, or segments still coming,
// keeps it waiting; anything else is a stall, recovered with a new stream.
function watchSeek(player, targetTime, expectedToPlay) {
  cancelSeekWatch();
  const requestId = watch.requestId;
  if (!expectedToPlay) return requestId;
  Object.assign(watch, { player, startedAt: performance.now(), snapshot: summarizeStats(readStats(player)) });
  const check = () => {
    watch.timer = null;
    if (requestId !== watch.requestId || watch.player !== player || state.player !== player) return;
    const status = player.getStatus?.();
    if (!["seeking", "buffering"].includes(status)) {
      cancelSeekWatch();
      return;
    }
    const snapshot = summarizeStats(readStats(player));
    const elapsedMs = Math.round(performance.now() - watch.startedAt);
    const again = () => {
      watch.timer = setTimeout(check, STALL_CHECK_MS);
    };
    if (hasSeekPlaybackProgress(watch.snapshot, snapshot, targetTime)) {
      watch.snapshot = snapshot;
      logPlayerEvent("seek_progress_observed", { requestId, targetTime, elapsedMs, playerStats: snapshot });
      again();
      return;
    }
    const downloading = [snapshot?.hlsActiveDownloads, snapshot?.hlsQueuedSegments, snapshot?.hlsRetryWaitingSegments].some((value) => Number(value) > 0);
    if (downloading && elapsedMs < NETWORK_WAIT_MAX_MS) {
      logPlayerEvent("seek_waiting_for_network", { requestId, targetTime, elapsedMs, playerStats: snapshot });
      again();
      return;
    }
    logPlayerEvent("seek_stall_detected", { requestId, targetTime, elapsedMs, playerStatus: status, playerStats: snapshot, buffer: bufferState(readStats(player)) });
    const error = Object.assign(new Error(`seek made no playback progress for ${STALL_CHECK_MS}ms`), { code: "SEEK_STALLED" });
    cancelSeekWatch();
    fromPlayer.recover(player, error, { startTime: targetTime });
  };
  watch.timer = setTimeout(check, STALL_CHECK_MS);
  return requestId;
}

function seekInStream(player, targetTime, expectedToPlay, { fromTime = state.currentTime, preserveHlsBuffer = false, label = "seek" } = {}) {
  const startedAt = performance.now();
  const requestId = watchSeek(player, targetTime, expectedToPlay);
  logPlayerEvent("seek_requested", { requestId, label, fromTime, targetTime, expectedToPlay, preserveHlsBuffer, playerStats: summarizeStats(readStats(player)) });
  const current = () => requestId === watch.requestId && state.player === player;
  const durationMs = () => Math.round(performance.now() - startedAt);
  void player.seek(BigInt(Math.floor(targetTime * 1000)), { preserveHlsBuffer }).then((applied) => {
    logPlayerEvent("seek_completed", { requestId, label, targetTime, applied: applied !== false, current: current(), durationMs: durationMs(), playerStats: summarizeStats(readStats(player)) });
    if (!current() || applied === false) return;
    if (expectedToPlay && state.playbackIntent === "playing") player.resume().catch(() => {});
  }).catch((error) => {
    const seekError = error instanceof Error ? error : new Error(String(error));
    logPlayerEvent("seek_failed", { requestId, label, targetTime, current: current(), durationMs: durationMs(), error: seekError.message, playerStats: summarizeStats(readStats(player)) });
    if (!current()) return;
    seekError.code ||= "SEEK_FAILED";
    cancelSeekWatch();
    if (!fromPlayer.recover(player, seekError, { startTime: targetTime })) console.error("[player] Seek error:", seekError);
  });
}

// --- A seek by a new stream -----------------------------------------------------

// `requestId` counts the seeks that asked for a stream. `pending` while one
// is asked for or on its way; `transitionPending` while the screen holds
// the picture for it (or for an optimistic seek's new stream, play()). The
// seek: { player, targetTime, asked, expectedToPlay, fromTime, asking,
// sent, settled }, where `asked` is the target its request went for and
// `targetTime` the last one the owner asked for. `built` is the Hub's new
// session for it, once Yolo built it.
const restart = { requestId: 0, pending: false, transitionPending: false, seek: null, built: null, loadTimer: null };

/** A seek's new stream is asked for, on its way, or held for on screen. */
export const seekStreamPending = () => restart.pending || restart.transitionPending;
/** A seek's new stream is asked for or on its way: a failure meanwhile waits for it. */
export const seekStreamAsked = () => restart.pending;
/** The screen holds the picture for a new stream after a seek. */
export const seekTransitionHeld = () => restart.transitionPending;
/** How many seeks asked for a stream so far: a later count means a newer seek. */
export const seekStreamCount = () => restart.requestId;
/** The seek whose new stream `player` waits for, or null. */
export const seekAwaitingStream = (player) => (restart.pending && restart.seek?.player === player ? restart.seek : null);

/** An optimistic seek's new stream comes (play()): the screen holds the picture for it. */
export function holdSeekTransition() {
  restart.transitionPending = true;
}

/** The new stream plays, or the screen left it: the seek indicator goes. */
export function endSeekTransition() {
  restart.pending = false;
  restart.transitionPending = false;
  setSeekTransitionPending(false);
}

/** A stream came or the owner left: no seek waits for a stream any more, and with `keepTransition` the picture stays held. */
export function forgetSeekStream({ keepTransition = false } = {}) {
  restart.requestId += 1;
  restart.pending = false;
  restart.seek = null;
  restart.built = null;
  cancelStreamWatch();
  if (!keepTransition) restart.transitionPending = false;
}

/**
 * Asks Yolo for a new stream at `targetTime`, in place of the one on screen
 * (or of the one Yolo built in its place whose `load` never came,
 * replacedStream()). One such stream is asked for at a time: a seek while
 * the request is on its way, or while the stream Yolo built for it is, only
 * moves the target, and that stream starts there (seekStreamStart). A second
 * request would race the first at the Hub, and come back superseded once
 * Yolo had built the first one's stream, which then played at the first
 * target. `again` asks anew even so, since the stream on its way is known
 * lost (rejoinHubStream, player.js), unless the request still waits for the
 * realtime connection: sent then, it replaces the lost stream. `settled`
 * hears how the request was answered (true, "skipped", or null for a failure).
 */
export function seekWithNewStream(player, targetTime, expectedToPlay, { fromTime, again = false, settled = () => {} }) {
  if (!state.source) return false;
  const current = restart.pending ? restart.seek : null;
  const onItsWay = current?.player === player
    && (again ? current.asking && !current.sent : current.asking || Boolean(restart.built));
  if (onItsWay) {
    current.targetTime = targetTime;
    current.expectedToPlay = expectedToPlay;
    current.settled.push(settled);
    logPlayerEvent("seek_session_restart_retargeted", { requestId: restart.requestId, asked: current.asked, targetTime });
    return true;
  }
  const requestId = ++restart.requestId;
  const seek = { player, targetTime, asked: targetTime, expectedToPlay, fromTime, asking: true, sent: false, settled: [settled] };
  Object.assign(restart, { pending: true, transitionPending: true, seek, built: null });
  cancelStreamWatch();
  cancelSeekWatch();
  void player.pause().catch(() => {});
  state.isPlaying = false;
  setSeekTransitionPending(true);
  logPlayerEvent("seek_session_restart_requested", {
    requestId,
    fromTime,
    targetTime,
    seekableRange: player.getSeekableRange?.() || null,
    sessionId: state.sessionId,
    replaces: fromPlayer.replacedStream(),
  });

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
  const stillMine = () => requestId === restart.requestId && state.player === player;
  void fromPlayer.requestStream({ meta: { source: state.source, sessionId: state.sessionId } }, askAt, {
    label: "Seek",
    recovery: false,
    reason: "seek",
    accepted: (sessionId) => {
      if (requestId === restart.requestId) restart.built = sessionId;
    },
  }).then((created) => {
    answered(created);
    if (!stillMine()) return;
    // Yolo has this stream, or a newer one ("skipped"): its `load` is on the way.
    watchStream(requestId, player);
    if (created === true) logPlayerEvent("seek_session_restart_created", { requestId, fromTime, targetTime: seek.asked, sessionId: restart.built });
  }).catch((error) => {
    answered(null);
    if (stillMine()) failSeekStream(player, requestId, error?.message || String(error));
  });
  return true;
}

/**
 * Where the stream a seek asked for starts (play(), for a `load` with reason
 * "seek"): at the last place the owner asked for, which a seek sent while
 * that stream was on its way moved. A target before the stream's own start
 * is another seek once it plays (`then`), which asks for a stream there.
 */
export function seekStreamStart(startTime) {
  const seek = seekAwaitingStream(state.player);
  if (!seek || Math.abs(seek.targetTime - seek.asked) < 0.5) return { startTime, then: null };
  logPlayerEvent("seek_session_restart_moved", { asked: seek.asked, targetTime: seek.targetTime, streamStart: startTime });
  return seek.targetTime >= startTime ? { startTime: seek.targetTime, then: null } : { startTime, then: seek.targetTime };
}

// The seek did not get its stream: the player stays where it was. When Yolo
// built one whose `load` never came over a connection that answers, the
// stream on screen is one Yolo stopped: the screen asks for a new stream
// where it was, in place of the one Yolo built.
function failSeekStream(player, requestId, error) {
  const { targetTime = null, fromTime = null, expectedToPlay = false } = restart.seek || {};
  const built = restart.built && restart.built !== state.sessionId ? restart.built : null;
  Object.assign(restart, { pending: false, transitionPending: false, seek: null, built: null });
  cancelStreamWatch();
  setSeekTransitionPending(false);
  const position = fromPlayer.position(player);
  state.currentTime = position;
  updateTimeDisplay();
  updateProgress(state.duration > 0 ? position / state.duration : 0);
  logPlayerEvent("seek_session_restart_failed", { requestId, fromTime, targetTime, built, error });
  showPlaybackNotice("Couldn't skip there. Try again.");
  if (built) fromPlayer.rejoinBuilt(player, built, position);
  else if (expectedToPlay && state.playbackIntent === "playing") void player.resume().catch(() => {});
}

// The backstop for a seek's stream that Yolo built but whose `load` has not
// come: the realtime connection may have died without the page noticing. It
// is made to prove itself; a dead one is replaced, and the welcome after it
// asks again (rejoinHubStream). While the connection is down the seek waits
// for that welcome. One that answers and still brings no stream ends the
// seek as failed, so the seek indicator never stays.
function watchStream(requestId, player) {
  cancelStreamWatch();
  const armedAt = performance.now();
  let probed = false;
  const check = () => {
    restart.loadTimer = null;
    const seek = restart.seek;
    if (requestId !== restart.requestId || !restart.pending || state.player !== player || !seek) return;
    const realtime = fromPlayer.realtime();
    const again = () => {
      restart.loadTimer = setTimeout(check, STREAM_LOAD_WAIT_MS);
    };
    if (realtime?.running && !realtime.ready) {
      again();
      return;
    }
    if (!probed && realtime?.running) {
      probed = true;
      logPlayerEvent("seek_session_restart_load_missing", { requestId, targetTime: seek.targetTime, built: restart.built });
      realtime.probe();
      again();
      return;
    }
    failSeekStream(player, requestId, `no stream arrived ${Math.round(performance.now() - armedAt)} ms after Yolo built it`);
  };
  restart.loadTimer = setTimeout(check, STREAM_LOAD_WAIT_MS);
}

function cancelStreamWatch() {
  clearTimeout(restart.loadTimer);
  restart.loadTimer = null;
}

// --- Asking for a seek ------------------------------------------------------------

// Every seek asked of the player counts (play() drops a seek it was to make
// once its stream loaded when the owner asked for another one meanwhile).
let seeksAsked = 0;

export const seekCount = () => seeksAsked;

/** A seek the owner made on this screen (the controls, the system's media keys). */
export function seekHere(timeSec) {
  fromPlayer.ownAction("seek");
  seekToTime(timeSec);
}

// A live stream: the <video> engine seeks in the window the browser keeps;
// the canvas engine seeks near the edge in place, and elsewhere in the DVR
// window plays a new stream positioned there.
function seekLive(player, timeSec) {
  const requestedTime = Number(timeSec);
  if (!Number.isFinite(requestedTime)) return;
  const fromTime = state.currentTime;
  const playing = state.playbackIntent === "playing";
  if (player.seeksLiveInPlace) {
    const timeline = player.getLiveTimeline();
    if (!timeline) return;
    const target = Math.max(timeline.startTime, Math.min(timeline.edgeTime, requestedTime));
    state.currentTime = target;
    updateTimeDisplay();
    updateProgress(timeline.edgeTime > timeline.startTime ? (target - timeline.startTime) / (timeline.edgeTime - timeline.startTime) : 1);
    seekInStream(player, target, playing, { fromTime, label: "live" });
    return;
  }
  const request = fromPlayer.streamRequest();
  if (!request || !state.liveDvrAvailable) return;
  const nearEdge = requestedTime >= state.liveEdgeTime - 6;
  const target = Math.max(state.liveStartTime, Math.min(nearEdge ? state.liveEdgeTime + LIVE_EDGE_LEAD_SECONDS : state.liveEdgeTime, requestedTime));
  if (nearEdge) {
    state.currentTime = target;
    player.hlsStartSeconds = 2;
    updateTimeDisplay();
    updateProgress(1);
    seekInStream(player, target, playing, { preserveHlsBuffer: true, fromTime, label: "live-edge" });
    return;
  }
  const mediaSource = request.meta.mediaSource;
  const sourceUrl = typeof mediaSource === "object" ? mediaSource?.url : null;
  if (!sourceUrl) return;
  const positioned = new URL(sourceUrl, location.origin);
  positioned.searchParams.set("at", String(target));
  void fromPlayer.replay(request.url, request.title, {
    ...request.meta,
    mediaSource: { ...mediaSource, url: `${positioned.pathname}${positioned.search}` },
    startTime: target,
    autoplay: playing,
    __recovery: true,
    __liveSeek: true,
  }).catch((error) => console.error("[player] Live seek error:", error));
}

/**
 * A seek on this screen, from the owner or Yolo. `settled`: the stream on
 * screen is loaded, even while its seek transition waits for a first
 * picture (play(), for a seek the owner asked for while it was on its way):
 * a target it can seek to is a seek in it.
 */
export function seekToTime(timeSec, { settled = false } = {}) {
  fromPlayer.forgetFinished();
  // A seek while the player is kept (an agent's, the bar's skip back): Yolo
  // moved its position already; the player goes on there.
  if (!state.player && fromPlayer.seekKept(timeSec)) return;
  const player = state.player;
  if (!player) return;
  seeksAsked += 1;
  if (state.isLive) {
    seekLive(player, timeSec);
    return;
  }
  const requestedTime = Number(timeSec);
  if (state.duration <= 0 || !Number.isFinite(requestedTime)) return;
  const fromTime = state.currentTime;
  const target = Math.max(0, Math.min(state.duration, requestedTime));
  const playing = state.playbackIntent === "playing";
  const newStream = shouldRestartSessionForSeek({
    sessionId: state.source ? state.sessionId : null,
    targetTime: target,
    seekableStartTime: player.getSeekableRange?.()?.start,
    sessionRestartPending: restart.pending || (restart.transitionPending && !settled),
  });
  if (newStream) setSeekTransitionPending(true);
  state.currentTime = target;
  updateTimeDisplay();
  updateProgress(state.currentTime / state.duration);
  if (newStream) {
    seekWithNewStream(player, target, playing, { fromTime });
    return;
  }
  seekInStream(player, target, playing, { fromTime, label: "vod" });
  fromPlayer.reportProgress();
}
