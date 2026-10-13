// Turning yt-dlp's JSON into an Input for Yolo's media pipeline
// (Agent Note 2026-10-11-node-media-pipeline), ported from the Drive-In server:
// viewport-based format selection, the four delivery shapes yt-dlp can return,
// cache identities for signed CDN URLs, and YouTube's live DVR playlists.

export const WINDOWED_TARGET_HEIGHT = 720;
export const LOW_FPS_TARGET_HEIGHT = 1080;
// The node's usual ceiling; a lower limits.maxVideoKbps is a device's
// adaptive-quality cap (the player stalled on this connection).
export const DEFAULT_MAX_VIDEO_KBPS = 4800;
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.92 Safari/537.36";

// The height a device should get. Fast motion (50+ fps) stays at the
// device's limit (720p for the Tesla profile); low-frame-rate detail may go
// to 1080p within the same bitrate cap.
export function targetHeight(capabilities = {}) {
  const max = Number(capabilities.maxHeight);
  return Number.isFinite(max) && max > 0 ? Math.min(Math.floor(max), WINDOWED_TARGET_HEIGHT) : WINDOWED_TARGET_HEIGHT;
}

export function buildFormatSelector({ targetHeight: height = WINDOWED_TARGET_HEIGHT, maxVideoKbps = DEFAULT_MAX_VIDEO_KBPS, videoCodec = "avc1", audioCodec = "mp4a" } = {}) {
  const motionHeight = Math.max(144, Math.floor(Number(height) || WINDOWED_TARGET_HEIGHT));
  const detailHeight = Math.max(motionHeight, LOW_FPS_TARGET_HEIGHT);
  const bitrate = Math.max(200, Math.floor(Number(maxVideoKbps) || DEFAULT_MAX_VIDEO_KBPS));
  // Under a device's cap, when no format fits, the smallest one is the
  // closest to what the connection carries; the best one would stall again.
  const smallest = bitrate < DEFAULT_MAX_VIDEO_KBPS
    ? [
      `b[height<=${detailHeight}][tbr<=${bitrate}]`,
      `wv[vcodec^=${videoCodec}]+ba[acodec^=${audioCodec}]`,
      "wv+ba*",
      "w",
    ]
    : [];
  const preferredMotion = `bv[vcodec^=${videoCodec}][height<=${motionHeight}][tbr<=${bitrate}][fps>=50]`;
  const anyMotion = `bv[height<=${motionHeight}][tbr<=${bitrate}][fps>=50]`;
  const preferredDetail = `bv[vcodec^=${videoCodec}][height<=${detailHeight}][tbr<=${bitrate}][fps<50]`;
  const anyDetail = `bv[height<=${detailHeight}][tbr<=${bitrate}][fps<50]`;
  return [
    `${preferredMotion}+ba[acodec^=${audioCodec}]`,
    `${preferredMotion}+ba*`,
    `${anyMotion}+ba[acodec^=${audioCodec}]`,
    `${anyMotion}+ba*`,
    `${preferredDetail}+ba[acodec^=${audioCodec}]`,
    `${preferredDetail}+ba*`,
    `${anyDetail}+ba[acodec^=${audioCodec}]`,
    `${anyDetail}+ba*`,
    ...smallest,
    `b*[height<=${motionHeight}][fps>=50]`,
    `b*[height<=${detailHeight}][fps<50]`,
    `b*[height<=${motionHeight}]`,
    "b*",
  ].join("/");
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};
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
export function inputFromInfo(info, { maxVideoKbps = 4800, live = null } = {}) {
  // HLS formats (live streams in particular) come as separate video and
  // audio renditions of one master playlist: play the master, so the player
  // gets audio and a variant within the bitrate cap.
  const manifest = info.manifest_url
    || (info.requested_formats?.length && info.requested_formats.every(isHlsFormat) ? info.requested_formats.find((format) => format.manifest_url)?.manifest_url : null)
    || (isHlsFormat(info) ? info.manifest_url : null);
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
