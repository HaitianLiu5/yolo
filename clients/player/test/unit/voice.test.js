import assert from "node:assert/strict";
import test from "node:test";

import { AUTO_SEND_MS, createEndpointer, createVoiceController, downsample, encodeWav, microphoneProblem } from "../../src/voice.js";

test("a recording leaves as the transcriber's 16 kHz mono 16-bit WAV", () => {
  const samples = downsample(Float32Array.from({ length: 4_800 }, (_, index) => (index % 2 ? 0.5 : -0.5)), 48_000);
  assert.equal(samples.length, 1_600);
  const wav = encodeWav(Float32Array.of(0, 1, -1, 2));
  const view = new DataView(wav.buffer);
  const text = (at) => String.fromCharCode(...wav.subarray(at, at + 4));
  assert.deepEqual([text(0), text(8), text(12), text(36)], ["RIFF", "WAVE", "fmt ", "data"]);
  assert.deepEqual([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)], [1, 1, 16_000, 16]);
  assert.equal(view.getUint32(40, true), 8);
  // Clipped to the 16-bit range.
  assert.deepEqual([1, 2, 3].map((index) => view.getInt16(44 + index * 2, true)), [32_767, -32_768, 32_767]);
});

test("recording stops after a pause that follows speech, when nobody speaks, and at 30 seconds", () => {
  const pause = createEndpointer();
  assert.equal(pause.push(0, 100), null);
  assert.equal(pause.push(0.2, 600), null);
  assert.equal(pause.push(0, 2_000), null);
  assert.equal(pause.push(0, 2_100), "silence");

  assert.equal(createEndpointer().push(0, 8_000), "no_speech");
  assert.equal(createEndpointer().push(0.3, 30_000), "limit");
});

test("the browser's refusals become what the owner can do about them", () => {
  assert.equal(microphoneProblem({ name: "NotAllowedError" }).code, "denied");
  assert.equal(microphoneProblem({ name: "NotFoundError" }).code, "no_microphone");
  assert.equal(microphoneProblem({ name: "TypeError" }).code, "failed");
});

// A recording that hears what `heard` says; `refuse` is the browser's error.
function setup({ heard = true, refuse = null, answer = { text: "播放老友记" } } = {}) {
  const phases = [];
  const sent = [];
  const events = [];
  const timers = [];
  const requests = [];
  const recordings = [];
  const controller = createVoiceController({
    record: (hooks) => {
      const recording = {
        hooks,
        heard,
        cancelled: false,
        async start() {
          if (refuse) throw refuse;
        },
        stop: () => ({ wav: new Uint8Array(44), seconds: 2 }),
        cancel() {
          this.cancelled = true;
        },
      };
      recordings.push(recording);
      return recording;
    },
    transcribe: (wav, signal) => {
      const request = { wav, signal };
      requests.push(request);
      return typeof answer === "function" ? answer(request) : Promise.resolve(answer);
    },
    onChange: (state) => phases.push(state.phase),
    onSend: (text) => sent.push(text),
    report: (type, fields) => events.push({ type, ...fields }),
    now: () => 0,
    setTimer: (callback, ms) => {
      timers.push({ callback, ms });
      return timers.length;
    },
    clearTimer: (id) => {
      timers[id - 1].cleared = true;
    },
  });
  return { controller, phases, sent, events, timers, requests, recordings };
}

test("tap, speak, tap: the words fill in and go two seconds later", async () => {
  const { controller, phases, sent, events, timers } = setup();
  await controller.toggle();
  assert.equal(controller.state.phase, "recording");
  await controller.toggle();
  assert.deepEqual(controller.state, { phase: "countdown", text: "播放老友记" });
  assert.equal(timers[0].ms, AUTO_SEND_MS);
  assert.deepEqual(sent, []);
  timers[0].callback();
  assert.deepEqual(sent, ["播放老友记"]);
  assert.deepEqual(phases, ["starting", "recording", "transcribing", "countdown", "idle"]);
  // The device event says how it went, never what was said.
  assert.deepEqual(events, [{ type: "voice_input", outcome: "transcribed", seconds: 2, stop: "tap", transcribeMs: 0, chars: 5 }]);
});

test("a pause stops the recording by itself", async () => {
  const { controller, recordings } = setup();
  await controller.toggle();
  recordings[0].hooks.onEnd("silence");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.phase, "countdown");
});

test("touching the field keeps the words to edit, and nothing is sent", async () => {
  const { controller, sent, timers } = setup();
  await controller.toggle();
  await controller.toggle();
  assert.equal(controller.hold(), true);
  assert.equal(timers[0].cleared, true);
  assert.equal(controller.state.phase, "idle");
  assert.deepEqual(sent, []);
  assert.equal(controller.hold(), false);
});

test("nothing heard is said at once, without asking the transcriber", async () => {
  const { controller, requests } = setup({ heard: false });
  await controller.toggle();
  await controller.toggle();
  assert.equal(controller.state.phase, "error");
  assert.match(controller.state.message, /heard nothing/);
  assert.equal(requests.length, 0);
});

test("a refused microphone says how to allow it", async () => {
  const { controller, events } = setup({ refuse: Object.assign(new Error("denied"), { name: "NotAllowedError" }) });
  await controller.toggle();
  assert.equal(controller.state.phase, "error");
  assert.match(controller.state.message, /Allow it/);
  assert.deepEqual(events, [{ type: "voice_input", outcome: "denied", error: "NotAllowedError" }]);
});

test("a tap while the words come back cancels the request, and its late answer is dropped", async () => {
  let respond;
  const { controller, requests, sent, timers } = setup({ answer: () => new Promise((resolve) => { respond = resolve; }) });
  await controller.toggle();
  const finishing = controller.toggle();
  assert.equal(controller.state.phase, "transcribing");
  await controller.toggle();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(controller.state.phase, "idle");
  respond({ text: "too late" });
  await finishing;
  assert.equal(controller.state.phase, "idle");
  assert.deepEqual([sent, timers], [[], []]);
});

test("a failed transcription shows Yolo's message, and a tap during the countdown records again", async () => {
  const failing = setup({ answer: () => Promise.reject(Object.assign(new Error("Upgrade the media node to ask by voice"), { code: "not_found" })) });
  await failing.controller.toggle();
  await failing.controller.toggle();
  assert.deepEqual(failing.controller.state, { phase: "error", message: "Upgrade the media node to ask by voice" });
  assert.equal(failing.events.at(-1).error, "not_found");

  const again = setup();
  await again.controller.toggle();
  await again.controller.toggle();
  await again.controller.toggle();
  assert.equal(again.timers[0].cleared, true);
  assert.equal(again.controller.state.phase, "recording");
  assert.equal(again.recordings.length, 2);
});
