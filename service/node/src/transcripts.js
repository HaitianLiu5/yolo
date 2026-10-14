import { formatTimestamp, normalizeSource, sourceKey, trackLanguage, YoloError } from "@useyolo/core";

// Transcripts for agents (Agent Note 2026-10-07-remote-mcp-server): the text
// of a subtitle track as timed cues, sliced by time under a size cap or
// searched, so an agent can say what was said and seek to it. The text comes
// from the WebVTT the node already serves: the playing session's own
// subtitle(), else the source's subtitle(source, trackId). Image subtitles
// are pictures and have no text. Parsed cues are cached per item and track,
// bounded by entries, characters, and age.

const TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&lrm;": "", "&rlm;": "" };

function seconds(stamp) {
  const parts = stamp.replace(",", ".").split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

const cleanLine = (line) => line
  .replace(/<[^>]*>/g, "")
  .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp|lrm|rlm);/g, (entity) => ENTITIES[entity])
  .replace(/\{\\[^}]*\}/g, "")
  .replace(/\s+/g, " ")
  .trim();

const round = (value) => Math.round(value * 1000) / 1000;

/**
 * WebVTT (or SRT-style timings) → [{ start, end, text }] in seconds, one line
 * of text per cue, sorted. Rolling captions repeat the previous cue's line:
 * a line the cue just before already had is dropped, and a cue left with
 * nothing new only extends that cue.
 */
