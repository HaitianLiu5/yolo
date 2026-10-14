import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { formatTimestamp, normalizeCapabilities, parseTimestamp, WEB_NATIVE_CAPABILITIES, YoloError } from "@useyolo/core";
import { silentLogger } from "../log.js";
import { isMasterPlaylist } from "./hls.js";
import { normalizeInput } from "./input.js";
import { ffmpegHeaders } from "./transcode.js";
import { fetchTextWithRetry } from "./upstream.js";

// One picture of a video at a time, for agents
// (Agent Note 2026-10-13-video-frames). No screen is involved: the node reads
// the item the way it would stream it, from the Input a source plugin's
// prepare() returns, and ffmpeg decodes one frame with a fast input seek.
//
// - The playing session's own bytes come first: a split stream's segment that
//   the device already fetched is in the disk cache, and the session's
//   current URLs save a prepare, which can take a source seconds.
// - Otherwise the source prepares the item with `reason: "frame"`: the node
//   itself reads it, so the original file suits best, no subtitle is chosen,
//   and the source's `stop()` runs right after.
// - A JPEG of at most MAX_FRAME_BYTES leaves the node. Nothing is written to
//   disk and nothing about the item is logged.

export const FRAME_WIDTH = 1280;
export const MIN_FRAME_WIDTH = 160;
export const MAX_FRAME_WIDTH = 1920;
export const FRAME_TIMEOUT_MS = 15_000;
export const MAX_FRAME_BYTES = 1536 * 1024;
// Frame requests at once on this node; more are refused, not queued.
const MAX_FRAME_REQUESTS = 2;
// ffmpeg gives up on an upstream read that stalls this long (microseconds).
const READ_TIMEOUT_US = 8_000_000;
// mjpeg quality scale: 3 looks right; the second only when the first is too large.
const QUALITIES = [3, 9];
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const HEIGHTS = [360, 480, 720, 1080];
const MAX_STDERR = 4096;

export const clampWidth = (width) => {
  const value = Math.floor(Number(width));
  return Number.isFinite(value) && value > 0 ? Math.min(MAX_FRAME_WIDTH, Math.max(MIN_FRAME_WIDTH, value)) : FRAME_WIDTH;
};

// The picture size in a JPEG's start-of-frame segment.
export function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length && buffer[offset] === 0xff) {
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { width: null, height: null };
}

// The variant of a master playlist to read: the smallest whose picture is at
// least `width` wide, else the largest; without sizes, the highest bandwidth.
export function pickVariant(body, width) {
  const lines = body.split(/\r?\n/);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("#EXT-X-STREAM-INF:")) continue;
    const uri = lines.slice(index + 1).find((line) => line.trim() && !line.startsWith("#"));
    if (!uri) continue;
    const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(lines[index])?.[1]) || 0;
    const size = /RESOLUTION=(\d+)x(\d+)/.exec(lines[index]);
    variants.push({ uri: uri.trim(), bandwidth, width: size ? Number(size[1]) : 0 });
  }
  if (!variants.length) return null;
  const bySize = (a, b) => a.width - b.width || a.bandwidth - b.bandwidth;
  const wide = variants.filter((variant) => variant.width >= width).sort(bySize);
  if (wide.length) return wide[0].uri;
  return variants.sort(bySize).at(-1).uri;
}

function ffmpegError(stderr, at) {
  if (/\b40[13]\b|Forbidden|Unauthorized/i.test(stderr)) return new YoloError("resolve_failed", "The source refused to serve the video; its link may have expired");
  if (/\b404\b|Not Found/i.test(stderr)) return new YoloError("resolve_failed", "The source no longer serves the video at the address it gave");
  return new YoloError("resolve_failed", `No frame could be read at ${formatTimestamp(at, { millis: true })}`);
}

