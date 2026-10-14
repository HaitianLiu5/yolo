import { isHttpUrl, YoloError } from "@useyolo/plugin-api";
import { canonicalUrl } from "./canonical.js";
import { buildFormatSelector, DEFAULT_MAX_VIDEO_KBPS, hlsNeedsDrm, inputFromInfo, isYouTubeUrl, slowerStart, splitTrack, streamProfile, targetHeight, youtubeLive } from "./formats.js";
import { hostOf, preferFastMirrors, trackOnHosts } from "./mirrors.js";
import { storyboardFromInfo } from "./storyboard.js";
import { createDanmaku } from "./danmaku.js";
import { createSubtitleStore, hasEnglishAndChinese, mergeEntries, subtitleEntries, trackFromEntry } from "./subtitles.js";
import { chaptersFromInfo, cookieArgs, createYtdlp, describeInfo, detailsFromInfo, playlistFromInfo } from "./ytdlp.js";

// Official source plugin: video pages and playlists from the sites yt-dlp
// supports (Agent Note 2026-10-11-plugin-architecture: yt-dlp is a plugin, so
// it can be updated or turned off on its own). It claims every http(s) URL, so
// list it after any plugin that should get the first look at a URL.
//
// Options (yolo.config.json), each falling back to the environment:
//   binary              yt-dlp executable, default "yt-dlp" on PATH
//   cookiesFile         YTDLP_COOKIES_FILE
//   cookiesFromBrowser  YTDLP_COOKIES_FROM_BROWSER
//
// Sources: { plugin: "ytdlp", id: <canonical URL>, url: <URL as given> }.
// Playback uses the URL as given; history and preferences use the id.

export const SOURCE_ID = "ytdlp";

const sourceFor = (url) => ({ id: canonicalUrl(url), url: url.trim() });
// A link straight to a media file or playlist needs no yt-dlp.
const DIRECT_MEDIA = /\.(m3u8|mp4|flv|ts|webm)(\?|$)/i;
// Metadata calls for one video (describe, tracks, details, chapters,
// subtitle) share one yt-dlp run for this long; a few videos are kept.
const INFO_TTL_MS = 10 * 60_000;
const INFO_ENTRIES = 16;

// Coalesced, bounded memo of an async lookup by key.
function memo(fn, { ttlMs = INFO_TTL_MS, entries = INFO_ENTRIES, now = () => Date.now() } = {}) {
  const cache = new Map(); // key → { at, value: Promise }
  return (key) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = Promise.resolve().then(() => fn(key));
    cache.delete(key);
    cache.set(key, { at: now(), value });
    // A failed lookup is not kept.
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    while (cache.size > entries) cache.delete(cache.keys().next().value);
    return value;
  };
}

const isDirectMedia = (url) => DIRECT_MEDIA.test(new URL(url).pathname + new URL(url).search);

