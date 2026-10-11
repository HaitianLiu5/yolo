import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Subtitles of web videos, ported from the Drive-In server: pick one format
// per language from yt-dlp's JSON, download it on demand, turn SRT and
// YouTube's segmented caption playlists into plain WebVTT, and keep it in the
// plugin's cache directory.

const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
// Automatic captions exist in every language YouTube can translate to; only
// offer the ones people here read.
const AUTO_CAPTION_LANGUAGES = /^(en|zh)/i;

export function srtToVtt(srt) {
  return `WEBVTT\n\n${String(srt).replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
}

function pickFormat(formats = []) {
  return formats.find((format) => format.ext === "vtt" && format.url)
    || formats.find((format) => format.ext === "srt" && (format.url || format.data))
    || formats.find((format) => format.data);
}

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
    entries.push({ key: lang, lang, name: pick.name || lang, auto: false, url: pick.url || null, data: pick.data || null, ext: pick.ext });
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
// to them (the same ids the 0.2 plugin and the legacy bridge used).
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

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Subtitle download answered ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SUBTITLE_BYTES) throw new Error("Subtitle is larger than 20 MiB");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_SUBTITLE_BYTES) throw new Error("Subtitle is larger than 20 MiB");
  return text;
}

async function fetchWithRetry(url, fetchImpl, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchText(url, fetchImpl);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((done) => setTimeout(done, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

// WebVTT text for one entry.
export async function downloadVtt(entry, { fetchImpl = (...args) => fetch(...args) } = {}) {
  let content;
  if (entry.data) {
    content = entry.ext === "srt" ? srtToVtt(entry.data) : entry.data;
  } else if (entry.url) {
    content = await fetchWithRetry(entry.url, fetchImpl);
    // Long YouTube videos get their captions as an HLS playlist of segments.
    if (content.startsWith("#EXTM3U")) {
      const parts = [];
      let bytes = 0;
      for (const segment of content.split("\n").filter((line) => line.startsWith("http"))) {
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
// directory, subtitles are downloaded each time they are asked for.
export function createSubtitleStore({ dir = null, fetchImpl } = {}) {
  const pending = new Map();
  const fileFor = (videoKey, entry) => {
    const lang = String(entry.key).normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "unknown";
    return join(dir, "subs", createHash("sha256").update(videoKey).digest("hex").slice(0, 24), `sub_${lang}.vtt`);
  };
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
      })();
      pending.set(key, download);
      try {
        return await download;
      } finally {
        pending.delete(key);
      }
    },
  };
}
