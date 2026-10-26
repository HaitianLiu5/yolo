import { toYoloError, YoloError } from "@useyolo/core";
import { normalizeTranscript } from "./speech.js";

// Voice input for Ask (Agent Note 2026-10-18-agent-from-the-screen): what a
// screen recorded, turned into the words of a request by the transcriber
// plugin AI subtitles use (speech.js). The screen sends at most 30 seconds of
// 16 kHz mono 16-bit WAV, the transcriber's own input, so nothing here
// decodes audio. The sound is passed on and dropped: never written to disk
// or logged.
//
// It does not wait behind AI subtitles' lane: a person is waiting. Each
// screen has one recording in flight, and a newer one from it stops the
// older, as each of the words-so-far requests a recording makes while it
// goes on does; at most two run on the node at once.

export const VOICE_SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = VOICE_SAMPLE_RATE * 2;
const WAV_HEADER_BYTES = 44;
export const MAX_VOICE_SECONDS = 30;
// The longest WAV a screen may send: 30 seconds and a little slack.
export const MAX_VOICE_BYTES = WAV_HEADER_BYTES + Math.ceil((MAX_VOICE_SECONDS + 0.5) * BYTES_PER_SECOND);
const MIN_VOICE_SECONDS = 0.3;
const MAX_RUNNING = 2;
const TRANSCRIBE_TIMEOUT_MS = 30_000;
// The longest request an agent takes (agents.js MAX_AGENT_TEXT).
const MAX_TEXT = 1000;
// A browser set to Chinese is transcribed as Chinese: a Whisper-style model
// skips detecting the language, about a third faster, and English said to it
// still comes back in English. The prompt keeps its Mandarin in simplified
// characters, since such models follow the prompt's script. Other browsers'
// languages are detected.
const LANGUAGES = { zh: { language: "zh", prompt: "以下是普通话的句子。" } };

const ascii = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));

/** Seconds of sound in a canonical 16 kHz mono 16-bit PCM WAV, or a YoloError. */
export function wavSeconds(bytes) {
  if (bytes.length < WAV_HEADER_BYTES || ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE" || ascii(bytes, 12) !== "fmt " || ascii(bytes, 36) !== "data") {
    throw new YoloError("invalid_request", "audio must be a WAV file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  if (format !== 1 || channels !== 1 || rate !== VOICE_SAMPLE_RATE || bits !== 16) {
    throw new YoloError("invalid_request", "audio must be 16 kHz mono 16-bit PCM");
  }
  const data = Math.min(view.getUint32(40, true), bytes.length - WAV_HEADER_BYTES);
  return data / BYTES_PER_SECOND;
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿＀-￯]/;

/** A transcript's segments as one request: no space between two CJK lines. */
export function joinSegments(segments) {
  let text = "";
  for (const { text: line } of segments) {
    if (!text) text = line;
    else text += CJK.test(text.at(-1)) && CJK.test(line[0]) ? line : ` ${line}`;
  }
  return text.slice(0, MAX_TEXT);
}

const primaryLanguage = (tag) => (typeof tag === "string" ? tag.split("-")[0].toLowerCase() : "");

export function createVoiceInput({ speech }) {
  const running = new Map(); // device id (or a per-request key) → AbortController

  return {
    /** Whether a transcriber is loaded. */
    available: () => Boolean(speech?.transcriber()),

    /**
     * `audio` is the WAV, base64; `language` the browser's language, a hint;
     * `device` the screen's id. Resolves { text, language }.
     */
    async transcribe({ audio, language = null, device = null } = {}, { signal } = {}) {
      const transcriber = speech?.transcriber();
      if (!transcriber) throw new YoloError("not_found", "No transcriber plugin is loaded on this media node");
      if (typeof audio !== "string" || !audio) throw new YoloError("invalid_request", "audio is required");
      if (audio.length > Math.ceil(MAX_VOICE_BYTES / 3) * 4) throw new YoloError("invalid_request", `audio is longer than ${MAX_VOICE_SECONDS} seconds`);
      const bytes = new Uint8Array(Buffer.from(audio, "base64"));
      const seconds = wavSeconds(bytes);
      if (seconds > MAX_VOICE_SECONDS + 0.5) throw new YoloError("invalid_request", `audio is longer than ${MAX_VOICE_SECONDS} seconds`);
      if (seconds < MIN_VOICE_SECONDS) return { text: "", language: null };

      const key = typeof device === "string" && device ? device : Symbol("voice");
      running.get(key)?.abort(new YoloError("superseded", "A newer recording replaced this one"));
      if (running.size >= MAX_RUNNING && !running.has(key)) throw new YoloError("rate_limited", "The speech service is busy; try again in a moment");
      const controller = new AbortController();
      running.set(key, controller);
      const stop = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(() => controller.abort(new YoloError("resolve_failed", "The speech service did not answer in time")), TRANSCRIBE_TIMEOUT_MS);
      try {
        const result = await transcriber.impl.transcribe({
          audio: bytes,
          format: "wav",
          language: LANGUAGES[primaryLanguage(language)]?.language ?? null,
          prompt: LANGUAGES[primaryLanguage(language)]?.prompt ?? null,
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw controller.signal.reason;
        const transcript = normalizeTranscript(result, seconds);
        return { text: joinSegments(transcript.segments), language: transcript.language };
      } catch (error) {
        if (controller.signal.reason instanceof YoloError) throw controller.signal.reason;
        const yolo = toYoloError(error);
        if (yolo.code === "internal") throw new YoloError("resolve_failed", `Speech to text failed: ${yolo.message}`, { cause: error });
        throw yolo;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        if (running.get(key) === controller) running.delete(key);
      }
    },
  };
}
