import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { formatTimestamp, normalizeCapabilities, parseTimestamp, WEB_NATIVE_CAPABILITIES, YoloError } from "@useyolo/core";
import { silentLogger } from "../log.js";
import { fmp4Segments, isMasterPlaylist } from "./hls.js";
import { normalizeInput } from "./input.js";
import { composeStoryboard, storyboardLayout } from "./storyboard-image.js";
import { ffmpegHeaders } from "./transcode.js";
import { fetchBytesWithRetry, fetchTextWithRetry } from "./upstream.js";

// Pictures of a video for agents (Agent Note 2026-10-13-video-frames): one
// frame at a time, or a storyboard of evenly spaced frames in one image. No
// screen is involved: the node reads the item the way it would stream it,
// from the Input a source plugin's prepare() returns, and ffmpeg decodes each
// frame with a fast input seek.
//
// - The playing session's own bytes come first: a split stream's segment that
//   the device already fetched is in the disk cache, and the session's
//   current URLs save a prepare, which can take a source seconds.
// - Otherwise the source prepares the item with `reason: "frame"`: the node
//   itself reads it, so the original file suits best, no subtitle is chosen,
//   and the source's `stop()` runs right after.
// - From fMP4 HLS the node fetches the init section and the one segment the
//   time falls in and decodes from the segment's start, as from a cached
//   segment: ffmpeg before 7 gives no frame when it seeks into fMP4 HLS.
// - A storyboard first takes the source's own storyboard images when its
//   plugin offers them (`storyboard()`), which costs no video reads.
// - A JPEG of at most MAX_FRAME_BYTES (MAX_STORYBOARD_BYTES) leaves the node.
//   Nothing is written to disk and nothing about the item is logged.

export const FRAME_WIDTH = 1280;
export const MIN_FRAME_WIDTH = 160;
export const MAX_FRAME_WIDTH = 1920;
export const FRAME_TIMEOUT_MS = 15_000;
export const MAX_FRAME_BYTES = 1536 * 1024;
export const STORYBOARD_COUNT = 12;
export const MIN_STORYBOARD_COUNT = 2;
export const MAX_STORYBOARD_COUNT = 30;
export const TILE_WIDTH = 320;
export const MIN_TILE_WIDTH = 80;
export const MAX_TILE_WIDTH = 480;
export const STORYBOARD_TIMEOUT_MS = 30_000;
export const MAX_STORYBOARD_BYTES = 2 * 1024 * 1024;
// Frame and storyboard requests at once on this node; more are refused, not queued.
const MAX_FRAME_REQUESTS = 2;
// Frames one storyboard reads at once.
const TILE_CONCURRENCY = 3;
// A source's own storyboard gets at most this long, so frames can follow.
const SOURCE_STORYBOARD_MS = 10_000;
const MAX_SHEET_BYTES = 4 * 1024 * 1024;
const MAX_SHEETS = 500;
// The encoder still gets this long after a storyboard's deadline, so tiles
// read in time are not lost.
const ENCODE_GRACE_MS = 3_000;
// ffmpeg gives up on an upstream read that stalls this long (microseconds).
const READ_TIMEOUT_US = 8_000_000;
// mjpeg quality scale: 3 looks right; the second only when the first is too large.
const QUALITIES = [3, 9];
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
// One fMP4 HLS segment, and its init section, read for a frame.
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;
const MAX_INIT_BYTES = 4 * 1024 * 1024;
const HEIGHTS = [360, 480, 720, 1080];
const MAX_STDERR = 4096;

const clampInt = (value, min, max, fallback) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(max, Math.max(min, number)) : fallback;
};
export const clampWidth = (width) => clampInt(width, MIN_FRAME_WIDTH, MAX_FRAME_WIDTH, FRAME_WIDTH);

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

