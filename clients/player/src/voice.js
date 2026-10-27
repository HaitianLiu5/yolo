// Voice input for Ask (Agent Note 2026-10-18-agent-from-the-screen): the
// screen records a request with the browser's microphone and Yolo's
// transcriber on the media node turns it into words. The browser's own speech
// recognition is not used: the car's browser is not known to offer it, and
// it would send the sound to the browser's vendor.
//
// The recording is captured with Web Audio, not MediaRecorder, whose formats
// the car's browser is not known to offer, and leaves as what the transcriber
// takes: 16 kHz mono 16-bit WAV, at most 30 seconds. It lives only in memory
// until it is sent; the microphone is released as soon as recording stops.
//
// While it records, what was said so far is sent again about once a second,
// one request at a time, so the words show as they are spoken; the request
// is made from the whole recording when it ends, unless the last of those
// already heard past the last speech, and then its words are the request's.

import { t } from "./i18n.js";

export const VOICE_SAMPLE_RATE = 16_000;
export const MAX_VOICE_SECONDS = 30;
// Recording stops by itself after this much quiet following speech …
export const SILENCE_STOP_MS = 800;
// … or when nobody spoke this long after it started.
export const NO_SPEECH_STOP_MS = 8_000;
// Speech is told from the room's noise, by level (RMS of a block of samples,
// 0–1). The noise is the quietest block of the first moments, before anyone
// can have started, and then follows the room: it falls at once to a quieter
// block and rises slowly, so a voice barely moves it. A block is speech at
// this many times the noise, within these bounds …
const CALIBRATE_MS = 250;
const SPEECH_RATIO = 3;
const MIN_SPEECH_LEVEL = 0.01;
const MAX_SPEECH_LEVEL = 0.12;
// … and a voice already speaking goes on above this share of that.
const SPEAKING_SHARE = 0.6;
// Less speech than this in all is a bump or a click, not a request.
const MIN_SPEECH_MS = 120;
// Settings' microphone check calls a recording at this level "heard".
const HEARD_LEVEL = 0.02;

/** Float samples at `from` Hz as `to` Hz, each output the mean of its input span. */
export function downsample(samples, from, to = VOICE_SAMPLE_RATE) {
  if (from === to) return Float32Array.from(samples);
  if (from < to) throw new RangeError(`Cannot record at ${from} Hz; ${to} Hz or more is needed`);
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < out.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let at = start; at < end; at += 1) sum += samples[at];
    out[index] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** Float samples (−1…1) as a 16-bit PCM mono WAV file. */
export function encodeWav(samples, rate = VOICE_SAMPLE_RATE) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

export function level(samples) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/**
 * When to stop by itself: fed each block's level and the time at its end (ms
 * since the start), it answers "silence" after quiet that follows speech,
 * "no_speech" when nobody spoke, "limit" at 30 seconds, or null to go on.
 * `lastSpeech` is when speech was last heard.
 */
export function createEndpointer({ silenceMs = SILENCE_STOP_MS, noSpeechMs = NO_SPEECH_STOP_MS, maxMs = MAX_VOICE_SECONDS * 1000 } = {}) {
  let noise = null;
  let quietest = Infinity;
  let speech = 0;
  let lastSpeech = 0;
  let previous = 0;
  const heard = () => speech >= MIN_SPEECH_MS;
  return {
    get heard() {
      return heard();
    },
    get lastSpeech() {
      return lastSpeech;
    },
    push(value, at) {
      const span = at - previous;
      previous = at;
      if (noise === null) {
        quietest = Math.min(quietest, value);
        if (at >= CALIBRATE_MS) noise = quietest;
      } else {
        const threshold = Math.min(MAX_SPEECH_LEVEL, Math.max(MIN_SPEECH_LEVEL, noise * SPEECH_RATIO));
        const speaking = speech > 0 && at - lastSpeech < silenceMs;
        if (value >= (speaking ? threshold * SPEAKING_SHARE : threshold)) {
          speech += span;
          lastSpeech = at;
          noise += (value - noise) * 0.002;
        } else {
          noise += (value - noise) * (value < noise ? 0.5 : 0.02);
        }
      }
      if (at >= maxMs) return "limit";
      if (!heard()) return at >= noSpeechMs ? "no_speech" : null;
      return at - lastSpeech >= silenceMs ? "silence" : null;
    },
  };
}

// An AudioWorklet that hands the microphone's samples to the page in blocks.
const CAPTURE_WORKLET = `
class YoloVoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(2048); this.size = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        this.block[this.size++] = channel[i];
        if (this.size === this.block.length) { this.port.postMessage(this.block.slice()); this.size = 0; }
      }
    }
    return true;
  }
}
registerProcessor("yolo-voice-capture", YoloVoiceCapture);
`;

