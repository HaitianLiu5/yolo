import { hostOf } from "./mirrors.js";

// Turning yt-dlp's JSON into an Input for Yolo's media pipeline
// (Agent Note 2026-10-11-node-media-pipeline):
// viewport-based format selection, the four delivery shapes yt-dlp can return,
// cache identities for signed CDN URLs, and YouTube's live DVR playlists.

// A device that names no maxHeight gets the car's 720p.
export const DEFAULT_TARGET_HEIGHT = 720;
export const LOW_FPS_TARGET_HEIGHT = 1080;
// Fast motion (50+ fps) goes no higher than this, whatever the screen:
// 2160p60 costs about twice the bitrate of 1440p60, and a software decoder
// may not keep up with it.
export const MOTION_MAX_HEIGHT = 1440;
// The relay's usual ceiling, assumed when the node names none; a
// limits.maxVideoKbps below it is taken for a device's adaptive-quality cap
// (the player stalled on this connection).
export const DEFAULT_MAX_VIDEO_KBPS = 4800;
export const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.92 Safari/537.36";

// yt-dlp's vcodec prefixes for Yolo's capability codec ids, and every
// spelling of each family, so that a device that did not announce a family
// never gets it.
const CODEC_PREFIXES = Object.freeze({ avc1: ["avc1"], hvc1: ["hvc1", "hev1"], vp09: ["vp09"], av01: ["av01"] });
const FAMILY_PREFIXES = Object.freeze({ hvc1: ["hvc1", "hev1", "hevc", "h265"], vp09: ["vp09", "vp9"], av01: ["av01", "av1"] });
// A codec other than H.264 is chosen only as a file the node serves by byte
// range (MP4 over http(s), not HLS or DASH fragments), and in SDR: WebM or
// HLS would make the node transcode it to H.264.
const BYTE_RANGE_MP4 = "[ext=mp4][protocol^=http][protocol!*=dash][dynamic_range=SDR]";
// Height bands for a device with codecs besides H.264: a taller picture in
// any announced codec wins over H.264 below it, because sites like YouTube
// offer H.264 only up to 1080p.
const BAND_FLOORS = Object.freeze([1440, 1080]);

/** The height a device should get: its own maxHeight (720p for the car). */
export function targetHeight(capabilities = {}) {
  const max = Number(capabilities.maxHeight);
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_TARGET_HEIGHT;
}

/**
 * yt-dlp's format selector for a device (Agent Note
 * 2026-10-07-capability-negotiation). Fast motion (50+ fps) gets up to the
 * device's height, at most MOTION_MAX_HEIGHT; low-frame-rate detail up to
 * the device's height and at least 1080p, within the same bitrate cap.
 * Within each height band H.264 comes first, then the device's other codecs
 * in its order; any codec of a family the device did not announce is left
 * out.
 * @param {{ targetHeight?: number, maxVideoKbps?: number, videoCodecs?: string[], audioCodec?: string }} [options]
 */
