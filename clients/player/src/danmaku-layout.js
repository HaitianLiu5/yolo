import { lanePx } from "./danmaku-paint.js";

// Where each danmaku comment is at a moment of the item
// (Agent Note 2026-10-13-danmaku). Placement is a function of media time,
// not of frames or wall time: a paused picture shows the same comments in
// the same places, and a faster playback rate moves them faster.
//
// Sizes and pace are Bilibili's web player's defaults, read from its code on
// 2026-10-14 and its screen on 2026-10-18: the text size is fixed
// (danmakuFontPx), whatever the picture's size, a scrolling comment crosses the picture in a time set by the picture's
// width (scrollSeconds), so a longer one moves faster, and a top or bottom
// comment stays FIXED_SECONDS, centred. At normal density, comments whose
// viewers' rank (`weight`, 0 to 10) is below LOW_WEIGHT are hidden, as
// Bilibili's "smart blocking" does at its default level, and no more
// scrolling comments enter in a second than the area has lanes, Bilibili's
// own budget.
//
// Bilibili lets that budget enter in one frame, so a burst reads as a column
// of comments; here comments enter one at a time, the budget spread over the
// second: each a lane's share of ENTRY_SECONDS after the one before it on
// average, varied per comment from half to one and a half of that, and
// never two in one frame. While another lane fits, a comment does not take
// the lane above or below the one that entered just before, so a burst into
// empty lanes interleaves instead of stacking into a staircase. A comment
// waits up to WAIT_SECONDS for its turn and a lane, and is dropped after
// that.
//
// A load or a seek starts the screen empty: comments from before that
// moment never show, and those after it enter at the edge, as after a seek
// in DPlayer and CommentCoreLibrary. New comments continue the layout; a new
// size or density lays the same moment out again as it played since then.
//
// Every mode shares one set of lanes, and no two comments on screen ever
// overlap: a comment takes the first lane (from the top, or from the bottom
// for a bottom comment) where it does not meet, at any moment both are on
// screen, any comment already there, keeping a gap between them. For two
// scrolling comments that means the earlier one has fully entered, plus the
// gap, and the later one does not catch up with it before it leaves: the
// test of Bilibili's player and of weizhenye/danmaku's allocate(), here
// exact over the whole time both show. A comment that fits nowhere is
// dropped, as in Bilibili's player and DPlayer, never drawn over another. A
// comment larger than the normal size takes two lanes. MAX_ACTIVE bounds
// the comments on screen at once.
//
// No DOM here: the renderer (danmaku.js) gives each comment's width and
// the area's geometry (danmakuGeometry).

export const FIXED_SECONDS = 4.5;
export const MAX_ACTIVE = 200;
// The part of the picture each area setting uses, from its top.
export const AREA_FRACTION = Object.freeze({ full: 1, half: 0.5, quarter: 0.25 });
// Viewers' rank below which comments are hidden, except at high density.
export const LOW_WEIGHT = 3;
// How long after its time a comment may still enter, by density.
export const WAIT_SECONDS = Object.freeze({ low: 1, normal: 1, high: 2 });
// A burst fills every lane over about this long.
export const ENTRY_SECONDS = 1;
// Two comments never enter closer than this: one frame at 30 frames a second.
export const FRAME_SECONDS = 1 / 30;
const WAIT_STEP_SECONDS = 1 / 15;
const FONT_SCALE = Object.freeze({ small: 0.82, normal: 1, large: 1.2 });
// The bottom of the picture that subtitles use: kept free while they show.
const SUBTITLE_BAND = 0.2;
// A jump forward of more than this between two updates is a seek, and so is
// a step back of more than BACK_SECONDS (a clock that re-anchors steps back
// a little, which is no seek).
const SEEK_SECONDS = 1;
const BACK_SECONDS = 0.25;
// A layout again at the same moment replays this much before it, at most,
// so lanes look as they did.
const REPLAY_SECONDS = 16;
// Pixels of overlap below this are rounding, not overlap.
const EPSILON = 1e-6;

// A normal comment's text size in CSS pixels: Bilibili's web player draws
// 25 px in a small window and full screen alike, in lanes 30 px apart.
export const DANMAKU_FONT_PX = 25;

