import { canonicalUrl } from "./canonical.js";
import { BROWSER_USER_AGENT } from "./formats.js";
import { playlistFromInfo } from "./ytdlp.js";

// The run a video is in (Agent Note 2026-10-23-up-next): a Bilibili video's
// parts, or the playlist a URL's `list=` names. Anything else is in none,
// and costs no yt-dlp run.

const BILIBILI_PARTS_API = "https://api.bilibili.com/x/player/pagelist";
const PARTS_TIMEOUT_MS = 5_000;

/**
 * The URL whose flat listing is the run `value` is in, or null: a Bilibili
 * video's page without ?p= (which names one part), or a URL with list=.
 */
export function sequenceUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return null;
  }
  url.hash = "";
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (host === "bilibili.com" && /^\/video\/[^/]+/.test(url.pathname)) {
    url.searchParams.delete("p");
    return url.toString();
  }
  return url.searchParams.has("list") ? url.toString() : null;
}

// One video however a run spells it: Bilibili's first part with or without
// ?p=1, a YouTube video with or without the playlist it was opened from.
function videoKey(value) {
  const url = new URL(canonicalUrl(value));
  if (url.hostname === "bilibili.com" && !url.searchParams.has("p")) url.searchParams.set("p", "1");
  for (const key of ["list", "index", "start_radio", "pp"]) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}

/**
 * The run in yt-dlp's flat listing `info`, and where the video at `url` is
 * in it: `{ title, index, entries }`, entries as playlistFromInfo() gives
 * them. Null for a listing of fewer than two videos or without this one.
 */
export function sequenceFrom(info, url) {
  const { title, entries } = playlistFromInfo(info);
  if (entries.length < 2) return null;
  let key;
  try {
    key = videoKey(url);
  } catch {
    return null;
  }
  const index = entries.findIndex((entry) => {
    try {
      return videoKey(entry.url) === key;
    } catch {
      return false;
    }
  });
  return index < 0 ? null : { title, index, entries };
}

/** A Bilibili part's page number in `url` (1 without ?p=), or null for any other URL. */
export function bilibiliPart(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase().replace(/^(www|m)\./, "") !== "bilibili.com") return null;
    const page = Number(parsed.searchParams.get("p") ?? 1);
    return Number.isInteger(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

/**
 * A Bilibili video's parts as Bilibili lists them, by page number: each
 * part's own name and length, which yt-dlp's flat listing leaves out. One
 * request, with no account; an empty map for a URL that names no video.
 */
export async function bilibiliParts(url, { fetchImpl = globalThis.fetch, timeoutMs = PARTS_TIMEOUT_MS } = {}) {
  const id = new URL(url).pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/i)?.[1];
  if (!id) return new Map();
  const query = /^av/i.test(id) ? `aid=${id.slice(2)}` : `bvid=${id}`;
  const response = await fetchImpl(`${BILIBILI_PARTS_API}?${query}`, {
    headers: { "User-Agent": BROWSER_USER_AGENT, Referer: "https://www.bilibili.com/" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Bilibili's part list answered ${response.status}`);
  const body = await response.json();
  if (body?.code !== 0 || !Array.isArray(body.data)) throw new Error(`Bilibili's part list answered code ${body?.code}`);
  return new Map(body.data.filter((part) => Number.isInteger(part?.page)).map((part) => [part.page, {
    title: String(part.part ?? "").trim() || null,
    duration: Number(part.duration) > 0 ? Math.floor(Number(part.duration)) : null,
  }]));
}
