import assert from "node:assert/strict";
import test from "node:test";

import { DANMAKU_DEFAULTS } from "@useyolo/core";
import {
  AREA_FRACTION, DanmakuLayout, danmakuFontPx, danmakuGeometry, FIXED_SECONDS, FRAME_SECONDS, MAX_ACTIVE, scrollSeconds, WAIT_SECONDS,
} from "../../src/danmaku-layout.js";
import { DEFAULT_METRICS } from "../../src/danmaku-paint.js";

// A picture 800 px wide with four lanes of 25 px; every comment's width is
// its text's length times 10 px, as a measured font would give.
const GEOMETRY = { width: 800, height: 100, laneHeight: 25 };
// Bilibili's crossing time at 800 px: 7.1 s, so a 200 px comment moves
// (800 + 200) / 7.1 = 140.8 px/s and clears its start, plus the 12.5 px gap,
// after 1.51 s.
const CROSS = scrollSeconds(800);
const measure = (comment) => comment.text.length * 10;
const scroll = (t, width = 200, extra = {}) => ({ t, text: "x".repeat(width / 10), mode: "scroll", color: "#ffffff", size: 1, ...extra });

// A layout of an item that starts at 0 s.
function layout(comments, { density = "normal", geometry = GEOMETRY } = {}) {
  const value = new DanmakuLayout({ measure });
  value.setGeometry(geometry);
  value.setDensity(density);
  value.setComments(comments);
  value.restart(0);
  return value;
}

// Plays on from the last update to `to`, a frame at a time, as a screen does.
function play(value, to) {
  let active = [];
  for (let time = value.lastTime ?? 0; time < to; time += FRAME_SECONDS) active = value.update(time);
  return value.update(to) ?? active;
}

const lanes = (active) => active.map((item) => item.lane);

test("text size and pace follow Bilibili's web player: size from the picture's height, crossing time from its width", () => {
  assert.equal(danmakuFontPx(300), 16);
  assert.ok(Math.abs(danmakuFontPx(532) - 21.81) < 0.01, "the car's picture, 532 CSS px");
  assert.equal(danmakuFontPx(760), 27);
  assert.ok(Math.abs(danmakuFontPx(810) - 27) < 0.01, "a 1440 x 900 window's picture");
  assert.ok(Math.abs(danmakuFontPx(1080) - 42.26) < 0.01);
  assert.equal(danmakuFontPx(1440), 40);
  assert.ok(Math.abs(danmakuFontPx(532, 0.82) - 17.88) < 0.01, "small");
  assert.deepEqual([500, 558, 946, 1440, 1920, 3600].map(scrollSeconds), [4.5, 7.1, 8.1, 10.1, 13.1, 18.1]);
});

test("by default comments keep to the top quarter of the picture, about five lanes, at the car's size and a computer's", () => {
  assert.equal(AREA_FRACTION[DANMAKU_DEFAULTS.area], 0.25);
  for (const [name, picture, expected] of [["car", { width: 946, height: 532, ratio: 1.25 }, 5], ["desktop", { width: 1440, height: 810, ratio: 2 }, 6]]) {
    const area = danmakuGeometry({ ...picture, metrics: DEFAULT_METRICS, settings: DANMAKU_DEFAULTS });
    const value = layout(denseFixture(), { geometry: { width: picture.width, height: area.areaHeight, laneHeight: area.laneHeight } });
    value.measure = (comment) => Math.ceil([...comment.text].length * area.fontPx * (comment.size || 1) + 2);
    assert.equal(value.laneCount, expected, name);
    let lowest = 0;
    for (let time = 0; time <= 40; time += FRAME_SECONDS) {
      for (const item of value.update(time)) lowest = Math.max(lowest, value.y(item) + item.span * area.laneHeight);
    }
    assert.ok(lowest > area.laneHeight && lowest <= picture.height * 0.25 + 1e-6, `${name}: comments reach ${lowest} of ${picture.height} px`);
  }
  // Subtitles take the bottom fifth: a full area stops above them.
  const full = danmakuGeometry({ width: 946, height: 532, metrics: DEFAULT_METRICS, settings: { ...DANMAKU_DEFAULTS, area: "full" }, subtitles: true });
  assert.equal(full.areaHeight, Math.floor(532 * 0.8));
});

