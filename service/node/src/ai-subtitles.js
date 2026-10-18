import { toYoloError, YoloError } from "@useyolo/core";
import { silentLogger } from "./log.js";
import { createAudioReader } from "./media/audio.js";
import { normalizeTranscript, normalizeTranslation } from "./speech.js";

// AI subtitles (Agent Note 2026-10-18-ai-subtitles): text tracks the node
// makes from an item's sound while it plays, for an item without subtitles in
// a language the owner reads, such as a live stream, which has none. A
// transcriber plugin turns each stretch of sound into timed text and a
// translator plugin turns that text into its language (speech.js). With no
// transcriber, streams offer no AI track; with no translator, only the
// original words.
//
// The work follows the screen. A device reads an AI track as a growing VTT:
// it asks again every few seconds for the cues of a window around its
// position (`?start=&end=`, seconds), and that window is what the node works
// on next, from its start. Sound is read in chunks of fixed length: 30
// seconds of a fixed-length item, Whisper's own window; whole segments adding
// up to at least 15 seconds of a live stream, which plays about 30 seconds
// behind its live edge, so a chunk's text is ready before the screen reaches
// it. One chunk is transcribed and one translated at a time on this node,
// the most recently asked item first; an item nobody asked about for a minute
// gets no more work. A failed chunk is tried again 20 seconds later, when a
// screen still asks.
//
// Times are the device's subtitle times: seconds into a fixed-length item,
// or seconds since the first segment of a live stream's DVR.

const ORIGINAL_TRACK = "ai-original";
const TRACK_PREFIX = "ai-";
const FILE_CHUNK_SECONDS = 30;
const LIVE_CHUNK_SECONDS = 15;
const WANT_TTL_MS = 60_000;
const RETRY_MS = 20_000;
const MAX_ITEMS = 8;
const MAX_CHUNKS = 4_000;
const MAX_WINDOW_SECONDS = 600;
const READ_TIMEOUT_MS = 60_000;
const WORK_TIMEOUT_MS = 120_000;
// What a transcriber is told of what came before, and a translator.
const PROMPT_CHARS = 400;
const CONTEXT_LINES = 6;

const pad = (value, length = 2) => String(value).padStart(length, "0");

function vttTime(seconds) {
  const millis = Math.round(seconds * 1000);
  const hours = Math.floor(millis / 3_600_000);
  return `${pad(hours)}:${pad(Math.floor(millis / 60_000) % 60)}:${pad(Math.floor(millis / 1000) % 60)}.${pad(millis % 1000, 3)}`;
}

const escapeCue = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/-->/g, "→");

function toVtt(cues) {
  return `WEBVTT\n\n${cues.map(({ start, end, text }) => `${vttTime(start)} --> ${vttTime(end)}\n${escapeCue(text)}\n\n`).join("")}`;
}

const isAiTrack = (id) => String(id).startsWith(TRACK_PREFIX);

// Runs `work(signal)`, aborted after `ms`.
async function bounded(ms, work) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new YoloError("resolve_failed", "The speech service took too long")), ms);
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `speech` is the plugin host's speech registry (speech.js). An audio source
 * is what media/pipeline.js says a session plays now: { duration, input,
 * live }, where `live` is { segmentDuration, latestSequence, segmentUrl,
 * headers } for a live stream, or null when the session is gone.
 */