// `fetchImpl` and `mirrorProbe` ({ bytes, timeoutMs }) are for the mirror
// probe (mirrors.js) and the comments (danmaku.js); tests pass fixtures.
// `cookiesFile` is the cookies file yt-dlp reads, if one is configured.
export function createYtdlpSource(ytdlp, { subtitles = createSubtitleStore(), logger = console, fetchImpl = globalThis.fetch, mirrorProbe = {}, cookiesFile = null } = {}) {
  const pageUrl = (source) => String(source.url || source.id);
  const info = memo((url) => ytdlp.info(url));
  const entriesOf = memo(async (url) => subtitleList(url, await info(url)));
  const danmaku = createDanmaku({ ytdlp, cookiesFile, fetchImpl, logger });

  // Formats for this device, plus everything about subtitles and refreshes.
  // `startTime` is where the mirror probe reads. Unless the device is
  // stepping its quality up (it measured its own throughput) or a refresh
  // keeps `videoFormatId`, a fastest mirror slower than the selected formats'
  // bitrate starts the stream on a smaller video format.
  async function resolvePlayable(url, { capabilities = {}, limits = {}, startTime = 0, reason = "play", videoFormatId = null } = {}) {
    const height = targetHeight(capabilities);
    const maxVideoKbps = Number(limits.maxVideoKbps) > 0 ? Number(limits.maxVideoKbps) : DEFAULT_MAX_VIDEO_KBPS;
    const selector = buildFormatSelector({
      targetHeight: height,
      maxVideoKbps,
      videoCodec: capabilities.video?.[0] || "avc1",
      audioCodec: capabilities.audio?.[0] || "mp4a",
    });
    const info = await ytdlp.playable(url, { selector });
    const live = isYouTubeUrl(url) && info.is_live ? youtubeLive : null;
    const resolved = inputFromInfo(info, { maxVideoKbps, live });
    if (!resolved) throw new YoloError("resolve_failed", "yt-dlp found no playable format");
    // yt-dlp saw DRM on some formats (it drops those): make sure the HLS it
    // kept is not encrypted too, which no Yolo player can decrypt.
    if (info._has_drm && resolved.type === "hls" && await hlsNeedsDrm(resolved.url, { headers: resolved.headers, fetchImpl })) {
      throw new YoloError("resolve_failed", "This video is DRM-protected, and Yolo cannot play DRM-protected video", { retryable: false });
    }
    // CDNs with mirror hosts (Bilibili's upos): start on the fastest one from
    // here, and give the node the others to hedge and fail over to.
    const formats = info.requested_formats?.length ? info.requested_formats : [info];
    const probed = await preferFastMirrors(resolved, formats, { fetchImpl, logger, ...mirrorProbe, startTime, duration: info.duration });
    const kept = videoFormatId ? info.formats?.find((format) => format.format_id === videoFormatId) : null;
    const lower = kept
      ? { format: kept, audio: formats.find((format) => format.vcodec === "none"), maxVideoKbps: null }
      : (!["quality", "frame"].includes(reason) && probed.input.type === "split" && probed.kbps ? slowerStart(info, probed.kbps) : null);
    if (!lower?.audio || probed.input.type !== "split") return { info, input: probed.input, profile: streamProfile(info, { targetHeight: height, maxVideoKbps }), start: null };
    const input = { ...probed.input, video: trackOnHosts(splitTrack(lower.format), lower.format, probed.hosts) };
    const picked = { ...info, requested_formats: [lower.format, lower.audio] };
    if (!kept) logger.info?.(`${hostOf(probed.input.video.url)} gives ${probed.kbps} kbps: starting at ${lower.format.format_id} (${Math.round(lower.format.tbr)} kbps)`);
    return {
      info,
      input,
      profile: streamProfile(picked, { targetHeight: height, maxVideoKbps: lower.maxVideoKbps ?? maxVideoKbps }),
      start: { videoFormatId: lower.format.format_id, maxVideoKbps: lower.maxVideoKbps },
    };
  }

  async function subtitleList(url, info) {
    let entries = subtitleEntries(info);
    if (isYouTubeUrl(url) && !hasEnglishAndChinese(entries)) {
      try {
        entries = mergeEntries(entries, subtitleEntries(await ytdlp.publicInfo(url)));
      } catch (error) {
        logger.warn?.(`public YouTube subtitle metadata unavailable: ${error.message}`);
      }
    }
    return entries;
  }

  return {
    async health() {
      const version = await ytdlp.version();
      return { available: Boolean(version), version };
    },
    claim: (url) => (isHttpUrl(url) ? sourceFor(url) : undefined),
    async expand(url) {
      const { title, entries } = playlistFromInfo(await ytdlp.flatPlaylist(url));
      return {
        title,
        items: entries.map((entry) => ({
          source: sourceFor(entry.url),
          title: entry.title,
          thumbnail: entry.thumbnail,
          duration: entry.duration,
        })),
      };
    },
    describe: async (source) => describeInfo(await info(pageUrl(source))),
    tracks: async (source) => ({ subtitles: (await entriesOf(pageUrl(source))).map(trackFromEntry), audio: [] }),
    // What agents read (Agent Note 2026-10-07-remote-mcp-server): the
    // description and channel, the uploader's chapters, and subtitle text
    // while the video is not playing.
    details: async (source) => detailsFromInfo(await info(pageUrl(source))),
    chapters: async (source) => chaptersFromInfo(await info(pageUrl(source))),
    async subtitle(source, trackId) {
      const url = pageUrl(source);
      const entry = (await entriesOf(url)).find((candidate) => `s_${candidate.key}` === trackId);
      if (!entry) throw new YoloError("not_found", `No subtitle ${trackId}`);
      return subtitles.get(canonicalUrl(url), entry);
    },
    // The storyboard images the site publishes, if any
    // (Agent Note 2026-10-13-video-frames): from the shared metadata lookup,
    // a few small sprite sheets instead of reading the video at every tile.
    storyboard: async (source) => (isDirectMedia(pageUrl(source)) ? null : storyboardFromInfo(await info(pageUrl(source)))),
    // Timed comments: Bilibili's danmaku, null for every other site.
    comments: (source, range) => danmaku(pageUrl(source), range),

    // Agent Note 2026-10-11-node-media-pipeline, "prepare". yt-dlp keeps no
    // resume position, so a null startTime starts at the beginning.
    async prepare(source, { capabilities = {}, startTime = null, limits = {}, reason = "play", chooseTracks } = {}) {
      const url = pageUrl(source);
      if (isDirectMedia(url)) {
        const hls = /\.m3u8(\?|$)/i.test(url);
        return {
          title: url,
          input: { type: hls ? "hls" : "file", url },
          startTime: Math.max(0, Number(startTime) || 0),
          tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
        };
      }
      const { info, input, profile, start } = await resolvePlayable(url, { capabilities, limits, startTime: Number(startTime) || 0, reason });
      // A frame (Agent Note 2026-10-13-video-frames) shows no subtitle, so it
      // skips their lookup, which can run yt-dlp a second time.
      const entries = reason === "frame" ? [] : await subtitleList(url, info);
      const available = { subtitles: entries.map(trackFromEntry), audio: [] };
      const selected = chooseTracks ? chooseTracks(available) : { subtitles: [], audio: null };
      const isLive = Boolean(info.is_live) && input.type === "hls";
      const videoKey = canonicalUrl(url);
      return {
        title: info.title || info.fulltitle || url,
        thumbnail: info.thumbnail || null,
        duration: Number(info.duration) > 0 ? Number(info.duration) : null,
        isLive,
        startTime: isLive ? 0 : Math.max(0, Number(startTime) || 0),
        profile,
        input,
        // Started below the device's cap for a slow mirror: the stream says so.
        ...(start?.maxVideoKbps ? { maxVideoKbps: start.maxVideoKbps } : {}),
        tracks: { ...available, selected: { subtitles: selected.subtitles, audio: null } },
        async subtitle(trackId) {
          const entry = entries.find((candidate) => `s_${candidate.key}` === trackId);
          if (!entry) throw new YoloError("not_found", `No subtitle ${trackId}`);
          return subtitles.get(videoKey, entry);
        },
        // Media URLs from yt-dlp are signed and expire after a few hours. A
        // refresh keeps the video format the stream started on.
        refresh: async () => (await resolvePlayable(url, { capabilities, limits, startTime: Number(startTime) || 0, reason: "quality", videoFormatId: start?.videoFormatId ?? null })).input,
      };
    },
  };
}

