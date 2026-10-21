import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { Worker } from "node:worker_threads";
import { extname, resolve } from "node:path";
import { YoloError } from "@useyolo/plugin-api";

// Plex subtitles: which streams are text
// (rendered by the player as WebVTT) and which are images (burned in by
// Plex's transcoder), converting ASS/SSA/SRT to WebVTT in a worker thread,
// extracting text tracks embedded in the media file with ffmpeg (the whole
// track, or a window of it while the whole one is not ready), and a
// memory + disk cache of the results in the plugin's cache directory.

const TEXT_SUBTITLE_CODECS = new Set(["ass", "ssa", "srt", "subrip", "vtt", "webvtt"]);
const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;
const SUBTITLE_CONVERSION_VERSION = 5;

export function isEmbeddedPlexTextSubtitle(stream) {
  return isPlexTextSubtitle(stream)
    && !stream?.file
    && !stream?.key
    && (typeof stream?.sourceFile === "string" || typeof stream?.sourceKey === "string")
    && Number.isInteger(Number(stream?.sourceStreamIndex))
    && Number(stream.sourceStreamIndex) >= 0;
}

// A subtitle stream inside the part's file gets the file's path and size as
// Plex reports them, its index in the file, and the part's key, which reads
// the file through Plex when the node cannot read the path.
export function plexSubtitleStreamsForPart(part) {
  return (part?.Stream || []).map((stream) => {
    if (stream.streamType !== 3 || stream.file || stream.key || !(part?.file || part?.key)) return stream;
    return {
      ...stream,
      ...(part.file ? { sourceFile: part.file } : {}),
      ...(Number(part.size) > 0 ? { sourceSize: Number(part.size) } : {}),
      ...(part.key ? { sourceKey: part.key } : {}),
      sourceStreamIndex: Number(stream.index),
    };
  });
}

async function localSubtitleStats(stream) {
  const path = stream?.file;
  if (!path || !TEXT_SUBTITLE_CODECS.has(extname(path).slice(1).toLowerCase())) return null;
  try {
    const stats = await stat(path, { bigint: true });
    return stats.isFile() ? stats : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  }
}