export function buildFormatSelector({ targetHeight: height = DEFAULT_TARGET_HEIGHT, maxVideoKbps = DEFAULT_MAX_VIDEO_KBPS, videoCodecs = ["avc1"], audioCodec = "mp4a" } = {}) {
  const deviceHeight = Math.max(144, Math.floor(Number(height) || DEFAULT_TARGET_HEIGHT));
  const motionHeight = Math.min(deviceHeight, MOTION_MAX_HEIGHT);
  const detailHeight = Math.max(deviceHeight, LOW_FPS_TARGET_HEIGHT);
  const bitrate = Math.max(200, Math.floor(Number(maxVideoKbps) || DEFAULT_MAX_VIDEO_KBPS));
  const others = [...new Set(videoCodecs)].filter((codec) => codec !== "avc1" && CODEC_PREFIXES[codec]);
  const audio = `+ba[acodec^=${audioCodec}]`;
  const excluded = Object.entries(FAMILY_PREFIXES)
    .filter(([codec]) => !videoCodecs.includes(codec))
    .flatMap(([, prefixes]) => prefixes)
    .map((prefix) => `[vcodec!^=?${prefix}]`)
    .join("");

  // H.264 first in each band, then the other codecs, then any codec the
  // device decodes.
  function byHeight(maxHeight, fps) {
    const floors = others.length ? BAND_FLOORS.filter((floor) => floor < maxHeight) : [];
    const bands = [maxHeight, ...floors].map((top, index) => {
      const floor = floors[index];
      return `[height<=${top}]${floor ? `[height>${floor}]` : ""}[tbr<=${bitrate}]${fps}`;
    });
    const any = `bv[height<=${maxHeight}][tbr<=${bitrate}]${fps}${excluded}`;
    return [
      ...bands.flatMap((band) => [
        `bv[vcodec^=avc1]${band}${audio}`,
        `bv[vcodec^=avc1]${band}+ba*`,
        ...others.flatMap((codec) => CODEC_PREFIXES[codec].map((prefix) => `bv[vcodec^=${prefix}]${BYTE_RANGE_MP4}${band}${audio}`)),
      ]),
      `${any}${audio}`,
      `${any}+ba*`,
    ];
  }

  // Under a device's cap, when no format fits, the smallest one is the
  // closest to what the connection carries; the best one would stall again.
  const smallest = bitrate < DEFAULT_MAX_VIDEO_KBPS
    ? [
      `b[height<=${detailHeight}][tbr<=${bitrate}]`,
      `wv[vcodec^=avc1]${audio}`,
      "wv+ba*",
      "w",
    ]
    : [];
  return [
    ...byHeight(motionHeight, "[fps>=50]"),
    ...byHeight(detailHeight, "[fps<50]"),
    ...smallest,
    `b*[height<=${motionHeight}][fps>=50]`,
    `b*[height<=${detailHeight}][fps<50]`,
    `b*[height<=${motionHeight}]`,
    "b*",
  ].join("/");
}

const isGoogleVideo = (url) => hostOf(url).endsWith("googlevideo.com");
const isBiliVideo = (url) => hostOf(url).includes("bilivideo.com");

export function isYouTubeUrl(value) {
  const host = hostOf(value);
  return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
}

function setIfMissing(headers, name, value) {
  if (!Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())) headers[name] = value;
}

// Request headers for a media URL: yt-dlp's per-format headers when it gave
// them, plus what the CDNs' hotlink checks expect.
export function mediaHeaders(url, given = null) {
  const headers = {};
  for (const [name, value] of Object.entries(given || {})) {
    if (name && value != null && value !== "") headers[name] = Array.isArray(value) ? value.join("; ") : String(value);
  }
  if (!given) {
    setIfMissing(headers, "User-Agent", BROWSER_USER_AGENT);
    setIfMissing(headers, "Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    setIfMissing(headers, "Accept-Language", "en-us,en;q=0.5");
    setIfMissing(headers, "Sec-Fetch-Mode", "navigate");
  }
  if (isGoogleVideo(url)) {
    setIfMissing(headers, "Referer", "https://www.youtube.com/");
    setIfMissing(headers, "Origin", "https://www.youtube.com");
  }
  if (isBiliVideo(url)) setIfMissing(headers, "Referer", "https://www.bilibili.com/");
  return headers;
}

// What the bytes behind a signed CDN URL are, so a re-signed URL of the same
// file reuses the node's disk cache. Null when the URL does not say.
export function cacheIdentity(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host.endsWith("googlevideo.com") || host.endsWith("youtube.com") || host === "youtu.be") {
    const params = parsed.searchParams;
    const fields = ["id", "itag", "clen", "lmt"].map((key) => params.get(key));
    if (fields.every(Boolean)) return `yt:${fields.join(":")}`;
    return null;
  }
  if (host.includes("bilivideo.com") && /\.m4s$/i.test(parsed.pathname)) return `bili:${parsed.pathname}`;
  return null;
}

export function streamProfile(info, { targetHeight: height, maxVideoKbps }) {
  const formats = info.requested_formats?.length ? info.requested_formats : [info];
  const video = formats.find((format) => format.vcodec && format.vcodec !== "none");
  const audio = formats.find((format) => format.acodec && format.acodec !== "none");
  if (!video) return null;
  return {
    width: video.width || null,
    height: video.height || null,
    fps: video.fps || null,
    videoKbps: video.tbr || video.vbr || null,
    audioKbps: audio?.abr || audio?.tbr || null,
    videoCodec: video.vcodec || null,
    audioCodec: audio?.acodec && audio.acodec !== "none" ? audio.acodec : null,
    formatId: formats.map((format) => format.format_id).filter(Boolean).join("+") || null,
    maxVideoKbps,
    targetHeight: height,
    split: formats.length > 1,
  };
}

