// Where each danmaku comment is at a moment of the item
// (Agent Note 2026-10-13-danmaku). Placement is a function of media time,
// not of frames or wall time: a paused picture shows the same comments in
// the same places, a faster playback rate moves them faster, and a seek lays
// the screen out again from the new time.
//
// Scrolling comments cross the picture from right to left in
// SCROLL_SECONDS of media time, so a longer one moves faster, and take the
// highest lane where they neither touch the lane's last comment at the start
// nor catch up with it before it leaves. Top and bottom comments stay
// FIXED_SECONDS, centred, stacking from their edge. A comment that fits in
// no lane is dropped, except at "high" density, where it overlaps the lane
// that has been busy longest; "low" keeps about a third of the comments.
// MAX_ACTIVE bounds the comments on screen at once.
//
// No DOM here: the renderer (danmaku.js) gives each comment's width.

export const SCROLL_SECONDS = 8;
export const FIXED_SECONDS = 4;
export const MAX_ACTIVE = 200;
// A jump forward of more than this between two updates is a seek, and so is
// a step back of more than BACK_SECONDS (a clock that re-anchors steps back
// a little, which is no seek).
const SEEK_SECONDS = 1;
const BACK_SECONDS = 0.25;
// A layout after a seek replays this much before the new time, so lanes
// look as they would have after playing there.
const REPLAY_SECONDS = 2 * SCROLL_SECONDS;

const durationOf = (mode) => (mode === "scroll" ? SCROLL_SECONDS : FIXED_SECONDS);
const spanOf = (comment) => (Number(comment.size) > 1.15 ? 2 : 1);

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
    this.lanes = { scroll: [], top: [], bottom: [] };
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
    return laneHeight > 0 ? Math.max(0, Math.floor(height / laneHeight)) : 0;
  }

  get gap() {
    return Math.max(12, (this.geometry?.laneHeight || 0) / 2);
  }

  /** The comments on screen at `time`, oldest first. */
  update(time) {
    if (!this.geometry) return (this.active = []);
    const replay = this.lastTime == null || time < this.lastTime - BACK_SECONDS || time > this.lastTime + SEEK_SECONDS;
    if (replay) {
      this.active = [];
      this.lanes = { scroll: [], top: [], bottom: [] };
      this.next = firstAtOrAfter(this.comments, time - REPLAY_SECONDS);
    }
    while (this.next < this.comments.length && this.comments[this.next].t <= time) this.place(this.comments[this.next++]);
    this.prune(time);
    this.lastTime = Math.max(time, replay ? time : this.lastTime);
    return this.active;
  }

  prune(time) {
    if (this.active.some((item) => time >= item.t + item.duration)) this.active = this.active.filter((item) => time < item.t + item.duration);
  }

  place(comment) {
    if (this.density === "low" && !keptAtLowDensity(comment)) return;
    if (this.active.length >= MAX_ACTIVE) {
      this.prune(comment.t);
      if (this.active.length >= MAX_ACTIVE) return;
    }
    const mode = comment.mode === "top" || comment.mode === "bottom" ? comment.mode : "scroll";
    const width = this.measure(comment);
    const span = Math.min(spanOf(comment), Math.max(1, this.laneCount));
    const item = {
      comment, mode, t: comment.t, width, span, lane: -1, duration: durationOf(mode),
      speed: mode === "scroll" ? (this.geometry.width + width) / SCROLL_SECONDS : 0,
    };
    const lane = this.freeLane(item);
    if (lane < 0) return;
    item.lane = lane;
    const lanes = this.lanes[mode];
    for (let index = lane; index < lane + span; index += 1) lanes[index] = item;
    this.active.push(item);
  }

  // Whether `item` may start in a lane whose last comment is `last`.
  clear(item, last) {
    if (!last || item.t >= last.t + last.duration) return true;
    if (item.mode !== "scroll") return false;
    const travelled = (item.t - last.t) * last.speed;
    if (travelled < last.width + this.gap) return false;
    // A faster comment must not reach the last one's tail before it leaves.
    return item.speed <= last.speed || (last.t + last.duration - item.t) * item.speed <= this.geometry.width;
  }

  freeLane(item) {
    const lanes = this.lanes[item.mode];
    const count = this.laneCount;
    for (let lane = 0; lane + item.span <= count; lane += 1) {
      let free = true;
      for (let index = lane; index < lane + item.span && free; index += 1) free = this.clear(item, lanes[index]);
      if (free) return lane;
    }
    if (this.density !== "high" || !count) return -1;
    // Dense: the lane whose last comment started longest ago.
    let best = 0;
    for (let lane = 1; lane + item.span <= count; lane += 1) {
      if ((lanes[lane]?.t ?? -Infinity) < (lanes[best]?.t ?? -Infinity)) best = lane;
    }
    return best;
  }

  /** Where `item`'s left edge is at `time`, in the geometry's pixels. */
  x(item, time) {
    return item.mode === "scroll" ? this.geometry.width - (time - item.t) * item.speed : (this.geometry.width - item.width) / 2;
  }

  /** Where `item`'s top edge is, in the geometry's pixels. */
  y(item) {
    const { height, laneHeight } = this.geometry;
    if (item.mode !== "bottom") return item.lane * laneHeight;
    return (this.laneCount - item.lane - item.span) * laneHeight + (height - this.laneCount * laneHeight);
  }

  /** Both, as `{ x, y }`. */
  position(item, time) {
    return { x: this.x(item, time), y: this.y(item) };
  }
}
