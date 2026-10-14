// Pure HLS playlist transforms for the media pipeline (no I/O): playlist
// rewriting, start-offset trimming and live DVR
// windows, without anything provider-specific. Sources describe their streams
// through the Input options in Agent Note 2026-10-11-node-media-pipeline.

// Rewrite every URI in a playlist: segment and playlist lines, and URI="…"
// attributes inside tags such as EXT-X-MAP, EXT-X-KEY and EXT-X-MEDIA.
export function rewriteHlsUris(body, rewriteUri) {
  return body
    .replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewriteUri(uri)}"`)
    .replace(/^(?!#)(\S+.*)$/gm, (_match, line) => rewriteUri(line.trim()));
}

export const isMasterPlaylist = (body) => body.includes("#EXT-X-STREAM-INF");

// The segments of an fMP4 media playlist, each with its start in the
// playlist, its absolute URL and byte range, and its EXT-X-MAP init section,
// so one segment can be read on its own. Null for a playlist that is not
// fMP4 throughout, is encrypted, or cannot be read exactly.
export function fmp4Segments(body, base) {
  const range = (value, from) => {
    const [length, offset] = value.split("@");
    const size = Number(length);
    const start = offset === undefined ? from : Number(offset);
    return Number.isInteger(size) && size > 0 && Number.isInteger(start) && start >= 0 ? { offset: start, length: size } : null;
  };
  const segments = [];
  let map = null;
  let duration = null;
  let byterange = null;
  let start = 0;
  let next = 0;
  try {
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-KEY:") && !/METHOD=NONE\b/i.test(line)) return null;
      if (line.startsWith("#EXT-X-MAP:")) {
        const uri = /URI="([^"]+)"/.exec(line)?.[1];
        const mapRange = /BYTERANGE="([^"]+)"/.exec(line)?.[1];
        if (!uri) return null;
        map = { url: new URL(uri, base).href, range: mapRange ? range(mapRange, 0) : null };
        if (mapRange && !map.range) return null;
      } else if (line.startsWith("#EXTINF:")) {
        duration = Number(line.slice("#EXTINF:".length).split(",", 1)[0]);
        if (!Number.isFinite(duration) || duration < 0) return null;
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
        byterange = range(line.slice("#EXT-X-BYTERANGE:".length), next);
        if (!byterange) return null;
      } else if (!line.startsWith("#")) {
        if (duration === null || !map) return null;
        segments.push({ url: new URL(line, base).href, start, duration, range: byterange, map });
        next = byterange ? byterange.offset + byterange.length : 0;
        start += duration;
        duration = null;
        byterange = null;
      }
    }
  } catch {
    // A URI that does not resolve.
    return null;
  }
  return segments.length ? segments : null;
}

// Drop variants above `maxBandwidth` bits per second or taller than the
// device's `maxHeight` (their RESOLUTION): a player takes the best variant
// it is given, and the canvas engine always does
// (Agent Note 2026-10-07-capability-negotiation). A master playlist whose
// every variant is too large keeps only its smallest rather than becoming
// unplayable.
export function filterVariants(body, maxBandwidth, maxHeight = 0) {
  if ((!maxBandwidth && !(maxHeight > 0)) || !isMasterPlaylist(body)) return body;
  const lines = body.split("\n");
  const kept = [];
  let skip = false;
  let variants = 0;
  let dropped = 0;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      variants += 1;
      const bandwidth = Number(line.match(/BANDWIDTH=(\d+)/)?.[1]);
      const height = Number(line.match(/RESOLUTION=\d+x(\d+)/)?.[1]);
      skip = Boolean(maxBandwidth && Number.isFinite(bandwidth) && bandwidth > maxBandwidth)
        || (maxHeight > 0 && Number.isFinite(height) && height > maxHeight);
      if (skip) dropped += 1;
    }
    if (skip && !line.startsWith("#")) {
      skip = false;
      continue;
    }
    if (!skip) kept.push(line);
  }
  if (!dropped) return body;
  if (dropped < variants) return kept.join("\n");
  return lowestVariantOnly(lines);
}

// Every variant is above the cap: keep the smallest, which is the closest
// to what the device can carry.
function lowestVariantOnly(lines) {
  let lowest = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("#EXT-X-STREAM-INF")) continue;
    const bandwidth = Number(lines[index].match(/BANDWIDTH=(\d+)/)?.[1]);
    if (!Number.isFinite(bandwidth)) return lines.join("\n");
    if (!lowest || bandwidth < lowest.bandwidth) lowest = { index, bandwidth };
  }
  const kept = [];
  let skip = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("#EXT-X-STREAM-INF")) skip = index !== lowest.index;
    if (skip && !line.startsWith("#")) {
      skip = false;
      continue;
    }
    if (!skip) kept.push(line);
  }
  return kept.join("\n");
}