/** Why the microphone could not be used, in the owner's words, by the browser's error. */
export function microphoneProblem(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return { code: "denied", message: t("Microphone access is off for Yolo. Allow it when the browser asks, or in its site settings.") };
    case "NotFoundError":
    case "OverconstrainedError":
      return { code: "no_microphone", message: t("This screen has no microphone Yolo can use.") };
    case "NotReadableError":
    case "AbortError":
      return { code: "busy", message: t("The microphone is in use by something else.") };
    default:
      return { code: "failed", message: t("Yolo could not start the microphone.") };
  }
}

/** Whether this browser can record at all; the car's says so only from software 2026.26 on AMD. */
export function canRecord(win = globalThis) {
  return Boolean(win.isSecureContext && typeof win.navigator?.mediaDevices?.getUserMedia === "function"
    && (win.AudioContext || win.webkitAudioContext));
}

/**
 * One recording. `start()` asks for the microphone (the browser's prompt on
 * first use) and resolves once it records; `onLevel(level)` follows the
 * sound and `onEnd(reason)` says it would stop by itself, which it does
 * unless `onEnd` returns false. `snapshot()` is what it has so far, as the
 * WAV bytes, the seconds, and `upTo` (ms); `stop()` is the whole of it, and
 * releases the microphone; `cancel()` drops it.
 */