// Which version of a subtitle the cache holds. A subtitle in a file is named
// by the file, not by Plex's ids: a sidecar by its path, size, and
// modification time; an embedded one by its file's path and size as Plex
// reports them and its index in that file. So its WebVTT survives a library
// rescan that gives the item and its streams new ids (`stable`). Anything
// else is named by Plex's ids and revalidated hourly. `sourceAvailable`:
// the node can read an embedded subtitle's file by its path.
export async function plexSubtitleVersionInfo(stream, { now = Date.now() } = {}) {
  const codec = stream?.codec || stream?.format;
  const stats = await localSubtitleStats(stream);
  let sourceStats = null;
  if (!stats && isEmbeddedPlexTextSubtitle(stream) && stream.sourceFile) {
    try {
      const candidate = await stat(stream.sourceFile, { bigint: true });
      if (candidate.isFile()) sourceStats = candidate;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  const sourceSize = Number(stream?.sourceSize) || (sourceStats ? Number(sourceStats.size) : 0);
  let parts;
  if (stats) {
    parts = ["file", codec, stream.file, stats.size, stats.mtimeNs];
  } else if (isEmbeddedPlexTextSubtitle(stream) && stream.sourceFile && sourceSize) {
    parts = ["embedded", codec, stream.sourceFile, sourceSize, stream.sourceStreamIndex];
  } else {
    // Plex does not reliably expose validators for every remote/embedded text
    // stream. Revalidate these hourly instead of making them immutable forever.
    parts = ["plex", codec, stream?.id, stream?.key, stream?.updatedAt, `hour:${Math.floor(now / 3600_000)}`];
  }
  const stable = parts[0] !== "plex";
  return {
    token: createHash("sha256").update([SUBTITLE_CONVERSION_VERSION, ...parts].map(String).join("\0")).digest("hex").slice(0, 16),
    stable,
    immutable: stable,
    sourceAvailable: !!sourceStats,
  };
}

export function isPlexTextSubtitle(stream) {
  return TEXT_SUBTITLE_CODECS.has(String(stream?.codec || stream?.format || "").toLowerCase());
}

export async function readPlexSubtitleFile(stream) {
  const path = stream?.file;
  const stats = await localSubtitleStats(stream);
  if (!stats) return null;
  if (stats.size > BigInt(MAX_SUBTITLE_BYTES)) {
    throw new Error(`Subtitle file is too large (${stats.size} bytes)`);
  }
  return readFile(path);
}

// `input` is where ffmpeg reads the file: `{ path }`, or `{ url, headers }`
// for Plex's copy of the part. `span` ({ start, seconds }) reads only the
// subtitles that start in that stretch: ffmpeg seeks there, and its times
// then count from `start` (which the caller adds back).
function embeddedSubtitleFfmpegArgs(stream, input, span = null) {
  if (!isEmbeddedPlexTextSubtitle(stream)) {
    throw new Error("Subtitle is not an extractable embedded text stream");
  }
  if (!input?.path && !input?.url) throw new Error("The subtitle's media file cannot be read");
  const codec = String(stream.codec || stream.format || "").toLowerCase();
  const output = codec === "ass" || codec === "ssa"
    ? { codec: "ass", format: "ass" }
    : codec === "srt" || codec === "subrip"
      ? { codec: "srt", format: "srt" }
      : codec === "vtt" || codec === "webvtt"
        ? { codec: "webvtt", format: "webvtt" }
        : null;
  if (!output) throw new Error(`Unsupported embedded subtitle codec: ${codec || "unknown"}`);
  const headers = Object.entries(input.headers || {}).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  return [
    "-nostdin",
    "-v", "error",
    ...(span ? ["-ss", String(span.start)] : []),
    ...(input.url ? ["-rw_timeout", "30000000", ...(headers ? ["-headers", headers] : []), "-i", input.url] : ["-i", input.path]),
    "-map", `0:${Number(stream.sourceStreamIndex)}`,
    ...(span ? ["-t", String(span.seconds)] : []),
    "-c:s", output.codec,
    "-f", output.format,
    "pipe:1",
  ];
}

// The whole embedded track, or with `span` the part of it that starts in
// that stretch, which may be empty.
export function extractEmbeddedPlexSubtitle(stream, {
  input,
  span = null,
  execFileImpl = execFile,
  timeoutMs = span ? 2 * 60_000 : 20 * 60_000,
} = {}) {
  const args = embeddedSubtitleFfmpegArgs(stream, input, span);
  return new Promise((resolvePromise, rejectPromise) => {
    execFileImpl("ffmpeg", args, {
      encoding: "buffer",
      maxBuffer: MAX_SUBTITLE_BYTES,
      timeout: timeoutMs,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = Buffer.from(stderr || "").toString("utf8").trim().slice(-500);
        rejectPromise(new Error(detail || `Embedded subtitle extraction failed: ${error.message}`));
        return;
      }
      const buffer = Buffer.from(stdout || "");
      if (!buffer.length && !span) {
        rejectPromise(new Error("Embedded subtitle extraction returned no data"));
        return;
      }
      resolvePromise(buffer);
    });
  });
}

export class SubtitleExtractionQueue {
  constructor({ maxConcurrent = 1 } = {}) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 1);
    this.active = 0;
    this.pending = [];
    this.tasks = new Map();
  }

  has(key) {
    return this.tasks.has(key);
  }

  enqueue(key, task) {
    const existing = this.tasks.get(key);
    if (existing) return existing;

    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolveTask = resolvePromise;
      rejectTask = rejectPromise;
    });
    this.tasks.set(key, promise);
    this.pending.push({ key, task, resolveTask, rejectTask });
    this.pump();
    return promise;
  }

  pump() {
    while (this.active < this.maxConcurrent && this.pending.length) {
      const item = this.pending.shift();
      this.active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolveTask, item.rejectTask)
        .finally(() => {
          this.active -= 1;
          this.tasks.delete(item.key);
          this.pump();
        });
    }
  }
}

