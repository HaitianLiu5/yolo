import { canonicalUrl } from "./canonical.js";
import { playlistFromInfo } from "./ytdlp.js";

// The run a video is in (Agent Note 2026-10-23-up-next): a Bilibili video's
// parts, or the playlist a URL's `list=` names. Anything else is in none,
// and costs no yt-dlp run.

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