test("scrolling comments take the highest lane that is clear, and fill no more than the lanes", () => {
  const comments = [scroll(0), scroll(0), scroll(0), scroll(0), scroll(0)];
  assert.deepEqual(lanes(layout(comments).update(0)).sort(), [0, 1, 2, 3], "a fifth comment that fits nowhere in time is dropped");
  // High density waits longer for a lane to clear.
  const queued = layout(comments, { density: "high" }).update(0);
  assert.equal(queued.length, 5);
  assert.ok(queued[4].t > 1.5);
});

test("a comment waits for the lane's last comment to clear its start, and never catches up with it", () => {
  const tail = layout([scroll(0), scroll(1), scroll(2)]);
  assert.deepEqual(lanes(play(tail, 2)), [0, 1, 0]);
  // A short, slow comment, then a long, fast one 2.5 s later: the fast one
  // would reach the slow one before it leaves, so it takes the next lane.
  const fast = layout([scroll(0, 100), scroll(2.5, 600)]);
  assert.deepEqual(lanes(play(fast, 2.5)), [0, 1]);
});

test("positions follow media time: across the picture in its crossing time, frozen while paused", () => {
  const value = layout([scroll(10)]);
  const [item] = play(value, 10);
  assert.deepEqual(value.position(item, 10), { x: 800, y: 0 });
  const half = 10 + CROSS / 2;
  assert.ok(Math.abs(value.x(item, half) - 300) < 1e-9);
  // Paused: the same time gives the same picture, and nothing new appears.
  const paused = play(value, half);
  assert.deepEqual(paused, [item]);
  assert.deepEqual(value.update(half), paused);
  // Twice the playback rate is twice the media time per second: the comment
  // simply leaves sooner, at the same media time.
  assert.equal(play(value, 10 + CROSS).length, 0);
});

test("top and bottom comments stay FIXED_SECONDS, centred, stacking from their edge of the shared lanes", () => {
  const value = layout([
    { t: 0, text: "top one", mode: "top" },
    { t: 1, text: "top two", mode: "top" },
    { t: 1, text: "bottom", mode: "bottom" },
    { t: FIXED_SECONDS + 0.5, text: "top three", mode: "top" },
  ]);
  const early = play(value, 1);
  assert.deepEqual(early.map((item) => [item.comment.text, item.lane]), [["top one", 0], ["top two", 1], ["bottom", 3]]);
  assert.deepEqual(value.position(early[0], 1), { x: (800 - 70) / 2, y: 0 });
  assert.deepEqual(value.position(early[2], 1), { x: (800 - 60) / 2, y: 75 });
  // The first top comment has gone: its lane is free again.
  assert.deepEqual(play(value, FIXED_SECONDS + 0.5).map((item) => [item.comment.text, item.lane]), [["top two", 1], ["bottom", 3], ["top three", 0]]);
});

