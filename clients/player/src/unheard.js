import { state } from "./state.js";

// What this screen did that Yolo may not have heard: a connection that died
// takes the report with it, and the welcome after it would still show the
// stream as it was (Agent Note 2026-10-07-hub-and-realtime-channel). Each
// record stands until a state from Yolo shows it heard, and main.js reads
// them against a welcome:
// - the stream the screen left without keeping its player (a plain
//   `idle`), until Yolo marks it left (`leftAt`) or names another stream;
// - the owner's pause on this screen (in Yolo's controls, the system's, or
//   outside them), until Yolo has it paused, names another stream, or it
//   plays again here or by a resume Yolo sent;
// - the stream that played to its end here and told Yolo `ended`, until
//   anything plays, pauses, or seeks it again or another stream starts.
// The first two are kept in the tab's sessionStorage too, so a page loaded
// again in the tab (a reload, a car's wake) still says them.

const LEFT_KEY = "yolo.leftStream";
const PAUSED_KEY = "yolo.pausedHere";

// A { sessionId, position } record in the tab's sessionStorage, or null.
function stored(key) {
  try {
    const value = JSON.parse(globalThis.sessionStorage?.getItem(key) ?? "null");
    return typeof value?.sessionId === "string" ? { sessionId: value.sessionId, position: Math.max(0, Number(value.position) || 0) } : null;
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    if (value) globalThis.sessionStorage?.setItem(key, JSON.stringify(value));
    else globalThis.sessionStorage?.removeItem(key);
  } catch {
    // Storage blocked or full: this page alone remembers it.
  }
}

let left = stored(LEFT_KEY);
let pausedHere = stored(PAUSED_KEY);
// { sessionId, player, heard }: `heard` once Yolo answered a ping sent after the `ended`.
let finished = null;

function setLeft(value) {
  left = value;
  store(LEFT_KEY, value);
}

function setPausedHere(value) {
  pausedHere = value;
  store(PAUSED_KEY, value);
}

// --- Left ----------------------------------------------------------------------

/** The screen left `sessionId` at `position` without keeping its player. */
export function noteLeft(sessionId, position) {
  setLeft({ sessionId, position });
}

/** Another stream starts here: nothing left stands. */
export function forgetLeft() {
  setLeft(null);
}

/** The stream this screen left, while Yolo has not said so: { sessionId, position }, or null. */
export const leftStream = () => left;

/** True while this screen has left `sessionId` without keeping its player and Yolo has not yet said so. */
export const streamLeftFor = (sessionId) => Boolean(sessionId) && left?.sessionId === sessionId;

// --- Paused here -----------------------------------------------------------------

/** The owner paused the stream on screen at `position`. */
export function notePausedHere(position) {
  if (state.sessionId) setPausedHere({ sessionId: state.sessionId, position });
}

/** The owner played the stream again, or Yolo resumed it: no pause stands. */
export function forgetPausedHere() {
  if (pausedHere) setPausedHere(null);
}

/**
 * The owner's pause of the stream the Hub's state names on this device, when
 * that state still has it playing or interrupted: Yolo never heard it.
 */
export function pausedHereFor(hub) {
  if (!pausedHere || !hub || hub.deviceId !== state.deviceId || hub.sessionId !== pausedHere.sessionId) return null;
  const playing = ["playing", "buffering", "loading"].includes(hub.status) || Boolean(hub.interruptedAt);
  return playing ? pausedHere : null;
}

// --- Finished here -----------------------------------------------------------------

/** The stream on screen (`player`) played to its end and told Yolo `ended`: the record, whose `heard` the caller sets. */
export function noteFinished(player) {
  finished = { sessionId: state.sessionId, player, heard: false };
  return finished;
}

/** Anything played, paused, or sought the stream again, or another stream starts. */
export function forgetFinished() {
  finished = null;
}

/** The stream on screen played to its end here, heard by Yolo or not (up-next.js). */
export function finishedHere() {
  return Boolean(finished) && finished.player === state.player && finished.sessionId === state.sessionId;
}

/**
 * The stream on screen played to its end here and its `ended` may not have
 * reached Yolo: the welcome still naming it means Yolo never heard `ended`.
 */
export function finishedOnScreen() {
  return finishedHere() && !finished.heard;
}

// --- What Yolo says ------------------------------------------------------------------

/** A state from Yolo (a broadcast or a welcome): what it shows heard, or moved past, no longer stands. */
export function noteHeard(hub) {
  const here = hub && hub.deviceId === state.deviceId;
  if (left && (!here || hub.sessionId !== left.sessionId || hub.leftAt)) setLeft(null);
  // Yolo heard the owner's pause (it has the stream paused, not by a
  // dropped connection), or moved on.
  if (pausedHere && (!here || hub.sessionId !== pausedHere.sessionId || (hub.status === "paused" && !hub.interruptedAt))) setPausedHere(null);
}