export function createAiSubtitles({ speech, logger = silentLogger } = {}) {
  const now = () => Date.now();
  const audio = createAudioReader({ logger });
  const items = new Map(); // key → item, least recently used first
  const lanes = { transcribe: false, translate: false };

  const translatedTrack = () => {
    const translator = speech.translator();
    return translator ? `${TRACK_PREFIX}${translator.impl.language}` : null;
  };

  // Chunk `index` of an item: its sound's span, and for a live stream its segments.
  function chunkOf(item, index) {
    let chunk = item.chunks.get(index);
    if (!chunk) {
      const span = item.live ? item.live.count * item.live.segmentDuration : FILE_CHUNK_SECONDS;
      chunk = { index, start: index * span, end: (index + 1) * span, transcript: null, translation: null, busy: { transcribe: false, translate: false }, failedAt: { transcribe: 0, translate: 0 } };
      item.chunks.set(index, chunk);
      if (item.chunks.size > MAX_CHUNKS) item.chunks.delete(item.chunks.keys().next().value);
    }
    return chunk;
  }

  // Learn a live stream's segments from its first source: a chunk is whole
  // segments adding up to at least LIVE_CHUNK_SECONDS.
  function learn(item, source) {
    if (!source || item.geometry) return;
    if (source.live) {
      const segmentDuration = Number(source.live.segmentDuration);
      if (!(segmentDuration > 0)) return;
      item.live = { segmentDuration, count: Math.max(1, Math.ceil(LIVE_CHUNK_SECONDS / segmentDuration)) };
    }
    item.geometry = true;
  }

  const span = (item) => (item.live ? item.live.count * item.live.segmentDuration : FILE_CHUNK_SECONDS);
  const indexAt = (item, seconds) => Math.max(0, Math.floor(seconds / span(item)));

  // Whether chunk `index` can be read now: inside a fixed-length item, or
  // published already on a live stream.
  function readable(item, source, index) {
    if (!source) return false;
    if (item.live) return Boolean(source.live) && (index + 1) * item.live.count - 1 <= source.live.latestSequence;
    return !(source.duration > 0) || index * FILE_CHUNK_SECONDS < source.duration;
  }

  const recent = (at) => at > 0 && now() - at < WANT_TTL_MS;

  function nextJob(lane) {
    const wanted = [...items.values()].filter((item) => item.want && recent(item.want.at) && (lane === "transcribe" || recent(item.translateAt)));
    wanted.sort((a, b) => b.want.at - a.want.at);
    for (const item of wanted) {
      if (!item.geometry) continue;
      const source = item.source();
      for (let index = indexAt(item, item.want.start); index <= indexAt(item, item.want.end); index += 1) {
        if (!readable(item, source, index)) break;
        const chunk = chunkOf(item, index);
        if (chunk.busy[lane] || now() - chunk.failedAt[lane] < RETRY_MS) continue;
        if (lane === "transcribe" && !chunk.transcript) return { item, chunk, source };
        if (lane === "translate" && chunk.transcript && !chunk.translation) return { item, chunk, source };
      }
    }
    return null;
  }

  // The last lines of the chunk before, for context.
  const before = (item, chunk) => item.chunks.get(chunk.index - 1)?.transcript?.segments.slice(-CONTEXT_LINES).map(({ text }) => text) ?? [];

  async function transcribe(item, chunk, source) {
    const transcriber = speech.transcriber();
    if (!transcriber) return;
    const seconds = chunk.end - chunk.start;
    const sound = item.live
      ? await audio.readLive(source.live, { from: chunk.index * item.live.count, to: (chunk.index + 1) * item.live.count - 1, timeoutMs: READ_TIMEOUT_MS })
      : await audio.read(source.input, { start: chunk.start, seconds: Math.min(seconds, source.duration > 0 ? source.duration - chunk.start : seconds), timeoutMs: READ_TIMEOUT_MS });
    const prompt = [item.title, ...before(item, chunk)].filter(Boolean).join("\n").slice(-PROMPT_CHARS) || null;
    const result = await bounded(WORK_TIMEOUT_MS, (signal) => transcriber.impl.transcribe({ audio: sound, format: "wav", language: null, prompt, signal }));
    const { language, segments } = normalizeTranscript(result, seconds);
    chunk.transcript = { language, segments: segments.map((segment) => ({ ...segment, start: segment.start + chunk.start, end: segment.end + chunk.start })) };
  }

  async function translate(item, chunk) {
    const translator = speech.translator();
    if (!translator) return;
    const lines = chunk.transcript.segments.map(({ text }) => text);
    if (!lines.length) {
      chunk.translation = [];
      return;
    }
    const result = await bounded(WORK_TIMEOUT_MS, (signal) => translator.impl.translate({
      lines, from: chunk.transcript.language, to: translator.impl.language, title: item.title, previous: before(item, chunk), signal,
    }));
    chunk.translation = normalizeTranslation(result, lines.length);
  }

  function pump() {
    for (const lane of ["transcribe", "translate"]) {
      if (lanes[lane]) continue;
      const job = nextJob(lane);
      if (!job) continue;
      const { item, chunk, source } = job;
      lanes[lane] = true;
      chunk.busy[lane] = true;
      (lane === "transcribe" ? transcribe(item, chunk, source) : translate(item, chunk))
        .then(() => {
          item.error = null;
        })
        .catch((error) => {
          const { message } = toYoloError(error);
          chunk.failedAt[lane] = now();
          item.error = { message, at: now() };
          logger.warn({ lane, at: chunk.start, err: message }, "AI subtitle chunk failed");
        })
        .finally(() => {
          chunk.busy[lane] = false;
          lanes[lane] = false;
          pump();
        });
    }
  }

  function itemFor(key, title, source) {
    let item = items.get(key);
    if (item) items.delete(key);
    item ??= { key, chunks: new Map(), geometry: false, live: null, want: null, translateAt: 0, error: null };
    items.set(key, item);
    if (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
    item.title = title || null;
    item.source = source;
    learn(item, source());
    return item;
  }

  function cuesOf(item, trackId, window) {
    const cues = [];
    const chunks = [...item.chunks.values()].sort((a, b) => a.index - b.index);
    for (const chunk of chunks) {
      if (!chunk.transcript || (window && (chunk.end <= window.start || chunk.start >= window.end))) continue;
      const lines = trackId === ORIGINAL_TRACK ? chunk.transcript.segments.map(({ text }) => text) : chunk.translation;
      if (!lines) continue;
      chunk.transcript.segments.forEach(({ start, end }, index) => {
        if (lines[index]) cues.push({ start, end, text: lines[index] });
      });
    }
    return cues;
  }

  return {
    /** Whether a transcriber is registered. */
    available: () => Boolean(speech.transcriber()),

    owns: (trackId) => isAiTrack(trackId),

    /** The AI tracks a stream offers: the translation first, then the original words. */
    tracks() {
      if (!speech.transcriber()) return [];
      const translated = translatedTrack();
      const track = (id, language, name) => ({ id, language, name, auto: true, format: "text", default: false, delivery: "vtt", growing: true });
      return [
        ...(translated ? [track(translated, speech.translator().impl.language, "")] : []),
        track(ORIGINAL_TRACK, "", "Original"),
      ];
    },

    /**
     * The WebVTT of an AI track: its cues inside `window` ({ start, end },
     * seconds), which also becomes the work to do next, or all its cues
     * without one. `source()` is the session's audio source now.
     */
    vtt({ key, title = null, trackId, window = null, source }) {
      if (!speech.transcriber()) throw new YoloError("not_found", "No transcriber plugin is loaded on this media node");
      if (trackId !== ORIGINAL_TRACK && trackId !== translatedTrack()) throw new YoloError("not_found", "Unknown subtitle");
      const item = itemFor(key, title, source);
      let range = null;
      if (window) {
        const start = Math.max(0, Number(window.start));
        const end = Math.min(Number(window.end), start + MAX_WINDOW_SECONDS);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new YoloError("invalid_request", "start and end are seconds, start <= end");
        range = { start, end };
        item.want = { start, end, at: now() };
        if (trackId !== ORIGINAL_TRACK) item.translateAt = now();
        pump();
      }
      const cues = cuesOf(item, trackId, range);
      // A service that fails while nothing has worked yet is said, so the
      // screen can tell the owner; later failures are retried quietly.
      if (range && !cues.length && item.error && recent(item.error.at) && ![...item.chunks.values()].some((chunk) => chunk.transcript)) {
        throw new YoloError("resolve_failed", `AI subtitles failed: ${item.error.message}`);
      }
      return toVtt(cues);
    },
  };
}