test("a load or a seek starts from its moment: comments from before it never show", () => {
  const comments = Array.from({ length: 60 }, (_, index) => scroll(index, 100));
  const value = layout(comments);
  play(value, 5);
  // Forward: nothing from before 40 s; the comment of 40 s enters at the edge.
  const forward = value.update(40);
  assert.deepEqual(forward.map((item) => item.comment.t), [40]);
  assert.equal(value.position(forward[0], 40).x, 800);
  // Back to 2 s: the comment of 2 s, not those of 0 and 1.
  assert.deepEqual(value.update(2).map((item) => item.comment.t), [2]);
  // Playing on adds each comment at its own time.
  assert.deepEqual(play(value, 3.5).map((item) => item.comment.t), [2, 3]);
  // A new item from 20 s: its comments from 20 s on, and when its first
  // frame comes seconds later, only those from then on.
  value.restart(20);
  assert.deepEqual(value.update(20.5).map((item) => item.comment.t), [20]);
  assert.deepEqual(play(value, 21.5).map((item) => item.comment.t), [20, 21]);
  value.restart(20);
  assert.deepEqual(value.update(23.5).map((item) => item.comment.t), []);
  assert.deepEqual(play(value, 24.5).map((item) => item.comment.t), [24]);
  // New comments continue the layout, those already past left out; a new
  // size lays the same moment out again.
  value.setComments([...comments, scroll(24.2, 100), scroll(25.2, 100)].sort((a, b) => a.t - b.t));
  assert.deepEqual(play(value, 25.5).map((item) => item.comment.t), [24, 25, 25.2]);
  value.setGeometry({ ...GEOMETRY });
  assert.deepEqual(value.update(25.5).map((item) => item.comment.t), [24, 24.2, 25, 25.2]);
});

test("a new density lays the same moment out again", () => {
  const value = layout([scroll(0), scroll(0.5, 100), scroll(1)]);
  assert.equal(play(value, 1.2).length, 3);
  value.setDensity("low");
  const kept = value.update(1.2).length;
  assert.ok(kept < 3, `${kept} at low density`);
  value.setDensity("normal");
  assert.equal(value.update(1.2).length, 3);
});

test("comments their viewers rank below 3 hide at normal density, as Bilibili's smart blocking does by default, and show at high", () => {
  const comments = [scroll(0, 100, { weight: 10 }), scroll(1, 100, { weight: 2 }), scroll(2, 100, { weight: 3 }), scroll(3, 100)];
  assert.deepEqual(play(layout(comments), 3).map((item) => item.comment.t), [0, 2, 3]);
  assert.deepEqual(play(layout(comments, { density: "high" }), 3).map((item) => item.comment.t), [0, 1, 2, 3]);
});

test("low density keeps about a third, the same ones every time; no density exceeds MAX_ACTIVE", () => {
  const tall = { width: 800, height: 10_000, laneHeight: 25 };
  const many = Array.from({ length: 400 }, (_, index) => scroll(index / 50, 10, { text: `comment ${index}` }));
  const all = play(layout(many, { geometry: tall }), 7.99).length;
  const shown = play(layout(many, { density: "low", geometry: tall }), 7.99).length;
  assert.equal(all, MAX_ACTIVE, "more than the bound on screen at once");
  assert.ok(shown > 90 && shown < 160, `${shown} of 400`);
  assert.equal(play(layout(many, { density: "low", geometry: tall }), 7.99).length, shown);
  assert.equal(play(layout(many, { density: "high", geometry: tall }), 7.99).length, MAX_ACTIVE);
});

test("a large comment takes two lanes", () => {
  const value = layout([scroll(0, 200, { size: 1.44 }), scroll(0)]);
  assert.deepEqual(value.update(0).map((item) => [item.lane, item.span]), [[0, 2], [3, 1]]);
});

// --- No overlap, ever --------------------------------------------------------

// A dense, varied fixture: 12 comments a second for 2 minutes, of every
// mode, length, and size, and a burst of 60 in half a second at 30 s, from
// a fixed seed.
function denseFixture({ seconds = 120, perSecond = 12, seed = 7 } = {}) {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const comment = (t) => {
    const pick = random();
    const roll = random();
    return {
      t,
      text: "字".repeat(1 + Math.floor(random() * 34)),
      mode: pick < 0.7 ? "scroll" : pick < 0.9 ? "top" : "bottom",
      size: roll < 0.8 ? 1 : roll < 0.9 ? 0.72 : 1.44,
    };
  };
  const steady = Array.from({ length: seconds * perSecond }, (_, index) => comment(index / perSecond + random() / perSecond));
  const burst = Array.from({ length: 60 }, () => comment(30 + random() / 2));
  return [...steady, ...burst].sort((a, b) => a.t - b.t);
}