// A transcoder that starts at an offset may publish placeholder segments from
// zero up to EXT-X-START:TIME-OFFSET. Drop them, so the player's timeline and
// segment indexes begin where the media really starts.
export function trimToStartOffset(body, { onTrim = null } = {}) {
  const hadTrailingNewline = body.endsWith("\n");
  const lines = body.split(/\r?\n/);
  const startLine = lines.find((line) => line.startsWith("#EXT-X-START:"));
  const resumeOffset = Number(startLine?.match(/TIME-OFFSET=(-?\d+(?:\.\d+)?)/i)?.[1]);
  if (!Number.isFinite(resumeOffset) || resumeOffset <= 0) return body;

  const firstSegmentIndex = lines.findIndex((line) => line.startsWith("#EXTINF:"));
  if (firstSegmentIndex === -1) return body;

  let accumulated = 0;
  let dropped = 0;
  let firstKept = -1;
  for (let index = firstSegmentIndex; index < lines.length; index += 1) {
    if (!lines[index].startsWith("#EXTINF:")) continue;
    const duration = Number(lines[index].slice("#EXTINF:".length).split(",", 1)[0]);
    if (!Number.isFinite(duration) || duration < 0) return body;
    if (accumulated + duration > resumeOffset) {
      firstKept = index;
      break;
    }
    accumulated += duration;
    dropped += 1;
  }
  if (!dropped || firstKept === -1) return body;

  const sequenceIndex = lines.findIndex((line) => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  const sequence = sequenceIndex === -1 ? 0 : Number(lines[sequenceIndex].slice("#EXT-X-MEDIA-SEQUENCE:".length));
  if (!Number.isInteger(sequence) || sequence < 0) return body;

  const trimmed = [...lines.slice(0, firstSegmentIndex), ...lines.slice(firstKept)]
    .filter((line) => !line.startsWith("#EXT-X-START:"));
  const nextSequence = sequence + dropped;
  const trimmedSequenceIndex = trimmed.findIndex((line) => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  if (trimmedSequenceIndex === -1) {
    trimmed.splice(trimmed.findIndex((line) => line.startsWith("#EXTINF:")), 0, `#EXT-X-MEDIA-SEQUENCE:${nextSequence}`);
  } else {
    trimmed[trimmedSequenceIndex] = `#EXT-X-MEDIA-SEQUENCE:${nextSequence}`;
  }
  onTrim?.({ resumeOffset, droppedSegments: dropped, nextMediaSequence: nextSequence });
  const result = trimmed.join("\n");
  return hadTrailingNewline && !result.endsWith("\n") ? `${result}\n` : result;
}

// --- Live DVR windows --------------------------------------------------------
// Some live sources publish a long, sequence-addressed DVR playlist. A source
// plugin parses it into a LiveIndex (Input.live.parse); the pipeline serves a
// bounded window around the play cursor, so the decoder keeps a short live
// playlist and can seek back within the DVR range. The player reads the
// EXT-X-YOLO-* tags to draw its live timeline.
//
// LiveIndex: { mediaSequence, latestSequence, segmentDuration, startedAt,
//   liveEdge, targetDuration, segmentUrl(sequence) }

// The player buffers about 15 seconds before its clock starts, so begin 15
// seconds behind and settle near a 30-second latency.
const DEFAULT_CURSOR_LATENCY_SECONDS = 15;
const WINDOW_AHEAD_SECONDS = 150;
const WINDOW_BEHIND_SECONDS = 30;

export function sequenceForTime(index, time) {
  const requested = Number(time);
  if (time == null || time === "" || !Number.isFinite(requested)) return null;
  return Math.max(0, Math.min(index.latestSequence, Math.floor((requested - index.startedAt) / index.segmentDuration)));
}

// `segmentPath(sequence)` names the pipeline's own live segment route.
export function buildLiveWindow(index, {
  cursorSequence,
  segmentPath,
  defaultLatencySeconds = DEFAULT_CURSOR_LATENCY_SECONDS,
  windowAheadSeconds = WINDOW_AHEAD_SECONDS,
  windowBehindSeconds = WINDOW_BEHIND_SECONDS,
} = {}) {
  const defaultCursor = index.latestSequence - Math.ceil(defaultLatencySeconds / index.segmentDuration);
  const play = Math.max(0, Math.min(index.latestSequence, Number.isInteger(cursorSequence) ? cursorSequence : defaultCursor));
  const start = Math.max(0, play - Math.ceil(windowBehindSeconds / index.segmentDuration));
  const count = Math.max(1, Math.ceil(windowAheadSeconds / index.segmentDuration));
  // Advertise a bounded future runway; the segment route waits until an
  // advertised sequence is published, which keeps live decoders open.
  const end = play + count - 1;
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.ceil(index.targetDuration)}`,
    `#EXT-X-MEDIA-SEQUENCE:${start}`,
    `#EXT-X-PROGRAM-DATE-TIME:${new Date((index.startedAt + start * index.segmentDuration) * 1000).toISOString()}`,
  ];
  const playStart = index.startedAt + play * index.segmentDuration;
  lines.push(`#EXT-X-YOLO-DVR-START:${index.startedAt}`, `#EXT-X-YOLO-LIVE-EDGE:${index.liveEdge}`, `#EXT-X-YOLO-PLAY-START:${playStart}`);
  for (let sequence = start; sequence <= end; sequence += 1) {
    lines.push(`#EXTINF:${index.segmentDuration.toFixed(3)},`);
    lines.push(segmentPath(sequence));
  }
  return `${lines.join("\n")}\n`;
}

// --- ffmpeg output -----------------------------------------------------------

// Point an ffmpeg HLS playlist's files at the pipeline's route for them.
export function rewriteTranscodePlaylist(body, filePath) {
  return rewriteHlsUris(body, (uri) => {
    if (/^https?:\/\//i.test(uri)) return uri;
    const name = uri.split("?")[0].replace(/[\\/]+/g, "").replace(/^\.+/g, "");
    return name ? filePath(name) : uri;
  });
}
