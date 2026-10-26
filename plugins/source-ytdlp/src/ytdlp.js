import { execFile } from "node:child_process";
import { isHttpUrl, YoloError } from "@useyolo/plugin-api";
import { needsVimeoLogin, vimeoPlayerUrl } from "./vimeo.js";

// yt-dlp for URL metadata, subtitle lists, playlist expansion, and the
// formats to play.

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
// How long, and for how many pages, a Vimeo page that needed the embed
// player goes there directly.
const VIA_PLAYER_TTL_MS = 60 * 60_000;
const VIA_PLAYER_ENTRIES = 64;

// What the embed player answered for a page, with the page as its address.
const asPage = (info, url) => ({ ...info, webpage_url: url });

// A cookies file wins over a browser profile; neither means anonymous.
export function cookieArgs({ cookiesFile, cookiesFromBrowser } = {}) {
  const file = String(cookiesFile ?? "").trim();
  const browser = String(cookiesFromBrowser ?? "").trim();
  if (file) return ["--cookies", file];
  if (browser) return ["--cookies-from-browser", browser];
  return [];
}

function entryUrl(entry) {
  if (entry.webpage_url) return entry.webpage_url;
  if (entry.url && /^https?:\/\//i.test(entry.url)) return entry.url;
  const extractor = String(entry.ie_key || entry.extractor_key || "").toLowerCase();
  if (extractor.includes("youtube") && entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  return null;
}

const lastThumbnail = (info) => (Array.isArray(info.thumbnails) && info.thumbnails.length
  ? info.thumbnails[info.thumbnails.length - 1]?.url
  : info.thumbnail) || null;

const wholeSeconds = (value) => (Number(value) > 0 ? Math.floor(Number(value)) : null);

export function describeInfo(info) {
  return {
    title: info.title || info.fulltitle || info.webpage_url || null,
    thumbnail: lastThumbnail(info),
    duration: wholeSeconds(info.duration),
    isLive: Boolean(info.is_live),
  };
}

const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const dated = (value) => (/^\d{8}$/.test(String(value ?? "")) ? String(value) : null);

// What an agent reads about a video (the plugin API's Details): yt-dlp's
// description, channel, dates, categories, tags, series, and counts.
export function detailsFromInfo(info = {}) {
  const channel = info.channel || info.uploader || null;
  const people = [
    ...(channel ? [{ name: channel, role: "channel" }] : []),
    ...asList(info.creators ?? info.creator).map((name) => ({ name, role: "creator" })),
    ...asList(info.artists ?? info.artist).map((name) => ({ name, role: "artist" })),
  ];
  return {
    title: info.title || info.fulltitle || null,
    kind: info.is_live ? "live" : info.episode_number != null ? "episode" : "video",
    description: info.description || null,
    date: dated(info.release_date) || dated(info.upload_date),
    year: info.release_year ?? null,
    duration: info.duration ?? null,
    people,
    genres: asList(info.genres).length ? asList(info.genres) : asList(info.categories),
    tags: asList(info.tags),
    ratings: Number(info.average_rating) > 0 ? [{ value: Number(info.average_rating), max: 5 }] : [],
    contentRating: Number(info.age_limit) > 0 ? `${info.age_limit}+` : null,
    series: info.series ? { title: info.series, season: info.season_number, episode: info.episode_number, episodeTitle: info.episode } : null,
    language: info.language || null,
    url: info.webpage_url || info.original_url || null,
    stats: { views: info.view_count, likes: info.like_count, comments: info.comment_count, followers: info.channel_follower_count },
  };
}

// The video's own chapters, as the uploader marked them.
export function chaptersFromInfo(info = {}) {
  return {
    chapters: asList(info.chapters).map((chapter) => ({ start: chapter.start_time, end: chapter.end_time, title: chapter.title, kind: "chapter" })),
    duration: info.duration ?? null,
  };
}

// Playlist entries as { url, title, thumbnail, duration }; entries without a
// playable link are dropped, and a title the listing lacks (a Bilibili
// video's parts) is null.
export function playlistFromInfo(info) {
  const entries = (Array.isArray(info?.entries) ? info.entries : []).map((entry) => {
    const link = entryUrl(entry);
    if (!link) return null;
    return {
      url: link,
      title: entry.title || entry.fulltitle || null,
      thumbnail: lastThumbnail(entry),
      duration: wholeSeconds(entry.duration),
    };
  }).filter(Boolean);
  return { title: info?.title || info?.playlist_title || null, entries };
}

// `proxy()` is the node's egress proxy for this run, or null
// (Agent Note 2026-10-13-node-egress-proxy): yt-dlp then makes every request
// through it, and the node sends each host direct or through a proxy by the
// owner's rules.
export function createYtdlp({ binary = "yt-dlp", cookies = [], proxy = () => null, exec = execFile } = {}) {
  // `onWarning(text)` hears each of yt-dlp's warnings of a run that worked;
  // without it, yt-dlp prints none.
  function run(args, { withCookies = true, signal, onWarning = null } = {}) {
    return new Promise((resolve, reject) => {
      const via = proxy();
      exec(binary, [...(via ? ["--proxy", via] : []), ...(withCookies ? cookies : []), ...(onWarning ? [] : ["--no-warnings"]), ...args], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, signal }, (error, stdout, stderr) => {
        if (error) {
          const message = String(stderr || error.message).trim().split("\n").pop();
          return reject(new YoloError("resolve_failed", message || "yt-dlp failed", { cause: error }));
        }
        for (const line of String(stderr || "").split("\n")) {
          if (onWarning && line.startsWith("WARNING: ")) onWarning(line.slice("WARNING: ".length).trim());
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (cause) {
          reject(new YoloError("resolve_failed", "yt-dlp returned invalid JSON", { cause }));
        }
      });
    });
  }

  const checkUrl = (url) => {
    if (!isHttpUrl(url)) throw new YoloError("invalid_request", "A valid http(s) URL is required");
    return url.trim();
  };

  // Vimeo pages that needed a login and resolved through the embed player
  // (vimeo.js): page URL → { player, at }. Asking the page first again would
  // cost each later call a failed yt-dlp run.
  const viaPlayer = new Map();
  async function runUrl(url, args, options) {
    const known = viaPlayer.get(url);
    if (known && Date.now() - known.at < VIA_PLAYER_TTL_MS) return asPage(await run([...args, "--", known.player], options), url);
    let error;
    try {
      return await run([...args, "--", url], options);
    } catch (caught) {
      error = caught;
    }
    const player = needsVimeoLogin(error) ? vimeoPlayerUrl(url) : null;
    if (!player) throw error;
    // A player that refuses too (a private video) keeps the page's error,
    // which says how to sign in.
    const info = await run([...args, "--", player], options).catch(() => {
      throw error;
    });
    viaPlayer.delete(url);
    viaPlayer.set(url, { player, at: Date.now() });
    while (viaPlayer.size > VIA_PLAYER_ENTRIES) viaPlayer.delete(viaPlayer.keys().next().value);
    return asPage(info, url);
  }

  return {
    info: (url) => runUrl(checkUrl(url), ["-j", "--no-playlist", "--skip-download"]),
    // The formats `selector` picks, with their (short-lived) media URLs.
    playable: (url, { selector, signal } = {}) => runUrl(checkUrl(url), ["-j", "--no-playlist", ...(selector ? ["-f", selector] : [])], { signal }),
    // YouTube can withhold caption URLs from signed-in clients without a
    // subtitles PO token; anonymous metadata still lists them.
    publicInfo: (url, { signal } = {}) => runUrl(checkUrl(url), ["-j", "--no-playlist", "--skip-download"], { withCookies: false, signal }),
    flatPlaylist: (url) => run(["--flat-playlist", "--dump-single-json", "--", checkUrl(url)]),
    // What some sites list only when subtitles are asked for, which -j alone
    // never does: Bilibili's subtitles (only to a signed-in account) and its
    // comment XML as the `danmaku` subtitle. -j writes no file. Formats may
    // fail (a member-only video) while these are still there.
    subtitled: (url, { onWarning } = {}) => runUrl(checkUrl(url), ["-j", "--no-playlist", "--skip-download", "--ignore-no-formats-error", "--write-subs", "--sub-langs", "all,-live_chat"], { onWarning }),
    version: () => new Promise((resolve) => {
      exec(binary, ["--version"], { timeout: 5_000 }, (error, stdout) => resolve(error ? null : String(stdout).trim()));
    }),
  };
}
