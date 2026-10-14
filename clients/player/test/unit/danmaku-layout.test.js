import assert from "node:assert/strict";
import test from "node:test";

import { DanmakuLayout, FIXED_SECONDS, MAX_ACTIVE, SCROLL_SECONDS } from "../../src/danmaku-layout.js";

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
  // Dense lets it overlap the lane that has been busy longest.
  assert.equal(layout(comments, { density: "high" }).update(0).length, 5);
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

test("top and bottom comments stay FIXED_SECONDS, centred, stacking from their edge", () => {
  const value = layout([
    { t: 0, text: "top one", mode: "top" },
    { t: 1, text: "top two", mode: "top" },
    { t: 1, text: "bottom", mode: "bottom" },
    { t: FIXED_SECONDS + 0.5, text: "top three", mode: "top" },
  ]);
  const early = value.update(1);
  assert.deepEqual(early.map((item) => [item.comment.text, item.lane]), [["top one", 0], ["top two", 1], ["bottom", 0]]);
  assert.deepEqual(value.position(early[0], 1), { x: (800 - 70) / 2, y: 0 });
  assert.deepEqual(value.position(early[2], 1), { x: (800 - 60) / 2, y: 75 });
  // The first top comment has gone: its lane is free again.
  assert.deepEqual(value.update(FIXED_SECONDS + 0.5).map((item) => [item.comment.text, item.lane]), [["top two", 1], ["bottom", 0], ["top three", 0]]);
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
  assert.equal(layout(many, { density: "high" }).update(7.99).length, MAX_ACTIVE);
});

test("a large comment takes two lanes", () => {
  const value = layout([scroll(0, 200, { size: 1.44 }), scroll(0)]);
  assert.deepEqual(value.update(0).map((item) => [item.lane, item.span]), [[0, 2], [2, 1]]);
});
