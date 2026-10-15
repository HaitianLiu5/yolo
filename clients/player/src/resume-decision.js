// What a fresh page (a reload, or the car waking up) does with the Hub's
// playback state. Owner decision 2026-10-12, like Spotify in a car: if this
// device's item was playing, or was interrupted while playing (the Hub marks
// `interruptedAt` when the device's last connection drops), it plays on at
// the saved position however long the car slept. If the owner had paused
// before leaving, it stays paused. A playing or interrupted item with
// nothing left to play is `finished` (Agent Note 2026-10-12-retry-at-stream-end):
// the page tells Yolo the item ended instead of asking for a stream at its
// end, and Yolo plays the queue's next item. A paused one is never
// finished, since that would start the next item without anyone asking: it
// stays paused, a few seconds before its end so that its stream has
// something to show. An item the owner left with Back (the Hub marks
// `leftAt`) waits in the now-playing bar instead (remote.js).

import { hasNothingLeftToPlay } from "./playback-recovery.js";

const PLAYING = new Set(["playing", "buffering", "loading"]);

/** How far before its end a paused item with nothing left to play loads. */
export const PAUSED_AT_END_SECONDS = 3;

/**
 * @param {object | null} hub  The Hub's PlaybackState from `welcome`.
 * @param {string | null} deviceId  This device.
 * @returns {{ source: object, sessionId: string, position: number, autoplay: boolean,
 *   why: "playing" | "interrupted" | "paused", finished: boolean } | null}  null when there is
 *   nothing of this device's to resume, or it waits in the now-playing bar.
 */
export function resumeDecision(hub, deviceId) {
  if (!hub || !deviceId || hub.deviceId !== deviceId) return null;
  if (!hub.item?.source || !hub.sessionId || hub.status === "idle") return null;
  let position = Math.max(0, Number(hub.position) || 0);
  let why = "paused";
  if (PLAYING.has(hub.status)) why = "playing";
  else if (hub.interruptedAt) why = "interrupted";
  if (why === "paused" && hub.leftAt) return null;
  const atEnd = hasNothingLeftToPlay(position, hub.item.duration, { isLive: Boolean(hub.item.isLive) });
  if (atEnd && why === "paused") position = Math.max(0, Number(hub.item.duration) - PAUSED_AT_END_SECONDS);
  return { source: hub.item.source, sessionId: hub.sessionId, position, autoplay: why !== "paused", why, finished: atEnd && why !== "paused" };
}
