import { randomBytes } from "node:crypto";
import { YoloError } from "@useyolo/plugin-api";
import { itemFromMetadata, subtitleLabel, tracksFromPart } from "./plex.js";
import {
  describePlexSubtitle,
  extractEmbeddedPlexSubtitle,
  isEmbeddedPlexTextSubtitle,
  isPlexTextSubtitle,
  PlexSubtitleCache,
  plexSubtitleStreamsForPart,
  plexSubtitleVersionInfo,
  readPlexSubtitleFile,
  resolvePlexSubtitleDelivery,
  SubtitleExtractionQueue,
} from "./subtitles.js";

// Playing a Plex item through Yolo's media pipeline (the source's prepare(),
// Agent Note 2026-10-11-node-media-pipeline):
//
// - Plex transcodes every item once at a fixed 720p (4–4.8 Mbps): the car's
//   210-second segment buffer must not be thrown away by bitrate switches.
//   Only a device's adaptive-quality cap (limits.maxVideoKbps, after it
//   stalled on a slow connection) lowers the bitrate, and the resolution
//   with it.
// - Text subtitles go to the player as WebVTT (converted here, cached);
//   image subtitles, and text ones that cannot be converted yet, are burned
//   in by Plex's transcoder.
// - Plex keeps its own watch position (viewOffset). Yolo keeps its own too;
//   a null startTime means Yolo has none, so playback resumes at Plex's.
// - Transcode sessions are stopped when Yolo is done with them, and Yolo's
//   pipeline asks health() when a segment is missing, to tell a slow
//   transcoder from one Plex already dropped.
// - On the home network (`network: "lan"`,
//   Agent Note 2026-10-12-lan-direct-play) the original file plays as it is
//   when the device takes its container and codecs (Yolo's playable()), no
//   subtitle is burned in, and the chosen audio is the file's default: the
//   node proxies Plex's part by byte range, so the token stays on the node.
//   Otherwise a <video> device gets Plex's direct stream at its own
//   resolution, which copies video that fits and converts only the rest; the
//   car keeps the fixed 720p transcode.

export const PLEX_VIDEO_RESOLUTION = "1280x720";
export const DEFAULT_VIDEO_BITRATE_KBPS = 4800;
const MIN_VIDEO_BITRATE_KBPS = 4000;
const MAX_VIDEO_BITRATE_KBPS = 4800;
// Lower bitrates need smaller pictures to look right (Plex's own presets
// pair 1.5 Mbps with 480p and 0.7 Mbps with 360p).
const RESOLUTION_FOR_BITRATE = [
  { minKbps: 2000, width: 1280, height: 720 },
  { minKbps: 1200, width: 854, height: 480 },
  { minKbps: 600, width: 640, height: 360 },
  { minKbps: 0, width: 426, height: 240 },
];
const LOWEST_VIDEO_BITRATE_KBPS = 300;
// A LAN transcode's target bitrate (Plex's highest 1080p preset); Plex's
// direct stream still copies video up to the stream's limit.
export const LAN_TRANSCODE_KBPS = 20_000;
const LAN_HEIGHTS = [2160, 1440, 1080, 720];
// Plex's codec names → Yolo's capability codec ids.
const VIDEO_CODECS = Object.freeze({ h264: "avc1", hevc: "hvc1", h265: "hvc1", vp9: "vp09", av1: "av01" });
const AUDIO_CODECS = Object.freeze({ aac: "mp4a", mp3: "mp3", ac3: "ac-3", eac3: "ec-3", flac: "flac", opus: "opus", dca: "dts", dts: "dts", truehd: "mlpa" });
const HDR_TRANSFER = /smpte2084|arib-std-b67/i;

