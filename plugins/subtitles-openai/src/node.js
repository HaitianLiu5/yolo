import { YoloError } from "@useyolo/plugin-api";

// Official AI subtitle plugin (Agent Note 2026-10-18-ai-subtitles): speech
// to text and translation through the two HTTP interfaces most model servers
// speak, OpenAI's:
//
//   POST {url}/audio/transcriptions   the transcriber, with segment times
//   POST {url}/chat/completions       the translator
//
// So the owner runs whatever model they like where they like, such as a
// Whisper server and a local language model on a Mac at home, and Yolo never
// knows which. A hosted service with the same interfaces works too, at its
// own price.
//
// Options (yolo.config.json):
//   url              the server's base URL, such as "http://mbp.local:8000/v1" (required)
//   transcribeModel  the speech model's name on that server, default "whisper-1"
//   translateUrl     another server for translation, default `url`
//   translateModel   the language model's name; without it, no translator
//   language         what to translate into, default "zh-Hans"
//   apiKey           sent as a Bearer token, default SUBTITLES_OPENAI_API_KEY

const TRANSCRIBER_ID = "openai";
const TRANSLATOR_ID = "openai";
const DEFAULT_TRANSCRIBE_MODEL = "whisper-1";
const DEFAULT_LANGUAGE = "zh-Hans";
// Whisper's own rule for a segment that is silence or noise.
const NO_SPEECH_PROBABILITY = 0.6;
const LOW_LOG_PROBABILITY = -1;
const MAX_ERROR_CHARS = 200;

// verbose_json names the language ("japanese"); Yolo takes a tag.
const LANGUAGE_TAGS = {
  arabic: "ar", cantonese: "yue", chinese: "zh", dutch: "nl", english: "en", french: "fr", german: "de", hindi: "hi",
  indonesian: "id", italian: "it", japanese: "ja", korean: "ko", malay: "ms", polish: "pl", portuguese: "pt",
  russian: "ru", spanish: "es", swedish: "sv", thai: "th", turkish: "tr", ukrainian: "uk", vietnamese: "vi",
};

function languageTag(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (LANGUAGE_TAGS[text]) return LANGUAGE_TAGS[text];
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(text) ? text : null;
}

// Seconds of 16 kHz mono 16-bit WAV.
const wavSeconds = (audio) => Math.max(0, audio.length - 44) / 32_000;

/** verbose_json → { language, segments }, without what Whisper itself takes for silence. */
function readTranscription(body, audioSeconds) {
  const language = languageTag(body?.language);
  if (Array.isArray(body?.segments)) {
    const segments = body.segments
      .filter((segment) => !(Number(segment.no_speech_prob) > NO_SPEECH_PROBABILITY && !(Number(segment.avg_logprob) >= LOW_LOG_PROBABILITY)))
      .map(({ start, end, text }) => ({ start: Number(start), end: Number(end), text: String(text ?? "") }));
    return { language, segments };
  }
  // A server that gives only the text: one cue for the whole stretch.
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  return { language, segments: text ? [{ start: 0, end: audioSeconds, text }] : [] };
}

/** The lines of a translator's answer: a JSON array of strings, wherever it sits in the reply. */
function readTranslation(content) {
  const text = String(content ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new YoloError("resolve_failed", "The language model did not answer with a list of lines");
  let lines;
  try {
    lines = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new YoloError("resolve_failed", "The language model's list of lines is not valid JSON");
  }
  if (!Array.isArray(lines)) throw new YoloError("resolve_failed", "The language model did not answer with a list of lines");
  return lines.map((line) => (typeof line === "string" ? line : String(line ?? "")));
}

function languageName(tag) {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

function translationMessages({ lines, from, to, title, previous }) {
  const target = languageName(to);
  const system = [
    `You translate video subtitles into ${target}.`,
    "Each input line is one subtitle cue, often a fragment of speech recognized automatically, with mistakes.",
    "Translate every line on its own, keeping its order and meaning; keep names, game and technical terms as viewers of this video say them.",
    "Reply with only a JSON array of strings, exactly one per input line, and nothing else.",
  ].join(" ");
  const user = JSON.stringify({
    title: title ?? undefined,
    spoken_language: from ? languageName(from) : undefined,
    previous_lines: previous?.length ? previous : undefined,
    lines,
  });
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function createOpenAiSpeech({
  url, transcribeModel = DEFAULT_TRANSCRIBE_MODEL, translateUrl = null, translateModel = null, language = DEFAULT_LANGUAGE, apiKey = null,
}) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new TypeError("subtitles-openai needs the `url` option: the server's base URL, such as http://mbp.local:8000/v1");
  const base = (value) => value.replace(/\/+$/, "");
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};

  async function call(endpoint, init, signal) {
    let response;
    try {
      response = await fetch(endpoint, { ...init, headers: { ...headers, ...init.headers }, signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new YoloError("resolve_failed", `The speech server at ${new URL(endpoint).host} cannot be reached: ${error.cause?.code ?? error.message}`);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS);
      throw new YoloError("resolve_failed", `The speech server at ${new URL(endpoint).host} answered ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return response.json();
  }

  const transcriber = {
    title: `Speech to text (${transcribeModel})`,
    async transcribe({ audio, language: spoken = null, prompt = null, signal }) {
      const form = new FormData();
      form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
      form.append("model", transcribeModel);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      if (spoken) form.append("language", spoken.split("-")[0]);
      if (prompt) form.append("prompt", prompt);
      const body = await call(`${base(url)}/audio/transcriptions`, { method: "POST", body: form }, signal);
      return readTranscription(body, wavSeconds(audio));
    },
  };

  const translator = translateModel ? {
    title: `Translation (${translateModel})`,
    language,
    async translate({ lines, from, to, title, previous, signal }) {
      const body = await call(`${base(translateUrl || url)}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: translateModel, temperature: 0.2, messages: translationMessages({ lines, from, to, title, previous }) }),
      }, signal);
      return readTranslation(body?.choices?.[0]?.message?.content);
    },
  } : null;

  return { transcriber, translator };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function subtitlesOpenAiPlugin(yolo) {
  const { options, env } = yolo;
  const { transcriber, translator } = createOpenAiSpeech({
    url: options.url,
    transcribeModel: options.transcribeModel ?? DEFAULT_TRANSCRIBE_MODEL,
    translateUrl: options.translateUrl ?? null,
    translateModel: options.translateModel ?? null,
    language: options.language ?? DEFAULT_LANGUAGE,
    apiKey: options.apiKey ?? env.SUBTITLES_OPENAI_API_KEY ?? null,
  });
  yolo.registerTranscriber(TRANSCRIBER_ID, transcriber);
  if (translator) yolo.registerTranslator(TRANSLATOR_ID, translator);
}