const WINDOW_CHUNK_SECONDS = 30;
// A window reads at most 4 minutes of the item.
const MAX_WINDOW_CHUNKS = 8;
const WINDOW_WAIT_MS = 6_000;
const CHUNK_RETRY_MS = 20_000;
const MAX_WINDOW_TRACKS = 4;

function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((done) => {
    timer = setTimeout(done, ms);
  })]).finally(() => clearTimeout(timer));
}

// The cues of one chunk: the subtitles that start in it, at their times in
// the item.
async function readWindowChunk(stream, input, index) {
  const start = index * WINDOW_CHUNK_SECONDS;
  const buffer = await extractEmbeddedPlexSubtitle(stream, { input, span: { start, seconds: WINDOW_CHUNK_SECONDS } });
  if (!buffer.length) return [];
  return vttCues(subtitleToVtt(stream, buffer, { requireCue: false }))
    .map((cue) => ({ ...cue, start: cue.start + start, end: cue.end + start }));
}

// Windows of embedded text subtitles whose whole track is not extracted yet
// (Agent Note 2026-10-07-capability-negotiation). A screen reads such a
// growing track for a window around its position; ffmpeg seeks into the
// file and reads the subtitles that start in that stretch, in 30-second
// chunks from the window's start, one at a time per track, the latest
// window first. A read waits up to 6 seconds for its window, then answers
// the cues made so far; the rest come with the screen's next read. Chunks
// stay in memory for the last 4 tracks read, and a failed chunk is tried
// again after 20 seconds.
export class SubtitleWindows {
  constructor() {
    this.tracks = new Map();
  }

  entry(key) {
    const entry = this.tracks.get(key) ?? { chunks: new Map(), failed: new Map(), wanted: [], working: null, error: null };
    this.tracks.delete(key);
    this.tracks.set(key, entry);
    while (this.tracks.size > MAX_WINDOW_TRACKS) this.tracks.delete(this.tracks.keys().next().value);
    return entry;
  }

  // The whole track is ready: its windows are no longer needed.
  forget(key) {
    this.tracks.delete(key);
  }

  missing(entry) {
    const now = Date.now();
    return entry.wanted.filter((index) => !entry.chunks.has(index) && !(now - (entry.failed.get(index) ?? -Infinity) < CHUNK_RETRY_MS));
  }

  work(entry, stream, input) {
    entry.working ||= (async () => {
      for (let index = this.missing(entry)[0]; index !== undefined; index = this.missing(entry)[0]) {
        try {
          entry.chunks.set(index, await readWindowChunk(stream, input, index));
          entry.failed.delete(index);
        } catch (error) {
          entry.failed.set(index, Date.now());
          entry.error = error;
        }
      }
    })().finally(() => {
      entry.working = null;
    });
    return entry.working;
  }

  // WebVTT of the cues made so far that overlap `window` ({ start, end },
  // seconds), after reading the window; without one, every cue made so far,
  // and nothing is read. `input` is where ffmpeg reads the file.
  async read(key, stream, input, window = null) {
    const entry = this.entry(key);
    if (window) {
      const first = Math.floor(Math.max(0, window.start) / WINDOW_CHUNK_SECONDS);
      const last = Math.max(first, Math.min(Math.ceil(window.end / WINDOW_CHUNK_SECONDS) - 1, first + MAX_WINDOW_CHUNKS - 1));
      entry.wanted = Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
      const deadline = Date.now() + WINDOW_WAIT_MS;
      while (this.missing(entry).length && Date.now() < deadline) {
        await within(this.work(entry, stream, input), deadline - Date.now());
      }
      if (!entry.chunks.size && entry.wanted.every((index) => entry.failed.has(index))) {
        throw new YoloError("resolve_failed", `The subtitle could not be read from the file: ${entry.error?.message || "unknown error"}`);
      }
    }
    const seen = new Set();
    const cues = [];
    for (const chunk of entry.chunks.values()) {
      for (const cue of chunk) {
        const id = `${cue.start.toFixed(2)}|${cue.end.toFixed(2)}|${cue.text}`;
        if (seen.has(id)) continue;
        seen.add(id);
        cues.push(cue);
      }
    }
    return windowVtt(cues.sort((left, right) => left.start - right.start || left.end - right.end), window);
  }
}

function decodeSubtitleBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    // Older Chinese subtitle collections are often GB18030/GBK encoded.
    return new TextDecoder("gb18030").decode(bytes).replace(/^\uFEFF/, "");
  }
}

function assTimestampToVtt(value) {
  const match = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{1,3})$/);
  if (!match) return null;
  const milliseconds = match[4].padEnd(3, "0").slice(0, 3);
  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3]}.${milliseconds}`;
}

function splitAssFields(line, fieldCount) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < fieldCount - 1; index += 1) {
    const comma = line.indexOf(",", start);
    if (comma === -1) return null;
    fields.push(line.slice(start, comma));
    start = comma + 1;
  }
  fields.push(line.slice(start));
  return fields;
}

function cleanAssText(text) {
  const lines = String(text)
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const classified = lines.map((line, index) => {
    const latinCount = (line.match(/\p{Script=Latin}/gu) || []).length;
    const hanCount = (line.match(/\p{Script=Han}/gu) || []).length;
    return {
      line,
      index,
      kind: latinCount > hanCount ? "english" : hanCount > 0 ? "chinese" : "other",
    };
  });
  const isBilingual = classified.some((entry) => entry.kind === "english")
    && classified.some((entry) => entry.kind === "chinese");
  if (isBilingual) {
    const rank = { english: 0, chinese: 1, other: 2 };
    classified.sort((left, right) => rank[left.kind] - rank[right.kind] || left.index - right.index);
  }
  return classified.map((entry) => entry.line).join("\n");
}

function parseAssCues(ass) {
  const cues = [];
  let inEvents = false;
  let format = null;

  for (const rawLine of String(ass).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[events\]$/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (line.startsWith("[") && !/^\[events\]$/i.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;

    const formatMatch = line.match(/^Format\s*:\s*(.+)$/i);
    if (formatMatch) {
      format = formatMatch[1].split(",").map((field) => field.trim().toLowerCase());
      continue;
    }

    const dialogueMatch = line.match(/^Dialogue\s*:\s*(.*)$/i);
    if (!dialogueMatch || !format?.length) continue;
    const values = splitAssFields(dialogueMatch[1], format.length);
    if (!values) continue;
    const cue = Object.fromEntries(format.map((field, index) => [field, values[index]]));
    const start = assTimestampToVtt(cue.start);
    const end = assTimestampToVtt(cue.end);
    const text = cleanAssText(cue.text);
    if (start && end && text) cues.push({ start, end, text });
  }

  return cues;
}

function assToVtt(ass) {
  const cues = parseAssCues(ass);
  return `WEBVTT\n\n${cues.map((cue) => `${cue.start} --> ${cue.end}\n${cue.text}`).join("\n\n")}\n`;
}

function srtToVtt(srt) {
  return `WEBVTT\n\n${String(srt)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
}

// `requireCue: false` for a window of a track, which may hold no cue.
function subtitleToVtt(stream, buffer, { requireCue = true } = {}) {
  const codec = String(stream?.codec || stream?.format || "").toLowerCase();
  const text = decodeSubtitleBuffer(buffer);
  let vtt;
  if (codec === "ass" || codec === "ssa") vtt = assToVtt(text);
  else if (codec === "srt" || codec === "subrip") vtt = srtToVtt(text);
  if (codec === "vtt" || codec === "webvtt") {
    vtt = /^WEBVTT\b/.test(text.trimStart()) ? text : `WEBVTT\n\n${text}`;
  }
  if (!vtt) throw new Error(`Unsupported text subtitle codec: ${codec || "unknown"}`);
  const hasCue = /(?:(?:\d+):)?\d{2}:\d{2}[.,]\d{3}\s*-->/m.test(vtt);
  if (!hasCue && requireCue) throw new Error("Converted subtitle contains no timed cues");
  return vtt.replace(/\r\n?/g, "\n");
}

const CUE_TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})(.*)$/;

function cueSeconds(value) {
  const fields = value.replace(",", ".").split(":").map(Number);
  return fields.reduce((total, field) => total * 60 + field, 0);
}