// The transcode for this prepare: the configured bitrate, or the device's
// cap when it is lower, and the picture size that suits it.
export function transcodeProfile(videoBitrate, limits = null) {
  const cap = Number(limits?.maxVideoKbps);
  const kbps = Number.isFinite(cap) && cap > 0 ? Math.max(LOWEST_VIDEO_BITRATE_KBPS, Math.min(videoBitrate, Math.floor(cap))) : videoBitrate;
  const { width, height } = RESOLUTION_FOR_BITRATE.find((step) => kbps >= step.minKbps);
  return { videoBitrate: kbps, width, height, videoResolution: `${width}x${height}` };
}
// The transcode on the LAN for a <video> device: its picture size, and a
// limit high enough for Plex to copy the original's video. A device's
// adaptive-quality cap at or below the usual bitrate gets the usual ladder.
export function lanTranscodeProfile(videoBitrate, capabilities = {}, limits = null) {
  const cap = Number(limits?.maxVideoKbps);
  if (Number.isFinite(cap) && cap > 0 && cap <= videoBitrate) return transcodeProfile(videoBitrate, limits);
  const maxHeight = Number(capabilities.maxHeight) || 1080;
  const height = LAN_HEIGHTS.find((step) => step <= maxHeight) ?? 720;
  const width = Math.round((height * 16) / 9);
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : LAN_TRANSCODE_KBPS;
  return { videoBitrate: Math.min(limit, LAN_TRANSCODE_KBPS), maxVideoBitrate: limit, width, height, videoResolution: `${width}x${height}` };
}

const lower = (value) => String(value ?? "").trim().toLowerCase();

// The audio the file plays when nothing chooses: the default stream, else the first.
const fileAudio = (part) => {
  const audio = (part?.Stream || []).filter((stream) => stream.streamType === 2);
  return audio.find((stream) => stream.default) ?? audio[0] ?? null;
};

// Plex's description of a part, in the terms of Yolo's playable().
export function describeOriginal(media, part) {
  const video = (part?.Stream || []).find((stream) => stream.streamType === 1) ?? null;
  const audio = fileAudio(part);
  return {
    container: lower(part?.container || media?.container),
    video: video ? {
      codec: VIDEO_CODECS[lower(video.codec)] ?? lower(video.codec),
      profile: video.profile ?? null,
      bitDepth: Number(video.bitDepth) || 8,
      hdr: HDR_TRANSFER.test(video.colorTrc || "") || Boolean(video.DOVIPresent),
      width: Number(video.width || media?.width) || null,
      height: Number(video.height || media?.height) || null,
    } : null,
    audio: audio ? [{ codec: AUDIO_CODECS[lower(audio.codec)] ?? lower(audio.codec), channels: Number(audio.channels) || null }] : [],
    kbps: Number(media?.bitrate) || null,
  };
}

const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;
const PRODUCT = "Yolo";

export function normalizeVideoBitrate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= MIN_VIDEO_BITRATE_KBPS && parsed <= MAX_VIDEO_BITRATE_KBPS
    ? Math.floor(parsed)
    : DEFAULT_VIDEO_BITRATE_KBPS;
}

function transcodeParams(ratingKey, { subtitleStreamID, audioStreamID, offsetSec, session, videoBitrate, maxVideoBitrate = videoBitrate, videoResolution = PLEX_VIDEO_RESOLUTION }) {
  return new URLSearchParams({
    hasMDE: "1",
    path: `/library/metadata/${ratingKey}`,
    mediaIndex: "0",
    partIndex: "0",
    protocol: "hls",
    fastSeek: "1",
    directPlay: "0",
    directStream: "1",
    directStreamAudio: "1",
    videoResolution,
    maxVideoBitrate: String(maxVideoBitrate),
    videoBitrate: String(videoBitrate),
    subtitleSize: "100",
    subtitles: subtitleStreamID ? "burn" : "none",
    audioBoost: "280",
    location: "lan",
    addDebugOverlay: "0",
    autoAdjustQuality: "0",
    autoAdjustSubtitle: "0",
    mediaBufferSize: "102400",
    ...(audioStreamID ? { audioStreamID: String(audioStreamID) } : {}),
    ...(offsetSec ? { offset: String(offsetSec) } : {}),
    session,
    "X-Plex-Incomplete-Segments": "1",
    "X-Plex-Client-Identifier": `yolo-${session}`,
    "X-Plex-Product": PRODUCT,
    "X-Plex-Features": "external-media,indirect-media,hub-style-list",
    "X-Plex-Platform": "Chrome",
    "X-Plex-Platform-Version": "136.0",
    "X-Plex-Device": "Linux",
    "X-Plex-Device-Name": "Yolo",
    "X-Plex-Model": "bundled",
  });
}