// A storyboard's times: the middles of `count` equal parts of from..to, so
// neither the first black frame nor the very end is shown.
export function storyboardTimes({ from = null, to = null, count, duration = null, title = null }) {
  const name = title ? `"${title}"` : "this item";
  const start = from == null ? 0 : parseTimestamp(from);
  const end = to == null ? duration : parseTimestamp(to);
  if (duration && start >= duration) throw new YoloError("invalid_request", `${formatTimestamp(start)} is past the end of ${name}, which lasts ${formatTimestamp(duration)}`);
  if (duration && end > duration + 1) throw new YoloError("invalid_request", `${formatTimestamp(end)} is past the end of ${name}, which lasts ${formatTimestamp(duration)}`);
  if (!(end > 0)) throw new YoloError("invalid_request", `The length of ${name} is unknown; pass \`to\``);
  if (end <= start) throw new YoloError("invalid_request", "`to` must come after `from`");
  const step = (end - start) / count;
  const times = Array.from({ length: count }, (_, index) => Number((start + (index + 0.5) * step).toFixed(3)));
  return { from: start, to: end, step, times };
}

// A source's storyboard() answer, checked: sheets of tiles with where each
// starts, how long it covers, its grid, and the seconds between tiles.
export function normalizeStoryboard(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.sheets)) return null;
  const positive = (number) => Number.isFinite(Number(number)) && Number(number) > 0;
  const sheets = value.sheets.slice(0, MAX_SHEETS).filter((sheet) => sheet && typeof sheet.url === "string" && /^https?:\/\//i.test(sheet.url)
    && Number(sheet.start) >= 0 && positive(sheet.duration) && positive(sheet.columns) && positive(sheet.rows)
    && positive(sheet.tileWidth) && positive(sheet.tileHeight)).map((sheet) => {
    const columns = Math.min(50, Math.floor(sheet.columns));
    const rows = Math.min(50, Math.floor(sheet.rows));
    return {
      url: sheet.url,
      headers: sheet.headers && typeof sheet.headers === "object" ? { ...sheet.headers } : null,
      start: Number(sheet.start),
      duration: Number(sheet.duration),
      columns,
      rows,
      tileWidth: Math.floor(sheet.tileWidth),
      tileHeight: Math.floor(sheet.tileHeight),
      interval: positive(sheet.interval) ? Number(sheet.interval) : Number(sheet.duration) / (columns * rows),
    };
  }).sort((a, b) => a.start - b.start);
  if (!sheets.length) return null;
  return { title: typeof value.title === "string" ? value.title : null, duration: positive(value.duration) ? Number(value.duration) : null, sheets };
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

const FFMPEG = ["-hide_banner", "-loglevel", "error", "-nostdin"];
const ONE_FRAME = ["-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn"];
// A JPEG at most `width` wide and as tall, never larger than the source, an
// even size, and full-range YUV as JPEG expects.
const jpegOutput = (width, quality) => [
  ...ONE_FRAME,
  "-vf", `scale=w='min(${width},iw)':h='min(${width},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:out_range=full,format=yuvj420p`,
  "-c:v", "mjpeg", "-q:v", String(quality), "-f", "image2pipe", "pipe:1",
];
// A storyboard tile: exactly tileWidth × tileHeight RGB, letterboxed.
const tileOutput = ({ tileWidth: width, tileHeight: height }, crop = null) => [
  ...ONE_FRAME,
  "-vf", `${crop ? `${crop},` : ""}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgb24`,
  "-f", "rawvideo", "pipe:1",
];

