// The prepare context's `playable(media)` (Agent Note 2026-10-12-lan-direct-play):
// whether the playing device can take a source's original file as it is.
// A plugin describes the file in provider-neutral terms; this compares the
// description with the device's capabilities and the stream's bitrate limit.
//
//   direct     the file plays as it is (progressive, by byte range)
//   remux      the codecs play, the container does not: copy into a new one
//   audio      the video plays, the audio does not: copy video, convert audio
//   transcode  the video does not play here (codec, bit depth, HDR, size, or
//              a bitrate above the limit)
//
// `reasons` names every mismatch. Unknown fields count as playable, except a
// missing video codec, which never direct-plays.

const CONTAINER_ALIASES = Object.freeze({ m4v: "mp4", "mp4v": "mp4" });

const lower = (value) => String(value ?? "").trim().toLowerCase();

/**
 * @param {{ container?: string, video?: { codec?: string, bitDepth?: number, hdr?: boolean, height?: number } | null,
 *   audio?: Array<{ codec?: string }>, kbps?: number }} media
 * @param {{ capabilities: object, limits?: { maxVideoKbps?: number } }} device
 * @returns {{ decision: "direct" | "remux" | "audio" | "transcode", reasons: string[] }}
 */
export function playable(media = {}, { capabilities = {}, limits = {} } = {}) {
  const reasons = [];
  const video = media.video ?? null;
  const videoCodecs = (capabilities.video || []).map(lower);
  const audioCodecs = (capabilities.audio || []).map(lower);
  const containers = (capabilities.containers || []).map(lower);

  let videoPlays = true;
  if (video) {
    if (!video.codec || !videoCodecs.includes(lower(video.codec))) reasons.push("video_codec");
    if (Number(video.bitDepth) > 8) reasons.push("bit_depth");
    if (video.hdr === true) reasons.push("hdr");
    if (Number(video.height) > 0 && Number(capabilities.maxHeight) > 0 && Number(video.height) > Number(capabilities.maxHeight)) reasons.push("resolution");
    videoPlays = reasons.length === 0;
  }
  const maxKbps = Number(limits.maxVideoKbps);
  if (Number(media.kbps) > 0 && Number.isFinite(maxKbps) && maxKbps > 0 && Number(media.kbps) > maxKbps) {
    reasons.push("bitrate");
    videoPlays = false;
  }
  if (!videoPlays) return { decision: "transcode", reasons };

  const audio = Array.isArray(media.audio) ? media.audio : [];
  const audioPlays = audio.every((track) => audioCodecs.includes(lower(track.codec)));
  if (!audioPlays) reasons.push("audio_codec");
  const container = lower(media.container);
  const containerPlays = Boolean(container) && containers.includes(CONTAINER_ALIASES[container] ?? container)
    && (capabilities.delivery || []).includes("mp4");
  if (!containerPlays) reasons.push("container");

  if (!audioPlays) return { decision: "audio", reasons };
  if (!containerPlays) return { decision: "remux", reasons };
  return { decision: "direct", reasons };
}
