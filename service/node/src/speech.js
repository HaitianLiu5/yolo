import { YoloError } from "@useyolo/core";

// The node's speech plugins (Agent Note 2026-10-18-ai-subtitles). A
// transcriber turns a stretch of audio into timed text; a translator turns
// lines of text into its language. Both are services the owner runs, on this
// machine or another at home, behind an interface any model can serve, so
// Yolo never knows which model it is. The first of each registered is used.

const SPEECH_ID = /^[a-z][a-z0-9-]{0,31}$/;
const TRANSCRIBER_FIELDS = Object.freeze(["title", "transcribe", "detectLanguage"]);
const TRANSLATOR_FIELDS = Object.freeze(["title", "language", "translate"]);
// A BCP 47 tag, such as "zh-Hans" or "en".
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function checkCommon(kind, id, impl) {
  if (!SPEECH_ID.test(String(id))) {
    throw new TypeError(`${kind} id "${id}" must be lowercase letters, digits and dashes, starting with a letter`);
  }
  if (!impl || typeof impl !== "object") throw new TypeError(`${kind} ${id} must be an object of methods`);
  if (impl.title !== undefined && typeof impl.title !== "string") throw new TypeError(`${kind} ${id}: title must be a string`);
}

export function checkTranscriberImpl(id, impl) {
  checkCommon("Transcriber", id, impl);
  if (typeof impl.transcribe !== "function") throw new TypeError(`Transcriber ${id}: transcribe must be a function`);
  if (impl.detectLanguage !== undefined && typeof impl.detectLanguage !== "function") throw new TypeError(`Transcriber ${id}: detectLanguage must be a function`);
  return Object.keys(impl).filter((key) => !TRANSCRIBER_FIELDS.includes(key));
}

export function checkTranslatorImpl(id, impl) {
  checkCommon("Translator", id, impl);
  if (typeof impl.translate !== "function") throw new TypeError(`Translator ${id}: translate must be a function`);
  if (!LANGUAGE_TAG.test(String(impl.language ?? ""))) throw new TypeError(`Translator ${id}: language must be a language tag, such as "zh-Hans"`);
  return Object.keys(impl).filter((key) => !TRANSLATOR_FIELDS.includes(key));
}

const round = (value) => Math.round(value * 1000) / 1000;

/**
 * A transcriber's answer for `duration` seconds of audio, checked:
 * { language, segments: [{ start, end, text }] } in seconds from the start
 * of the audio, sorted, inside it, without empty text.
 */
export function normalizeTranscript(result, duration) {
  if (!result || typeof result !== "object" || !Array.isArray(result.segments)) {
    throw new YoloError("resolve_failed", "The transcriber answered without segments");
  }
  const segments = [];
  for (const segment of result.segments) {
    const text = typeof segment?.text === "string" ? segment.text.replace(/\s+/g, " ").trim() : "";
    const start = Math.max(0, Number(segment?.start));
    const end = Math.min(duration, Number(segment?.end));
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    segments.push({ start: round(start), end: round(end), text });
  }
  segments.sort((a, b) => a.start - b.start);
  const language = typeof result.language === "string" && LANGUAGE_TAG.test(result.language) ? result.language : null;
  return { language, segments };
}

/** A translator's answer for `count` lines, checked: one string per line. */
export function normalizeTranslation(result, count) {
  if (!Array.isArray(result) || result.length !== count) {
    throw new YoloError("resolve_failed", `The translator answered ${Array.isArray(result) ? result.length : "no"} lines for ${count}`);
  }
  return result.map((line) => (typeof line === "string" ? line.replace(/\s+/g, " ").trim() : ""));
}

export function createSpeechRegistry() {
  const kinds = { transcriber: new Map(), translator: new Map() }; // id → { id, plugin, impl }, in registration order
  const first = (kind) => kinds[kind].values().next().value ?? null;

  return {
    add(kind, id, impl, plugin) {
      if (kinds[kind].has(id)) throw new Error(`The ${kind} id "${id}" is already registered`);
      kinds[kind].set(id, { id, plugin, impl });
    },
    remove(kind, id) {
      kinds[kind].delete(id);
    },
    has: (kind, id) => kinds[kind].has(id),
    ids: (kind) => [...kinds[kind].keys()],
    /** The transcriber in use, or null. */
    transcriber: () => first("transcriber"),
    /** The translator in use, or null. */
    translator: () => first("translator"),
  };
}