// At most `limit` calls of `fn` at once, results in order.
async function mapLimit(values, limit, fn) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await fn(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

const aspectOf = (profile) => (Number(profile?.width) > 0 && Number(profile?.height) > 0 ? Number(profile.width) / Number(profile.height) : null);

export function createFrames({
  sources, media = null, ffmpeg = "ffmpeg", fetchImpl = globalThis.fetch, maxVideoKbps = 4800, logger = silentLogger,
  maxRequests = MAX_FRAME_REQUESTS, timeoutMs = FRAME_TIMEOUT_MS, storyboardTimeoutMs = STORYBOARD_TIMEOUT_MS, now = () => Date.now(),
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
  const tooSlow = (budgetMs) => new YoloError("resolve_failed", `Reading the video took longer than ${Math.round(budgetMs / 1000)} seconds`);

  function beforeDeadline(promise, deadline, budgetMs) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(tooSlow(budgetMs)), Math.max(0, remaining(deadline)));
      }),
    ]).finally(() => clearTimeout(timer));
  }

  // One request at a time per slot; `work(deadline)` runs within `budgetMs`.
  async function slot(budgetMs, work) {
    if (active >= maxRequests) throw new YoloError("rate_limited", "The media node is already reading frames; retry in a few seconds");
    active += 1;
    try {
      return await work(now() + budgetMs);
    } finally {
      active -= 1;
    }
  }

  // The item the session `sessionId` plays, when it is `source` and its
  // bytes can be read: not a transcoding source's, whose segments exist only
  // near where the device plays.
  function playingItem(sessionId, source) {
    const playing = sessionId && media ? media.frameSource(sessionId, source) : null;
    if (!playing || (playing.input?.type === "hls" && playing.input.transcoder)) return null;
    return { ...playing, aspect: aspectOf(playing.profile), release: async () => {} };
  }

  // The item from a fresh prepare(); `release()` runs the source's stop().
  async function prepared(source, startTime, width, deadline, budgetMs) {
    const pending = sources.prepare(source, frameContext(startTime, width));
    let descriptor;
    try {
      descriptor = await beforeDeadline(pending, deadline, budgetMs);
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
      aspect: aspectOf(descriptor.profile),
      input,
      cachedAt: () => null,
      release: () => Promise.resolve().then(() => descriptor.stop?.()).catch(() => {}),
    };
  }

  const playlist = async (url, headers, deadline) => {
    const { response, body } = await fetchTextWithRetry(url, { headers: { ...(headers || {}) }, redirect: "follow" }, {
      retries: 1, label: "frame-playlist", maxBytes: MAX_PLAYLIST_BYTES, timeoutMs: Math.max(1000, Math.min(8000, remaining(deadline))), fetchFn: fetchImpl, logger,
    });
    if (!response.ok) throw new YoloError("resolve_failed", `The source's playlist answered ${response.status}`);
    return { body, base: response.url || url };
  };

  // Where ffmpeg reads: the file, a split stream's video, or one variant of
  // an HLS stream, with that variant's segments when it is fMP4.
  async function target(input, width, deadline) {
    if (input.type === "file") return { url: input.url, headers: input.headers };
    if (input.type === "split") return { url: input.video.url, headers: input.video.headers ?? null };
    let { body, base } = input.manifest ? { body: input.manifest, base: input.url } : await playlist(input.url, input.headers, deadline);
    const variant = isMasterPlaylist(body) ? pickVariant(body, width) : null;
    const url = variant ? new URL(variant, base).href : input.url;
    if (variant) {
      try {
        ({ body, base } = await playlist(url, input.headers, deadline));
      } catch (error) {
        // ffmpeg reads the variant itself, and says what fails.
        logger.debug?.({ err: error.message }, "The variant playlist could not be read");
        body = "";
      }
    }
    return { url, headers: input.headers, segments: fmp4Segments(body, base) };
  }

  // A part of an fMP4 HLS stream: the whole resource, or its byte range.
  async function part({ url, range }, headers, deadline, maxBytes = MAX_SEGMENT_BYTES) {
    const rangeHeader = range ? { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
    const { response, bytes } = await fetchBytesWithRetry(url, { headers: { ...(headers || {}), ...rangeHeader }, redirect: "follow" }, {
      retries: 1, label: "frame-segment", maxBytes, timeoutMs: Math.max(1000, remaining(deadline)), fetchFn: fetchImpl, logger,
    });
    // ffmpeg would get the same refusal: no point in trying it after these.
    if (response.status === 401 || response.status === 403) throw Object.assign(new YoloError("resolve_failed", "The source refused to serve the video; its link may have expired"), { final: true });
    if (response.status === 404) throw Object.assign(new YoloError("resolve_failed", "The source no longer serves the video at the address it gave"), { final: true });
    if (!response.ok) throw new YoloError("resolve_failed", `The source's segment answered ${response.status}`);
    // A server that ignores Range sends the whole resource.
    return range && response.status === 200 ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
  }

  // One JPEG, at a lower quality when the first is too large.
  async function encode(args, { input = null, deadline, at, width, maxBytes = MAX_FRAME_BYTES, output = (quality) => jpegOutput(width, quality) }) {
    for (const quality of QUALITIES) {
      if (remaining(deadline) <= 0) throw new YoloError("resolve_failed", "Reading the video took too long");
      try {
        return await runFfmpeg([...args, ...output(quality)], { ffmpeg, input, timeoutMs: remaining(deadline), maxBytes, at });
      } catch (error) {
        if (!error.tooLarge || quality === QUALITIES.at(-1)) throw error;
      }
    }
    throw new YoloError("resolve_failed", "The picture is too large");
  }

  // One storyboard tile as RGB pixels.
  async function decodeTile(args, { input = null, deadline, at, layout, crop = null }) {
    if (remaining(deadline) <= 0) throw new YoloError("resolve_failed", "Reading the video took too long");
    const size = layout.tileWidth * layout.tileHeight * 3;
    const rgb = await runFfmpeg([...args, ...tileOutput(layout, crop)], { ffmpeg, input, timeoutMs: remaining(deadline), maxBytes: size, at });
    if (rgb.length !== size) throw new YoloError("resolve_failed", `No frame could be read at ${formatTimestamp(at)}`);
    return rgb;
  }

  // The frame at `at` of `item`, decoded by `decode(inputArgs, stdin)`: from
  // the cached segment when the item has it, else from the source.
  async function read(item, at, width, deadline, decode) {
    const cached = item.cachedAt(at);
    if (cached) {
      try {
        const input = Buffer.concat([cached.init, readFileSync(cached.segmentPath)]);
        // A pipe cannot seek: decode from the segment's start to the offset.
        return { result: await decode([...FFMPEG, "-i", "pipe:0", "-ss", cached.offset.toFixed(3)], input), input: "cache" };
      } catch (error) {
        // An evicted entry or a bad segment: read it from upstream instead.
        logger.debug?.({ err: error.message }, "A cached segment gave no frame");
      }
    }
    item.target ??= target(item.input, width, deadline);
    const { url, headers, segments } = await item.target;
    const segment = segments?.findLast((candidate) => candidate.start <= at);
    if (segment) {
      // The init section is the same for every segment of a stream.
      item.inits ??= new Map();
      const initKey = `${segment.map.url} ${segment.map.range?.offset ?? ""}`;
      if (!item.inits.has(initKey)) {
        item.inits.set(initKey, part(segment.map, headers, deadline, MAX_INIT_BYTES).catch((error) => {
          item.inits.delete(initKey);
          throw error;
        }));
      }
      try {
        const [init, media] = await Promise.all([item.inits.get(initKey), part(segment, headers, deadline)]);
        // A pipe cannot seek: decode from the segment's start to the offset.
        const offset = Math.max(0, at - segment.start);
        return { result: await decode([...FFMPEG, "-i", "pipe:0", "-ss", offset.toFixed(3)], Buffer.concat([init, media])), input: item.input.type };
      } catch (error) {
        // A segment too large or not served, or a playlist whose durations
        // do not match its media: ffmpeg reads the stream.
        if (error.final || remaining(deadline) <= 0) throw error;
        logger.debug?.({ err: error.message }, "The segment gave no frame; reading the stream");
      }
    }
    const args = [...FFMPEG, "-rw_timeout", String(READ_TIMEOUT_US), "-headers", ffmpegHeaders(headers || {}), "-ss", at.toFixed(3), "-i", url];
    return { result: await decode(args, null), input: item.input.type };
  }

  function checkLive(item) {
    if (item.isLive) {
      throw new YoloError("invalid_request", `${item.title ? `"${item.title}"` : "This item"} is a live stream: frames can be read only from a video with a fixed length`);
    }
  }

  function check(item, at) {
    checkLive(item);
    if (item.duration && at > item.duration) {
      throw new YoloError("invalid_request", `${formatTimestamp(at, { millis: true })} is past the end of ${item.title ? `"${item.title}"` : "this item"}, which lasts ${formatTimestamp(item.duration)}`);
    }
  }

  // A sheet of a source's storyboard, at most MAX_SHEET_BYTES.
  async function download(sheet, deadline) {
    const response = await fetchImpl(sheet.url, {
      headers: { ...(sheet.headers || {}) }, redirect: "follow", signal: AbortSignal.timeout(Math.max(1000, remaining(deadline))),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new YoloError("resolve_failed", `The source's storyboard image answered ${response.status}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_SHEET_BYTES) throw new YoloError("resolve_failed", "The source's storyboard image is too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  // Tiles cut from the source's own storyboard images; each tile is labelled
  // with the time it shows, which is the nearest the source has.
  async function boardTiles(board, times, layout, deadline) {
    const sheets = new Map();
    const sheetBytes = (sheet) => {
      if (!sheets.has(sheet.url)) sheets.set(sheet.url, download(sheet, deadline));
      return sheets.get(sheet.url);
    };
    return mapLimit(times, TILE_CONCURRENCY, async (at) => {
      const sheet = board.sheets.findLast((candidate) => candidate.start <= at);
      if (!sheet || at >= sheet.start + sheet.duration + sheet.interval) return { at, rgb: null };
      const index = Math.min(sheet.columns * sheet.rows - 1, Math.floor((at - sheet.start) / sheet.interval));
      const time = Number((sheet.start + index * sheet.interval).toFixed(3));
      const crop = `crop=${sheet.tileWidth}:${sheet.tileHeight}:${(index % sheet.columns) * sheet.tileWidth}:${Math.floor(index / sheet.columns) * sheet.tileHeight}`;
      try {
        const rgb = await decodeTile([...FFMPEG, "-i", "pipe:0"], { input: await sheetBytes(sheet), deadline, at: time, layout, crop });
        return { at: time, rgb };
      } catch (error) {
        logger.debug?.({ err: error.message }, "A storyboard image gave no tile");
        return { at: time, rgb: null, error };
      }
    });
  }

  async function frameTiles(item, times, layout, deadline) {
    return mapLimit(times, TILE_CONCURRENCY, async (at) => {
      try {
        const { result } = await read(item, at, layout.tileWidth, deadline, (args, input) => decodeTile(args, { input, deadline, at, layout }));
        return { at, rgb: result };
      } catch (error) {
        logger.debug?.({ err: error.message }, "A storyboard frame could not be read");
        return { at, rgb: null, error };
      }
    });
  }

  // The source's own storyboard, or null: a slow or failing one gives way
  // to frames read by the node.
  async function sourceBoard(source, deadline) {
    if (typeof sources.storyboard !== "function") return null;
    const pending = Promise.resolve().then(() => sources.storyboard(source));
    try {
      return normalizeStoryboard(await beforeDeadline(pending, Math.min(deadline, now() + SOURCE_STORYBOARD_MS), SOURCE_STORYBOARD_MS));
    } catch (error) {
      logger.debug?.({ err: error.message }, "The source's storyboard is unavailable; reading frames");
      return null;
    }
  }

  async function encodeBoard(layout, tiles, step, deadline) {
    const label = (at) => formatTimestamp(at, { millis: step < 1 });
    const rgb = composeStoryboard(layout, tiles.map((tile) => ({ rgb: tile.rgb, label: label(tile.at) })));
    return encode(["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${layout.width}x${layout.height}`, "-i", "pipe:0"], {
      input: rgb,
      deadline: Math.max(deadline, now()) + ENCODE_GRACE_MS,
      maxBytes: MAX_STORYBOARD_BYTES,
      output: (quality) => ["-frames:v", "1", "-vf", "scale=out_range=full,format=yuvj420p", "-c:v", "mjpeg", "-q:v", String(quality), "-f", "image2pipe", "pipe:1"],
    });
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
      return slot(timeoutMs, async (deadline) => {
        const playing = playingItem(sessionId, source);
        if (playing) {
          check(playing, at);
          try {
            const { result, input } = await read(playing, at, size, deadline, (args, stdin) => encode(args, { input: stdin, deadline, at, width: size }));
            return presentFrame(result, { item: playing, at, input, source });
          } catch (error) {
            if (remaining(deadline) <= 0) throw error;
            logger.debug?.({ err: error.message }, "The playing session gave no frame; preparing the item");
          }
        }
        const item = await prepared(source, at, size, deadline, timeoutMs);
        try {
          check(item, at);
          const { result, input } = await read(item, at, size, deadline, (args, stdin) => encode(args, { input: stdin, deadline, at, width: size }));
          return presentFrame(result, { item, at, input, source });
        } finally {
          await item.release();
        }
      });
    },

    // { source, from?, to?, count?, width?, sessionId?, duration? } → one
    // JPEG of `count` evenly spaced frames in a grid, each labelled with its
    // time, and the times. `duration` is the control plane's, for a source
    // whose own storyboard does not say.
    async storyboard({ source, from = null, to = null, count, width, sessionId = null, duration = null }) {
      const total = clampInt(count, MIN_STORYBOARD_COUNT, MAX_STORYBOARD_COUNT, STORYBOARD_COUNT);
      const tileWidth = clampInt(width, MIN_TILE_WIDTH, MAX_TILE_WIDTH, TILE_WIDTH);
      // Bad times fail before any work.
      if (from != null) parseTimestamp(from);
      if (to != null) parseTimestamp(to);
      return slot(storyboardTimeoutMs, async (deadline) => {
        const board = await sourceBoard(source, deadline);
        if (board) {
          const span = storyboardTimes({ from, to, count: total, duration: board.duration ?? duration, title: board.title });
          const first = board.sheets[0];
          const layout = storyboardLayout({ count: total, tileWidth, aspect: first.tileWidth / first.tileHeight });
          const tiles = await boardTiles(board, span.times, layout, deadline);
          if (tiles.some((tile) => tile.rgb)) {
            const image = await encodeBoard(layout, tiles, span.step, deadline);
            return presentBoard(image, { layout, tiles, span, title: board.title, duration: board.duration ?? duration, origin: "storyboard", input: null, source });
          }
          logger.debug?.({}, "The source's storyboard images gave no tile; reading frames");
        }
        const item = playingItem(sessionId, source)
          ?? await prepared(source, from == null ? 0 : parseTimestamp(from), tileWidth, deadline, storyboardTimeoutMs);
        try {
          checkLive(item);
          const span = storyboardTimes({ from, to, count: total, duration: item.duration ?? duration, title: item.title });
          const layout = storyboardLayout({ count: total, tileWidth, aspect: item.aspect ?? 16 / 9 });
          const tiles = await frameTiles(item, span.times, layout, deadline);
          if (!tiles.some((tile) => tile.rgb)) throw tiles.find((tile) => tile.error)?.error ?? new YoloError("resolve_failed", "No frame of the storyboard could be read");
          const image = await encodeBoard(layout, tiles, span.step, deadline);
          return presentBoard(image, { layout, tiles, span, title: item.title, duration: item.duration ?? duration, origin: "frames", input: item.input.type, source });
        } finally {
          await item.release();
        }
      });
    },
  };
}

function presentFrame(image, { item, at, input, source }) {
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

function presentBoard(image, { layout, tiles, span, title, duration, origin, input, source }) {
  return {
    image: image.toString("base64"),
    mimeType: "image/jpeg",
    ...jpegSize(image),
    bytes: image.length,
    title: title ?? null,
    duration: duration ?? null,
    from: span.from,
    to: span.to,
    step: Number(span.step.toFixed(3)),
    count: tiles.length,
    columns: layout.columns,
    rows: layout.rows,
    tileWidth: layout.tileWidth,
    tileHeight: layout.tileHeight,
    times: tiles.map((tile) => tile.at),
    missing: tiles.filter((tile) => !tile.rgb).map((tile) => tile.at),
    origin,
    input,
    plugin: source.plugin,
  };
}
