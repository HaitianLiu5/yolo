import { isHttpUrl, YoloError } from "@useyolo/plugin-api";
import { canonicalUrl } from "./canonical.js";
import { buildFormatSelector, DEFAULT_MAX_VIDEO_KBPS, hlsNeedsDrm, inputFromInfo, isYouTubeUrl, slowerStart, splitTrack, streamProfile, targetHeight, youtubeLive } from "./formats.js";
import { hostOf, preferFastMirrors, trackOnHosts } from "./mirrors.js";
import { storyboardFromInfo } from "./storyboard.js";
import { createDanmaku, isBilibiliPage } from "./danmaku.js";
import { createSubtitleStore, hasEnglishAndChinese, mergeEntries, subtitleEntries, trackFromEntry } from "./subtitles.js";
import { chaptersFromInfo, cookieArgs, createYtdlp, describeInfo, detailsFromInfo, playlistFromInfo } from "./ytdlp.js";
import { bilibiliPart, bilibiliParts, sequenceFrom, sequenceUrl } from "./sequence.js";
import { bangumiEpisode, bangumiOf, bangumiSeason } from "./bilibili-bangumi.js";
import { gameOf, gameReplays, preferredReplay } from "./tencent-sports.js";

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

// Puts `value` in `cache` as its newest entry, dropping the oldest past
// `entries`: the bounded caches below, a Map in insertion order.
function keepNewest(cache, key, value, entries) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > entries) cache.delete(cache.keys().next().value);
}

// Coalesced, bounded memo of an async lookup by key.
function memo(fn, { ttlMs = INFO_TTL_MS, entries = INFO_ENTRIES, now = () => Date.now() } = {}) {
  const cache = new Map(); // key → { at, value: Promise }
  return (key) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = Promise.resolve().then(() => fn(key));
    keepNewest(cache, key, { at: now(), value }, entries);
    // A failed lookup is not kept.
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    return value;
  };
}

const isDirectMedia = (url) => DIRECT_MEDIA.test(new URL(url).pathname + new URL(url).search);

// What yt-dlp resolved for playing (formats for a device, and YouTube's
// caption list) is reused while its links are far from expiry: a replay from
// history, a retry, a recovery, or a seek before the stream's start then
// runs no yt-dlp. A link's expiry is its `expire`, `expires`, or `deadline`
// parameter; links without one are reused for LINK_TTL_MS. A failed run and
// a live stream are not kept, and refresh() always resolves again.
const RESOLVED_ENTRIES = 8;
const LINK_TTL_MS = 10 * 60_000;
const EXPIRY_MARGIN_MS = 10 * 60_000;

function linkExpiry(url) {
  try {
    const params = new URL(url).searchParams;
    const value = Number(params.get("expire") || params.get("expires") || params.get("deadline"));
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? value * 1000 : value;
  } catch {
    return null;
  }
}

function resolvedLinks(info) {
  const formats = info.requested_formats?.length ? info.requested_formats : [info];
  const subtitles = [info.subtitles, info.automatic_captions].flatMap((tracks) => Object.values(tracks || {}).flat());
  return [...formats.flatMap((format) => [format.url, format.manifest_url]), ...subtitles.map((track) => track?.url)].filter(Boolean);
}

// Until when `info` may be reused, or 0 for never.
function reusableUntil(info, now) {
  if (info?.is_live) return 0;
  const expiries = resolvedLinks(info).map(linkExpiry).filter((value) => value != null);
  return expiries.length ? Math.min(...expiries) - EXPIRY_MARGIN_MS : now + LINK_TTL_MS;
}

