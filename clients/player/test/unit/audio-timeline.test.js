import assert from "node:assert/strict";
import test from "node:test";
import { placeAudioBuffer } from "../../src/engine/audio-timeline.js";

// The canvas engine writes audio buffers back to back by their timestamps,
// so the sound stays with the picture (mediabunny-player.js produceAudio).
const RATE = 48_000;
const FRAME = 1024 / RATE;
const buffer = (timestamp, frames = 1024) => ({ timestamp, frames, sampleRate: RATE });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("gapless audio is written as is; a gap becomes silence, an overlap is trimmed, a buffer behind is skipped, a jump re-anchors", () => {
  let end = 10;
  for (let index = 0; index < 100; index += 1) {
    const placed = placeAudioBuffer(buffer(10 + index * FRAME), end, { first: index === 0 });
    assert.deepEqual([placed.silenceFrames, placed.startFrame, placed.skip, placed.discontinuity], [0, 0, false, null]);
    end = placed.outputEnd;
  }
  near(end, 10 + 100 * FRAME);

  const gap = placeAudioBuffer(buffer(10.5), 10);
  assert.deepEqual([gap.silenceFrames, gap.discontinuity], [24_000, "gap"]);
  near(gap.outputEnd, 10.5 + FRAME);
  assert.equal(placeAudioBuffer(buffer(10.01), 10).silenceFrames, 0, "jitter is not a gap");

  const overlap = placeAudioBuffer(buffer(10 - 0.03, 4096), 10);
  assert.deepEqual([overlap.startFrame, overlap.discontinuity], [Math.round(0.03 * RATE), "overlap"]);
  const behind = placeAudioBuffer(buffer(9), 10);
  assert.deepEqual([behind.skip, behind.outputEnd], [true, 10]);

  const jump = placeAudioBuffer(buffer(500), 10);
  assert.deepEqual([jump.silenceFrames, jump.discontinuity], [0, "jump"]);
});

test("the first buffer after a seek starts exactly at the seek", () => {
  const before = placeAudioBuffer(buffer(30 - 0.01), 30, { first: true });
  assert.deepEqual([before.startFrame, before.discontinuity], [Math.round(0.01 * RATE), null]);
  const later = placeAudioBuffer(buffer(30.2), 30, { first: true });
  assert.deepEqual([later.silenceFrames, later.discontinuity], [Math.round(0.2 * RATE), "gap"]);
});