// Runs ffmpeg and resolves with its stdout. Its stderr can quote signed
// upstream URLs, so it only classifies the failure and is never passed on.
export function runFfmpeg(args, { ffmpeg = "ffmpeg", input = null, timeoutMs, maxBytes = MAX_FRAME_BYTES, at = 0 }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const chunks = [];
    let size = 0;
    let stderr = "";
    let failure = null;
    const stop = (error) => {
      failure ??= error;
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => stop(new YoloError("resolve_failed", "Reading the frame took too long")), Math.max(1, timeoutMs));
    proc.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) stop(Object.assign(new YoloError("resolve_failed", "The picture is too large"), { tooLarge: true }));
      else chunks.push(chunk);
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (text) => {
      stderr = (stderr + text).slice(-MAX_STDERR);
    });
    if (input) {
      proc.stdin.on("error", () => {});
      proc.stdin.end(input);
    }
    proc.once("error", (error) => stop(error.code === "ENOENT" ? new YoloError("resolve_failed", "ffmpeg is not installed on the media node") : error));
    proc.once("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0 || !size) return reject(ffmpegError(stderr, at));
      resolve(Buffer.concat(chunks));
    });
  });
}

// The scale filter: at most `width` wide and as tall, never larger than the
// source, an even size, and full-range YUV as JPEG expects.
const scaleFilter = (width) => `scale=w='min(${width},iw)':h='min(${width},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:out_range=full,format=yuvj420p`;
const output = (width, quality) => ["-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn", "-vf", scaleFilter(width), "-c:v", "mjpeg", "-q:v", String(quality), "-f", "image2pipe", "pipe:1"];