// A bounded cache of resolutions by key; one run at a time per key.
function resolutionCache({ now, entries = RESOLVED_ENTRIES }) {
  const cache = new Map(); // key → { until, value: Promise }
  return (key, resolve, { fresh = false } = {}) => {
    const hit = cache.get(key);
    if (!fresh && hit && hit.until > now()) {
      keepNewest(cache, key, hit, entries);
      return hit.value;
    }
    const entry = { until: Infinity, value: null };
    entry.value = Promise.resolve().then(resolve).then((info) => {
      entry.until = reusableUntil(info, now());
      if (entry.until <= now() && cache.get(key) === entry) cache.delete(key);
      return info;
    }, (error) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
    keepNewest(cache, key, entry, entries);
    return entry.value;
  };
}

// `fetchImpl` and `mirrorProbe` ({ bytes, timeoutMs }) are for the mirror
// probe (mirrors.js) and the comments (danmaku.js); tests pass fixtures.
// `cookiesFile` is the cookies file yt-dlp reads, if one is configured.
export function createYtdlpSource(ytdlp, { subtitles = createSubtitleStore(), logger = console, fetchImpl = globalThis.fetch, mirrorProbe = {}, cookiesFile = null, now = () => Date.now() } = {}) {
  const pageUrl = (source) => String(source.url || source.id);
  // Tencent Sports games (tencent-sports.js) and what their replay lists say
  // about each replay (its title, length, and picture, which yt-dlp does not
  // read from Tencent Video), by the replay's canonical URL.
  const games = memo((mid) => gameReplays(mid, { fetchImpl }));
  const replays = new Map();
  // Bilibili seasons (bilibili-bangumi.js), by "ss<id>" or "ep<id>".
  const seasons = memo((key) => bangumiSeason(key.startsWith("ss") ? { season: key.slice(2) } : { episode: key.slice(2) }, { fetchImpl }));
  const seasonOf = (page) => seasons(page.season ? `ss${page.season}` : `ep${page.episode}`);
  // The page yt-dlp reads for `source`, and what a list said about it: a
  // game page's replay, a Bilibili season's first episode or an episode
  // named after its show, or the page itself.
  async function target(source) {
    const url = pageUrl(source);
    const bangumi = bangumiOf(url);
    if (bangumi) {
      let season;
      try {
        season = await seasonOf(bangumi);
      } catch (error) {
        // An episode still plays, under yt-dlp's own name; a season needs the list.
        if (bangumi.episode) {
          logger.warn?.(`Bilibili season unavailable for ${url}: ${error.message}`);
          return { url, about: null };
        }
        throw error;
      }
      const episode = bangumiEpisode(season, bangumi);
      if (episode) return { url: episode.url, about: episode };
      if (bangumi.episode) return { url, about: null };
      throw new YoloError("not_found", "This season has no episode yet", { retryable: false });
    }
    const game = gameOf(url);
    if (!game) return { url, about: replays.get(canonicalUrl(url)) ?? null };
    const { replays: list } = await games(game.mid);
    for (const replay of list) keepNewest(replays, canonicalUrl(replay.url), replay, INFO_ENTRIES * 4);
    const replay = preferredReplay(list, game.vid);
    if (!replay) throw new YoloError("not_found", "This game has no replay yet", { retryable: false });
    return { url: replay.url, about: replay };
  }
  const pageOf = async (source) => (await target(source)).url;
  const info = memo((url) => ytdlp.info(url));
  const listing = memo((url) => ytdlp.flatPlaylist(url));
  const parts = memo((url) => bilibiliParts(url, { fetchImpl }));
  // A Bilibili video's part names and lengths for its listing URL, or none
  // for any other run, or when Bilibili does not answer: its parts then
  // stay unnamed.
  const partsOf = async (listUrl) => {
    if (!bilibiliPart(listUrl)) return new Map();
    try {
      return await parts(listUrl);
    } catch (error) {
      logger.warn?.(`Bilibili part names unavailable: ${error.message}`);
      return new Map();
    }
  };
  // A Bilibili video's cover, which every part of it shares, by its listing
  // URL, as the last prepare() of one of its parts found it.
  const covers = new Map();
  const rememberCover = (url, thumbnail) => {
    const listUrl = bilibiliPart(url) ? sequenceUrl(url) : null;
    if (listUrl && thumbnail) keepNewest(covers, listUrl, thumbnail, INFO_ENTRIES);
  };
  const entriesOf = memo(async (url) => subtitleList(url, await info(url)));
  const resolved = resolutionCache({ now });
  const playable = (url, selector, extractorArgs, options) => resolved(`playable\n${url}\n${selector}\n${extractorArgs}`, () => ytdlp.playable(url, { selector, extractorArgs }), options);
  const publicInfo = (url) => resolved(`public\n${url}`, () => ytdlp.publicInfo(url));
  // Bilibili's subtitles and comment XML, from one yt-dlp run per page that
  // asks for subtitles. Bilibili gives its subtitles only to a signed-in
  // account, which yt-dlp says in a warning that goes to the node's log.
  const subtitled = memo((url) => ytdlp.subtitled(url, {
    onWarning: (text) => {
      if (/subtitle/i.test(text)) logger.warn?.(`${url}: ${text.replace(/\s*Use --cookies.*$/s, "")} Set the plugin's cookiesFile option, or YTDLP_COOKIES_FILE, to a cookies file of a signed-in account.`);
    },
  }));
  const danmaku = createDanmaku({ ytdlp: { subtitled }, cookiesFile, fetchImpl, logger });

  // What yt-dlp picks for this device: its format selector and the
  // (cached) resolution.
  function formatsFor(url, { capabilities = {}, limits = {}, fresh = false } = {}) {
    const height = targetHeight(capabilities);
    const maxVideoKbps = Number(limits.maxVideoKbps) > 0 ? Number(limits.maxVideoKbps) : DEFAULT_MAX_VIDEO_KBPS;
    const videoCodecs = Array.isArray(capabilities.video) && capabilities.video.length ? capabilities.video : ["avc1"];
    const selector = buildFormatSelector({ targetHeight: height, maxVideoKbps, videoCodecs, audioCodec: capabilities.audio?.[0] || "mp4a" });
    // Tencent Video's formats name no codec, so a selector cannot keep HEVC
    // from a screen without it: yt-dlp asks Tencent for H.264 instead
    // (yt-dlp/, Agent Note 2026-10-26-tencent-sports-replays).
    const extractorArgs = videoCodecs.some((codec) => /^(hvc1|hev1)/.test(codec)) ? [] : ["vqqvideo:codec=h264"];
    return { height, maxVideoKbps, info: playable(url, selector, extractorArgs, { fresh }) };
  }

  // Formats for this device, plus everything about subtitles and refreshes.
  // `startTime` is where the mirror probe reads. Unless the device is
  // stepping its quality up (it measured its own throughput) or a refresh
  // keeps `videoFormatId`, a fastest mirror slower than the selected formats'
  // bitrate starts the stream on a smaller video format.
  async function resolvePlayable(url, { capabilities = {}, limits = {}, startTime = 0, reason = "play", videoFormatId = null, fresh = false } = {}) {
    const { height, maxVideoKbps, info: resolving } = formatsFor(url, { capabilities, limits, fresh });
    const info = await resolving;
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
        entries = mergeEntries(entries, subtitleEntries(await publicInfo(url)));
      } catch (error) {
        logger.warn?.(`public YouTube subtitle metadata unavailable: ${error.message}`);
      }
    } else if (isBilibiliPage(url) && !entries.length) {
      try {
        entries = subtitleEntries(await subtitled(url));
      } catch (error) {
        logger.warn?.(`Bilibili subtitles unavailable: ${error.message}`);
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
      // A Bilibili season or episode page: the season's episodes.
      const bangumi = bangumiOf(url);
      if (bangumi) {
        const season = await seasonOf(bangumi);
        return {
          title: season.title,
          items: season.episodes.map((episode) => ({ source: sourceFor(episode.url), title: episode.title, thumbnail: episode.thumbnail, duration: episode.duration })),
        };
      }
      // A Tencent Sports game: its replays, the one its page plays first.
      const game = gameOf(url);
      if (game) {
        const { title, replays: list } = await games(game.mid);
        const first = preferredReplay(list, game.vid);
        return {
          title: title ?? list[0]?.title ?? null,
          items: [first, ...list.filter((replay) => replay !== first)].filter(Boolean).map((replay) => ({
            source: sourceFor(replay.url), title: replay.title, thumbnail: replay.thumbnail, duration: replay.duration,
          })),
        };
      }
      const { title, entries } = playlistFromInfo(await ytdlp.flatPlaylist(url));
      return {
        title,
        items: entries.map((entry) => ({
          source: sourceFor(entry.url),
          title: entry.title ?? entry.url,
          thumbnail: entry.thumbnail,
          duration: entry.duration,
        })),
      };
    },
    // A video's run (sequence.js), from one flat listing that every video of
    // the run shares for a while (Agent Note 2026-10-23-up-next). A Bilibili
    // video's parts, which that listing does not name, take their names and
    // lengths from Bilibili's own part list (without it they stay unnamed),
    // "P3" as their place, and the video's cover.
    async sequence(source) {
      const url = pageUrl(source);
      // A Bilibili season's episodes, in order; a season page is its first.
      const bangumi = bangumiOf(url);
      if (bangumi) {
        const season = await seasonOf(bangumi);
        const index = season.episodes.indexOf(bangumiEpisode(season, bangumi));
        if (index < 0 || season.episodes.length < 2) return null;
        return {
          title: season.title,
          index,
          items: season.episodes.map((episode) => ({
            source: sourceFor(episode.url),
            title: episode.title,
            ...(episode.number ? { label: /^\d/.test(episode.number) ? `E${episode.number}` : episode.number } : {}),
            thumbnail: episode.thumbnail,
            duration: episode.duration,
          })),
        };
      }
      const listUrl = sequenceUrl(url);
      if (!listUrl) return null;
      const [flat, named] = await Promise.all([listing(listUrl), partsOf(listUrl)]);
      const run = sequenceFrom(flat, url);
      if (!run) return null;
      return {
        title: run.title,
        index: run.index,
        items: run.entries.map((entry) => {
          const page = bilibiliPart(entry.url);
          const part = page ? named.get(page) : null;
          const title = entry.title ?? part?.title ?? null;
          return {
            source: sourceFor(entry.url),
            ...(title ? { title } : {}),
            ...(page ? { label: `P${page}` } : {}),
            thumbnail: entry.thumbnail ?? (page ? covers.get(listUrl) : null) ?? null,
            duration: entry.duration ?? part?.duration ?? null,
          };
        }),
      };
    },
    async describe(source) {
      const { url, about } = await target(source);
      const described = describeInfo(await info(url));
      return about ? { ...described, title: about.title, duration: described.duration ?? about.duration, thumbnail: described.thumbnail ?? about.thumbnail } : described;
    },
    tracks: async (source) => ({ subtitles: (await entriesOf(await pageOf(source))).map(trackFromEntry), audio: [] }),
    // What agents read (Agent Note 2026-10-07-remote-mcp-server): the
    // description and channel, the uploader's chapters, and subtitle text
    // while the video is not playing.
    async details(source) {
      const { url, about } = await target(source);
      const details = detailsFromInfo(await info(url));
      return about ? { ...details, title: about.title, duration: details.duration ?? about.duration } : details;
    },
    chapters: async (source) => chaptersFromInfo(await info(await pageOf(source))),
    async subtitle(source, trackId) {
      const url = await pageOf(source);
      const entry = (await entriesOf(url)).find((candidate) => `s_${candidate.key}` === trackId);
      if (!entry) throw new YoloError("not_found", `No subtitle ${trackId}`);
      return subtitles.get(canonicalUrl(url), entry);
    },
    // The storyboard images the site publishes, if any
    // (Agent Note 2026-10-13-video-frames): from the shared metadata lookup,
    // a few small sprite sheets instead of reading the video at every tile.
    async storyboard(source) {
      const url = await pageOf(source);
      return isDirectMedia(url) ? null : storyboardFromInfo(await info(url));
    },
    // Timed comments: Bilibili's danmaku, null for every other site.
    comments: async (source, range) => danmaku(await pageOf(source), range),

    // Resolve ahead for a device that may play this soon (Agent Note
    // 2026-10-11-source-plugin-api, "warm"): its formats and YouTube's
    // caption list, which prepare() then reuses. The mirror probe waits for
    // prepare, since a mirror's speed changes by the minute.
    async warm(source, { capabilities = {}, limits = {} } = {}) {
      const url = await pageOf(source);
      if (isDirectMedia(url)) return;
      await subtitleList(url, await formatsFor(url, { capabilities, limits }).info);
    },

    // Agent Note 2026-10-11-node-media-pipeline, "prepare". yt-dlp keeps no
    // resume position, so a null startTime starts at the beginning.
    async prepare(source, { capabilities = {}, startTime = null, limits = {}, reason = "play", chooseTracks } = {}) {
      const { url, about } = await target(source);
      if (isDirectMedia(url)) {
        const hls = /\.m3u8(\?|$)/i.test(url);
        return {
          title: url,
          input: { type: hls ? "hls" : "file", url },
          startTime: Math.max(0, Number(startTime) || 0),
          tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
        };
      }
      // A frame (Agent Note 2026-10-13-video-frames) shows no subtitle, so it
      // skips their lookup, which can run yt-dlp a second time. Bilibili's
      // run starts alongside the formats', so the stream does not wait for it.
      if (reason !== "frame" && isBilibiliPage(url)) subtitled(url).catch(() => {});
      const { info, input, profile, start } = await resolvePlayable(url, { capabilities, limits, startTime: Number(startTime) || 0, reason });
      rememberCover(url, info.thumbnail);
      const entries = reason === "frame" ? [] : await subtitleList(url, info);
      const available = { subtitles: entries.map(trackFromEntry), audio: [] };
      const selected = chooseTracks ? chooseTracks(available) : { subtitles: [], audio: null };
      const isLive = Boolean(info.is_live) && input.type === "hls";
      const videoKey = canonicalUrl(url);
      return {
        title: about?.title || info.title || info.fulltitle || url,
        thumbnail: info.thumbnail || about?.thumbnail || null,
        // A replay's length from its list is not the stream's: without the
        // owner's sign-in, Tencent gives a short preview. The stream says.
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
        refresh: async () => (await resolvePlayable(url, { capabilities, limits, startTime: Number(startTime) || 0, reason: "quality", videoFormatId: start?.videoFormatId ?? null, fresh: true })).input,
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
  // yt-dlp and the plugin's own requests follow the owner's egress rules.
  const fetchImpl = yolo.fetch ?? globalThis.fetch;
  const ytdlp = createYtdlp({ binary: String(yolo.options.binary || "yt-dlp"), cookies: cookiesFor(yolo.options, yolo.env), proxy: () => yolo.egressProxy?.() ?? null });
  yolo.registerSource(SOURCE_ID, createYtdlpSource(ytdlp, {
    subtitles: createSubtitleStore({ dir: yolo.cacheDir ?? null, fetchImpl }),
    logger: yolo.log ?? console,
    fetchImpl,
    cookiesFile: cookiesFileFor(yolo.options, yolo.env),
  }));
}
