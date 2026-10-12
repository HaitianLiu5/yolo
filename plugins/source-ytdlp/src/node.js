import { isHttpUrl, YoloError } from "@useyolo/plugin-api";
import { canonicalUrl } from "./canonical.js";
import { buildFormatSelector, inputFromInfo, isYouTubeUrl, streamProfile, targetHeight, youtubeLive } from "./formats.js";
import { preferFastMirrors } from "./mirrors.js";
import { createSubtitleStore, hasEnglishAndChinese, mergeEntries, subtitleEntries, trackFromEntry } from "./subtitles.js";
import { cookieArgs, createYtdlp, describeInfo, playlistFromInfo, subtitleTracks } from "./ytdlp.js";

// Official source plugin: video pages and playlists from the sites yt-dlp
// supports (decision 21: yt-dlp is a plugin, so it can be updated or turned
// off on its own). It claims every http(s) URL, so list it after any plugin
// that should get the first look at a URL.
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

// `fetchImpl` and `mirrorProbe` ({ bytes, timeoutMs }) are for the mirror
// probe (mirrors.js); tests pass fixtures.
export function createYtdlpSource(ytdlp, { subtitles = createSubtitleStore(), logger = console, fetchImpl = globalThis.fetch, mirrorProbe = {} } = {}) {
  const pageUrl = (source) => String(source.url || source.id);

  // Formats for this device, plus everything about subtitles and refreshes.
  async function resolvePlayable(url, { capabilities = {}, limits = {} } = {}) {
    const height = targetHeight(capabilities);
    const maxVideoKbps = Number(limits.maxVideoKbps) > 0 ? Number(limits.maxVideoKbps) : 4800;
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
    // CDNs with mirror hosts (Bilibili's upos): start on the fastest one from
    // here, and give the node the others to fail over to.
    const formats = info.requested_formats?.length ? info.requested_formats : [info];
    const input = await preferFastMirrors(resolved, formats, { fetchImpl, logger, ...mirrorProbe });
    return { info, input, profile: streamProfile(info, { targetHeight: height, maxVideoKbps }) };
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
    describe: async (source) => describeInfo(await ytdlp.info(pageUrl(source))),
    tracks: async (source) => ({ subtitles: subtitleTracks(await ytdlp.info(pageUrl(source))), audio: [] }),

    // docs/yolo-plugins.md, "Playing". yt-dlp keeps no resume position, so a
    // null startTime starts at the beginning.
    async prepare(source, { capabilities = {}, startTime = null, limits = {}, chooseTracks } = {}) {
      const url = pageUrl(source);
      if (DIRECT_MEDIA.test(new URL(url).pathname + new URL(url).search)) {
        const hls = /\.m3u8(\?|$)/i.test(url);
        return {
          title: url,
          input: { type: hls ? "hls" : "file", url },
          startTime: Math.max(0, Number(startTime) || 0),
          tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
        };
      }
      const { info, input, profile } = await resolvePlayable(url, { capabilities, limits });
      const entries = await subtitleList(url, info);
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
        tracks: { ...available, selected: { subtitles: selected.subtitles, audio: null } },
        async subtitle(trackId) {
          const entry = entries.find((candidate) => `s_${candidate.key}` === trackId);
          if (!entry) throw new YoloError("not_found", `No subtitle ${trackId}`);
          return subtitles.get(videoKey, entry);
        },
        // Media URLs from yt-dlp are signed and expire after a few hours.
        refresh: async () => (await resolvePlayable(url, { capabilities, limits })).input,
      };
    },
  };
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
  }));
}
