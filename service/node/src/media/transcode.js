import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { silentLogger } from "../log.js";

// ffmpeg fallback for separate audio/video files: transcode both into one
// fMP4 HLS stream on disk (H.264 + AAC).
// Used when an Input asks for it (`split.transcode`) or DASH_TRANSCODE=1.

export const TRANSCODE_STARTUP_TIMEOUT_MS = 18_000;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function headerValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.filter(Boolean).map((part) => String(part).trim()).join("; ");
  return String(value).trim();
}

// ffmpeg's -headers argument: CRLF-terminated lines, with browser-like
// defaults for headers the source did not set.
export function ffmpegHeaders(headers = {}) {
  const merged = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const text = headerValue(value);
    if (name && text) merged[String(name).trim()] = text;
  }
  const has = (name) => Object.keys(merged).some((key) => key.toLowerCase() === name.toLowerCase());
  if (!has("User-Agent")) merged["User-Agent"] = DEFAULT_USER_AGENT;
  if (!has("Accept")) merged.Accept = "*/*";
  if (!has("Accept-Language")) merged["Accept-Language"] = "en-US,en;q=0.8";
  return `${Object.entries(merged).map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n`;
}

export function countSegments(dir) {
  try {
    return readdirSync(dir).filter((file) => /\.m4s$/i.test(file)).length;
  } catch {
    return 0;
  }
}

// Ready once the init segment and two media segments exist, or one segment of
// a short VOD that ffmpeg already finished (a second one will never come).
export function isTranscodeReady(dir) {
  const playlist = resolve(dir, "playlist.m3u8");
  if (!existsSync(playlist) || !existsSync(resolve(dir, "init.mp4"))) return false;
  const count = countSegments(dir);
  if (count >= 2) return true;
  if (count === 1) {
    try {
      return /^#EXT-X-ENDLIST\s*$/m.test(readFileSync(playlist, "utf8"));
    } catch {
      return false;
    }
  }
  return false;
}

export function startTranscode({ dir, video, audio, maxVideoKbps = 4800, ffmpeg = "ffmpeg", logger = silentLogger }) {
  mkdirSync(dir, { recursive: true });
  const playlistPath = resolve(dir, "playlist.m3u8");
  const args = [
    "-hide_banner", "-loglevel", "info",
    "-headers", ffmpegHeaders(video.headers), "-i", video.url,
    "-headers", ffmpegHeaders(audio.headers), "-i", audio.url,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "veryfast",
    "-profile:v", "main", "-level", "4.0", "-crf", "23",
    "-maxrate", `${maxVideoKbps}k`, "-bufsize", `${maxVideoKbps * 2}k`,
    "-c:a", "aac", "-b:a", "192k",
    "-f", "hls", "-hls_time", "6", "-hls_list_size", "0",
    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", resolve(dir, "seg%d.m4s"),
    playlistPath,
  ];
  const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
  const job = { dir, playlistPath, proc, exited: false, errors: [] };
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (text) => {
    for (const line of text.split(/\r?\n/)) {
      if (/error|failed/i.test(line)) {
        job.errors.push(line.trim());
        logger.warn({ dir, line: line.trim() }, "ffmpeg");
      }
    }
  });
  proc.once("error", (error) => {
    job.exited = true;
    job.errors.push(error.message);
  });
  proc.once("close", () => {
    job.exited = true;
  });

  job.ready = async ({ timeoutMs = TRANSCODE_STARTUP_TIMEOUT_MS, pollMs = 150 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isTranscodeReady(dir)) {
        const body = readFileSync(playlistPath, "utf8");
        if (body.includes("#EXTM3U") && body.includes("init.mp4") && body.includes(".m4s")) return true;
      }
      if (job.exited && !existsSync(playlistPath)) return false;
      await wait(pollMs);
    }
    return false;
  };

  job.stop = async ({ timeoutMs = 5_000 } = {}) => {
    if (!job.exited && proc.exitCode == null && proc.signalCode == null) {
      const closed = new Promise((done) => {
        proc.once("close", done);
        proc.once("error", done);
      });
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      await Promise.race([closed, wait(timeoutMs)]);
      if (!job.exited) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };

  return job;
}
