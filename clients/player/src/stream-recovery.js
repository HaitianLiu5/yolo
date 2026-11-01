import { hideBuffering, updatePlayButton } from "./controls.js";
import { isNetworkFailure } from "./network.js";
import { showPlaybackError } from "./player-screens.js";
import { playOnThisDevice, requestStream, streamRecoveryPending } from "./playback.js";
import {
  buildFreshPlaybackSessionRequest,
  hasNothingLeftToPlay,
  hasRecoveryPlaybackProgress,
  planRetry,
  playbackRecoveryDelayMs,
} from "./playback-recovery.js";
import { cancelSeekWatch, seekAwaitingStream, seekStreamAsked, seekWithNewStream } from "./seek.js";
import { state } from "./state.js";
import { sourceKeyOf } from "./store.js";
import { readStats, summarizeStats } from "./telemetry/engine-stats.js";
import { logPlayerEvent } from "./telemetry/player-log.js";

// Keeping playback going with new streams from Yolo, in place of the one on
// screen: when it fails (recovery, with a capped backoff, until a new
// stream plays: the car can be offline for minutes), when the owner tries
// again, and when a reconnect lost the `load` of a stream Yolo built for
// this screen (rejoin, Agent Note 2026-10-07-hub-and-realtime-channel).
// Each new stream arrives as a `load` (play(), player.js); the picture stays
// under the spinner until it plays.

// A recovered stream that plays this long resets the backoff.
const STABLE_MS = 60_000;
// A recovered stream that has not moved by then is recovered again.
const CONFIRM_TIMEOUT_MS = 20_000;
const STREAM_REQUEST_FAILED = "STREAM_REQUEST_FAILED";

let fromPlayer = null;

/**
 * What recovery needs from the player (player.js):
 * - `position(player)` is where playback is;
 * - `showRecovering(player)` holds the last picture under the spinner, and
 *   `dropHeldPicture()` lets it go;
 * - `finish(player)` ends the item as if it had played to its end;
 * - `replay(url, title, meta)` plays a stream; `stop()` leaves the item;
 * - `notePathFailure(error)` tells the media paths a stream failed;
 * - `qualityCap()` is the bitrate a new stream may have, and
 *   `qualityChange()` the quality change on its way, if any.
 */
export function initStreamRecovery(deps) {
  fromPlayer = deps;
}

// --- The stream on screen -------------------------------------------------------

// `request` is what the stream on screen came from ({ url, title, meta }),
// which a new stream rebuilds; the rest counts and times the recovery.
const recovery = { request: null, attempts: 0, retryTimer: null, confirmationTimer: null, pending: null, stableTimer: null };

export const streamRequest = () => recovery.request;
/** A recovery waits to ask for its new stream. */
export const recoveryScheduled = () => Boolean(recovery.retryTimer);

function clearConfirmation() {
  clearTimeout(recovery.confirmationTimer);
  recovery.confirmationTimer = null;
  recovery.pending = null;
}

function clearTimers() {
  clearTimeout(recovery.retryTimer);
  recovery.retryTimer = null;
  clearTimeout(recovery.stableTimer);
  recovery.stableTimer = null;
  clearConfirmation();
}

/** Nothing is being recovered, and the backoff starts again. */
export function resetRecovery() {
  clearTimers();
  recovery.attempts = 0;
}

/**
 * A stream begins to load (play()): a new one becomes the one a recovery
 * rebuilds; a recovered one keeps the request it came from, with its own
 * session, delivery, and tracks.
 */
export function recordStream({ url, title, meta, recovered }) {
  if (!recovered) {
    resetRecovery();
    const { __recovery, ...requestMeta } = meta;
    recovery.request = { url, title, meta: requestMeta };
    return;
  }
  if (!recovery.request || !meta.sessionId) return;
  recovery.request = {
    ...recovery.request,
    url,
    meta: {
      ...recovery.request.meta,
      sessionId: meta.sessionId, mediaSource: meta.mediaSource, tracks: meta.tracks, origin: meta.origin ?? null, network: meta.network ?? null,
    },
  };
}

/** The owner left the stream, or kept it behind the home screen: its request, which nothing recovers any more. */
export function forgetStream() {
  const { request } = recovery;
  resetRecovery();
  recovery.request = null;
  return request;
}

/** A kept player shows again: its stream is the one to recover. */
export function restoreStream(request) {
  recovery.request = request;
}

// --- New streams ------------------------------------------------------------------