export function createRecording({ win = globalThis, onLevel = () => {}, onEnd = () => {}, endpointer = createEndpointer() } = {}) {
  const chunks = [];
  let stream = null;
  let context = null;
  let node = null;
  let rate = 0;
  let samples = 0;
  let ended = false;

  function release() {
    ended = true;
    try {
      if (node?.port) node.port.onmessage = null;
      node?.disconnect();
    } catch {
      // Already gone.
    }
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    void context?.close().catch(() => {});
    context = null;
  }

  function take(block) {
    if (ended) return;
    chunks.push(block);
    samples += block.length;
    const value = level(block);
    onLevel(value);
    const reason = endpointer.push(value, (samples / rate) * 1000);
    if (reason && onEnd(reason) !== false) ended = true;
  }

  function sofar() {
    const recorded = new Float32Array(samples);
    let at = 0;
    for (const chunk of chunks) {
      recorded.set(chunk, at);
      at += chunk.length;
    }
    if (!rate) return { wav: encodeWav(new Float32Array(0)), seconds: 0, upTo: 0 };
    const limit = MAX_VOICE_SECONDS * rate;
    const voice = downsample(recorded.length > limit ? recorded.subarray(0, limit) : recorded, rate);
    return { wav: encodeWav(voice), seconds: voice.length / VOICE_SAMPLE_RATE, upTo: (samples / rate) * 1000 };
  }

  return {
    get heard() {
      return endpointer.heard;
    },
    /** When speech was last heard, in ms since the start. */
    get lastSpeech() {
      return endpointer.lastSpeech ?? 0;
    },
    /** The rate the browser records at, before it becomes 16 kHz. */
    get rate() {
      return rate;
    },
    async start() {
      stream = await win.navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      try {
        const Context = win.AudioContext || win.webkitAudioContext;
        context = new Context();
        rate = context.sampleRate;
        const source = context.createMediaStreamSource(stream);
        if (context.audioWorklet && win.AudioWorkletNode) {
          const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
          try {
            await context.audioWorklet.addModule(url);
          } finally {
            URL.revokeObjectURL(url);
          }
          node = new win.AudioWorkletNode(context, "yolo-voice-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
          node.port.onmessage = (event) => take(event.data);
          source.connect(node);
        } else {
          // Older browsers: the deprecated processor, which needs an output.
          node = context.createScriptProcessor(2048, 1, 1);
          node.onaudioprocess = (event) => take(Float32Array.from(event.inputBuffer.getChannelData(0)));
          source.connect(node);
          node.connect(context.destination);
        }
        if (context.state === "suspended") await context.resume();
      } catch (error) {
        release();
        throw error;
      }
    },
    snapshot: sofar,
    stop() {
      const whole = sofar();
      release();
      return whole;
    },
    cancel() {
      chunks.length = 0;
      release();
    },
  };
}

// A press on the microphone held this long is held to talk, and letting go
// sends; a shorter one is a tap, and it listens until a pause or a tap.
export const HOLD_MS = 350;
// While it records, the words so far are asked for this often.
export const PARTIAL_EVERY_MS = 1_000;
// Words asked for this far past the last speech heard all of the request.
const PARTIAL_TAIL_MS = 300;

/**
 * Ask's microphone, without the page. A tap (`toggle()`, or `press()` and
 * `release()` within HOLD_MS) records until a pause or another tap; a press
 * held longer records until it is let go, and `release({ cancel: true })`
 * drops it. The words show as they are said and go to `onSend(text)` as soon
 * as the recording ends. `onChange(state)` gets
 * { phase: "idle" | "starting" | "recording" | "transcribing" | "error", level?, text?, held?, message? }.
 * `report(type, fields)` is the device event, without the words or sound.
 */
export function createVoiceController({
  transcribe,
  onChange = () => {},
  onSend = () => {},
  report = () => {},
  record = (hooks) => createRecording(hooks),
  now = () => Date.now(),
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  let state = { phase: "idle" };
  let recording = null;
  let request = null;
  // The words so far: the request in flight ({ controller, upTo, done }) and
  // the last answer ({ upTo, text }), upTo in ms of the recording.
  let partial = null;
  let latest = null;
  let partials = 0;
  let pressed = null;
  let ticker = null;
  let holdTimer = null;

  const set = (next) => {
    state = next;
    onChange(state);
  };
  const event = (fields) => report("voice_input", fields);
  const words = (text) => (typeof text === "string" ? text.trim() : "");
  const held = () => Boolean(pressed && now() - pressed.at >= HOLD_MS);

  function stopTimers() {
    if (ticker !== null) clearTimer(ticker);
    if (holdTimer !== null) clearTimer(holdTimer);
    ticker = null;
    holdTimer = null;
  }

  function dropPartial() {
    partial?.controller.abort();
    partial = null;
  }

  // Asks for the words so far: one request at a time, and only once more
  // was said since the last.
  function tick(current) {
    ticker = setTimer(() => tick(current), PARTIAL_EVERY_MS);
    if (partial || !current.heard || current.lastSpeech <= (latest?.upTo ?? 0)) return;
    const { wav, upTo } = current.snapshot();
    const controller = new AbortController();
    const asked = { controller, upTo };
    asked.done = transcribe(wav, controller.signal).then((result) => words(result?.text), () => null).then((text) => {
      if (partial === asked) partial = null;
      if (text === null || controller.signal.aborted) return null;
      latest = { upTo, text };
      if (text && recording === current && state.phase === "recording") {
        partials += 1;
        set({ ...state, text });
      }
      return text;
    });
    partial = asked;
  }

  async function start() {
    const current = record({
      onLevel: (value) => {
        if (recording === current && state.phase === "recording") set({ ...state, level: value });
      },
      onEnd: (reason) => {
        if (recording !== current) return undefined;
        // Held down, it records until it is let go.
        if (pressed && reason !== "limit") return false;
        void finish(reason);
        return undefined;
      },
    });
    recording = current;
    latest = null;
    partials = 0;
    set({ phase: "starting" });
    try {
      await current.start();
    } catch (error) {
      if (recording !== current) return;
      recording = null;
      pressed = null;
      stopTimers();
      const problem = microphoneProblem(error);
      event({ outcome: problem.code, error: error?.name ?? null });
      set({ phase: "error", message: problem.message });
      return;
    }
    // Cancelled while the browser asked for the microphone.
    if (recording !== current) {
      current.cancel();
      return;
    }
    set({ phase: "recording", level: 0, text: "", held: held() });
    ticker = setTimer(() => tick(current), PARTIAL_EVERY_MS);
  }

  async function finish(stop) {
    const current = recording;
    recording = null;
    pressed = null;
    stopTimers();
    const heard = current.heard;
    const lastSpeech = current.lastSpeech;
    const { wav, seconds } = current.stop();
    const pending = partial;
    const shown = state.text ?? "";
    if (!heard) {
      dropPartial();
      event({ outcome: "no_speech", seconds, stop });
      set({ phase: "error", message: t("Yolo heard nothing. Tap the microphone and speak.") });
      return;
    }
    const controller = new AbortController();
    request = controller;
    set({ phase: "transcribing", text: shown });
    const began = now();
    const heardAll = (upTo) => upTo >= lastSpeech + PARTIAL_TAIL_MS;
    let text = null;
    try {
      // Words asked for after the last speech are the whole request's.
      if (latest && heardAll(latest.upTo)) {
        text = latest.text;
        dropPartial();
      } else if (pending && heardAll(pending.upTo)) {
        text = await pending.done;
        if (request !== controller) return;
      }
      const fromPartial = text !== null;
      if (!fromPartial) {
        dropPartial();
        text = words((await transcribe(wav, controller.signal))?.text);
        if (request !== controller) return;
      }
      request = null;
      event({ outcome: text ? "transcribed" : "empty", seconds, stop, transcribeMs: now() - began, chars: text.length, partials, fromPartial });
      if (!text) {
        set({ phase: "error", message: t("Yolo could not make out any words. Try again.") });
        return;
      }
      set({ phase: "idle" });
      onSend(text);
    } catch (error) {
      if (request !== controller) return;
      request = null;
      event({ outcome: "failed", seconds, stop, transcribeMs: now() - began, error: error?.code ?? error?.name ?? null });
      // The words seen so far stay, to send by hand.
      set({ phase: "error", message: error?.message || t("Yolo could not turn that into words."), text: shown });
    }
  }

  function cancel() {
    const wasActive = state.phase !== "idle";
    recording?.cancel();
    recording = null;
    pressed = null;
    stopTimers();
    request?.abort();
    request = null;
    dropPartial();
    if (wasActive) set({ phase: "idle" });
  }

  return {
    get state() {
      return state;
    },
    /** A tap on the microphone: start, stop and send, or cancel what runs. */
    toggle() {
      if (state.phase === "recording") return finish("tap");
      if (state.phase === "starting" || state.phase === "transcribing") return cancel();
      return start();
    },
    /** The microphone pressed down: as a tap, and it may be held to talk. */
    press() {
      if (state.phase !== "idle" && state.phase !== "error") return this.toggle();
      pressed = { at: now() };
      holdTimer = setTimer(() => {
        holdTimer = null;
        if (pressed && state.phase === "recording") set({ ...state, held: true });
      }, HOLD_MS);
      return start();
    },
    /** Let go: held, it sends, or with `cancel` drops; a tap listens on. */
    release({ cancel: drop = false } = {}) {
      if (!pressed) return undefined;
      const wasHeld = held();
      pressed = null;
      if (holdTimer !== null) clearTimer(holdTimer);
      holdTimer = null;
      if (!wasHeld || state.phase !== "recording") return undefined;
      if (!drop) return finish("release");
      event({ outcome: "cancelled", stop: "release" });
      cancel();
      return undefined;
    },
    cancel,
  };
}

const MIC_TEST_MS = 3_000;
const SPEECH_TEST_MS = 5_000;

/**
 * Settings' microphone check, for finding out what a car's browser offers:
 * three seconds recorded with Web Audio (the level heard, never the sound),
 * then, where the browser has one, five seconds of its own speech
 * recognition (whether it answered or its error code, never the words).
 * `onProgress(step)` says "recording" or "recognition". Resolves the result
 * for the device event and the row.
 */
export async function testMicrophone({ win = globalThis, onProgress = () => {} } = {}) {
  const result = { recording: null, recognition: null };
  if (!canRecord(win)) {
    result.recording = { outcome: "unsupported", secure: win.isSecureContext === true };
  } else {
    let peak = 0;
    const recording = createRecording({
      win,
      onLevel: (value) => {
        peak = Math.max(peak, value);
      },
      endpointer: { heard: false, push: () => null },
    });
    try {
      onProgress("recording");
      await recording.start();
      await new Promise((resolve) => setTimeout(resolve, MIC_TEST_MS));
      const { seconds } = recording.stop();
      result.recording = { outcome: peak >= HEARD_LEVEL ? "heard" : "silent", peak: Math.round(peak * 1000) / 1000, seconds: Math.round(seconds * 10) / 10, rate: recording.rate };
    } catch (error) {
      recording.cancel();
      result.recording = { outcome: microphoneProblem(error).code, error: error?.name ?? null };
    }
  }

  const Recognition = win.SpeechRecognition || win.webkitSpeechRecognition;
  if (typeof Recognition !== "function") {
    result.recognition = { outcome: "unsupported" };
    return result;
  }
  onProgress("recognition");
  result.recognition = await new Promise((resolve) => {
    let settled = false;
    let recognition;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        recognition?.abort();
      } catch {
        // Already stopped.
      }
      resolve(value);
    };
    const timer = setTimeout(() => done({ outcome: "no_result" }), SPEECH_TEST_MS);
    try {
      recognition = new Recognition();
      recognition.lang = win.navigator?.language || "en-US";
      recognition.interimResults = true;
      recognition.onresult = (event) => done({ outcome: "heard", chars: String(event.results?.[0]?.[0]?.transcript ?? "").length });
      recognition.onerror = (event) => done({ outcome: "error", error: event?.error ?? null });
      recognition.onend = () => done({ outcome: "ended" });
      recognition.start();
    } catch (error) {
      done({ outcome: "error", error: error?.name ?? null });
    }
  });
  return result;
}
