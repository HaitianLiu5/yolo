import assert from "node:assert/strict";
import test from "node:test";

import { createEndpointer, createVoiceController, downsample, encodeWav, HOLD_MS, microphoneProblem, PARTIAL_EVERY_MS } from "../../src/voice.js";

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

// Feeds `level` in 50 ms blocks over (from, to]; the first answer and when.
function feed(endpointer, level, from, to) {
  for (let at = from + 50; at <= to; at += 50) {
    const reason = endpointer.push(level, at);
    if (reason) return [reason, at];
  }
  return null;
}

test("recording stops after a pause that follows speech, when nobody speaks, and at 30 seconds", () => {
  const quiet = createEndpointer();
  assert.equal(feed(quiet, 0.002, 0, 300), null);
  assert.equal(feed(quiet, 0.2, 300, 1_000), null);
  assert.equal(quiet.lastSpeech, 1_000);
  assert.deepEqual(feed(quiet, 0.002, 1_000, 3_000), ["silence", 1_800]);

  assert.deepEqual(feed(createEndpointer(), 0, 0, 9_000), ["no_speech", 8_000]);
  assert.deepEqual(feed(createEndpointer(), 0.3, 0, 31_000), ["limit", 30_000]);
});

test("speech is told from the room's noise, and a click is not speech", () => {
  // A car's noise that would be speech in a quiet room is not here …
  const car = createEndpointer();
  assert.equal(feed(car, 0.03, 0, 300), null);
  assert.equal(feed(car, 0.05, 300, 2_000), null);
  assert.equal(car.heard, false);
  // … a voice over it is, and it goes on while it stays clear of the noise.
  assert.equal(feed(car, 0.2, 2_000, 2_500), null);
  assert.equal(feed(car, 0.09, 2_500, 3_000), null);
  assert.equal(car.lastSpeech, 3_000);
  assert.deepEqual(feed(car, 0.03, 3_000, 5_000), ["silence", 3_800]);

  const click = createEndpointer();
  feed(click, 0.002, 0, 300);
  click.push(0.5, 350);
  assert.equal(click.heard, false);
  assert.deepEqual(feed(click, 0.002, 350, 9_000), ["no_speech", 8_000]);
});

test("the browser's refusals become what the owner can do about them", () => {
  assert.equal(microphoneProblem({ name: "NotAllowedError" }).code, "denied");
  assert.equal(microphoneProblem({ name: "NotFoundError" }).code, "no_microphone");
  assert.equal(microphoneProblem({ name: "TypeError" }).code, "failed");
});