/**
 * Asks Yolo for a new stream of the current item (the source resolves it
 * again, so expired URLs and dropped transcodes are replaced). The request
 * waits until the realtime channel is welcomed, joins a recovery already on
 * its way (the welcome after a wake may have started one), and retries what
 * can heal (stream-requests.js). Returns false without a source, "skipped"
 * when the stream to replace is gone already, true once Yolo accepted;
 * `accepted` hears the Hub's new session then. `startTime` may be a
 * function, read when the request goes. The request replaces the stream on
 * screen (the one in `request`), or the one Yolo built in its place whose
 * `load` never came (replacedStream()); it goes only while that stream is
 * still on screen.
 */
export async function requestNewStream(request, startTime, { label = "Playback recovery", recovery: recovering = true, reason, accepted = () => {} } = {}) {
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
        recovery: recovering,
        reason,
        // The same quality as now, or a step up kept for the next stream: a
        // seek or a recovery is no reason to go back to a bitrate that
        // stalled. In place of a stream whose `load` never came, or on
        // another media path, what Yolo keeps for this screen and the path:
        // that stream may have been a quality change.
        maxVideoKbps: replaces === playing ? fromPlayer.qualityCap() : undefined,
      })?.body ?? null;
    }, { label, reason: reason || (recovering ? "recovery" : "seek") });
  } catch (error) {
    // Another stream replaced this one first (a quality change, a seek, an
    // agent's play): its `load` is on the way over the realtime connection,
    // which the request pinged (playback.js), so there is nothing to
    // recover here.
    if (error?.code === "superseded") return "skipped";
    throw Object.assign(new Error(`${label} could not create a fresh stream: ${error.message}`, { cause: error }), {
      code: STREAM_REQUEST_FAILED,
      apiCode: error?.code || null,
      network: error?.network === true || isNetworkFailure(error),
    });
  }
  if (result === null) return "skipped";
  if (result?.state?.sessionId) accepted(result.state.sessionId);
  return true;
}

// A new stream in place of the one `player` shows, from `startTime`, that
// must then play (or stand ready, paused) within CONFIRM_TIMEOUT_MS. Says
// what Yolo answered (requestNewStream).
async function rebuildStream(player, request, startTime, { label, attempt = 1 } = {}) {
  const requested = await requestNewStream(request, startTime, label ? { label } : {});
  if (requested === true) awaitConfirmation(attempt, startTime, player);
  return requested;
}

// --- Recovery -----------------------------------------------------------------------

