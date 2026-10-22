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

export const VOICE_SAMPLE_RATE = 16_000;
export const MAX_VOICE_SECONDS = 30;
// Recording stops by itself after this much quiet following speech …
export const SILENCE_STOP_MS = 1_500;
// … or when nobody spoke this long after it started.
export const NO_SPEECH_STOP_MS = 8_000;
// The level (RMS of a block of samples, 0–1) above which a block is speech.
const SPEECH_LEVEL = 0.02;

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
 * When to stop by itself: fed each block's level and its time (ms since the
 * start), it answers "silence" after quiet that follows speech, "no_speech"
 * when nobody spoke, "limit" at 30 seconds, or null to go on.
 */
export function createEndpointer({ silenceMs = SILENCE_STOP_MS, noSpeechMs = NO_SPEECH_STOP_MS, maxMs = MAX_VOICE_SECONDS * 1000 } = {}) {
  let heard = false;
  let lastSpeech = 0;
  return {
    get heard() {
      return heard;
    },
    push(value, at) {
      if (value >= SPEECH_LEVEL) {
        heard = true;
        lastSpeech = at;
      }
      if (at >= maxMs) return "limit";
      if (!heard) return at >= noSpeechMs ? "no_speech" : null;
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
      return { code: "denied", message: "Microphone access is off for Yolo. Allow it when the browser asks, or in its site settings." };
    case "NotFoundError":
    case "OverconstrainedError":
      return { code: "no_microphone", message: "This screen has no microphone Yolo can use." };
    case "NotReadableError":
    case "AbortError":
      return { code: "busy", message: "The microphone is in use by something else." };
    default:
      return { code: "failed", message: "Yolo could not start the microphone." };
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
 * sound and `onEnd(reason)` says it stopped by itself. `stop()` resolves the
 * WAV bytes and the seconds recorded; `cancel()` drops it.
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
    if (reason) {
      ended = true;
      onEnd(reason);
    }
  }

  return {
    get heard() {
      return endpointer.heard;
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
    stop() {
      const recorded = new Float32Array(samples);
      let at = 0;
      for (const chunk of chunks) {
        recorded.set(chunk, at);
        at += chunk.length;
      }
      release();
      if (!rate) return { wav: encodeWav(new Float32Array(0)), seconds: 0 };
      const limit = MAX_VOICE_SECONDS * rate;
      const voice = downsample(recorded.length > limit ? recorded.subarray(0, limit) : recorded, rate);
      return { wav: encodeWav(voice), seconds: voice.length / VOICE_SAMPLE_RATE };
    },
    cancel() {
      chunks.length = 0;
      release();
    },
  };
}

// After the words come back, they wait this long in the field before they
// are sent, so a tap on the field can stop them to edit.
export const AUTO_SEND_MS = 2_000;

/**
 * Ask's microphone, without the page: tap to record, tap again (or pause)
 * to stop, then the words fill the field and go after AUTO_SEND_MS unless
 * `hold()` keeps them for editing. `onChange(state)` gets
 * { phase: "idle" | "starting" | "recording" | "transcribing" | "countdown" | "error", level?, text?, message? }.
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
  let timer = null;

  const set = (next) => {
    state = next;
    onChange(state);
  };
  const event = (fields) => report("voice_input", fields);

  async function start() {
    const current = record({
      onLevel: (value) => {
        if (recording === current && state.phase === "recording") set({ phase: "recording", level: value });
      },
      onEnd: (reason) => {
        if (recording === current) void finish(reason);
      },
    });
    recording = current;
    set({ phase: "starting" });
    try {
      await current.start();
    } catch (error) {
      if (recording !== current) return;
      recording = null;
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
    set({ phase: "recording", level: 0 });
  }

  async function finish(stop) {
    const current = recording;
    recording = null;
    const heard = current.heard;
    const { wav, seconds } = current.stop();
    if (!heard) {
      event({ outcome: "no_speech", seconds, stop });
      set({ phase: "error", message: "Yolo heard nothing. Tap the microphone and speak." });
      return;
    }
    const controller = new AbortController();
    request = controller;
    set({ phase: "transcribing" });
    const began = now();
    try {
      const { text } = await transcribe(wav, controller.signal);
      if (request !== controller) return;
      request = null;
      const words = typeof text === "string" ? text.trim() : "";
      event({ outcome: words ? "transcribed" : "empty", seconds, stop, transcribeMs: now() - began, chars: words.length });
      if (!words) {
        set({ phase: "error", message: "Yolo could not make out any words. Try again." });
        return;
      }
      set({ phase: "countdown", text: words });
      timer = setTimer(() => {
        timer = null;
        set({ phase: "idle" });
        onSend(words);
      }, AUTO_SEND_MS);
    } catch (error) {
      if (request !== controller) return;
      request = null;
      event({ outcome: "failed", seconds, stop, transcribeMs: now() - began, error: error?.code ?? error?.name ?? null });
      set({ phase: "error", message: error?.message || "Yolo could not turn that into words." });
    }
  }

  function cancel() {
    const wasActive = state.phase !== "idle";
    recording?.cancel();
    recording = null;
    request?.abort();
    request = null;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (wasActive) set({ phase: "idle" });
  }

  return {
    get state() {
      return state;
    },
    /** The microphone button: start, stop and transcribe, or cancel what runs. */
    // Words waiting to be sent are dropped for a new recording.
    toggle() {
      if (state.phase === "recording") return finish("tap");
      if (state.phase === "starting" || state.phase === "transcribing") return cancel();
      if (state.phase === "countdown") cancel();
      return start();
    },
    cancel,
    /** Keeps words waiting to be sent in the field, for the person to edit. */
    hold() {
      if (state.phase !== "countdown") return false;
      clearTimer(timer);
      timer = null;
      event({ outcome: "held" });
      set({ phase: "idle" });
      return true;
    },
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
      result.recording = { outcome: peak >= SPEECH_LEVEL ? "heard" : "silent", peak: Math.round(peak * 1000) / 1000, seconds: Math.round(seconds * 10) / 10, rate: recording.rate };
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