/** The text size in CSS pixels of a normal comment at the text size setting's `scale`. */
export function danmakuFontPx(scale = 1) {
  return Math.max(12, DANMAKU_FONT_PX * scale);
}

// Bilibili's crossing times by the picture's width: 4.5 s below 558 px,
// then [from, seconds] up to the next width, and past the last, one more
// second every 500 px. (Bilibili adds under 0.12 s for longer comments.)
const CROSSING = [[558, 7.1], [888, 8.1], [1082, 9.1], [1246, 10.1], [1452, 11.1], [1744, 13.1], [2314, 14.1], [2560, 16.1]];

/** Seconds a scrolling comment takes to cross a picture `width` CSS pixels wide. */
export function scrollSeconds(width) {
  const w = Number(width) || 0;
  if (w < CROSSING[0][0]) return 4.5;
  const next = CROSSING.findIndex(([from], index) => index > 0 && w <= from);
  if (next > 0) return CROSSING[next - 1][1];
  const [last, seconds] = CROSSING.at(-1);
  return seconds + Math.floor((w - last) / 500);
}

/**
 * Where comments go over a picture `width` x `height` CSS pixels drawn at
 * `ratio` device pixels per CSS pixel: the text size, a lane's height in
 * whole device pixels, and the area, the top `fraction` of the picture
 * (less the subtitles' band while they show).
 */
export function danmakuGeometry({ width, height, ratio = 1, metrics, settings, subtitles = false }) {
  const fontPx = danmakuFontPx(FONT_SCALE[settings.fontSize] ?? 1);
  const laneDevice = Math.ceil(lanePx(metrics, fontPx) * ratio);
  const fraction = Math.min(AREA_FRACTION[settings.area] ?? 1, subtitles ? 1 - SUBTITLE_BAND : 1);
  return {
    fontPx,
    laneDevice,
    laneHeight: laneDevice / ratio,
    fraction,
    areaHeight: Math.max(1, Math.floor(height * fraction)),
  };
}

/** Lanes a comment of this size takes: its line is `size` lines tall. */
export const spanOf = (comment) => Math.min(2, Math.max(1, Math.ceil((Number(comment.size) || 1) - 0.001)));