// A recording that hears what `heard` says, with speech last at
// `lastSpeech`; `refuse` is the browser's error. `answer` is each request's
// answer, the words so far and the last; `clock.at` is the time.
function setup({ heard = true, refuse = null, answer = { text: "播放老友记" } } = {}) {
  const phases = [];
  const sent = [];
  const events = [];
  const timers = [];
  const requests = [];
  const recordings = [];
  const clock = { at: 0 };
  const controller = createVoiceController({
    record: (hooks) => {
      const recording = {
        hooks,
        heard,
        lastSpeech: 1_000,
        upTo: 1_200,
        cancelled: false,
        async start() {
          if (refuse) throw refuse;
        },
        snapshot() {
          return { wav: new Uint8Array(44), seconds: this.upTo / 1000, upTo: this.upTo };
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
      return typeof answer === "function" ? answer(request, requests.length) : Promise.resolve(answer);
    },
    onChange: (state) => phases.push(state.phase),
    onSend: (text) => sent.push(text),
    report: (type, fields) => events.push({ type, ...fields }),
    now: () => clock.at,
    setTimer: (callback, ms) => {
      timers.push({ callback, ms });
      return timers.length;
    },
    clearTimer: (id) => {
      timers[id - 1].cleared = true;
    },
  });
  // Runs the latest timer of `ms` that is still set.
  const fire = async (ms) => {
    const timer = timers.findLast((entry) => entry.ms === ms && !entry.cleared && !entry.fired);
    timer.fired = true;
    timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { controller, phases, sent, events, timers, requests, recordings, clock, fire };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("tap, speak, tap: the words are asked at once", async () => {
  const { controller, phases, sent, events } = setup();
  await controller.toggle();
  assert.equal(controller.state.phase, "recording");
  await controller.toggle();
  assert.deepEqual(sent, ["播放老友记"]);
  assert.deepEqual(phases, ["starting", "recording", "transcribing", "idle"]);
  // The device event says how it went, never what was said.
  assert.deepEqual(events, [{ type: "voice_input", outcome: "transcribed", seconds: 2, stop: "tap", transcribeMs: 0, chars: 5, partials: 0, fromPartial: false }]);
});

test("the words show as they are said, and words heard past the last speech are the request", async () => {
  const words = ["播放", "播放老友记"];
  const { controller, recordings, requests, sent, events, fire } = setup({ answer: (request, count) => Promise.resolve({ text: words[count - 1] }) });
  await controller.toggle();
  const [recording] = recordings;
  await fire(PARTIAL_EVERY_MS);
  assert.deepEqual([controller.state.phase, controller.state.text], ["recording", "播放"]);
  // Nothing new said: nothing asked.
  await fire(PARTIAL_EVERY_MS);
  assert.equal(requests.length, 1);
  Object.assign(recording, { lastSpeech: 1_800, upTo: 2_200 });
  await fire(PARTIAL_EVERY_MS);
  assert.equal(controller.state.text, "播放老友记");
  // The pause ends it, and the last words go without asking again.
  recording.hooks.onEnd("silence");
  await settle();
  assert.deepEqual([sent, requests.length], [["播放老友记"], 2]);
  assert.deepEqual([events[0].partials, events[0].fromPartial, events[0].stop], [2, true, "silence"]);
});

test("words that may have missed the end are asked again from the whole recording", async () => {
  const { controller, recordings, requests, sent, fire } = setup({ answer: (request, count) => Promise.resolve({ text: count === 1 ? "播放" : "播放老友记" }) });
  await controller.toggle();
  await fire(PARTIAL_EVERY_MS);
  recordings[0].lastSpeech = 1_100;
  await controller.toggle();
  assert.deepEqual([sent, requests.length], [["播放老友记"], 2]);
});

test("held to talk, it records through pauses and sends on letting go", async () => {
  const { controller, recordings, sent, events, clock, fire } = setup();
  await controller.press();
  clock.at = HOLD_MS;
  await fire(HOLD_MS);
  assert.equal(controller.state.held, true);
  assert.equal(recordings[0].hooks.onEnd("silence"), false);
  assert.equal(controller.state.phase, "recording");
  await controller.release();
  assert.deepEqual(sent, ["播放老友记"]);
  assert.equal(events[0].stop, "release");
});

test("slid away it is dropped, and a quick press is a tap that listens on", async () => {
  const away = setup();
  await away.controller.press();
  away.clock.at = HOLD_MS + 100;
  away.controller.release({ cancel: true });
  assert.deepEqual([away.controller.state.phase, away.sent, away.recordings[0].cancelled], ["idle", [], true]);
  assert.deepEqual(away.events, [{ type: "voice_input", outcome: "cancelled", stop: "release" }]);

  const tap = setup();
  await tap.controller.press();
  tap.clock.at = 100;
  tap.controller.release({ cancel: true });
  assert.equal(tap.controller.state.phase, "recording");
  tap.recordings[0].hooks.onEnd("silence");
  await settle();
  assert.deepEqual(tap.sent, ["播放老友记"]);
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

test("a tap while the words go cancels the request, and its late answer is dropped", async () => {
  let respond;
  const { controller, requests, sent } = setup({ answer: () => new Promise((resolve) => { respond = resolve; }) });
  await controller.toggle();
  const finishing = controller.toggle();
  assert.equal(controller.state.phase, "transcribing");
  await controller.toggle();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(controller.state.phase, "idle");
  respond({ text: "too late" });
  await finishing;
  assert.equal(controller.state.phase, "idle");
  assert.deepEqual(sent, []);
});

test("a failed transcription shows Yolo's message over the words seen so far, and a tap records again", async () => {
  const failure = Object.assign(new Error("Upgrade the media node to ask by voice"), { code: "not_found" });
  const { controller, recordings, events, fire } = setup({ answer: (request, count) => (count === 1 ? Promise.resolve({ text: "播放" }) : Promise.reject(failure)) });
  await controller.toggle();
  await fire(PARTIAL_EVERY_MS);
  recordings[0].lastSpeech = 1_100;
  await controller.toggle();
  assert.deepEqual(controller.state, { phase: "error", message: "Upgrade the media node to ask by voice", text: "播放" });
  assert.equal(events.at(-1).error, "not_found");
  await controller.toggle();
  assert.equal(controller.state.phase, "recording");
  assert.equal(recordings.length, 2);
});
