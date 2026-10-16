import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { YoloError } from "@useyolo/plugin-api";

// Subtitles of web videos: pick one format
// per language from yt-dlp's JSON, download it on demand, turn SRT and
// YouTube's segmented caption playlists into plain WebVTT, and keep it in the
// plugin's cache directory.

const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
// A site that answers 429 for a subtitle (YouTube does for its machine
// translations) is not asked for it again until its Retry-After has passed;
// without one, RATE_LIMIT_MS, doubling with each refusal in a row, at most
// MAX_RATE_LIMIT_MS. Asking again at once only lengthens the limit, which
// then refuses the site's other subtitles too.
const RATE_LIMIT_MS = 60_000;
const MAX_RATE_LIMIT_MS = 15 * 60_000;
const RATE_LIMIT_ENTRIES = 256;
// Automatic captions exist in every language YouTube can translate to; only
// offer the ones people here read.
const AUTO_CAPTION_LANGUAGES = /^(en|zh)/i;

function srtToVtt(srt) {
  return `WEBVTT\n\n${String(srt).replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
}

// A whole file before a segmented one (an HLS or DASH subtitle rendition).
const isWholeFile = (format) => !/m3u8|dash/.test(String(format.protocol || "")) && !format.manifest_url;

function pickFormat(formats = []) {
  return formats.find((format) => format.ext === "vtt" && format.url && isWholeFile(format))
    || formats.find((format) => format.ext === "vtt" && format.url)
    || formats.find((format) => format.ext === "srt" && (format.url || format.data))
    || formats.find((format) => format.data);
}

// Vimeo lists its machine-made captions as subtitles in `<lang>-x-autogen`.
const GENERATED = /-x-autogen$/i;

// One entry per language: { key, lang, name, auto, url, data, ext }. An
// automatic caption in a language that also has a real subtitle gets the key
// `<lang>-auto`.
export function subtitleEntries(info = {}) {
  const entries = [];
  const manual = new Set();
  for (const [lang, formats] of Object.entries(info.subtitles || {})) {
    if (lang === "danmaku" || lang === "live_chat") continue;
    const pick = pickFormat(formats);
    if (!pick) continue;
    manual.add(lang);
    const auto = GENERATED.test(lang);
    const base = lang.replace(GENERATED, "");
    entries.push({ key: lang, lang: base, name: auto ? `${pick.name || base} (auto)` : pick.name || lang, auto, url: pick.url || null, data: pick.data || null, ext: pick.ext });
  }
  for (const [lang, formats] of Object.entries(info.automatic_captions || {})) {
    if (!AUTO_CAPTION_LANGUAGES.test(lang) || lang.includes("-orig")) continue;
    const pick = pickFormat(formats);
    if (!pick) continue;
    const key = manual.has(lang) ? `${lang}-auto` : lang;
    entries.push({ key, lang, name: `${pick.name || lang} (auto)`, auto: true, url: pick.url || null, data: pick.data || null, ext: pick.ext });
  }
  return entries;
}

export function hasEnglishAndChinese(entries = []) {
  const bases = new Set(entries.map((entry) => entry.lang.split("-")[0].toLowerCase()));
  return bases.has("en") && bases.has("zh");
}

export function mergeEntries(primary = [], fallback = []) {
  const merged = [...primary];
  const keys = new Set(primary.map((entry) => entry.key));
  for (const entry of fallback) {
    if (keys.has(entry.key)) continue;
    merged.push(entry);
    keys.add(entry.key);
  }
  return merged;
}

// Track ids are `s_<key>`, stable for the same video, as saved choices refer
// to them, including choices saved by earlier releases.
export function trackFromEntry(entry) {
  return {
    id: `s_${entry.key}`,
    kind: "subtitle",
    language: entry.lang,
    name: entry.name,
    auto: entry.auto,
    format: "text",
    default: false,
    delivery: "vtt",
  };
}

function cleanVtt(content) {
  return content
    .replace(/<\/?c[^>]*>/g, "")
    .replace(/<[\d:.]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// The wait a 429's Retry-After asks for, in milliseconds (seconds or an
// HTTP date), or null without a usable one.
function retryAfterMs(value, now = Date.now()) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function rateLimited(url, waitMs) {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  let host = "The site";
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a URL: keep the generic name.
  }
  return new YoloError("rate_limited", `${host} is limiting subtitle downloads; try again in ${seconds} s`, { details: { retryAfter: seconds } });
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    const error = rateLimited(url, 0);
    // What the site asked for; the store decides the wait.
    error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
    throw error;
  }
  if (!response.ok) throw new Error(`Subtitle download answered ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SUBTITLE_BYTES) throw new Error("Subtitle is larger than 20 MiB");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_SUBTITLE_BYTES) throw new Error("Subtitle is larger than 20 MiB");
  return text;
}