function cueTimestamp(seconds) {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${pad(Math.floor(millis / 3_600_000))}:${pad(Math.floor(millis / 60_000) % 60)}:${pad(Math.floor(millis / 1000) % 60)}.${pad(millis % 1000, 3)}`;
}

/** The timed cues of WebVTT text: `{ start, end, settings, text }`, seconds. */
export function vttCues(vtt) {
  const cues = [];
  for (const block of String(vtt).replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => CUE_TIMING.test(line));
    if (at === -1) continue;
    const [, start, end, settings] = CUE_TIMING.exec(lines[at]);
    const text = lines.slice(at + 1).join("\n").trim();
    if (text) cues.push({ start: cueSeconds(start), end: cueSeconds(end), settings: settings.trimEnd(), text });
  }
  return cues;
}

/** WebVTT of the cues that overlap `window` ({ start, end }, seconds), or of all of them without one. */
export function windowVtt(cues, window = null) {
  const shown = window ? cues.filter((cue) => cue.end > window.start && cue.start < window.end) : cues;
  return `WEBVTT\n\n${shown.map((cue) => `${cueTimestamp(cue.start)} --> ${cueTimestamp(cue.end)}${cue.settings}\n${cue.text}`).join("\n\n")}\n`;
}

export function analyzeSubtitle(stream, buffer) {
  const codec = String(stream?.codec || stream?.format || "").toLowerCase();
  const decoded = decodeSubtitleBuffer(buffer);
  const sample = codec === "ass" || codec === "ssa"
    ? parseAssCues(decoded).map((cue) => cue.text).join("\n")
    : decoded;
  return {
    vtt: subtitleToVtt(stream, buffer),
    inferredLanguage: inferTextLanguage(sample),
  };
}

function convertSubtitleInWorker(stream, buffer) {
  return new Promise((resolvePromise, rejectPromise) => {
    const bytes = Uint8Array.from(buffer);
    const worker = new Worker(new URL("./subtitle-worker.js", import.meta.url), {
      execArgv: [],
      workerData: {
        stream: { codec: stream?.codec, format: stream?.format },
        buffer: bytes,
      },
      transferList: [bytes.buffer],
    });
    worker.once("message", (message) => {
      if (message?.error) rejectPromise(new Error(message.error));
      else resolvePromise(message);
    });
    worker.once("error", rejectPromise);
    worker.once("exit", (code) => {
      if (code !== 0) rejectPromise(new Error(`Subtitle worker exited with code ${code}`));
    });
  });
}

export class PlexSubtitleCache {
  constructor(cacheDir, {
    maxMemoryEntries = 64,
    maxMemoryBytes = 64 * 1024 * 1024,
    maxDiskEntries = 512,
    maxDiskBytes = 256 * 1024 * 1024,
    maxConcurrentConversions = 2,
    convert = convertSubtitleInWorker,
  } = {}) {
    this.cacheDir = cacheDir;
    this.maxMemoryEntries = maxMemoryEntries;
    this.maxMemoryBytes = maxMemoryBytes;
    this.maxDiskEntries = maxDiskEntries;
    this.maxDiskBytes = maxDiskBytes;
    this.maxConcurrentConversions = maxConcurrentConversions;
    this.convert = convert;
    this.memory = new Map();
    this.memoryBytes = 0;
    this.inFlight = new Map();
    this.activeConversions = 0;
    this.conversionWaiters = [];
    this.ready = mkdir(cacheDir, { recursive: true }).then(() => this.pruneDisk());
  }

  // A subtitle in a file is cached under its file's identity alone, so
  // another ratingKey for the same file finds it (plexSubtitleVersionInfo).
  cacheKey(ratingKey, stream, versionInfo) {
    if (versionInfo.stable) return `file-${versionInfo.token}`;
    const safeRatingKey = String(ratingKey).replace(/[^a-z0-9_-]/gi, "_");
    const safeStreamId = String(stream.id).replace(/[^a-z0-9_-]/gi, "_");
    return `${safeRatingKey}-${safeStreamId}-${versionInfo.token}`;
  }

  remember(key, value) {
    const previous = this.memory.get(key);
    if (previous) this.memoryBytes -= previous.byteSize;
    this.memory.delete(key);
    this.memory.set(key, value);
    this.memoryBytes += value.byteSize;
    while (this.memory.size > this.maxMemoryEntries || this.memoryBytes > this.maxMemoryBytes) {
      const oldestKey = this.memory.keys().next().value;
      this.memoryBytes -= this.memory.get(oldestKey).byteSize;
      this.memory.delete(oldestKey);
    }
  }

  async pruneDisk() {
    const names = (await readdir(this.cacheDir)).filter((name) => name.endsWith(".vtt"));
    const entries = (await Promise.all(names.map(async (name) => {
      try {
        const stats = await stat(resolve(this.cacheDir, name));
        const metadataPath = resolve(this.cacheDir, name.replace(/\.vtt$/, ".json"));
        const metadataSize = await stat(metadataPath).then((value) => value.size).catch(() => 0);
        return { name, mtimeMs: stats.mtimeMs, size: stats.size + metadataSize };
      } catch {
        return null;
      }
    }))).filter(Boolean).sort((left, right) => right.mtimeMs - left.mtimeMs);

    let retainedBytes = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const shouldDelete = index >= this.maxDiskEntries || retainedBytes + entry.size > this.maxDiskBytes;
      if (!shouldDelete) {
        retainedBytes += entry.size;
        continue;
      }
      await Promise.all([
        unlink(resolve(this.cacheDir, entry.name)).catch(() => {}),
        unlink(resolve(this.cacheDir, entry.name.replace(/\.vtt$/, ".json"))).catch(() => {}),
      ]);
    }
  }

  async readDiskValue(key) {
    const vttPath = resolve(this.cacheDir, `${key}.vtt`);
    try {
      const [vtt, metadata] = await Promise.all([
        readFile(vttPath, "utf8"),
        readFile(resolve(this.cacheDir, `${key}.json`), "utf8")
          .then((value) => JSON.parse(value))
          .catch(() => ({})),
      ]);
      return {
        vtt,
        inferredLanguage: metadata.inferredLanguage || null,
        byteSize: Buffer.byteLength(vtt),
      };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeDiskValue(key, value) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    const vttPath = resolve(this.cacheDir, `${key}.vtt`);
    const metadataPath = resolve(this.cacheDir, `${key}.json`);
    const temporaryVttPath = `${vttPath}.${suffix}`;
    const temporaryMetadataPath = `${metadataPath}.${suffix}`;
    try {
      await Promise.all([
        writeFile(temporaryVttPath, value.vtt, "utf8"),
        writeFile(temporaryMetadataPath, JSON.stringify({ inferredLanguage: value.inferredLanguage }), "utf8"),
      ]);
      await rename(temporaryVttPath, vttPath);
      await rename(temporaryMetadataPath, metadataPath);
    } catch (error) {
      await Promise.all([
        unlink(temporaryVttPath).catch(() => {}),
        unlink(temporaryMetadataPath).catch(() => {}),
      ]);
      throw error;
    }
  }

  async runConversion(task) {
    if (this.activeConversions >= this.maxConcurrentConversions) {
      await new Promise((resolvePromise) => this.conversionWaiters.push(resolvePromise));
    }
    this.activeConversions += 1;
    try {
      return await task();
    } finally {
      this.activeConversions -= 1;
      this.conversionWaiters.shift()?.();
    }
  }

  async getCached(ratingKey, stream, providedVersionInfo = null) {
    await this.ready;
    const versionInfo = providedVersionInfo || await plexSubtitleVersionInfo(stream);
    const version = versionInfo.token;
    const key = this.cacheKey(ratingKey, stream, versionInfo);
    const etag = `"yolo-subtitle-${version}"`;
    const memoryHit = this.memory.get(key);
    if (memoryHit) {
      this.remember(key, memoryHit);
      return { ...memoryHit, version, etag, immutable: versionInfo.immutable, source: "memory" };
    }

    const diskHit = await this.readDiskValue(key);
    if (!diskHit) return null;
    this.remember(key, diskHit);
    return { ...diskHit, version, etag, immutable: versionInfo.immutable, source: "disk" };
  }

  async get(ratingKey, stream, loadBuffer, providedVersionInfo = null) {
    await this.ready;
    const versionInfo = providedVersionInfo || await plexSubtitleVersionInfo(stream);
    const version = versionInfo.token;
    const key = this.cacheKey(ratingKey, stream, versionInfo);
    const etag = `"yolo-subtitle-${version}"`;
    const cached = await this.getCached(ratingKey, stream, versionInfo);
    if (cached) return cached;

    if (this.inFlight.has(key)) {
      const value = await this.inFlight.get(key);
      return { ...value, version, etag, immutable: versionInfo.immutable, source: "coalesced" };
    }

    const conversion = (async () => {
      const buffer = await loadBuffer(stream);
      const analysis = await this.runConversion(() => this.convert(stream, buffer));
      const value = {
        vtt: analysis.vtt,
        inferredLanguage: analysis.inferredLanguage || null,
        byteSize: Buffer.byteLength(analysis.vtt),
      };
      await this.writeDiskValue(key, value);
      this.remember(key, value);
      await this.pruneDisk();
      return value;
    })();
    this.inFlight.set(key, conversion);
    try {
      const value = await conversion;
      return { ...value, version, etag, immutable: versionInfo.immutable, source: "converted" };
    } finally {
      this.inFlight.delete(key);
    }
  }
}

function isUnknownLabel(value) {
  return !value || /^unknown$/i.test(String(value).trim());
}

function inferTextLanguage(text) {
  const sample = String(text || "");
  const hasHan = /\p{Script=Han}/u.test(sample);
  const hasKana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sample);
  const hasHangul = /\p{Script=Hangul}/u.test(sample);
  const hasLatin = /\p{Script=Latin}/u.test(sample);

  if (hasKana) return { language: "日本語", languageCode: "jpn", label: hasLatin ? "日英双语" : "日本語" };
  if (hasHangul) return { language: "한국어", languageCode: "kor", label: hasLatin ? "韩英双语" : "한국어" };
  if (hasHan) return { language: "中文", languageCode: "zho", label: hasLatin ? "中英双语" : "中文" };
  return null;
}

export function describePlexSubtitle(ratingKey, stream, {
  versionToken = null,
  inferredLanguage = null,
  externalAvailable = true,
} = {}) {
  const codec = String(stream?.codec || stream?.format || "").toLowerCase();
  const textSubtitle = isPlexTextSubtitle(stream);
  const originalTitle = stream?.title || stream?.displayTitle || stream?.extendedDisplayTitle;
  let language = stream?.language;
  let languageCode = stream?.languageCode;
  let displayTitle = stream?.displayTitle || stream?.extendedDisplayTitle || originalTitle;

  if (textSubtitle && isUnknownLabel(displayTitle) && inferredLanguage) {
    language = inferredLanguage.language;
    languageCode = inferredLanguage.languageCode;
    displayTitle = inferredLanguage.label;
  }
  if (isUnknownLabel(displayTitle)) displayTitle = codec ? `Unknown (${codec.toUpperCase()})` : "Unknown";

  return {
    id: stream.id,
    codec,
    language,
    languageCode,
    title: isUnknownLabel(originalTitle) ? displayTitle : originalTitle,
    displayTitle,
    delivery: textSubtitle && externalAvailable ? "external" : "burn",
    ...(versionToken ? { versionToken } : {}),
  };
}

export async function resolvePlexSubtitleDelivery(descriptor, ensureExternalSubtitle) {
  if (!descriptor || descriptor.delivery !== "external") {
    return { subtitle: descriptor, burnSubtitleStreamID: descriptor?.id || null, fallback: false };
  }
  try {
    await ensureExternalSubtitle();
    return { subtitle: descriptor, burnSubtitleStreamID: null, fallback: false };
  } catch (error) {
    return {
      subtitle: { ...descriptor, delivery: "burn", fallbackReason: error.message },
      burnSubtitleStreamID: descriptor.id,
      fallback: true,
      error,
    };
  }
}
