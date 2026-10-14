// Where each danmaku comment is at a moment of the item
// (Agent Note 2026-10-13-danmaku). Placement is a function of media time,
// not of frames or wall time: a paused picture shows the same comments in
// the same places, a faster playback rate moves them faster, and a seek lays
// the screen out again from the new time.
//
// A scrolling comment crosses the picture from right to left in
// SCROLL_SECONDS of media time, so a longer one moves faster; a top or
// bottom comment stays FIXED_SECONDS, centred. Every mode shares one set of
// lanes, and no two comments on screen ever overlap: a comment takes the
// first lane (from the top, or from the bottom for a bottom comment) where
// it does not meet, at any moment both are on screen, any comment already
// there, keeping a gap between them. For two scrolling comments that means
// the earlier one has fully entered, plus the gap, and the later one does
// not catch up with it before it leaves. A comment larger than the normal
// size takes two lanes. When no lane is free, "high" density waits up to
// QUEUE_SECONDS for one, and every density then drops the comment; "low"
// keeps about a third of the comments to begin with. MAX_ACTIVE bounds the
// comments on screen at once.
//
// No DOM here: the renderer (danmaku.js) gives each comment's width and
// the lanes' height.

export const SCROLL_SECONDS = 8;
export const FIXED_SECONDS = 4;
export const MAX_ACTIVE = 200;
export const QUEUE_SECONDS = 2;
const QUEUE_STEP_SECONDS = 0.25;
// A jump forward of more than this between two updates is a seek, and so is
// a step back of more than BACK_SECONDS (a clock that re-anchors steps back
// a little, which is no seek).
const SEEK_SECONDS = 1;
const BACK_SECONDS = 0.25;
// A layout after a seek replays this much before the new time, so lanes
// look as they would have after playing there.
const REPLAY_SECONDS = 2 * SCROLL_SECONDS;
// Pixels of overlap below this are rounding, not overlap.
const EPSILON = 1e-6;

const durationOf = (mode) => (mode === "scroll" ? SCROLL_SECONDS : FIXED_SECONDS);

/** Lanes a comment of this size takes: its line is `size` lines tall. */
export const spanOf = (comment) => Math.min(2, Math.max(1, Math.ceil((Number(comment.size) || 1) - 0.001)));

// About a third, the same third every time.
function keptAtLowDensity(comment) {
  let hash = Math.round(comment.t * 1000) | 0;
  for (let index = 0; index < comment.text.length; index += 1) hash = (Math.imul(hash, 31) + comment.text.charCodeAt(index)) | 0;
  return ((hash >>> 0) % 3) === 0;
}

