import assert from "node:assert/strict";
import test from "node:test";
import { AudioRingBuffer } from "../../src/engine/audio-ring-buffer.js";
import { placeAudioBuffer, silentAudioBuffer } from "../../src/engine/audio-timeline.js";

const RATE = 48_000;
const FRAME = 1024 / RATE; // one AAC frame
const buffer = (timestamp, frames = 1024) => ({ timestamp, frames, sampleRate: RATE });

test("gapless audio is written as it is, buffer after buffer", () => {
  let end = 10;
  for (let index = 0; index < 100; index += 1) {
    const placed = placeAudioBuffer(buffer(10 + index * FRAME), end, { first: index === 0 });
    assert.deepEqual([placed.silenceFrames, placed.startFrame, placed.skip, placed.discontinuity], [0, 0, false, null]);
    end = placed.outputEnd;
  }
  assert.ok(Math.abs(end - (10 + 100 * FRAME)) < 1e-9);
});

test("a gap in the timestamps becomes silence, so the sound stays with the picture", () => {
  const placed = placeAudioBuffer(buffer(10.5), 10);
  assert.equal(placed.silenceFrames, 24_000);
  assert.equal(placed.discontinuity, "gap");
  assert.ok(Math.abs(placed.outputEnd - (10.5 + FRAME)) < 1e-9);
  // Small timestamp jitter is not a gap.
  assert.equal(placeAudioBuffer(buffer(10.01), 10).silenceFrames, 0);
});

test("an overlap is trimmed, and a buffer that lies wholly behind the output is skipped", () => {
  const overlap = placeAudioBuffer(buffer(10 - 0.03, 4096), 10);
  assert.equal(overlap.startFrame, Math.round(0.03 * RATE));
  assert.equal(overlap.discontinuity, "overlap");
  const behind = placeAudioBuffer(buffer(9), 10);
  assert.deepEqual([behind.skip, behind.outputEnd], [true, 10]);
});

test("the first buffer after a seek starts exactly at the seek, also when the audio starts later", () => {
  const before = placeAudioBuffer(buffer(30 - 0.01), 30, { first: true });
  assert.deepEqual([before.startFrame, before.discontinuity], [Math.round(0.01 * RATE), null]);
  const later = placeAudioBuffer(buffer(30.2), 30, { first: true });
  assert.deepEqual([later.silenceFrames, later.discontinuity], [Math.round(0.2 * RATE), "gap"]);
});

test("a jump of more than ten seconds re-anchors instead of playing silence", () => {
  const placed = placeAudioBuffer(buffer(500), 10);
  assert.deepEqual([placed.silenceFrames, placed.discontinuity], [0, "jump"]);
  assert.ok(Math.abs(placed.outputEnd - (500 + FRAME)) < 1e-9);
});

test("silence goes through the ring buffer like decoded audio", async () => {
  const ring = new AudioRingBuffer({ channels: 2, capacityFrames: 4096 });
  assert.equal(await ring.writeAudioBuffer(silentAudioBuffer(1000, RATE)), true);
  assert.equal(ring.availableFrames, 1000);
});