// Plex's transcode inventory says whether a session still exists (the same
// check python-plexapi uses). A failed or odd answer is unknown, not proof
// that the session is gone.
function sessionHealth(data, session) {
  const container = data?.MediaContainer;
  if (!session || !container) return "unknown";
  const sessions = container.TranscodeSession;
  if (!Array.isArray(sessions)) return container.size === 0 ? "expired" : "unknown";
  if (sessions.some((entry) => entry.key === session || entry.key === `/transcode/sessions/${session}`)) return "alive";
  if (sessions.some((entry) => typeof entry.key !== "string")) return "unknown";
  return "expired";
}

const streamId = (trackId) => String(trackId ?? "").replace(/^plex:/, "");

export function createPlayback({ plex, cacheDir = null, videoBitrate = DEFAULT_VIDEO_BITRATE_KBPS, logger = console }) {
  const subtitleCache = cacheDir ? new PlexSubtitleCache(`${cacheDir}/subtitles`) : null;
  const extraction = new SubtitleExtractionQueue({ maxConcurrent: 1 });
  const descriptors = new Map();

  function remember(key, descriptor) {
    descriptors.delete(key);
    descriptors.set(key, descriptor);
    while (descriptors.size > 128) descriptors.delete(descriptors.keys().next().value);
  }

  async function loadSubtitleBuffer(stream) {
    const local = await readPlexSubtitleFile(stream);
    if (local) return local;
    if (isEmbeddedPlexTextSubtitle(stream)) return extractEmbeddedPlexSubtitle(stream);
    if (!stream.key) throw new Error("Plex subtitle stream has no downloadable source");
    const response = await plex.raw(stream.key, { accept: "*/*", timeout: 30_000 });
    if (!response.ok) throw new Error(`Plex subtitle download answered ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_SUBTITLE_BYTES) throw new Error("Plex subtitle is larger than 20 MiB");
    return buffer;
  }

  // Subtitles of one part, with what Yolo can deliver for each.
  async function listSubtitles(ratingKey, streams) {
    return Promise.all(streams.filter((stream) => stream.streamType === 3).map(async (stream) => {
      const versionInfo = await plexSubtitleVersionInfo(stream);
      const key = `${ratingKey}:${stream.id}:${versionInfo.token}`;
      const known = descriptors.get(key);
      if (known) return known;
      let inferredLanguage = null;
      const title = stream.displayTitle || stream.extendedDisplayTitle || stream.title;
      if (subtitleCache && isPlexTextSubtitle(stream) && (!title || /^unknown$/i.test(title))) {
        try {
          const cached = isEmbeddedPlexTextSubtitle(stream)
            ? await subtitleCache.getCached(ratingKey, stream, versionInfo)
            : await subtitleCache.get(ratingKey, stream, loadSubtitleBuffer, versionInfo);
          inferredLanguage = cached?.inferredLanguage || null;
        } catch (error) {
          logger.warn?.(`could not inspect text subtitle ${stream.id}: ${error.message}`);
        }
      }
      const descriptor = describePlexSubtitle(ratingKey, stream, {
        versionToken: versionInfo.token,
        inferredLanguage,
        // Converting needs the cache; embedded text needs the media file.
        externalAvailable: Boolean(subtitleCache) && (!isEmbeddedPlexTextSubtitle(stream) || versionInfo.sourceAvailable),
      });
      remember(key, descriptor);
      return descriptor;
    }));
  }

  function scheduleExtraction(ratingKey, stream, versionInfo) {
    const key = `${ratingKey}:${stream.id}:${versionInfo.token}`;
    const already = extraction.has(key);
    const task = extraction.enqueue(key, async () => {
      const cached = await subtitleCache.get(ratingKey, stream, loadSubtitleBuffer, versionInfo);
      descriptors.delete(key);
      logger.info?.(`embedded subtitle ${stream.id} of ${ratingKey} is ready as WebVTT`);
      return cached;
    });
    task.catch((error) => logger.warn?.(`embedded subtitle extraction failed: ${error.message}`));
    return already;
  }

  const subtitleTrack = (descriptor) => ({
    id: `plex:${descriptor.id}`,
    kind: "subtitle",
    language: descriptor.languageCode || descriptor.language || "",
    name: subtitleLabel(descriptor),
    auto: false,
    format: isPlexTextSubtitle(descriptor) ? "text" : "image",
    default: false,
    delivery: descriptor.delivery === "external" ? "vtt" : "burn",
  });

  async function startTranscode(ratingKey, options, signal) {
    const params = transcodeParams(ratingKey, options);
    const decision = await plex.raw(`/video/:/transcode/universal/decision?${params}`, { timeout: 30_000, signal });
    const body = await decision.text().catch(() => "");
    if (!decision.ok) throw new YoloError("resolve_failed", `Plex transcode decision failed with ${decision.status}`);
    let detail = null;
    try {
      detail = JSON.parse(body)?.MediaContainer;
    } catch {
      // Older servers answer XML; the decision itself is what matters.
    }
    logger.info?.(`transcode decision for ${ratingKey}: ${detail?.generalDecisionText || decision.status}`);
    // Fetching the master playlist starts the transcode before the device
    // asks for its first segment.
    const startPath = `/video/:/transcode/universal/start.m3u8?${params}`;
    const start = await plex.raw(startPath, { accept: "*/*", timeout: 30_000, signal });
    const manifest = await start.text();
    if (!start.ok) throw new YoloError("resolve_failed", `Plex could not start the transcode (${start.status})`);
    return { url: new URL(startPath, plex.url).href, manifest };
  }

  // WebVTT of a text subtitle, or `{ pending }` while an embedded one is
  // extracted.
  async function subtitleText(ratingKey, partStreams, trackId) {
    const id = streamId(trackId);
    const stream = partStreams.find((candidate) => candidate.streamType === 3 && String(candidate.id) === id);
    if (!stream) throw new YoloError("not_found", `This item has no subtitle ${trackId}`);
    if (!isPlexTextSubtitle(stream)) throw new YoloError("not_found", "Image subtitles are rendered by Plex");
    if (!subtitleCache) throw new YoloError("not_found", "Text subtitles need the plugin's cache directory");
    const versionInfo = await plexSubtitleVersionInfo(stream);
    let cached = await subtitleCache.getCached(ratingKey, stream, versionInfo);
    if (!cached && isEmbeddedPlexTextSubtitle(stream)) {
      scheduleExtraction(ratingKey, stream, versionInfo);
      return { pending: true, retryAfter: 5 };
    }
    cached ||= await subtitleCache.get(ratingKey, stream, loadSubtitleBuffer, versionInfo);
    return cached.vtt;
  }

  // Plex's own watch position, so other Plex apps continue from here.
  async function reportProgress(ratingKey, session, { position, status }) {
    const params = new URLSearchParams({
      key: ratingKey,
      identifier: "com.plexapp.plugins.library",
      time: String(Math.floor(Math.max(0, Number(position) || 0) * 1000)),
      state: status === "paused" ? "paused" : "playing",
    });
    await plex.raw(`/:/progress?${params}`, { accept: "*/*", timeout: 5_000, headers: { "X-Plex-Client-Identifier": `yolo-${session}` } }).catch(() => {});
  }

  async function stopTranscode(session) {
    try {
      await plex.raw(`/video/:/transcode/universal/stop?${new URLSearchParams({ session })}`, { accept: "*/*", timeout: 5_000 });
    } catch (error) {
      logger.warn?.(`could not stop transcode ${session}: ${error.message}`);
    }
  }

  return {
    // WebVTT of a text subtitle while the item is not playing (transcripts).
    async subtitle(ratingKey, trackId) {
      const part = (await plex.metadata(String(ratingKey))).Media?.[0]?.Part?.[0];
      if (!part) throw new YoloError("not_found", "This Plex item has no file");
      return subtitleText(String(ratingKey), plexSubtitleStreamsForPart(part), trackId);
    },

    async prepare(source, { startTime = null, reason = "play", chooseTracks, limits = null, capabilities = {}, network = "tunnel", playable = null } = {}) {
      const ratingKey = String(source.id);
      const meta = await plex.metadata(ratingKey);
      const media = meta.Media?.[0];
      const part = media?.Part?.[0];
      if (!part) throw new YoloError("resolve_failed", "This Plex item has no playable file");

      // A frame for an agent (Agent Note 2026-10-13-video-frames): the node
      // reads the original file itself, so nothing is transcoded, no
      // subtitle is converted, and the part's track selection in Plex stays
      // as the owner left it.
      if (reason === "frame" && part.key) {
        const item = itemFromMetadata(meta);
        return {
          title: item.title,
          artwork: item.artwork,
          duration: Number(meta.duration) > 0 ? Math.round(Number(meta.duration) / 1000) : null,
          isLive: false,
          startTime: Math.max(0, Number(startTime) || 0),
          tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
          input: { type: "file", url: new URL(part.key, plex.url).href, headers: { Accept: "*/*", "X-Plex-Token": plex.token }, cache: false },
        };
      }
      const partStreams = plexSubtitleStreamsForPart(part);
      const subtitleDescriptors = await listSubtitles(ratingKey, partStreams);
      const available = { subtitles: subtitleDescriptors.map(subtitleTrack), audio: tracksFromPart(part).audio };
      const chosen = chooseTracks ? chooseTracks(available) : { subtitles: [], audio: null };

      // The player shows one Plex subtitle at a time.
      const chosenSubtitle = chosen.subtitles[0] ? subtitleDescriptors.find((descriptor) => `plex:${descriptor.id}` === String(chosen.subtitles[0])) : null;
      let burnStreamId = null;
      const delivered = new Map(subtitleDescriptors.map((descriptor) => [String(descriptor.id), descriptor]));
      if (chosenSubtitle?.delivery === "external") {
        const stream = partStreams.find((candidate) => candidate.streamType === 3 && String(candidate.id) === String(chosenSubtitle.id));
        const versionInfo = await plexSubtitleVersionInfo(stream);
        if (isEmbeddedPlexTextSubtitle(stream)) {
          if (!await subtitleCache.getCached(ratingKey, stream, versionInfo)) {
            // Extracting from a large file takes minutes: burn it in now, and
            // the next playback gets the WebVTT.
            delivered.set(String(stream.id), { ...chosenSubtitle, delivery: "burn" });
            burnStreamId = stream.id;
            scheduleExtraction(ratingKey, stream, versionInfo);
          }
        } else {
          const resolved = await resolvePlexSubtitleDelivery(chosenSubtitle, () => subtitleCache.get(ratingKey, stream, loadSubtitleBuffer, versionInfo));
          if (resolved.fallback) logger.warn?.(`text subtitle conversion failed, burning in: ${resolved.error.message}`);
          delivered.set(String(stream.id), resolved.subtitle);
          burnStreamId = resolved.burnSubtitleStreamID;
        }
      } else if (chosenSubtitle) {
        burnStreamId = chosenSubtitle.id;
      }
      const audioStreamId = chosen.audio ? streamId(chosen.audio) : null;

      // The part's selection is what Plex's transcoder burns in and plays.
      const selection = new URLSearchParams({ allParts: "1", subtitleStreamID: burnStreamId ? String(burnStreamId) : "0" });
      if (audioStreamId) selection.set("audioStreamID", audioStreamId);
      const put = await plex.raw(`/library/parts/${encodeURIComponent(part.id)}?${selection}`, { method: "PUT", accept: "*/*" });
      if (!put.ok) logger.warn?.(`Plex did not accept the track selection (${put.status})`);

      // Yolo's position wins; without one, resume where Plex left off.
      const resumeMs = startTime != null ? Math.max(0, Number(startTime) || 0) * 1000 : Number(meta.viewOffset) || 0;
      const session = `yolo-${randomBytes(8).toString("hex")}`;
      const item = itemFromMetadata(meta);
      const subtitleTracks = subtitleDescriptors.map((descriptor) => subtitleTrack(delivered.get(String(descriptor.id))));
      const common = {
        title: item.title,
        artwork: item.artwork,
        duration: Number(meta.duration) > 0 ? Math.round(Number(meta.duration) / 1000) : null,
        isLive: false,
        startTime: resumeMs / 1000,
        tracks: {
          subtitles: subtitleTracks,
          audio: available.audio,
          selected: { subtitles: chosenSubtitle ? [`plex:${chosenSubtitle.id}`] : [], audio: audioStreamId ? `plex:${audioStreamId}` : null },
        },
      };

      if (network === "lan" && typeof playable === "function" && part.key) {
        const original = describeOriginal(media, part);
        const verdict = playable(original);
        const defaultAudio = fileAudio(part);
        const audioIsDefault = !audioStreamId || String(audioStreamId) === String(defaultAudio?.id);
        const direct = verdict.decision === "direct" && !burnStreamId && audioIsDefault;
        logger.info?.(`LAN decision for ${ratingKey}: ${direct ? "direct play" : `${verdict.decision} (${[...verdict.reasons, ...(burnStreamId ? ["burned subtitle"] : []), ...(audioIsDefault ? [] : ["chosen audio"])].join(", ")})`}`);
        if (direct) {
          return {
            ...common,
            profile: {
              width: original.video?.width ?? null, height: original.video?.height ?? null, videoKbps: original.kbps, audioKbps: 0,
              videoCodec: original.video?.codec ?? null, audioCodec: original.audio[0]?.codec ?? null, split: false, original: true,
            },
            // The token goes as a header from the node; the device sees only /m/… URLs.
            input: { type: "file", url: new URL(part.key, plex.url).href, headers: { Accept: "*/*", "X-Plex-Token": plex.token }, cache: false },
            subtitle: (trackId) => subtitleText(ratingKey, partStreams, trackId),
            progress: (report) => reportProgress(ratingKey, session, report),
          };
        }
      }

      const quality = network === "lan" && capabilities.renderer === "html5-video"
        ? lanTranscodeProfile(videoBitrate, capabilities, limits)
        : transcodeProfile(videoBitrate, limits);
      const transcode = await startTranscode(ratingKey, {
        subtitleStreamID: burnStreamId,
        audioStreamID: audioStreamId,
        offsetSec: resumeMs ? Math.floor(resumeMs / 1000) : 0,
        session,
        videoBitrate: quality.videoBitrate,
        maxVideoBitrate: quality.maxVideoBitrate,
        videoResolution: quality.videoResolution,
      });

      let stopped = false;
      return {
        ...common,
        profile: { width: quality.width, height: quality.height, videoKbps: quality.videoBitrate, audioKbps: 128, videoCodec: "avc1", split: false },
        input: {
          type: "hls",
          url: transcode.url,
          manifest: transcode.manifest,
          headers: { Accept: "*/*", "X-Plex-Token": plex.token },
          trimToStart: true,
          transcoder: true,
          cache: false,
        },
        subtitle: (trackId) => subtitleText(ratingKey, partStreams, trackId),
        async health() {
          try {
            const response = await plex.raw("/transcode/sessions", { timeout: 2_000 });
            return response.ok ? sessionHealth(await response.json(), session) : "unknown";
          } catch {
            return "unknown";
          }
        },
        progress: (report) => reportProgress(ratingKey, session, report),
        async stop() {
          if (stopped) return;
          stopped = true;
          await stopTranscode(session);
        },
      };
    },
  };
}
