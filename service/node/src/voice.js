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
// The languages the owner speaks, in their order (Settings › Your Yolo ›
// Voice languages), decide what a recording is heard as. One is transcribed as it, with
// no detection. With more, the transcriber's detection chooses among them
// alone, never a language the owner does not speak, which a second of noise
// often looks like; a later one wins only when it is more than even and ahead
// of the first, since a short recording of the first is often taken for
// another. A transcriber that cannot detect transcribes as it detects, and a
// language outside the owner's is transcribed again as their first. Without
// the owner's languages, a browser set to Chinese is heard as Chinese and
// others' languages are detected.
//
// Chinese comes with a prompt in its script, since a Whisper-style model
// follows the prompt's script and writes traditional characters without one.
// English words said in the Chinese stay in Latin letters either way.
const MAX_LANGUAGES = 4;
const TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const PROMPTS = {
  "zh-Hans": "以下是普通话的句子。",
  "zh-Hant": "以下是普通話的句子。",
};
const LATER_LANGUAGE_WINS = 0.5;

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

// Chinese is written in one script or the other; a bare "zh" or a region
// says which as people use it.
function chineseScript(tag) {
  const lower = tag.toLowerCase();
  if (/-hant\b|-(tw|hk|mo)\b/.test(lower)) return "zh-Hant";
  return "zh-Hans";
}

/** The owner's languages as tags, first first, without repeats; [] when they chose none. */
export function voiceLanguages(list) {
  const tags = [];
  for (const value of Array.isArray(list) ? list : []) {
    if (typeof value !== "string" || !TAG.test(value)) continue;
    const tag = primaryLanguage(value) === "zh" ? chineseScript(value) : value;
    if (!tags.some((seen) => primaryLanguage(seen) === primaryLanguage(tag))) tags.push(tag);
  }
  return tags.slice(0, MAX_LANGUAGES);
}

/** What the transcriber is told for `tag`: { language, prompt }. */
const hearingAs = (tag) => ({ language: tag, prompt: PROMPTS[tag] ?? null });

/**
 * Which of the owner's `languages` a recording is in, from the transcriber's
 * `probabilities` (keyed by primary language): the first, unless a later one
 * is more than even and ahead of it.
 */
export function chooseLanguage(languages, probabilities) {
  const chance = (tag) => Number(probabilities?.[primaryLanguage(tag)]) || 0;
  let chosen = languages[0];
  for (const tag of languages.slice(1)) {
    if (chance(tag) > LATER_LANGUAGE_WINS && chance(tag) > chance(chosen)) chosen = tag;
  }
  return chosen;
}

// The recording transcribed as the owner's languages say, or as the
// browser's `hint` says when they chose none.
async function hear(impl, audio, languages, hint, signal) {
  const transcribe = (as) => impl.transcribe({ audio, format: "wav", language: as.language, prompt: as.prompt, signal });
  if (!languages.length) {
    return transcribe(primaryLanguage(hint) === "zh" ? { language: "zh", prompt: PROMPTS["zh-Hans"] } : { language: null, prompt: null });
  }
  if (languages.length === 1) return transcribe(hearingAs(languages[0]));
  const detected = typeof impl.detectLanguage === "function" ? await impl.detectLanguage({ audio, format: "wav", signal }) : null;
  if (detected?.probabilities) return transcribe(hearingAs(chooseLanguage(languages, detected.probabilities)));
  const first = hearingAs(languages[0]);
  const result = await transcribe({ language: null, prompt: first.prompt });
  const heard = primaryLanguage(result?.language);
  return languages.some((tag) => primaryLanguage(tag) === heard) ? result : transcribe(first);
}

export function createVoiceInput({ speech }) {
  const running = new Map(); // device id (or a per-request key) → AbortController

  return {
    /** Whether a transcriber is loaded. */
    available: () => Boolean(speech?.transcriber()),

    /**
     * `audio` is the WAV, base64; `languages` the owner's, first first;
     * `language` the browser's, a hint when the owner chose none; `device` the
     * screen's id. Resolves { text, language }.
     */
    async transcribe({ audio, languages = null, language = null, device = null } = {}, { signal } = {}) {
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
        const result = await hear(transcriber.impl, bytes, voiceLanguages(languages), language, controller.signal);
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
