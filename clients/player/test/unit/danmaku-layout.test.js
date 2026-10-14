import assert from "node:assert/strict";
import test from "node:test";

import { DanmakuLayout, FIXED_SECONDS, MAX_ACTIVE, QUEUE_SECONDS, SCROLL_SECONDS } from "../../src/danmaku-layout.js";

// A picture 800 px wide with four lanes of 25 px; every comment's width is
// its text's length times 10 px, as a measured font would give.
const GEOMETRY = { width: 800, height: 100, laneHeight: 25 };
const measure = (comment) => comment.text.length * 10;
const scroll = (t, width = 200, extra = {}) => ({ t, text: "x".repeat(width / 10), mode: "scroll", color: "#ffffff", size: 1, ...extra });

function layout(comments, { density = "normal", geometry = GEOMETRY } = {}) {
  const value = new DanmakuLayout({ measure });
  value.setGeometry(geometry);
  value.setDensity(density);
  value.setComments(comments);
  return value;
}

const lanes = (active) => active.map((item) => item.lane);

test("scrolling comments take the highest lane whose last comment is clear, and fill no more than the lanes", () => {
  const comments = [scroll(0), scroll(0), scroll(0), scroll(0), scroll(0)];
  assert.deepEqual(lanes(layout(comments).update(0)), [0, 1, 2, 3], "a fifth comment that fits nowhere is dropped");
  // High density queues it until a lane is clear instead.
  const queued = layout(comments, { density: "high" }).update(0);
  assert.equal(queued.length, 5);
  assert.ok(queued[4].t > 0);
});

test("a comment waits for the lane's last comment to clear its start, and never catches up with it", () => {
  // 200 px at (800 + 200) / 8 = 125 px/s: one second later its tail is only 125 px in.
  const tail = layout([scroll(0), scroll(1), scroll(2)]);
  assert.deepEqual(lanes(tail.update(2)), [0, 1, 0]);
  // A short, slow comment, then a long, fast one 3 s later: the fast one
  // would reach the slow one before it leaves, so it takes the next lane.
  const fast = layout([scroll(0, 100), scroll(3, 600)]);
  assert.deepEqual(lanes(fast.update(3)), [0, 1]);
});

test("positions follow media time: across the picture in SCROLL_SECONDS, frozen while paused", () => {
  const value = layout([scroll(10)]);
  const [item] = value.update(10);
  assert.deepEqual(value.position(item, 10), { x: 800, y: 0 });
  assert.deepEqual(value.position(item, 10 + SCROLL_SECONDS / 2), { x: 300, y: 0 });
  // Paused: the same time gives the same picture, and nothing new appears.
  const paused = value.update(14);
  assert.deepEqual(paused.map((entry) => value.position(entry, 14)), [{ x: 300, y: 0 }]);
  assert.deepEqual(value.update(14), paused);
  // Twice the playback rate is twice the media time per second: the comment
  // simply leaves sooner, at the same media time.
  assert.equal(value.update(10 + SCROLL_SECONDS).length, 0);
});

test("top and bottom comments stay FIXED_SECONDS, centred, stacking from their edge of the shared lanes", () => {
  const value = layout([
    { t: 0, text: "top one", mode: "top" },
    { t: 1, text: "top two", mode: "top" },
    { t: 1, text: "bottom", mode: "bottom" },
    { t: FIXED_SECONDS + 0.5, text: "top three", mode: "top" },
  ]);
  const early = value.update(1);
  assert.deepEqual(early.map((item) => [item.comment.text, item.lane]), [["top one", 0], ["top two", 1], ["bottom", 3]]);
  assert.deepEqual(value.position(early[0], 1), { x: (800 - 70) / 2, y: 0 });
  assert.deepEqual(value.position(early[2], 1), { x: (800 - 60) / 2, y: 75 });
  // The first top comment has gone: its lane is free again.
  assert.deepEqual(value.update(FIXED_SECONDS + 0.5).map((item) => [item.comment.text, item.lane]), [["top two", 1], ["bottom", 3], ["top three", 0]]);
});