const hasVideo = (format) => Boolean(format?.vcodec && format.vcodec !== "none");
const hasAudio = (format) => Boolean(format?.acodec && format.acodec !== "none");

export function splitTrack(format) {
  return {
    url: format.url,
    headers: mediaHeaders(format.url, format.http_headers || null),
    cacheKey: cacheIdentity,
    codec: (hasVideo(format) ? format.vcodec : format.acodec) || undefined,
    width: format.width || undefined,
    height: format.height || undefined,
    fps: format.fps || undefined,
    kbps: format.tbr || undefined,
  };
}

const isHlsFormat = (format) => /m3u8/.test(String(format?.protocol || ""));

/**
 * The video format to start a split stream on when its upstream gives only
 * `kbps` (a probe's rate, its first-byte wait included): the best of the same
 * codec and no taller than the selected one whose bitrate with the audio
 * fits under `kbps`, else the smallest such. Null when the selected video
 * fits or nothing smaller exists.
 * `maxVideoKbps` is the cap the stream then reports, so the device's
 * adaptive quality can step back up (Agent Note 2026-10-11-adaptive-quality).
 */
export function slowerStart(info, kbps) {
  const requested = info?.requested_formats || [];
  const video = requested.find(hasVideo);
  const audio = requested.find((format) => hasAudio(format) && !hasVideo(format));
  if (!video || !audio || !(kbps > 0) || !(video.tbr > 0)) return null;
  const audioKbps = Number(audio.abr || audio.tbr) || 0;
  if (kbps >= video.tbr + audioKbps) return null;
  const family = (codec) => String(codec || "").split(".")[0];
  const smaller = (info.formats || [])
    .filter((format) => hasVideo(format) && !hasAudio(format) && format.url && !isHlsFormat(format)
      && family(format.vcodec) === family(video.vcodec) && format.tbr > 0 && format.tbr < video.tbr
      && (Number(format.height) || 0) <= (Number(video.height) || Infinity))
    .sort((a, b) => b.tbr - a.tbr);
  if (!smaller.length) return null;
  const budget = kbps - audioKbps;
  const format = smaller.find((candidate) => candidate.tbr <= budget) || smaller.at(-1);
  return { format, audio, maxVideoKbps: Math.ceil(Math.max(format.tbr, budget)) };
}

