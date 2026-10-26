import { formatTimestamp, YoloError } from "@useyolo/core";
import { silentLogger } from "../log.js";
import { pickVariant, runFfmpeg } from "./frames.js";
import { isMasterPlaylist } from "./hls.js";
import { ffmpegHeaders, httpProxyArgs } from "./transcode.js";
import { fetchBytesWithRetry, fetchTextWithRetry } from "./upstream.js";

// A stretch of an item's sound for a transcriber (Agent Note
// 2026-10-18-ai-subtitles), read the way the node streams the item: from the
// Input a media session plays, with the URLs it reads now. ffmpeg turns it
// into 16 kHz mono 16-bit WAV, what speech models take. Nothing is written to
// disk, and ffmpeg's stderr, which can quote signed upstream URLs, is never
// passed on.
//
// - A file, or a split stream's audio, is read with a fast input seek.
// - HLS reads the master playlist's audio rendition when it has one, else its
//   smallest variant, so no picture larger than needed is fetched.
// - A live stream (Input `live`) is read by sequence number: the node fetches
//   the segments the stretch covers and pipes them to ffmpeg.

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const READ_TIMEOUT_US = 15_000_000;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const MAX_LIVE_SEGMENT_BYTES = 32 * 1024 * 1024;
const FFMPEG = ["-hide_banner", "-loglevel", "error", "-nostdin"];
const WAV_OUTPUT = ["-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"];

// ffmpeg cannot seek back in a pipe to write a WAV's sizes; write them here,
// so every reader takes the file.
function fixWavSizes(wav) {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return wav;
  wav.writeUInt32LE(wav.length - 8, 4);
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    if (id === "data") {
      wav.writeUInt32LE(wav.length - offset - 8, offset + 4);
      break;
    }
    offset += 8 + wav.readUInt32LE(offset + 4);
  }
  return wav;
}

// The audio rendition of a master playlist (the default one first), or null.
function audioRendition(body) {
  const renditions = body.split(/\r?\n/)
    .filter((line) => line.startsWith("#EXT-X-MEDIA:") && /TYPE=AUDIO/.test(line))
    .map((line) => ({ uri: /URI="([^"]+)"/.exec(line)?.[1] ?? null, isDefault: /DEFAULT=YES/.test(line) }))
    .filter(({ uri }) => uri);
  return (renditions.find(({ isDefault }) => isDefault) ?? renditions[0])?.uri ?? null;
}

const remaining = (deadline, now) => Math.max(0, deadline - now());

// `egress` (egress/egress.js) routes its reads by the owner's rules.
export function createAudioReader({ logger = silentLogger, egress = null } = {}) {
  const fetchFn = egress?.fetch ?? globalThis.fetch;
  const proxyFor = (url) => egress?.proxyFor(url) ?? null;
  const now = () => Date.now();
  async function wav(args, { input = null, seconds, deadline, at }) {
    try {
      const output = await runFfmpeg([...args, ...WAV_OUTPUT], {
        input, timeoutMs: remaining(deadline, now), maxBytes: Math.ceil(seconds * BYTES_PER_SECOND * 1.1) + 64 * 1024, at,
      });
      return fixWavSizes(output);
    } catch (error) {
      if (/not installed/.test(error.message) || /refused|no longer serves/.test(error.message)) throw error;
      throw new YoloError("resolve_failed", `No sound could be read at ${formatTimestamp(at)}`);
    }
  }

  // Where ffmpeg reads the sound of a fixed-length item.
  async function target(input, deadline) {
    if (input.type === "file") return { url: input.url, headers: input.headers };
    if (input.type === "split") return { url: input.audio.url, headers: input.audio.headers ?? null };
    const body = input.manifest ?? (await fetchTextWithRetry(input.url, { headers: input.headers || {}, redirect: "follow" }, {
      retries: 1, label: "audio-playlist", maxBytes: MAX_PLAYLIST_BYTES, timeoutMs: Math.max(1000, remaining(deadline, now)), fetchFn, logger,
    })).body;
    if (!isMasterPlaylist(body)) return { url: input.url, headers: input.headers };
    const uri = audioRendition(body) ?? pickVariant(body, 0);
    return { url: uri ? new URL(uri, input.url).href : input.url, headers: input.headers };
  }

  return {
    /** `seconds` of sound from `start` of a fixed-length item's Input, as WAV. */
    async read(input, { start, seconds, timeoutMs }) {
      const deadline = now() + timeoutMs;
      const { url, headers } = await target(input, deadline);
      const args = [...FFMPEG, "-rw_timeout", String(READ_TIMEOUT_US), "-headers", ffmpegHeaders(headers || {}),
        "-ss", start.toFixed(3), "-t", seconds.toFixed(3), ...httpProxyArgs(proxyFor(url)), "-i", url];
      return wav(args, { seconds, deadline, at: start });
    },

    /**
     * The sound of live segments `from`..`to` (sequence numbers), as WAV.
     * `live` is { segmentDuration, segmentUrl(sequence), headers }.
     */
    async readLive(live, { from, to, timeoutMs }) {
      const deadline = now() + timeoutMs;
      const parts = [];
      for (let sequence = from; sequence <= to; sequence += 1) {
        const url = live.segmentUrl(sequence);
        if (!url) throw new YoloError("resolve_failed", `Live segment ${sequence} is no longer served`);
        const { response, bytes } = await fetchBytesWithRetry(url, { headers: live.headers || {}, redirect: "follow" }, {
          retries: 1, label: "audio-segment", maxBytes: MAX_LIVE_SEGMENT_BYTES, timeoutMs: Math.max(1000, remaining(deadline, now)), fetchFn, logger,
        });
        if (!response.ok) throw new YoloError("resolve_failed", `Live segment ${sequence} answered ${response.status}`);
        parts.push(bytes);
      }
      const seconds = (to - from + 1) * live.segmentDuration;
      return wav([...FFMPEG, "-i", "pipe:0"], { input: Buffer.concat(parts), seconds, deadline, at: from * live.segmentDuration });
    },
  };
}