test("a seek lays out again from the new time, forward and back", () => {
  const comments = Array.from({ length: 60 }, (_, index) => scroll(index, 100));
  const value = layout(comments);
  value.update(5);
  // Forward: only comments still on screen at 40 s, none from before the seek.
  const forward = value.update(40);
  assert.deepEqual(forward.map((item) => item.comment.t), [33, 34, 35, 36, 37, 38, 39, 40]);
  assert.ok(forward.every((item) => value.position(item, 40).x <= 800));
  // Back to 2 s: comments from 0 to 2.
  assert.deepEqual(value.update(2).map((item) => item.comment.t), [0, 1, 2]);
  // Playing on adds each comment at its own time.
  assert.deepEqual(value.update(3.5).map((item) => item.comment.t), [0, 1, 2, 3]);
});

test("new comments, a new size, or a new density lay out again at the same time", () => {
  const value = layout([scroll(0)]);
  assert.equal(value.update(1).length, 1);
  value.setComments([scroll(0), scroll(0.5)]);
  assert.equal(value.update(1).length, 2);
  value.setGeometry({ width: 400, height: 25, laneHeight: 25 });
  const narrow = value.update(1);
  assert.deepEqual(lanes(narrow), [0], "one lane: the second comment does not fit");
  assert.equal(value.position(narrow[0], 1).x, 400 - (600 / SCROLL_SECONDS));
});

test("low density keeps about a third, the same ones every time; no density exceeds MAX_ACTIVE", () => {
  const tall = { width: 800, height: 10_000, laneHeight: 25 };
  const many = Array.from({ length: 400 }, (_, index) => scroll(index / 50, 10, { text: `comment ${index}` }));
  const all = layout(many, { geometry: tall }).update(7.99).length;
  const shown = layout(many, { density: "low", geometry: tall }).update(7.99).length;
  assert.equal(all, MAX_ACTIVE, "400 on screen at once is more than the bound");
  assert.ok(shown > 100 && shown < 170, `${shown} of 400`);
  assert.equal(layout(many, { density: "low", geometry: tall }).update(7.99).length, shown);
  assert.equal(layout(many, { density: "high", geometry: tall }).update(7.99).length, MAX_ACTIVE);
});

test("a large comment takes two lanes", () => {
  const value = layout([scroll(0, 200, { size: 1.44 }), scroll(0)]);
  assert.deepEqual(value.update(0).map((item) => [item.lane, item.span]), [[0, 2], [2, 1]]);
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
        if (waited < -1e-9 || waited > (density === "high" ? QUEUE_SECONDS : 0) + 1e-9) found.push(`${describe(item)} waited ${waited} s`);
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

test("at high density a comment waits briefly for a lane instead of overlapping; at normal it is dropped", () => {
  // Four lanes of 200 px comments at 125 px/s: a lane is clear for the next
  // one after (200 + 12.5) / 125 = 1.7 s.
  const comments = [scroll(0), scroll(0), scroll(0), scroll(0), scroll(0.5)];
  const normal = layout(comments);
  assert.equal(normal.update(3).length, 4);
  const high = layout(comments, { density: "high" });
  const active = high.update(3);
  assert.equal(active.length, 5);
  const waited = active.find((item) => item.comment === comments[4]);
  assert.ok(waited.t >= 1.7 && waited.t <= 0.5 + QUEUE_SECONDS, `starts at ${waited.t}`);
  assert.equal(waited.lane, 0);
});

test("top and bottom comments share the lanes with scrolling ones and never cover them", () => {
  // A scrolling comment crosses the centre of lane 0 between 3 and 5 s: a top
  // comment at 2 s takes the next lane, and a bottom one stacks up from the
  // last lane.
  const value = layout([scroll(0, 400), { t: 2, text: "centred", mode: "top" }, { t: 2, text: "low", mode: "bottom" }]);
  assert.deepEqual(value.update(2).map((item) => [item.mode, item.lane]), [["scroll", 0], ["top", 1], ["bottom", 3]]);
});