function firstAtOrAfter(comments, time) {
  let low = 0;
  let high = comments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (comments[middle].t < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

// The times in [range.low, range.high] where p + q·τ < 0, narrowed in place.
function whereNegative(range, p, q) {
  if (Math.abs(q) < 1e-12) {
    if (p >= -EPSILON) range.high = -Infinity;
    return;
  }
  const root = (-EPSILON - p) / q;
  if (q > 0) range.high = Math.min(range.high, root);
  else range.low = Math.max(range.low, root);
}

export class DanmakuLayout {
  /** @param {{ measure: (comment: object) => number }} options  a comment's width in the geometry's pixels */
  constructor({ measure }) {
    this.measure = measure;
    this.comments = [];
    this.geometry = null;
    this.density = "normal";
    this.active = [];
    this.lastTime = null;
    this.next = 0;
    this.lanes = [];
  }

  /** Comments in time order. */
  setComments(comments) {
    this.comments = comments;
    this.lastTime = null;
  }

  /** `width` and `height` of the area comments use, and the height of one lane. */
  setGeometry(geometry) {
    this.geometry = geometry;
    this.lastTime = null;
  }

  setDensity(density) {
    this.density = density;
    this.lastTime = null;
  }

  /** Forget the layout; the next update lays out from its time. */
  reset() {
    this.lastTime = null;
  }

  get laneCount() {
    const { height = 0, laneHeight = 0 } = this.geometry || {};
    return laneHeight > 0 ? Math.max(0, Math.floor(height / laneHeight + 1e-9)) : 0;
  }

  get gap() {
    return Math.max(12, (this.geometry?.laneHeight || 0) / 2);
  }

  /** The comments placed by `time`, oldest first; one that waits for a lane starts after it. */
  update(time) {
    if (!this.geometry) return (this.active = []);
    const replay = this.lastTime == null || time < this.lastTime - BACK_SECONDS || time > this.lastTime + SEEK_SECONDS;
    if (replay) {
      this.active = [];
      this.lanes = Array.from({ length: this.laneCount }, () => []);
      this.next = firstAtOrAfter(this.comments, time - REPLAY_SECONDS);
    }
    while (this.next < this.comments.length && this.comments[this.next].t <= time) this.place(this.comments[this.next++]);
    this.prune(time);
    this.lastTime = Math.max(time, replay ? time : this.lastTime);
    return this.active;
  }

  prune(time) {
    if (this.active.some((item) => time >= item.end)) this.active = this.active.filter((item) => time < item.end);
  }

  // Where `item`'s left edge is at τ, as p + q·τ.
  edge(item) {
    if (item.mode !== "scroll") return { p: (this.geometry.width - item.width) / 2, q: 0 };
    return { p: this.geometry.width + item.t * item.speed, q: -item.speed };
  }

  /** Whether `a` and `b` come closer than the gap while both are on screen (in the same lanes). */
  meets(a, b) {
    const range = { low: Math.max(a.t, b.t), high: Math.min(a.end, b.end) };
    if (range.high - range.low <= 1e-9) return false;
    const left = this.edge(a);
    const right = this.edge(b);
    const gap = this.gap;
    // a starts before b's end plus the gap, and b before a's end plus the gap.
    whereNegative(range, left.p - right.p - b.width - gap, left.q - right.q);
    whereNegative(range, right.p - left.p - a.width - gap, right.q - left.q);
    return range.high - range.low > 1e-9;
  }

  fits(item, lane) {
    for (let index = lane; index < lane + item.span; index += 1) {
      for (const other of this.lanes[index]) if (this.meets(item, other)) return false;
    }
    return true;
  }

  place(comment) {
    if (this.density === "low" && !keptAtLowDensity(comment)) return;
    this.prune(comment.t);
    if (this.active.length >= MAX_ACTIVE) return;
    const count = this.laneCount;
    const mode = comment.mode === "top" || comment.mode === "bottom" ? comment.mode : "scroll";
    const span = Math.min(spanOf(comment), count);
    if (!span) return;
    const width = this.measure(comment);
    const duration = durationOf(mode);
    const item = {
      comment, mode, t: comment.t, end: comment.t + duration, width, span, lane: -1, duration,
      speed: mode === "scroll" ? (this.geometry.width + width) / SCROLL_SECONDS : 0,
    };
    // Lanes keep the comments that are still on screen when this one starts.
    for (const lane of this.lanes) {
      if (lane.length && lane[0].end <= comment.t) {
        const kept = lane.filter((other) => other.end > comment.t);
        lane.length = 0;
        lane.push(...kept);
      }
    }
    const waits = this.density === "high" ? Math.round(QUEUE_SECONDS / QUEUE_STEP_SECONDS) : 0;
    for (let wait = 0; wait <= waits; wait += 1) {
      item.t = comment.t + wait * QUEUE_STEP_SECONDS;
      item.end = item.t + duration;
      for (let step = 0; step + span <= count; step += 1) {
        const lane = mode === "bottom" ? count - span - step : step;
        if (!this.fits(item, lane)) continue;
        item.lane = lane;
        for (let index = lane; index < lane + span; index += 1) this.lanes[index].push(item);
        this.active.push(item);
        return;
      }
    }
  }

  /** Where `item`'s left edge is at `time`, in the geometry's pixels. */
  x(item, time) {
    return item.mode === "scroll" ? this.geometry.width - (time - item.t) * item.speed : (this.geometry.width - item.width) / 2;
  }

  /** Where `item`'s top edge is, in the geometry's pixels. */
  y(item) {
    return item.lane * this.geometry.laneHeight;
  }

  /** Both, as `{ x, y }`. */
  position(item, time) {
    return { x: this.x(item, time), y: this.y(item) };
  }
}
