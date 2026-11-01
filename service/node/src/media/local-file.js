import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { extname, resolve } from "node:path";

// What the node knows of a file on its own disk before it plays it
// (Agent Note 2026-10-26-folder-source): ffprobe's reading of its streams in
// the capabilities' terms, and its video keyframes, which the local stream
// (local-stream.js) cuts its segments at so that a stream restarted anywhere
// gives the same segments. The keyframes come from the file's own index (an
// MP4's sample tables, a Matroska file's cues), read in a few small reads;
// any other file is scanned with ffprobe, which reads all of it, once, kept
// on disk by the file's path, size, and modification time.

const PROBE_TIMEOUT_MS = 20_000;
const SCAN_TIMEOUT_MS = 90_000;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_KEYFRAMES = 200_000;

// ffprobe's codec names in the capabilities' codec ids.
const VIDEO_CODECS = Object.freeze({ h264: "avc1", hevc: "hvc1", vp9: "vp09", vp8: "vp08", av1: "av01", mpeg4: "mp4v", mpeg2video: "mp2v", mpeg1video: "mp1v", vc1: "vc-1", wmv3: "wmv3" });
const AUDIO_CODECS = Object.freeze({ aac: "mp4a", mp3: "mp3", ac3: "ac-3", eac3: "ec-3", opus: "opus", flac: "flac", dts: "dts", truehd: "mlpa", vorbis: "vorbis", mp2: "mp2", alac: "alac" });
// Containers by extension, in the capabilities' names.
const CONTAINERS = Object.freeze({ ".mp4": "mp4", ".m4v": "mp4", ".mov": "mov", ".mkv": "mkv", ".webm": "webm", ".avi": "avi", ".ts": "ts", ".m2ts": "ts", ".mts": "ts", ".wmv": "wmv", ".flv": "flv", ".mpg": "mpeg", ".mpeg": "mpeg" });
const MIME = Object.freeze({ mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" });

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

function run(command, args, { timeout, maxBuffer = 64 * 1024 * 1024 }) {
  return new Promise((done, fail) => {
    execFile(command, args, { timeout, maxBuffer, encoding: "utf8" }, (error, stdout) => (error ? fail(error) : done(stdout)));
  });
}

/** The MIME type a file direct-plays with, for its container. */
export const mimeOf = (container) => MIME[container] ?? "application/octet-stream";

/** ffprobe's JSON for a file, reduced to what playing it needs. */
export function readProbe(json, path) {
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const format = json?.format ?? {};
  const picture = streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const video = picture ? {
    index: picture.index,
    codec: VIDEO_CODECS[picture.codec_name] ?? picture.codec_name,
    width: number(picture.width),
    height: number(picture.height),
    fps: (() => {
      const [a, b] = String(picture.avg_frame_rate || picture.r_frame_rate || "").split("/").map(Number);
      return a > 0 && b > 0 ? Math.round((a / b) * 1000) / 1000 : null;
    })(),
    bitDepth: /1[02]le|1[02]be|p010|p012/.test(String(picture.pix_fmt)) ? 10 : 8,
    hdr: ["smpte2084", "arib-std-b67"].includes(picture.color_transfer),
  } : null;
  const audio = streams.filter((stream) => stream.codec_type === "audio").map((stream, at) => ({
    index: stream.index,
    order: at,
    codec: AUDIO_CODECS[stream.codec_name] ?? stream.codec_name,
    channels: number(stream.channels),
    language: stream.tags?.language ?? null,
    title: stream.tags?.title ?? null,
    default: Boolean(stream.disposition?.default),
  }));
  const subtitles = streams.filter((stream) => stream.codec_type === "subtitle").map((stream, at) => ({
    index: stream.index,
    order: at,
    codec: stream.codec_name,
    // Text a screen can draw; pictures (PGS, VobSub) would have to be burned in.
    text: ["subrip", "ass", "ssa", "webvtt", "mov_text", "text"].includes(stream.codec_name),
    language: stream.tags?.language ?? null,
    title: stream.tags?.title ?? null,
    default: Boolean(stream.disposition?.default),
    forced: Boolean(stream.disposition?.forced),
  }));
  return {
    container: CONTAINERS[extname(path).toLowerCase()] ?? String(format.format_name ?? "").split(",")[0],
    duration: number(format.duration),
    startTime: number(format.start_time) ?? 0,
    kbps: number(format.bit_rate) ? Math.round(Number(format.bit_rate) / 1000) : null,
    video,
    audio,
    subtitles,
  };
}

/** ffprobe a file on the node's disk. */
export async function probeFile(path, { ffprobe = "ffprobe" } = {}) {
  const stdout = await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { timeout: PROBE_TIMEOUT_MS });
  return readProbe(JSON.parse(stdout), path);
}

// --- MP4: the video track's sample tables --------------------------------

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

// The boxes inside `buffer` from `start` to `end`: { type, start, end } of
// each box's payload.
function boxes(buffer, start = 0, end = buffer.length) {
  const found = [];
  let at = start;
  while (at + 8 <= end) {
    let size = buffer.readUInt32BE(at);
    const type = buffer.toString("latin1", at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    found.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return found;
}

const child = (buffer, box, type) => boxes(buffer, box.start, box.end).find((one) => one.type === type) ?? null;

/** Video keyframe times (seconds, presentation order) from an MP4's moov, or null. */
export function mp4Keyframes(moov) {
  const top = { start: 0, end: moov.length };
  for (const trak of boxes(moov, top.start, top.end).filter((box) => box.type === "trak")) {
    const mdia = child(moov, trak, "mdia");
    const hdlr = mdia && child(moov, mdia, "hdlr");
    if (!hdlr || moov.toString("latin1", hdlr.start + 8, hdlr.start + 12) !== "vide") continue;
    const mdhd = child(moov, mdia, "mdhd");
    const version = moov[mdhd.start];
    const timescale = moov.readUInt32BE(mdhd.start + (version === 1 ? 20 : 12));
    const stbl = child(moov, child(moov, mdia, "minf") ?? { start: 0, end: 0 }, "stbl");
    if (!stbl || !timescale) return null;
    const stts = child(moov, stbl, "stts");
    if (!stts) return null;
    // Decode times of every sample.
    const deltas = [];
    for (let entry = 0, count = moov.readUInt32BE(stts.start + 4); entry < count; entry += 1) {
      const at = stts.start + 8 + entry * 8;
      deltas.push([moov.readUInt32BE(at), moov.readUInt32BE(at + 4)]);
    }
    const offsets = [];
    const ctts = child(moov, stbl, "ctts");
    if (ctts) {
      const signed = moov[ctts.start] === 1;
      for (let entry = 0, count = moov.readUInt32BE(ctts.start + 4); entry < count; entry += 1) {
        const at = ctts.start + 8 + entry * 8;
        offsets.push([moov.readUInt32BE(at), signed ? moov.readInt32BE(at + 4) : moov.readUInt32BE(at + 4)]);
      }
    }
    const stss = child(moov, stbl, "stss");
    const sync = stss ? new Set(Array.from({ length: moov.readUInt32BE(stss.start + 4) }, (_, at) => moov.readUInt32BE(stss.start + 8 + at * 4))) : null;
    // The edit list's first media time is where presentation starts.
    let shift = 0;
    const elst = child(moov, child(moov, trak, "edts") ?? { start: 0, end: 0 }, "elst");
    if (elst) {
      const v1 = moov[elst.start] === 1;
      for (let entry = 0, count = moov.readUInt32BE(elst.start + 4); entry < count; entry += 1) {
        const at = elst.start + 8 + entry * (v1 ? 20 : 12);
        const mediaTime = v1 ? Number(moov.readBigInt64BE(at + 8)) : moov.readInt32BE(at + 4);
        if (mediaTime >= 0) {
          shift = mediaTime;
          break;
        }
      }
    }
    const times = [];
    let sample = 1;
    let dts = 0;
    let offsetEntry = 0;
    let offsetLeft = offsets[0]?.[0] ?? 0;
    for (const [count, delta] of deltas) {
      for (let n = 0; n < count; n += 1, sample += 1, dts += delta) {
        let offset = 0;
        if (offsets.length) {
          while (offsetLeft === 0 && offsetEntry < offsets.length - 1) offsetLeft = offsets[++offsetEntry][0];
          offset = offsets[offsetEntry][1];
          offsetLeft -= 1;
        }
        if (!sync || sync.has(sample)) {
          times.push((dts + offset - shift) / timescale);
          if (times.length > MAX_KEYFRAMES) return null;
        }
      }
    }
    return times.sort((a, b) => a - b);
  }
  return null;
}

async function mp4Index(handle, size) {
  let at = 0;
  while (at + 8 <= size) {
    const head = await readAt(handle, at, 16);
    if (head.length < 8) return null;
    let boxSize = head.readUInt32BE(0);
    const type = head.toString("latin1", 4, 8);
    let header = 8;
    if (boxSize === 1) {
      boxSize = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (boxSize === 0) {
      boxSize = size - at;
    }
    if (boxSize < header) return null;
    if (type === "moov") {
      if (boxSize > MAX_INDEX_BYTES) return null;
      const moov = await readAt(handle, at + header, boxSize - header);
      // A fragmented file keeps its samples in fragments: scan it instead.
      if (boxes(moov).some((box) => box.type === "mvex")) return null;
      return mp4Keyframes(moov);
    }
    at += boxSize;
  }
  return null;
}

// --- Matroska: the cues ----------------------------------------------------

const EBML = Object.freeze({ segment: 0x18538067, seekHead: 0x114d9b74, seek: 0x4dbb, seekId: 0x53ab, seekPosition: 0x53ac, info: 0x1549a966, timestampScale: 0x2ad7b1, tracks: 0x1654ae6b, trackEntry: 0xae, trackNumber: 0xd7, trackType: 0x83, cues: 0x1c53bb6b, cuePoint: 0xbb, cueTime: 0xb3, cueTrackPositions: 0xb7, cueTrack: 0xf7 });

// One EBML variable-length integer at `at`: { value, length }, or null.
function vint(buffer, at, { id = false } = {}) {
  const first = buffer[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8 || at + length > buffer.length) return null;
  let value = id ? first : first & (0xff >> length);
  let unknown = value === (0xff >> length);
  for (let n = 1; n < length; n += 1) {
    value = value * 256 + buffer[at + n];
    if (buffer[at + n] !== 0xff) unknown = false;
  }
  return { value: !id && unknown ? -1 : value, length };
}

// The elements inside buffer[start, end): { id, start, end } of each payload.
function elements(buffer, start = 0, end = buffer.length) {
  const found = [];
  let at = start;
  while (at < end) {
    const id = vint(buffer, at, { id: true });
    if (!id) break;
    const size = vint(buffer, at + id.length);
    if (!size) break;
    const begin = at + id.length + size.length;
    const stop = size.value < 0 ? end : Math.min(end, begin + size.value);
    found.push({ id: id.value, start: begin, end: stop, size: size.value });
    if (size.value < 0) break;
    at = stop;
  }
  return found;
}

const uint = (buffer, element) => {
  let value = 0;
  for (let at = element.start; at < element.end; at += 1) value = value * 256 + buffer[at];
  return value;
};

/** Video keyframe times (seconds) from a Matroska file's cues, or null. */
async function matroskaIndex(handle, size) {
  const head = await readAt(handle, 0, Math.min(size, 256 * 1024));
  const top = elements(head);
  const segment = top.find((element) => element.id === EBML.segment);
  if (!segment) return null;
  const base = segment.start;
  // The segment's first elements; Tracks and Cues may sit further in, which
  // the SeekHead says.
  const children = elements(head, base, head.length);
  const positions = {};
  for (const seekHead of children.filter((element) => element.id === EBML.seekHead)) {
    for (const seek of elements(head, seekHead.start, seekHead.end).filter((element) => element.id === EBML.seek)) {
      const fields = elements(head, seek.start, seek.end);
      const id = fields.find((element) => element.id === EBML.seekId);
      const position = fields.find((element) => element.id === EBML.seekPosition);
      if (id && position) positions[uint(head, id)] ??= base + uint(head, position);
    }
  }
  const read = async (id) => {
    const inline = children.find((element) => element.id === id);
    if (inline && inline.end <= head.length) return { buffer: head, element: inline };
    const at = positions[id];
    if (at == null || at >= size) return null;
    const header = await readAt(handle, at, 16);
    const element = elements(header)[0];
    if (!element || element.id !== id) return null;
    const length = element.size;
    if (length < 0 || length > MAX_INDEX_BYTES) return null;
    const body = await readAt(handle, at + element.start, length);
    return { buffer: body, element: { id, start: 0, end: body.length } };
  };
  const info = await read(EBML.info);
  const scaleElement = info && elements(info.buffer, info.element.start, info.element.end).find((element) => element.id === EBML.timestampScale);
  const scale = scaleElement ? uint(info.buffer, scaleElement) : 1_000_000;
  const tracks = await read(EBML.tracks);
  let videoTrack = null;
  if (tracks) {
    for (const entry of elements(tracks.buffer, tracks.element.start, tracks.element.end).filter((element) => element.id === EBML.trackEntry)) {
      const fields = elements(tracks.buffer, entry.start, entry.end);
      const type = fields.find((element) => element.id === EBML.trackType);
      const track = fields.find((element) => element.id === EBML.trackNumber);
      if (type && track && uint(tracks.buffer, type) === 1) {
        videoTrack = uint(tracks.buffer, track);
        break;
      }
    }
  }
  const cues = await read(EBML.cues);
  if (!cues || videoTrack == null) return null;
  const times = [];
  for (const point of elements(cues.buffer, cues.element.start, cues.element.end)) {
    if (point.id !== EBML.cuePoint) continue;
    const fields = elements(cues.buffer, point.start, point.end);
    const time = fields.find((element) => element.id === EBML.cueTime);
    const forVideo = fields.some((element) => element.id === EBML.cueTrackPositions
      && elements(cues.buffer, element.start, element.end).some((inner) => inner.id === EBML.cueTrack && uint(cues.buffer, inner) === videoTrack));
    if (time && forVideo) times.push((uint(cues.buffer, time) * scale) / 1e9);
    if (times.length > MAX_KEYFRAMES) return null;
  }
  return times.length > 1 ? times.sort((a, b) => a - b) : null;
}

// --- Any file: ffprobe reads every packet ------------------------------------

async function scanKeyframes(path, ffprobe) {
  const stdout = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path], { timeout: SCAN_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
  const times = [];
  for (const line of stdout.split("\n")) {
    const [time, flags] = line.split(",");
    if (flags?.startsWith("K") && Number.isFinite(Number(time))) times.push(Number(time));
  }
  return times.length > 1 ? times.sort((a, b) => a - b) : null;
}

// Where ffmpeg's timeline puts the first video packet, which an index's own
// times may miss by an edit list or a start offset.
async function firstVideoTime(path, ffprobe) {
  const stdout = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_entries", "packet=pts_time", "-of", "csv=p=0", path], { timeout: PROBE_TIMEOUT_MS });
  const value = Number(stdout.split("\n")[0]);
  return Number.isFinite(value) ? value : null;
}

/** Video keyframe times in ffmpeg's timeline for the file, or null. */
export async function readKeyframes(path, { ffprobe = "ffprobe", container = null, scan = true } = {}) {
  const { size } = statSync(path);
  const handle = await open(path, "r");
  let times = null;
  try {
    if (container === "mp4" || container === "mov") times = await mp4Index(handle, size);
    else if (container === "mkv" || container === "webm") times = await matroskaIndex(handle, size);
  } catch {
    times = null;
  } finally {
    await handle.close();
  }
  if (times) {
    const first = await firstVideoTime(path, ffprobe).catch(() => null);
    const shift = first == null ? 0 : first - times[0];
    return Math.abs(shift) > 0.0005 ? times.map((time) => time + shift) : times;
  }
  return scan ? scanKeyframes(path, ffprobe).catch(() => null) : null;
}

/**
 * The node's readings of local files, kept in memory and, for keyframes, on
 * disk under `dir`, by path, size, and modification time.
 */
export function createLocalFiles({ dir = null, ffprobe = "ffprobe", logger = null } = {}) {
  const probes = new Map();
  const indexes = new Map();
  const keyOf = (path) => {
    const stat = statSync(path);
    return `${path}\0${stat.size}\0${Math.floor(stat.mtimeMs)}`;
  };
  const remember = (map, key, promise) => {
    map.set(key, promise);
    promise.catch(() => map.delete(key));
    if (map.size > 256) map.delete(map.keys().next().value);
    return promise;
  };
  const diskPath = (key) => (dir ? resolve(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`) : null);

  return {
    probe(path) {
      const key = keyOf(path);
      return probes.get(key) ?? remember(probes, key, probeFile(path, { ffprobe }));
    },
    keyframes(path, { container = null } = {}) {
      const key = keyOf(path);
      if (indexes.has(key)) return indexes.get(key);
      const file = diskPath(key);
      return remember(indexes, key, (async () => {
        if (file) {
          try {
            return JSON.parse(readFileSync(file, "utf8")).keyframes;
          } catch {}
        }
        const started = Date.now();
        const keyframes = await readKeyframes(path, { ffprobe, container });
        logger?.info?.({ keyframes: keyframes?.length ?? 0, ms: Date.now() - started }, "Read a local file's keyframes");
        if (file && keyframes) {
          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(file, JSON.stringify({ keyframes }));
          } catch {}
        }
        return keyframes;
      })());
    },
  };
}