export function createFrames({
  sources, media = null, ffmpeg = "ffmpeg", fetchImpl = globalThis.fetch, maxVideoKbps = 4800, logger = silentLogger,
  maxRequests = MAX_FRAME_REQUESTS, timeoutMs = FRAME_TIMEOUT_MS, now = () => Date.now(),
} = {}) {
  let active = 0;

  // What a frame asks of a source's prepare(): the node reads the item
  // itself, so every file plays "as it is", the original is welcome, and the
  // picture has no subtitle drawn into it.
  function frameContext(startTime, width) {
    const maxHeight = HEIGHTS.find((height) => height >= (width * 9) / 16) ?? 1080;
    return {
      capabilities: normalizeCapabilities({ ...WEB_NATIVE_CAPABILITIES, maxHeight }),
      viewport: null,
      startTime,
      reason: "frame",
      limits: { maxVideoKbps },
      network: "lan",
      playable: () => ({ decision: "direct", reasons: [] }),
      chooseTracks: () => ({ subtitles: [], audio: null }),
    };
  }

  const remaining = (deadline) => deadline - now();
  const tooSlow = () => new YoloError("resolve_failed", `Reading the frame took longer than ${Math.round(timeoutMs / 1000)} seconds`);

  function beforeDeadline(promise, deadline) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(tooSlow()), Math.max(0, remaining(deadline)));
      }),
    ]).finally(() => clearTimeout(timer));
  }

  // The item from a fresh prepare(); `release()` runs the source's stop().
  async function prepared(source, startTime, width, deadline) {
    const pending = sources.prepare(source, frameContext(startTime, width));
    let descriptor;
    try {
      descriptor = await beforeDeadline(pending, deadline);
    } catch (error) {
      // A prepare that finishes after the deadline still gets its stop().
      pending.then((late) => late?.stop?.(), () => {}).catch(() => {});
      throw error;
    }
    let input;
    try {
      input = normalizeInput(descriptor.input);
    } catch (error) {
      await Promise.resolve().then(() => descriptor.stop?.()).catch(() => {});
      throw error;
    }
    return {
      title: descriptor.title ?? null,
      duration: Number(descriptor.duration) > 0 ? Number(descriptor.duration) : null,
      isLive: Boolean(descriptor.isLive) || Boolean(input.live),
      input,
      fresh: true,
      cachedAt: () => null,
      release: () => Promise.resolve().then(() => descriptor.stop?.()).catch(() => {}),
    };
  }

  // Where ffmpeg reads: the file, a split stream's video, or one variant of
  // an HLS stream.
  async function target(input, width, deadline) {
    if (input.type === "file") return { url: input.url, headers: input.headers };
    if (input.type === "split") return { url: input.video.url, headers: input.video.headers ?? null };
    let body = input.manifest;
    let base = input.url;
    if (!body) {
      const { response, body: text } = await fetchTextWithRetry(input.url, { headers: { ...(input.headers || {}) }, redirect: "follow" }, {
        retries: 1, label: "frame-playlist", maxBytes: MAX_PLAYLIST_BYTES, timeoutMs: Math.max(1000, Math.min(8000, remaining(deadline))), fetchFn: fetchImpl, logger,
      });
      if (!response.ok) throw new YoloError("resolve_failed", `The source's playlist answered ${response.status}`);
      body = text;
      base = response.url || input.url;
    }
    const variant = isMasterPlaylist(body) ? pickVariant(body, width) : null;
    return { url: variant ? new URL(variant, base).href : input.url, headers: input.headers };
  }

  // One JPEG, at a lower quality when the first is too large.
  async function encode(args, { input = null, deadline, at, width }) {
    for (const quality of QUALITIES) {
      if (remaining(deadline) <= 0) throw tooSlow();
      try {
        return await runFfmpeg([...args, ...output(width, quality)], { ffmpeg, input, timeoutMs: remaining(deadline), at });
      } catch (error) {
        if (!error.tooLarge || quality === QUALITIES.at(-1)) throw error;
      }
    }
    throw new YoloError("resolve_failed", "The picture is too large");
  }

  async function read(item, at, width, deadline) {
    const cached = item.cachedAt(at);
    if (cached) {
      try {
        const input = Buffer.concat([cached.init, readFileSync(cached.segmentPath)]);
        // A pipe cannot seek: decode from the segment's start to the offset.
        const image = await encode(["-hide_banner", "-loglevel", "error", "-nostdin", "-i", "pipe:0", "-ss", cached.offset.toFixed(3)], { input, deadline, at, width });
        return { image, input: "cache" };
      } catch (error) {
        // An evicted entry or a bad segment: read it from upstream instead.
        logger.debug?.({ err: error.message }, "A cached segment gave no frame");
      }
    }
    const { url, headers } = await target(item.input, width, deadline);
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-rw_timeout", String(READ_TIMEOUT_US), "-headers", ffmpegHeaders(headers || {}),
      "-ss", at.toFixed(3), "-i", url,
    ];
    return { image: await encode(args, { deadline, at, width }), input: item.input.type };
  }

  function check(item, at) {
    const title = item.title ? `"${item.title}"` : "This item";
    if (item.isLive) throw new YoloError("invalid_request", `${title} is a live stream: frames can be read only from a video with a fixed length`);
    if (item.duration && at > item.duration) {
      throw new YoloError("invalid_request", `${formatTimestamp(at, { millis: true })} is past the end of ${title}, which lasts ${formatTimestamp(item.duration)}`);
    }
  }

  return {
    get active() {
      return active;
    },

    // { source, time, width?, sessionId? } → { image (base64), mimeType,
    // width, height, time, title, duration, input, plugin }. `sessionId` is
    // the session the control plane says plays this item now.
    async frame({ source, time, width, sessionId = null }) {
      const at = parseTimestamp(time);
      const size = clampWidth(width);
      if (active >= maxRequests) throw new YoloError("rate_limited", "The media node is already reading frames; retry in a few seconds");
      active += 1;
      const deadline = now() + timeoutMs;
      let item = null;
      try {
        // The playing session's own bytes, unless its source transcodes as
        // it goes (its segments exist only near where the device plays).
        const playing = sessionId && media ? media.frameSource(sessionId, source) : null;
        if (playing && !(playing.input?.type === "hls" && playing.input.transcoder)) {
          check(playing, at);
          try {
            const frame = await read(playing, at, size, deadline);
            return present(frame, { item: playing, at, source });
          } catch (error) {
            if (remaining(deadline) <= 0) throw error;
            logger.debug?.({ err: error.message }, "The playing session gave no frame; preparing the item");
          }
        }
        item = await prepared(source, at, size, deadline);
        check(item, at);
        return present(await read(item, at, size, deadline), { item, at, source });
      } finally {
        active -= 1;
        await item?.release();
      }
    },
  };
}

function present({ image, input }, { item, at, source }) {
  return {
    image: image.toString("base64"),
    mimeType: "image/jpeg",
    ...jpegSize(image),
    bytes: image.length,
    time: at,
    title: item.title ?? null,
    duration: item.duration ?? null,
    input,
    plugin: source.plugin,
  };
}