// The four shapes yt-dlp returns, in order of preference: an HLS manifest; one
// file with audio and video; separate audio and video files; any file.
export function inputFromInfo(info, { maxVideoKbps = DEFAULT_MAX_VIDEO_KBPS, live = null } = {}) {
  // HLS formats (live streams in particular) come as separate video and
  // audio renditions of one master playlist: play the master, so the player
  // gets audio and a variant within the bitrate cap. An HLS format that names
  // no master (Tencent Video's, with unknown codecs) plays its own playlist.
  const manifest = info.manifest_url
    || (info.requested_formats?.length && info.requested_formats.every(isHlsFormat) ? info.requested_formats.find((format) => format.manifest_url)?.manifest_url : null)
    || (isHlsFormat(info) ? info.url : null);
  if (manifest) {
    return {
      type: "hls",
      url: manifest,
      headers: mediaHeaders(manifest),
      cacheKey: cacheIdentity,
      // BANDWIDTH includes audio; leave room for it above the video cap.
      maxBandwidth: (maxVideoKbps + 256) * 1000,
      ...(live ? { live } : {}),
    };
  }
  if (info.url && hasVideo(info) && hasAudio(info)) {
    return { type: "file", url: info.url, headers: mediaHeaders(info.url, info.http_headers || null), cacheKey: cacheIdentity };
  }
  const requested = info.requested_formats || [];
  const video = requested.find(hasVideo);
  const audio = requested.find((format) => hasAudio(format) && !hasVideo(format)) || requested.find(hasAudio);
  if (requested.length >= 2 && video && audio && video !== audio) {
    return { type: "split", video: splitTrack(video), audio: splitTrack(audio) };
  }
  if (info.url) return { type: "file", url: info.url, headers: mediaHeaders(info.url, info.http_headers || null), cacheKey: cacheIdentity };
  if (info.formats?.length) {
    const best = info.formats.find((format) => format.ext === "mp4" && hasVideo(format) && hasAudio(format)) || info.formats.at(-1);
    const url = best.url || best.manifest_url;
    if (url) return { type: /\.m3u8(?:[?#]|$)/i.test(url) ? "hls" : "file", url, headers: mediaHeaders(url, best.http_headers || null), cacheKey: cacheIdentity };
  }
  return null;
}

// --- DRM in HLS --------------------------------------------------------------
// yt-dlp's markers of a DRM key in an HLS playlist (HlsFD._has_drm: FairPlay,
// PlayReady, Adobe Access), and Widevine's system id. yt-dlp reads only the
// master playlist, but some sites (Vimeo) put the key in every media
// playlist, so a stream yt-dlp calls playable may still be encrypted.
const HLS_DRM = /#EXT-X-(?:SESSION-)?KEY:[^\n]*(?:URI="skd:\/\/|KEYFORMAT="(?:com\.apple\.streamingkeydelivery|com\.microsoft\.playready|urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed)")|#EXT-X-FAXS-CM:/i;
const DRM_CHECK_TIMEOUT_MS = 8_000;

// Whether an HLS stream needs a DRM key: its master playlist, else its first
// variant's media playlist, carries one. False when either cannot be read,
// so a slow CDN never blocks playback.
export async function hlsNeedsDrm(url, { headers = {}, fetchImpl = globalThis.fetch } = {}) {
  const read = async (target) => {
    const response = await fetchImpl(target, { headers, signal: AbortSignal.timeout(DRM_CHECK_TIMEOUT_MS) });
    return response.ok ? response.text() : "";
  };
  try {
    const master = await read(url);
    if (HLS_DRM.test(master)) return true;
    const lines = master.split(/\r?\n/).map((line) => line.trim());
    const variant = lines.find((line, index) => index > 0 && line && !line.startsWith("#") && lines[index - 1].startsWith("#EXT-X-STREAM-INF"));
    return variant ? HLS_DRM.test(await read(new URL(variant, url).href)) : false;
  } catch {
    return false;
  }
}

// --- YouTube live DVR ------------------------------------------------------
// YouTube's live playlists list hours of DVR segments addressed by sequence
// number (/sq/<n>/ in each URL). The pipeline keeps a bounded window around
// the play cursor (Input.live, Agent Note 2026-10-11-node-media-pipeline).

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function parseYoutubeLivePlaylist(body) {
  if (!body.includes("playlist_type/DVR") || !body.includes("googlevideo.com")) return null;
  const lines = body.split(/\r?\n/);
  const tag = (name) => lines.find((line) => line.startsWith(name))?.slice(name.length);
  const mediaSequence = finite(tag("#EXT-X-MEDIA-SEQUENCE:"));
  const programDateTime = Date.parse(tag("#EXT-X-PROGRAM-DATE-TIME:") || "") / 1000;
  const targetDuration = finite(tag("#EXT-X-TARGETDURATION:"));
  const segments = [];
  let pending = null;
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      pending = finite(line.slice("#EXTINF:".length).split(",", 1)[0]);
    } else if (pending != null && /^https?:\/\//i.test(line)) {
      const match = line.match(/\/sq\/(\d+)\//);
      if (match) segments.push({ sequence: Number(match[1]), duration: pending, url: line });
      pending = null;
    }
  }
  if (!Number.isInteger(mediaSequence) || mediaSequence < 0 || !Number.isFinite(programDateTime) || !segments.length) return null;
  const segmentDuration = segments[0].duration || targetDuration || 2;
  if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) return null;
  const latestSequence = segments.at(-1).sequence;
  const template = segments[0].url;
  return {
    mediaSequence,
    latestSequence,
    segmentDuration,
    startedAt: programDateTime - mediaSequence * segmentDuration,
    liveEdge: programDateTime + segments.reduce((sum, segment) => sum + segment.duration, 0),
    targetDuration: targetDuration || Math.ceil(segmentDuration),
    segmentUrl(sequence) {
      if (!Number.isInteger(sequence) || sequence < 0 || sequence > latestSequence) return null;
      return template.replace(/\/sq\/\d+\//, `/sq/${sequence}/`);
    },
  };
}

export const youtubeLive = Object.freeze({ parse: parseYoutubeLivePlaylist });