function hashOf(comment, seed) {
  let hash = (Math.round(comment.t * 1000) ^ seed) | 0;
  for (let index = 0; index < comment.text.length; index += 1) hash = (Math.imul(hash, 31) + comment.text.charCodeAt(index)) | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

// About a third, the same third every time.
const keptAtLowDensity = (comment) => hashOf(comment, 0) % 3 === 0;

// From 0.5 to 1.5, the same for a comment every time.
const variation = (comment) => 0.5 + (hashOf(comment, 0x5bd1e995) % 1024) / 1024;

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
    // Where this run of the layout began (a load or a seek): no comment from
    // before it shows. Null until the first update.
    this.origin = null;
    this.stale = true;
    this.next = 0;
    this.lanes = [];
    this.lastStart = -Infinity;
    this.lastLanes = null;
    this.crossing = 8;
  }

  /** Comments in time order. Those after the last moment laid out join the layout as it goes. */
  setComments(comments) {
    this.comments = comments;
    this.next = this.lastTime == null ? 0 : firstAtOrAfter(comments, this.lastTime + 1e-9);
  }

  /** `width` and `height` of the area comments use, and the height of one lane. */
  setGeometry(geometry) {
    this.geometry = geometry;
    this.crossing = scrollSeconds(geometry.width);
    this.stale = true;
  }

  setDensity(density) {
    this.density = density;
    this.stale = true;
  }

  /** Lay out the same moment again at the next update. */
  reset() {
    this.stale = true;
  }

  /**
   * A new item, from `time` (else from the next update's time): no comment
   * from before it shows, nor, when the first update comes more than a
   * second later, from before that update, as after a seek.
   */
  restart(time = null) {
    this.origin = Number.isFinite(time) ? time : null;
    this.lastTime = this.origin;
    this.stale = true;
  }

  get laneCount() {
    const { height = 0, laneHeight = 0 } = this.geometry || {};
    return laneHeight > 0 ? Math.max(0, Math.floor(height / laneHeight + 1e-9)) : 0;
  }

  get gap() {
    return Math.max(12, (this.geometry?.laneHeight || 0) / 2);
  }

  /** The comments placed by `time`, oldest first; one that waits to enter starts after it. */
  update(time) {
    if (!this.geometry) return (this.active = []);
    const seek = this.lastTime != null && (time < this.lastTime - BACK_SECONDS || time > this.lastTime + SEEK_SECONDS);
    let rebuilt = false;
    if (seek || this.origin == null) {
      this.origin = time;
      this.rebuild(time);
      rebuilt = true;
    } else if (this.stale || this.lastTime == null) {
      this.rebuild(Math.max(this.origin, time - REPLAY_SECONDS));
      rebuilt = true;
    }
    while (this.next < this.comments.length && this.comments[this.next].t <= time) this.place(this.comments[this.next++]);
    this.prune(time);
    this.lastTime = rebuilt ? time : Math.max(time, this.lastTime);
    return this.active;
  }

  rebuild(from) {
    this.stale = false;
    this.active = [];
    this.lanes = Array.from({ length: this.laneCount }, () => []);
    this.lastStart = -Infinity;
    this.lastLanes = null;
    this.next = firstAtOrAfter(this.comments, from);
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

  // Whether lanes from `lane` for `span` touch, or are, those of the comment
  // that entered last, if it entered less than ENTRY_SECONDS before `start`.
  nextToLast(lane, span, start) {
    if (!this.lastLanes || start - this.lastStart >= ENTRY_SECONDS) return false;
    const [from, to] = this.lastLanes;
    return lane <= to + 1 && lane + span - 1 >= from - 1;
  }

  shows(comment) {
    if (this.density === "low" && !keptAtLowDensity(comment)) return false;
    return this.density === "high" || !(comment.weight < LOW_WEIGHT);
  }

  place(comment) {
    if (!this.shows(comment)) return;
    this.prune(comment.t);
    if (this.active.length >= MAX_ACTIVE) return;
    const count = this.laneCount;
    const mode = comment.mode === "top" || comment.mode === "bottom" ? comment.mode : "scroll";
    const span = Math.min(spanOf(comment), count);
    if (!span) return;
    const width = this.measure(comment);
    const duration = mode === "scroll" ? this.crossing : FIXED_SECONDS;
    const item = {
      comment, mode, t: comment.t, end: comment.t + duration, width, span, lane: -1, duration,
      speed: mode === "scroll" ? (this.geometry.width + width) / duration : 0,
    };
    // Lanes keep the comments that are still on screen when this one starts.
    for (const lane of this.lanes) {
      if (lane.length && lane[0].end <= comment.t) {
        const kept = lane.filter((other) => other.end > comment.t);
        lane.length = 0;
        lane.push(...kept);
      }
    }
    // One at a time: a lane's share of ENTRY_SECONDS after the last to enter.
    const spacing = Math.max(FRAME_SECONDS, (ENTRY_SECONDS / count) * variation(comment));
    const latest = comment.t + (WAIT_SECONDS[this.density] ?? WAIT_SECONDS.normal) + 1e-9;
    for (let start = Math.max(comment.t, this.lastStart + spacing); start <= latest; start += WAIT_STEP_SECONDS) {
      item.t = start;
      item.end = start + duration;
      // The first lane that fits, from the top (the bottom for a bottom
      // comment), but not next to the comment that entered just before
      // while a lane elsewhere fits: a burst into empty lanes then
      // interleaves instead of stacking into a staircase.
      let chosen = -1;
      for (let step = 0; step + span <= count; step += 1) {
        const lane = mode === "bottom" ? count - span - step : step;
        if (!this.fits(item, lane)) continue;
        if (!this.nextToLast(lane, span, start)) {
          chosen = lane;
          break;
        }
        if (chosen < 0) chosen = lane;
      }
      if (chosen < 0) continue;
      item.lane = chosen;
      for (let index = chosen; index < chosen + span; index += 1) this.lanes[index].push(item);
      this.active.push(item);
      this.lastStart = start;
      this.lastLanes = [chosen, chosen + span - 1];
      return;
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