function isRecoverable(error) {
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

function markStable(player) {
  clearTimeout(recovery.stableTimer);
  recovery.stableTimer = setTimeout(() => {
    recovery.stableTimer = null;
    if (state.player !== player || !state.isPlaying) return;
    recovery.attempts = 0;
    logPlayerEvent("playback_recovery_stable", { currentTime: fromPlayer.position(player) });
  }, STABLE_MS);
}

/**
 * The engine's state and time (player.js): a recovered stream proves itself
 * once its picture moves past where it began, or once it stands paused and
 * ready when the owner had paused. Says whether this confirmed it.
 */
export function confirmRecovery(player, currentTime) {
  const pending = recovery.pending;
  if (!pending || state.player !== player || player === pending.previousPlayer) return false;
  const status = player.getStatus?.();
  const pausedReady = state.playbackIntent === "paused" && status === "paused";
  if (!pausedReady && status !== "playing") return false;
  const stats = summarizeStats(readStats(player));
  const hasVideo = Boolean(stats?.videoCodec);
  const presentationTime = hasVideo ? Number(stats?.videoCurrentTimeMs) / 1000 : currentTime;
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
  clearConfirmation();
  logPlayerEvent("playback_recovery_confirmed", {
    attempt: pending.attempt,
    requestedStartTime: pending.startTime,
    baselineTime: pending.baselineTime,
    currentTime,
    presentationTime,
  });
  if (pausedReady) recovery.attempts = 0;
  else markStable(player);
  return true;
}

function awaitConfirmation(attempt, startTime, previousPlayer) {
  clearTimeout(recovery.confirmationTimer);
  recovery.pending = { attempt, startTime, baselineTime: null, previousPlayer };
  recovery.confirmationTimer = setTimeout(() => {
    recovery.confirmationTimer = null;
    const pending = recovery.pending;
    if (!pending || pending.attempt !== attempt) return;
    recovery.pending = null;
    logPlayerEvent("playback_recovery_unconfirmed", {
      attempt,
      startTime,
      playerStatus: state.player?.getStatus?.() || null,
      playerStats: summarizeStats(readStats(state.player)),
    });
    const error = Object.assign(new Error(`recovery session made no playback progress for ${CONFIRM_TIMEOUT_MS}ms`), { code: "RECOVERY_NOT_CONFIRMED" });
    recover(state.player, error, { startTime: fromPlayer.position(state.player) });
  }, CONFIRM_TIMEOUT_MS);
  confirmRecovery(state.player, fromPlayer.position(state.player));
}

/**
 * `player` (or, with none, the start of a stream) failed with `error`: a new
 * stream from `startTime` (else where playback is) after the backoff, unless
 * the error is not one a new stream heals. Says whether it recovers (or
 * someone else does: a seek's new stream, a recovery already on its way).
 */
export function recover(player, error, { startTime: requestedStartTime } = {}) {
  const playerIsCurrent = player ? state.player === player : !state.player;
  const why = { error: error?.message || String(error), code: error?.code || null };
  if (playerIsCurrent && player && seekStreamAsked()) {
    logPlayerEvent("playback_recovery_deferred_for_seek", { error: why.error, targetTime: state.currentTime });
    return true;
  }
  if (playerIsCurrent) fromPlayer.notePathFailure(error);
  if (!playerIsCurrent || !recovery.request || !isRecoverable(error)) return false;
  if (recovery.retryTimer) return true;
  // A fresh stream is already being asked for (from here, or from the
  // welcome after a wake); a second request would supersede it.
  if (streamRecoveryPending()) {
    logPlayerEvent("playback_recovery_joined", why);
    return true;
  }
  clearConfirmation();
  clearTimeout(recovery.stableTimer);
  recovery.stableTimer = null;
  const attempt = recovery.attempts + 1;
  const delayMs = playbackRecoveryDelayMs(attempt);
  const startTime = Number.isFinite(requestedStartTime)
    ? Math.max(0, Math.min(state.duration || Infinity, requestedStartTime))
    : fromPlayer.position(player);
  // Nothing is left to play there: the item is over, as if it had ended
  // (Agent Note 2026-10-12-retry-at-stream-end). Yolo moves to the queue's
  // next item or stops; a stream at the end would wait forever.
  if (player && hasNothingLeftToPlay(startTime, state.duration, { isLive: state.isLive })) {
    logPlayerEvent("playback_recovery_finished", { ...why, startTime });
    cancelSeekWatch();
    player.pause?.().catch(() => {});
    fromPlayer.finish(player);
    return true;
  }
  recovery.attempts = attempt;
  cancelSeekWatch();
  state.isPlaying = false;
  player?.pause?.().catch(() => {});
  // The last picture stays, with a spinner: no text, however many tries.
  fromPlayer.showRecovering(player);
  const failure = player?.getFailure?.(error) ?? null;
  logPlayerEvent("playback_recovery_scheduled", { ...why, attempt, delayMs, startTime, ...(failure ? { failure } : {}) });

  recovery.retryTimer = setTimeout(async () => {
    recovery.retryTimer = null;
    // A quality change already on its way may replace the stream.
    await fromPlayer.qualityChange();
    if (player ? state.player !== player : state.player) return;
    const request = recovery.request;
    if (!request) return;
    try {
      const requested = await rebuildStream(player, request, startTime, { attempt });
      if (requested === "skipped") logPlayerEvent("playback_recovery_skipped", { attempt, startTime, sessionId: state.sessionId });
      if (requested) return;
      await fromPlayer.replay(request.url, request.title, { ...request.meta, startTime, __recovery: true });
    } catch (recoveryError) {
      logPlayerEvent("playback_recovery_attempt_failed", {
        error: recoveryError?.message || String(recoveryError),
        code: recoveryError?.apiCode || recoveryError?.code || null,
        attempt,
        startTime,
      });
      if (!recover(state.player, recoveryError, { startTime })) showPlaybackError(recoveryError);
    }
  }, delayMs);
  return true;
}

/**
 * "Try again": the same item again, never a stream with nothing left to
 * play (planRetry). A rebuild of the failed session while Yolo holds it;
 * otherwise, or when Yolo refuses the rebuild because it ended that session
 * meanwhile, a new play of the item on this device.
 */
export async function retryPlayback() {
  const request = recovery.request || (state.source ? { meta: { source: state.source, sessionId: state.sessionId } } : null);
  if (!request?.meta?.source) {
    fromPlayer.stop();
    return;
  }
  resetRecovery();
  state.playbackIntent = "playing";
  updatePlayButton();
  fromPlayer.showRecovering(state.player);
  const plan = planRetry({
    position: fromPlayer.position(state.player),
    duration: state.duration,
    isLive: state.isLive,
    sessionId: request.meta.sessionId ?? null,
    hubSessionId: state.hub?.sessionId ?? null,
  });
  logPlayerEvent("playback_retry_requested", plan);
  try {
    if (plan.rebuild) {
      if (await rebuildStream(state.player, request, plan.startTime, { label: "Retry" }) === true) return;
      // Skipped: another stream replaced this one (its `load` is here or on
      // the way), unless Yolo has no session left to replace it with.
      if (state.sessionId !== request.meta.sessionId || state.hub?.sessionId) return;
    }
    await playOnThisDevice({ source: request.meta.source }, { startTime: plan.startTime });
  } catch (error) {
    showPlaybackError(error);
  }
}

/**
 * The kept player cannot go on (its session ended while hidden, the screen
 * left its path, or its engine failed): a new stream of the same item at
 * the same position, with the picture kept until the new stream plays. The
 * tracks are the item's saved ones.
 */
export async function rebuildKept(player, plan) {
  logPlayerEvent("kept_player_rebuild", { why: plan.why, startTime: plan.startTime });
  fromPlayer.showRecovering(player);
  try {
    const requested = await rebuildStream(player, recovery.request, plan.startTime);
    if (requested === true || requested === "skipped" || state.player !== player) return;
    await playOnThisDevice({ source: state.source }, { startTime: plan.startTime });
  } catch (error) {
    if (state.player !== player) return;
    if (!recover(player, error, { startTime: plan.startTime })) showPlaybackError(error);
  }
}

// --- A stream whose `load` a reconnect lost ---------------------------------------

// A stream Yolo built for this screen in place of the one on screen, whose
// `load` never came (rejoinHubStream): { onScreen, sessionId, asking }.
// Yolo sends each `load` once, over the connection it has then.
let lostLoad = null;
// The request for another item a welcome named, on its way
// (rejoinHubItem): { onScreen, sessionId }.
let itemRejoin = null;

/** The session a request for a new stream of what plays replaces: the one on screen, or the one Yolo built in its place whose `load` never came. */
export function replacedStream() {
  return lostLoad && lostLoad.onScreen === state.sessionId ? lostLoad.sessionId : state.sessionId;
}

/** A stream came, or the owner left: no lost `load` is waited for. */
export function forgetLostLoads() {
  lostLoad = null;
  itemRejoin = null;
}

// A request in place of `lost` was refused (superseded) or no longer
// wanted: Yolo no longer has that stream for this screen.
function forgetLostLoad(lost) {
  if (lostLoad === lost) lostLoad = null;
}

// The player holds its picture under the spinner while a new stream comes.
function holdForNewStream(player) {
  cancelSeekWatch();
  state.isPlaying = false;
  void player.pause().catch(() => {});
  fromPlayer.showRecovering(player);
}

// A new stream of the item on screen where it is, in place of the stream
// Yolo built for this screen whose `load` never came (`lost`): the stream
// on screen is one Yolo stopped. The picture stays, with the spinner, until
// the new one plays.
function rejoinInPlace(player, position, lost) {
  holdForNewStream(player);
  const request = recovery.request?.meta?.sessionId === state.sessionId
    ? recovery.request
    : { meta: { source: state.source, sessionId: state.sessionId } };
  void requestNewStream(request, position).then((requested) => {
    lost.asking = false;
    if (state.player !== player) return;
    if (requested === true) {
      awaitConfirmation(1, position, player);
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
    if (!recover(player, error, { startTime: position })) showPlaybackError(error);
  });
}

/** A seek's new stream that Yolo built never came (seek.js): a new stream where the player is, in its place. */
export function rejoinBuilt(player, sessionId, position) {
  lostLoad = { onScreen: state.sessionId, sessionId, asking: true };
  rejoinInPlace(player, position, lostLoad);
}

// A request in place of a stream whose `load` never came was refused or is
// no longer wanted: until a `load` says otherwise, the stream on screen
// plays on, unless a newer such request is on its way.
function playOnAfterRejoin(player, onScreen) {
  if (state.player !== player || state.sessionId !== onScreen || lostLoad?.asking || itemRejoin) return;
  fromPlayer.dropHeldPicture();
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
  const seek = seekAwaitingStream(player);
  logPlayerEvent("hub_stream_rejoined", { sessionId: state.sessionId, lost: hub.sessionId, seekTo: seekTo ?? seek?.targetTime ?? null });
  if (seekTo != null && !seek) {
    // A seek Yolo sent for the stream whose `load` was lost, which the
    // screen left for that stream (main.js): the new stream starts there.
    rejoinInPlace(player, seekTo, lost);
  } else if (seek) {
    seekWithNewStream(player, seekTo ?? seek.targetTime, seek.expectedToPlay, {
      fromTime: seek.fromTime,
      again: true,
      settled: (created) => {
        lost.asking = false;
        if (created === "skipped") forgetLostLoad(lost);
      },
    });
  } else {
    rejoinInPlace(player, fromPlayer.position(player), lost);
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
  holdForNewStream(player);
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