// The cookies file in effect: the options' when they name cookies at all,
// else the environment's.
export function cookiesFileFor(options, env) {
  if (options.cookiesFile || options.cookiesFromBrowser) return String(options.cookiesFile || "").trim() || null;
  return String(env.YTDLP_COOKIES_FILE || "").trim() || null;
}

// Cookie options replace both environment variables rather than mix with them.
export function cookiesFor(options, env) {
  const { cookiesFile, cookiesFromBrowser } = options;
  return cookiesFile || cookiesFromBrowser
    ? cookieArgs({ cookiesFile, cookiesFromBrowser })
    : cookieArgs({ cookiesFile: env.YTDLP_COOKIES_FILE, cookiesFromBrowser: env.YTDLP_COOKIES_FROM_BROWSER });
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function ytdlpPlugin(yolo) {
  // Each call runs its own short-lived yt-dlp process, so nothing needs to
  // start or stop with the node.
  const ytdlp = createYtdlp({ binary: String(yolo.options.binary || "yt-dlp"), cookies: cookiesFor(yolo.options, yolo.env) });
  yolo.registerSource(SOURCE_ID, createYtdlpSource(ytdlp, {
    subtitles: createSubtitleStore({ dir: yolo.cacheDir ?? null }),
    logger: yolo.log ?? console,
    cookiesFile: cookiesFileFor(yolo.options, yolo.env),
  }));
}