export function parseVtt(vtt) {
  const raw = [];
  for (const block of String(vtt ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const index = lines.findIndex((line) => TIMING.test(line));
    if (index === -1) continue;
    const [, from, to] = TIMING.exec(lines[index]);
    const start = seconds(from);
    const end = seconds(to);
    const textLines = lines.slice(index + 1).map(cleanLine).filter(Boolean);
    if (!textLines.length || !(end >= start)) continue;
    raw.push({ start, end, lines: textLines });
  }
  raw.sort((a, b) => a.start - b.start);
  const cues = [];
  let previous = null;
  for (const cue of raw) {
    const fresh = previous && cue.start - previous.end <= 1
      ? cue.lines.filter((line) => !previous.lines.includes(line))
      : cue.lines;
    if (!fresh.length && previous) {
      previous.cue.end = round(Math.max(previous.cue.end, cue.end));
      previous.end = Math.max(previous.end, cue.end);
      continue;
    }
    const entry = { start: round(cue.start), end: round(cue.end), text: fresh.join(" ") };
    cues.push(entry);
    previous = { cue: entry, lines: cue.lines, end: cue.end };
  }
  return cues;
}

const line = (cue) => `${formatTimestamp(cue.start)} ${cue.text}`;

/**
 * The cues that overlap [from, to) as "m:ss text" lines, at most `maxChars`
 * characters of them. `nextFrom` is where the next page starts when the cap
 * cut the range short, else null.
 */
export function sliceCues(cues, { from = 0, to = Infinity, maxChars = 6000 } = {}) {
  const start = Math.max(0, Number(from) || 0);
  const end = to == null || !Number.isFinite(Number(to)) ? Infinity : Number(to);
  const lines = [];
  let size = 0;
  let nextFrom = null;
  for (const cue of cues) {
    if (cue.end <= start || cue.start >= end) continue;
    const text = line(cue);
    if (lines.length && size + text.length + 1 > maxChars) {
      nextFrom = cue.start;
      break;
    }
    lines.push(text);
    size += text.length + 1;
  }
  return { text: lines.join("\n"), count: lines.length, nextFrom };
}

// Lowercase, without accents or punctuation, for matching.
const fold = (value) => String(value ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim();

const excerpt = (value, max = 200) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);
// Neighbouring cues searched together, at most this far apart in time.
const WINDOW_SECONDS = 20;

/**
 * Where `query` is said: [{ at, time, text }], in order. The whole phrase
 * matches first, across cue boundaries; when it is never said, every word of
 * it within one cue, then within two or three neighbouring cues.
 */
export function searchCues(cues, query, { limit = 10 } = {}) {
  const phrase = fold(query);
  if (!phrase) throw new YoloError("invalid_request", "query is required");
  const folded = cues.map((cue) => fold(cue.text));
  const offsets = [];
  let joined = "";
  for (const text of folded) {
    offsets.push(joined.length);
    joined += `${text} `;
  }
  const cueAt = (offset) => {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (offsets[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const hits = [];
  for (let found = joined.indexOf(phrase); found !== -1; found = joined.indexOf(phrase, found + 1)) {
    const first = cueAt(found);
    const last = cueAt(found + phrase.length - 1);
    if (hits.at(-1)?.first === first) continue;
    hits.push({ first, last });
  }
  if (!hits.length) {
    const terms = [...new Set(phrase.split(" "))];
    for (let size = 1; size <= 3 && !hits.length && terms.length > 1; size += 1) {
      let after = -1;
      for (let first = 0; first + size <= cues.length; first += 1) {
        const last = first + size - 1;
        if (first <= after || cues[last].start - cues[first].start > WINDOW_SECONDS) continue;
        const window = folded.slice(first, last + 1).join(" ");
        if (!terms.every((term) => window.includes(term))) continue;
        hits.push({ first, last });
        after = last;
      }
    }
  }
  const max = Math.min(50, Math.max(1, Math.floor(Number(limit) || 10)));
  return hits.slice(0, max).map(({ first, last }) => ({
    at: cues[first].start,
    time: formatTimestamp(cues[first].start),
    text: excerpt(cues.slice(first, last + 1).map((cue) => cue.text).join(" ")),
  }));
}

/**
 * The subtitle track a transcript reads: `track` (an id) or `language` when
 * asked, else the first text track the user has selected, else the source's
 * default text track, else the first text track that is not automatic, else
 * any text track.
 */
export function chooseTextTrack(tracks, { track = null, language = null, selected = [] } = {}) {
  const all = Array.isArray(tracks) ? tracks : [];
  const isText = (entry) => (entry.format || "text") === "text";
  const describe = (entry) => `${entry.id} (${entry.name || entry.language || "?"})`;
  if (track != null && track !== "") {
    const asked = all.find((entry) => String(entry.id) === String(track));
    if (!asked) throw new YoloError("not_found", `No subtitle track ${track}; list_tracks shows this item's tracks`);
    if (!isText(asked)) throw new YoloError("invalid_request", `${describe(asked)} is an image subtitle: it is pictures, not text, so it has no transcript. Choose a text track.`);
    return asked;
  }
  const text = all.filter(isText);
  if (!all.length) throw new YoloError("not_found", "This item has no subtitles or captions, so there is no transcript");
  if (!text.length) throw new YoloError("not_found", "This item has only image subtitles (pictures, not text), so there is no transcript");
  if (language) {
    const wanted = trackLanguage(language);
    const matching = text.filter((entry) => trackLanguage(entry.language) === wanted);
    if (!matching.length) {
      const languages = [...new Set(text.map((entry) => trackLanguage(entry.language)).filter(Boolean))].sort();
      throw new YoloError("not_found", `No text subtitles in "${language}"; this item has ${languages.join(", ") || "unlabelled ones"}`);
    }
    return matching.find((entry) => !entry.auto) ?? matching[0];
  }
  const chosen = (Array.isArray(selected) ? selected : []).map(String);
  return text.find((entry) => chosen.includes(String(entry.id)))
    ?? text.find((entry) => entry.default)
    ?? text.find((entry) => !entry.auto)
    ?? text[0];
}

/** An LRU of parsed cues per item and track, bounded by entries, characters, and age. */
export function createTranscriptCache({ maxEntries = 24, maxChars = 8_000_000, ttlMs = 60 * 60_000, now = () => Date.now() } = {}) {
  const entries = new Map(); // key → { cues, chars, at }
  let chars = 0;
  const drop = (key) => {
    chars -= entries.get(key)?.chars ?? 0;
    entries.delete(key);
  };
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (now() - entry.at > ttlMs) {
        drop(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.cues;
    },
    set(key, cues) {
      drop(key);
      const size = cues.reduce((total, cue) => total + cue.text.length + 16, 0);
      if (size > maxChars) return;
      entries.set(key, { cues, chars: size, at: now() });
      chars += size;
      while (entries.size > maxEntries || chars > maxChars) drop(entries.keys().next().value);
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * Transcripts over the source registry and the media pipeline. `cues()`
 * resolves the track and its parsed cues; `sessionId` names the session that
 * plays this item now, whose tracks and subtitle text are used first.
 */
export function createTranscripts({ sources, media = null, cache = createTranscriptCache() }) {
  async function trackList(source, session) {
    if (session?.descriptor?.tracks?.subtitles) return session.descriptor.tracks.subtitles;
    return (await sources.tracks(source)).subtitles ?? [];
  }

  async function vtt(source, session, trackId) {
    const result = typeof session?.descriptor?.subtitle === "function"
      ? await session.descriptor.subtitle(trackId)
      : await sources.subtitle(source, trackId);
    if (result && typeof result === "object" && result.pending) {
      const wait = Math.max(1, Math.round(Number(result.retryAfter) || 5));
      throw new YoloError("resolve_failed", `The subtitle text is still being prepared; try again in about ${wait} seconds`, { retryable: true });
    }
    if (typeof result !== "string") throw new YoloError("not_found", "The source returned no subtitle text");
    return result;
  }

  return {
    async cues({ source: input, sessionId = null, track = null, language = null, selected = [] }) {
      const source = sources.require(normalizeSource(input));
      const candidate = sessionId && media ? media.session(String(sessionId)) : null;
      const session = candidate && sourceKey(candidate.source) === sourceKey(source) ? candidate : null;
      const chosen = chooseTextTrack(await trackList(source, session), { track, language, selected });
      const key = `${sourceKey(source)}\n${chosen.id}`;
      let cues = cache.get(key);
      if (!cues) {
        cues = parseVtt(await vtt(source, session, String(chosen.id)));
        cache.set(key, cues);
      }
      return {
        track: { id: String(chosen.id), language: chosen.language || "", name: chosen.name || "", ...(chosen.auto ? { auto: true } : {}) },
        cues,
      };
    },
  };
}
