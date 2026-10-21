import assert from "node:assert/strict";
import test from "node:test";
import { AudioRingBuffer } from "../../src/engine/audio-ring-buffer.js";
import { PresentationClock } from "../../src/engine/presentation-clock.js";

// The canvas engine's audio output as the browser runs it: the worklet's
// process() on the ring the main thread fills, whose played media frames
// are the player's clock (Agent Note 2026-04-04-canvas-playback-engine).
const RATE = 48_000;
const QUANTUM = 128;
let Processor = null;
globalThis.sampleRate = RATE;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage: () => {} };
  }
};
globalThis.registerProcessor = (_name, processor) => {
  Processor = processor;
};
await import("../../src/engine/audio-worklet-processor.js");

const TONE = 440;
const tone = (frame) => Math.sin((2 * Math.PI * TONE * frame) / RATE);
// The largest step between two samples of the tone itself.
const TONE_STEP = (2 * Math.PI * TONE) / RATE;

function audioOutput({ channels = 2 } = {}) {
  const ring = new AudioRingBuffer({ capacityFrames: RATE * 3, channels });
  const worklet = new Processor({ processorOptions: ring.processorOptions });
  let written = 0;
  let feeding = true;
  const write = (frames) => {
    const data = Float32Array.from({ length: frames }, (_, index) => tone(written + index));
    ring.writeChannels({ numberOfChannels: 1, getChannelData: () => data }, 0, frames);
    written += frames;
  };
  // Plays `seconds`, the main thread keeping the ring full; each quantum's
  // first sample with the clock before it.
  const play = (seconds) => {
    const samples = [];
    const clocks = [];
    for (let quantum = 0; quantum < Math.round((seconds * RATE) / QUANTUM); quantum++) {
      while (feeding && ring.capacityFrames - ring.availableFrames >= 4_800) write(4_800);
      const outputs = [Array.from({ length: channels }, () => new Float32Array(QUANTUM))];
      clocks.push(ring.consumedFrames);
      worklet.process([], outputs);
      samples.push(...outputs[0][0]);
    }
    return { samples, clocks };
  };
  // A seek: the ring starts a new timeline, the tone from its start.
  const reset = () => {
    ring.reset();
    written = 0;
    ring.setRunning(true);
  };
  ring.setRunning(true);
  return { ring, play, reset, starve: () => { feeding = false; } };
}

// The tone's frequency in what played, by its rising zero crossings.
function frequency(samples) {
  let crossings = 0;
  for (let index = 1; index < samples.length; index++) if (samples[index - 1] < 0 && samples[index] >= 0) crossings++;
  return crossings / (samples.length / RATE);
}

function largestStep(samples) {
  let step = 0;
  for (let index = 1; index < samples.length; index++) step = Math.max(step, Math.abs(samples[index] - samples[index - 1]));
  return step;
}

test("at normal speed the output is the ring as it is, and the clock counts it", () => {
  const { ring, play } = audioOutput();
  const { samples } = play(0.5);
  assert.equal(ring.consumedFrames, samples.length);
  samples.forEach((sample, frame) => assert.ok(Math.abs(sample - tone(frame)) < 1e-6, `frame ${frame}`));
});

test("at another speed the sound keeps its pitch, without a seam, and the clock counts the media played", () => {
  for (const speed of [0.25, 0.5, 1.5, 2]) {
    const { ring, play } = audioOutput();
    ring.setPlaybackRate(speed);
    const { samples } = play(1);
    assert.ok(Math.abs(frequency(samples) - TONE) <= 2, `${speed}×: ${frequency(samples)} Hz`);
    assert.ok(largestStep(samples) <= TONE_STEP * 1.05, `${speed}×: a seam`);
    assert.ok(Math.abs(ring.consumedFrames - samples.length * speed) <= 1, `${speed}×: clock ${ring.consumedFrames}`);
  }
});

test("a speed change goes on without a seam, and back at normal speed the ring plays as it is from where the clock says", () => {
  const { ring, play } = audioOutput();
  const first = play(0.25);
  ring.setPlaybackRate(2);
  const faster = play(0.5);
  ring.setPlaybackRate(1);
  const normal = play(0.5);
  assert.ok(largestStep([...first.samples, ...faster.samples, ...normal.samples]) <= TONE_STEP * 1.05, "a seam");
  assert.ok(normal.clocks[0] > first.clocks.at(-1) + RATE * 0.9, "the clock ran at twice the speed");
  // The last 0.25 s: each quantum is the tone from the clock before it.
  for (let quantum = normal.clocks.length / 2; quantum < normal.clocks.length; quantum++) {
    const clock = normal.clocks[quantum];
    for (let index = 0; index < QUANTUM; index++) {
      assert.ok(Math.abs(normal.samples[quantum * QUANTUM + index] - tone(clock + index)) < 1e-4, `quantum ${quantum}`);
    }
  }
});

test("at speed, a ring that runs dry asks for buffering and holds the clock, and its end plays out", () => {
  const { ring, play, starve } = audioOutput();
  ring.setPlaybackRate(1.5);
  play(0.25);
  starve();
  play(2.5);
  assert.deepEqual([ring.needsBuffering, ring.underrunCount], [true, 1]);
  const held = ring.consumedFrames;
  play(0.1);
  assert.equal(ring.consumedFrames, held, "no clock while dry");

  ring.markEnded();
  ring.setRunning(true);
  play(0.1);
  assert.equal(ring.availableFrames, 0, "the end played out");
});

test("a reset while stretching starts the next timeline from its start", () => {
  const { ring, play, reset } = audioOutput();
  ring.setPlaybackRate(2);
  play(0.25);
  reset();
  ring.setPlaybackRate(1);
  const { samples } = play(0.2);
  assert.equal(ring.consumedFrames, samples.length);
  samples.forEach((sample, frame) => assert.ok(Math.abs(sample - tone(frame)) < 1e-6, `frame ${frame}`));
});

test("without sound the clock runs on the wall clock at the speed", (t) => {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  const clock = new PresentationClock();
  clock.reset(10);
  clock.setRate(2);
  clock.start();
  now += 1_000;
  assert.equal(clock.currentTime, 12);
  clock.setRate(0.5);
  now += 1_000;
  assert.equal(clock.currentTime, 12.5);
  clock.stop();
  now += 1_000;
  assert.equal(clock.currentTime, 12.5);
});