// Other failures are tried three times; a 429 is not tried again.
async function fetchWithRetry(url, fetchImpl, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchText(url, fetchImpl);
    } catch (error) {
      lastError = error;
      if (error.code === "rate_limited") break;
      if (attempt < retries) await new Promise((done) => setTimeout(done, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

// WebVTT text for one entry.
async function downloadVtt(entry, { fetchImpl = (...args) => fetch(...args) } = {}) {
  let content;
  if (entry.data) {
    content = entry.ext === "srt" ? srtToVtt(entry.data) : entry.data;
  } else if (entry.url) {
    content = await fetchWithRetry(entry.url, fetchImpl);
    // Long YouTube videos get their captions as an HLS playlist of segments,
    // and a subtitle rendition of any HLS stream is one.
    if (content.startsWith("#EXTM3U")) {
      const parts = [];
      let bytes = 0;
      const segments = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
      for (const segment of segments.map((line) => new URL(line, entry.url).href)) {
        const part = await fetchWithRetry(segment, fetchImpl);
        bytes += Buffer.byteLength(part);
        if (bytes > MAX_SUBTITLE_BYTES) throw new Error("Combined subtitle segments are larger than 20 MiB");
        parts.push(part);
      }
      content = parts.map((part, index) => (index === 0 ? part : part.replace(/^WEBVTT[\s\S]*?\n\n/, ""))).join("\n");
    }
    if (entry.ext === "srt" && !content.startsWith("WEBVTT")) content = srtToVtt(content);
  } else {
    throw new Error("This subtitle has nothing to download");
  }
  if (!content.includes("-->")) throw new Error("The subtitle has no cues");
  return cleanVtt(content);
}

// A disk cache of downloaded WebVTT, one directory per video. Without a cache
// directory, subtitles are downloaded each time they are asked for. A
// subtitle the site refused with 429 throws `rate_limited` with
// `details.retryAfter` (seconds) until its wait is over, without asking the
// site; a cached file is served all the same.
export function createSubtitleStore({ dir = null, fetchImpl, now = () => Date.now() } = {}) {
  const pending = new Map();
  const limited = new Map(); // video and subtitle key → { until, waitMs, url }
  const fileFor = (videoKey, entry) => {
    const lang = String(entry.key).normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "unknown";
    return join(dir, "subs", createHash("sha256").update(videoKey).digest("hex").slice(0, 24), `sub_${lang}.vtt`);
  };
  function noteLimit(key, url, askedMs) {
    const previous = limited.get(key);
    const waitMs = Math.min(MAX_RATE_LIMIT_MS, askedMs ?? (previous ? previous.waitMs * 2 : RATE_LIMIT_MS));
    limited.delete(key);
    limited.set(key, { until: now() + waitMs, waitMs, url });
    while (limited.size > RATE_LIMIT_ENTRIES) limited.delete(limited.keys().next().value);
    return rateLimited(url, waitMs);
  }
  return {
    async get(videoKey, entry) {
      const file = dir ? fileFor(videoKey, entry) : null;
      if (file) {
        try {
          return await readFile(file, "utf8");
        } catch {
          // Not cached yet.
        }
      }
      const key = `${videoKey}\n${entry.key}`;
      const limit = limited.get(key);
      if (limit && limit.until > now()) throw rateLimited(limit.url, limit.until - now());
      if (pending.has(key)) return pending.get(key);
      const download = (async () => {
        const vtt = await downloadVtt(entry, { fetchImpl });
        if (file) {
          await mkdir(join(file, ".."), { recursive: true });
          const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
          await writeFile(temporary, vtt);
          await rename(temporary, file);
        }
        return vtt;
      })().then((vtt) => {
        limited.delete(key);
        return vtt;
      }, (error) => {
        throw error.code === "rate_limited" ? noteLimit(key, entry.url, error.retryAfterMs) : error;
      });
      pending.set(key, download);
      try {
        return await download;
      } finally {
        pending.delete(key);
      }
    },
  };
}