const box = (value, item) => ({ y: value.y(item), h: item.span * value.geometry.laneHeight });
const describe = (item) => `${item.mode} of ${item.comment.text.length} at ${item.t.toFixed(2)} s in lane ${item.lane}`;

// Every pair of comments on screen at `time`, as rectangles: none may intersect.
function overlaps(value, active, time) {
  const { width } = value.geometry;
  const boxes = active
    .filter((item) => item.t <= time)
    .map((item) => ({ item, x: value.x(item, time), w: item.width, ...box(value, item) }))
    .filter((entry) => entry.x < width && entry.x + entry.w > 0);
  const found = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [a, b] = [boxes[i], boxes[j]];
      if (a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01 && a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01) {
        found.push(`${time.toFixed(2)} s: ${describe(a.item)} and ${describe(b.item)}`);
      }
    }
  }
  return found;
}

// Every pair that one layout scheduled in the same band, over the whole time
// both are on screen, not only at sampled frames. Positions are linear in
// time, so a pair keeps the gap throughout exactly when one of them stays
// the gap or more to the right of the other at both ends of that time.
function crossings(value, items) {
  const list = [...items];
  const found = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const [a, b] = [list[i], list[j]];
      const [boxA, boxB] = [box(value, a), box(value, b)];
      if (boxA.y >= boxB.y + boxB.h - 0.01 || boxB.y >= boxA.y + boxA.h - 0.01) continue;
      const from = Math.max(a.t, b.t);
      const to = Math.min(a.t + a.duration, b.t + b.duration);
      if (to - from <= 1e-9) continue;
      const clear = (left, right) => [from, to].every((time) => value.x(right, time) - value.x(left, time) - left.width >= value.gap - 1e-6);
      if (!clear(a, b) && !clear(b, a)) found.push(`${describe(a)} and ${describe(b)}`);
    }
  }
  return found;
}

test("no two scheduled comments ever overlap in time and space, at any density, through a pause, seeks, and a resize", () => {
  const comments = denseFixture();
  const width = (comment) => comment.text.length * 20 * (comment.size || 1) + 6;
  for (const density of ["low", "normal", "high"]) {
    const value = layout(comments, { density, geometry: { width: 946, height: 532, laneHeight: 26 } });
    value.measure = width;
    const found = [];
    const shown = new Set();
    let scheduled = new Set();
    // One layout's schedule: everything placed between two seeks.
    const settle = () => {
      found.push(...crossings(value, scheduled));
      for (const item of scheduled) {
        const { y, h } = box(value, item);
        if (y < 0 || y + h > value.geometry.height + 1e-6) found.push(`${describe(item)} outside the area`);
        const waited = item.t - item.comment.t;
        if (waited < -1e-9 || waited > WAIT_SECONDS[density] + 1e-9) found.push(`${describe(item)} waited ${waited} s`);
      }
      scheduled = new Set();
    };
    const play = (from, to) => {
      settle();
      for (let time = from; time <= to; time += 1 / 30) {
        const active = value.update(time);
        for (const item of active) {
          scheduled.add(item);
          if (item.t <= time) shown.add(item.comment);
        }
        found.push(...overlaps(value, active, time));
      }
    };
    play(0, 40);
    // Paused: the same moment, many frames.
    for (let frame = 0; frame < 30; frame += 1) found.push(...overlaps(value, value.update(40), 40));
    play(85, 95); // a seek forward
    play(20, 30); // a seek back
    settle();
    value.setGeometry({ width: 700, height: 400, laneHeight: 30 }); // the window and the text size change
    play(30, 45);
    settle();
    assert.deepEqual(found.slice(0, 5), [], `${density}: ${found.length} overlaps`);
    // Not by showing nothing: a fair share of what was due still shows.
    const due = comments.filter((comment) => comment.t <= 45 || (comment.t >= 85 && comment.t <= 95)).length;
    const least = { low: 0.2, normal: 0.45, high: 0.5 }[density];
    assert.ok(shown.size >= due * least, `${density}: ${shown.size} of ${due} shown`);
  }
});

