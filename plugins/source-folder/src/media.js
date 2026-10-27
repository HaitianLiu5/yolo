import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// What the plugin reads from a file with ffprobe and ffmpeg
// (Agent Note 2026-10-26-folder-source): its duration, picture, and audio
// and subtitle streams; a picture from it where nothing beside it serves as
// artwork; and a text subtitle inside it as WebVTT. Readings are kept in
// `cacheDir` by the file's path, size, and modification time.

const PROBE_TIMEOUT_MS = 20_000;
const FRAME_TIMEOUT_MS = 20_000;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;
const TEXT_CODECS = new Set(["subrip", "ass", "ssa", "webvtt", "mov_text", "text"]);

const tagOf = (file) => `${file.path}\0${file.size}\0${file.mtime}`;
const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 24);

function run(command, args, { timeout, encoding = "utf8", maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((done, fail) => {
    execFile(command, args, { timeout, encoding, maxBuffer }, (error, stdout) => (error ? fail(error) : done(stdout)));
  });
}

/** ffprobe's JSON reduced to what the library and its tracks need. */
export function readStreams(json) {
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const rate = String(video?.avg_frame_rate || "").split("/").map(Number);
  return {
    duration: Number(json?.format?.duration) > 0 ? Math.round(Number(json.format.duration) * 1000) / 1000 : null,
    kbps: Number(json?.format?.bit_rate) > 0 ? Math.round(Number(json.format.bit_rate) / 1000) : null,
    video: video ? { codec: video.codec_name, width: Number(video.width) || null, height: Number(video.height) || null, fps: rate[0] > 0 && rate[1] > 0 ? Math.round((rate[0] / rate[1]) * 100) / 100 : null } : null,
    audio: streams.filter((stream) => stream.codec_type === "audio").map((stream) => ({
      index: stream.index, codec: stream.codec_name, channels: Number(stream.channels) || null,
      language: stream.tags?.language ?? null, title: stream.tags?.title ?? null, default: Boolean(stream.disposition?.default),
    })),
    subtitles: streams.filter((stream) => stream.codec_type === "subtitle").map((stream) => ({
      index: stream.index, codec: stream.codec_name, text: TEXT_CODECS.has(stream.codec_name),
      language: stream.tags?.language ?? null, title: stream.tags?.title ?? null,
      default: Boolean(stream.disposition?.default), forced: Boolean(stream.disposition?.forced),
    })),
  };
}

export function createMedia({ cacheDir = null, ffprobe = "ffprobe", ffmpeg = "ffmpeg", log = null } = {}) {
  const indexPath = cacheDir ? join(cacheDir, "probes.json") : null;
  let probes = new Map();
  try {
    if (indexPath) probes = new Map(Object.entries(JSON.parse(readFileSync(indexPath, "utf8"))));
  } catch {}
  let saving = null;
  const save = () => {
    if (!indexPath || saving) return;
    saving = setTimeout(() => {
      saving = null;
      try {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(`${indexPath}.tmp`, JSON.stringify(Object.fromEntries(probes)));
        renameSync(`${indexPath}.tmp`, indexPath);
      } catch (error) {
        log?.warn?.(`Could not keep the probes: ${error.message}`);
      }
    }, 2000);
    saving.unref?.();
  };
  const running = new Map();
  const extracting = new Map();

  /** The file's streams, probed once per path, size, and modification time. */
  async function probe(file) {
    const tag = tagOf(file);
    const known = probes.get(file.path);
    if (known?.tag === tag) return known.streams;
    if (running.has(tag)) return running.get(tag);
    const job = run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file.path], { timeout: PROBE_TIMEOUT_MS })
      .then((stdout) => {
        const streams = readStreams(JSON.parse(stdout));
        probes.set(file.path, { tag, streams });
        save();
        return streams;
      })
      .finally(() => running.delete(tag));
    running.set(tag, job);
    return job;
  }

  /** The probe already kept for the file, without probing. */
  const known = (file) => {
    const entry = probes.get(file.path);
    return entry?.tag === tagOf(file) ? entry.streams : null;
  };

  /** A JPEG of the file's picture at `at` seconds, kept in the cache. */
  async function frame(file, at) {
    const out = cacheDir ? join(cacheDir, "frames", `${hash(`${tagOf(file)}\0${Math.round(at)}`)}.jpg`) : null;
    if (out && existsSync(out)) return readFileSync(out);
    const bytes = await run(ffmpeg, ["-v", "error", "-ss", String(Math.max(0, at)), "-i", file.path, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "pipe:1"], { timeout: FRAME_TIMEOUT_MS, encoding: "buffer" });
    if (!bytes.length) throw new Error("ffmpeg gave no picture");
    if (out) {
      try {
        mkdirSync(join(cacheDir, "frames"), { recursive: true });
        writeFileSync(out, bytes);
      } catch {}
    }
    return bytes;
  }

  /** WebVTT of text from a subtitle file's bytes, which ffmpeg converts. */
  function toVtt(text, format) {
    if (format === "vtt") return Promise.resolve(text.startsWith("WEBVTT") ? text : `WEBVTT\n\n${text}`);
    return new Promise((done, fail) => {
      const proc = spawn(ffmpeg, ["-v", "error", "-f", format === "ssa" ? "ass" : format, "-i", "pipe:0", "-f", "webvtt", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
      const out = [];
      const err = [];
      const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
      proc.stdout.on("data", (chunk) => out.push(chunk));
      proc.stderr.on("data", (chunk) => err.push(chunk));
      proc.once("error", fail);
      proc.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) done(Buffer.concat(out).toString("utf8"));
        else fail(new Error(Buffer.concat(err).toString("utf8").trim() || `ffmpeg exited ${code}`));
      });
      proc.stdin.on("error", () => {});
      proc.stdin.end(text);
    });
  }

  /**
   * A text subtitle stream inside the file as WebVTT: the text once ffmpeg
   * has read it out, else `{ pending, retryAfter }` while it reads the file,
   * which takes as long as reading the whole file.
   */
  function embedded(file, index) {
    const out = cacheDir ? join(cacheDir, "subtitles", `${hash(`${tagOf(file)}\0${index}`)}.vtt`) : null;
    if (out && existsSync(out)) return readFileSync(out, "utf8");
    const key = `${tagOf(file)}\0${index}`;
    const state = extracting.get(key);
    if (state?.text != null) return state.text;
    if (state?.error) {
      extracting.delete(key);
      throw state.error;
    }
    if (!state) {
      const entry = {};
      extracting.set(key, entry);
      run(ffmpeg, ["-v", "error", "-i", file.path, "-map", `0:${index}`, "-f", "webvtt", "pipe:1"], { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
        .then((text) => {
          entry.text = text;
          if (out) {
            try {
              mkdirSync(join(cacheDir, "subtitles"), { recursive: true });
              writeFileSync(out, text);
              extracting.delete(key);
            } catch {}
          }
        })
        .catch((error) => {
          entry.error = error;
        });
    }
    return { pending: true, retryAfter: 3 };
  }

  return { probe, known, frame, toVtt, embedded };
}
