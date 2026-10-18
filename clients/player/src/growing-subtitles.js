// Growing subtitle tracks (Agent Note 2026-10-18-ai-subtitles): an AI track
// the media node writes while the item plays. The player reads it again
// every few seconds for a window around its position, and that window tells
// the node what to work on next, so the window reaches well ahead.

const GROWING_POLL_MS = 4_000;
const BEHIND_SECONDS = 10;
const AHEAD_SECONDS = 90;
// A seek further than this asks at once rather than at the next poll.
const JUMP_SECONDS = 20;

/** The window to ask for at subtitle time `time`: { start, end } in seconds. */
export function growingWindow(time) {
  const at = Math.max(0, Number(time) || 0);
  return { start: Math.max(0, at - BEHIND_SECONDS), end: at + AHEAD_SECONDS };
}

/** The track's URL asking for `window`. */
export function windowUrl(url, { start, end }) {
  const target = new URL(url);
  target.searchParams.set("start", start.toFixed(1));
  target.searchParams.set("end", end.toFixed(1));
  return target.href;
}

/** Whether to ask again now: due by the clock, or the position jumped. */
export function pollDue(last, time, nowMs) {
  if (!last) return true;
  return nowMs - last.at >= GROWING_POLL_MS || Math.abs(time - last.time) > JUMP_SECONDS;
}

/**
 * The track's cues after an answer for `window`: the fresh cues replace
 * every cue the answer covers (the window, widened to the fresh cues' span),
 * and the rest stay. Sorted as parseVTT sorts.
 */
export function mergeWindow(cues, fresh, window) {
  const start = Math.min(window.start, ...fresh.map((cue) => cue.start));
  const end = Math.max(window.end, ...fresh.map((cue) => cue.end));
  const kept = cues.filter((cue) => cue.end <= start || cue.start >= end);
  return [...kept, ...fresh].sort((left, right) => left.start - right.start || left.end - right.end);
}