test("a comment waits for a lane up to its density's wait instead of overlapping, and is dropped after that", () => {
  // Four lanes of 200 px comments: a lane is clear for the next one after
  // 1.51 s, past the second normal density waits for a comment of 0.4 s.
  const comments = [scroll(0), scroll(0), scroll(0), scroll(0), scroll(0.4)];
  const normal = layout(comments);
  assert.equal(play(normal, 3).length, 4);
  const high = layout(comments, { density: "high" });
  const active = play(high, 3);
  assert.equal(active.length, 5);
  const waited = active.find((item) => item.comment === comments[4]);
  assert.ok(waited.t >= 1.5 && waited.t <= 0.4 + WAIT_SECONDS.high, `starts at ${waited.t}`);
  assert.equal(waited.lane, 0);
});

test("top and bottom comments share the lanes with scrolling ones and never cover them", () => {
  // A scrolling comment crosses the centre of lane 0 between 3 and 5 s: a top
  // comment at 2 s takes the next lane, and a bottom one stacks up from the
  // last lane.
  const value = layout([scroll(0, 400), { t: 2, text: "centred", mode: "top" }, { t: 2, text: "low", mode: "bottom" }]);
  assert.deepEqual(play(value, 2).map((item) => [item.mode, item.lane]), [["scroll", 0], ["top", 1], ["bottom", 3]]);
});

// --- Entering one at a time ------------------------------------------------

test("comments enter one at a time, never a column of them in one frame, even when many share a moment", () => {
  // A video's opening: a dozen comments at exactly 0 s and more within the
  // first second, then the dense fixture with its burst of 60 at 30 s.
  const opening = [
    ...Array.from({ length: 12 }, (_, index) => ({ t: 0, text: `前排${"字".repeat(index % 7)}`, mode: "scroll", size: 1 })),
    ...Array.from({ length: 8 }, (_, index) => ({ t: 0.5, text: `来了${index}`, mode: index % 4 ? "scroll" : "top", size: 1 })),
  ];
  const comments = [...opening, ...denseFixture().map((comment) => ({ ...comment, t: comment.t + 1 }))].sort((a, b) => a.t - b.t);
  const frame = 1 / 30;
  for (const geometry of [{ width: 946, height: 133, laneHeight: 26 }, { width: 946, height: 532, laneHeight: 26 }]) {
    for (const density of ["low", "normal", "high"]) {
      const value = layout(comments, { density, geometry });
      value.measure = (comment) => [...comment.text].length * 20 * (comment.size || 1) + 6;
      const starts = new Map();
      for (let time = 0; time <= 45; time += frame) for (const item of value.update(time)) starts.set(item.comment, item.t);
      const sorted = [...starts.values()].sort((a, b) => a - b);
      const bursts = [];
      for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index] - sorted[index - 1] < frame - 1e-9) bursts.push(`${sorted[index - 1].toFixed(3)} and ${sorted[index].toFixed(3)} s`);
      }
      assert.deepEqual(bursts.slice(0, 5), [], `${density} in ${geometry.height} px: ${bursts.length} pairs entered within one frame`);
      // The opening still shows: its first comment at once, and several within its first two seconds.
      assert.equal(sorted[0], 0, density);
      assert.ok(sorted.filter((start) => start < 2).length >= (density === "low" ? 2 : 4), `${density}: ${sorted.filter((start) => start < 2).length} in the first 2 s`);
    }
  }
});
