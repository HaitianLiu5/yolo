import { lastThumbnail } from "./ytdlp.js";

// A YouTube channel as something Yolo follows for the owner
// (Agent Note 2026-11-04-living-home-and-media-pool): its identity, from a
// video's facts, and what yt-dlp's flat listings of its `videos` and `streams`
// tabs say is new. Those listings need one request a tab and no sign-in; they
// give no time for a broadcast that has not aired, so the plugin asks about
// the next ones. YouTube's channel RSS feeds answered 404 on 2026-11-04.

/** The channel of a video from its facts, or null when they name none. */
export function channelFollow(facts) {
  const id = facts?.channel_id;
  const title = facts?.channel || facts?.uploader;
  if (!id || !title) return null;
  return { id: `channel:${id}`, kind: "channel", title, url: facts.channel_url || `https://www.youtube.com/channel/${id}` };
}

const STATES = { is_upcoming: "upcoming", is_live: "live" };

/** The entries of a channel's tabs, each video once, without their source ({ url, … }). */
export function channelEntries(tabs, { by } = {}) {
  const seen = new Set();
  const entries = [];
  for (const tab of tabs) {
    for (const entry of Array.isArray(tab?.entries) ? tab.entries : []) {
      if (!entry?.id || !/^https?:\/\/[^/]*youtube\.com\/watch/.test(String(entry.url)) || !entry.title || seen.has(entry.id)) continue;
      seen.add(entry.id);
      const state = STATES[entry.live_status];
      entries.push({
        url: entry.url,
        title: entry.title,
        thumbnail: lastThumbnail(entry),
        duration: Number(entry.duration) > 0 ? Number(entry.duration) : null,
        at: Number(entry.timestamp) > 0 ? Number(entry.timestamp) * 1000 : null,
        by,
        ...(state ? { live: { state } } : {}),
      });
    }
  }
  return entries;
}

/**
 * A tab's next `count` broadcasts that have not aired: a tab lists the
 * furthest away first, so the nearest are its last.
 */
export const nearestUpcoming = (entries, count) => entries.filter((entry) => entry.live?.state === "upcoming").slice(-count);

/**
 * The `count` soonest of `timed` ([entry, start in ms or null]): each tab has
 * its own nearest, and only their start times say which of them come first.
 * One without a time comes after those with one.
 */
export const soonest = (timed, count) => [...timed].sort(([, a], [, b]) => (a ?? Infinity) - (b ?? Infinity)).slice(0, count);
