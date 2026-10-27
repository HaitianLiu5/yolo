import { YoloError } from "@useyolo/plugin-api";
import { BROWSER_USER_AGENT } from "./formats.js";

// Bilibili's bangumi (番剧) and other licensed series: a season page
// (bilibili.com/bangumi/play/ss…) and its episode pages (…/play/ep…). yt-dlp
// plays an episode page, but reads no show name (an episode is titled "1"),
// and asked for a season page it resolves every episode first. Bilibili's
// season API names the show and its episodes in one request, from anywhere
// and without a sign-in: a season page plays its first episode, an episode
// is named after its show, and the episodes are its run
// (Agent Note 2026-10-23-up-next). An episode page itself can need the
// owner's egress rules (Agent Note 2026-10-13-node-egress-proxy).

const SEASON_API = "https://api.bilibili.com/pgc/view/web/season";
const TIMEOUT_MS = 8_000;
const HEADERS = { "user-agent": BROWSER_USER_AGENT, referer: "https://www.bilibili.com/" };

// { season } or { episode } when `value` is a season or episode page, else null.
export function bangumiOf(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return null;
  }
  if (!/^(www\.|m\.)?bilibili\.com$/i.test(url.hostname)) return null;
  const match = /^\/bangumi\/play\/(ss|ep)(\d+)\/?$/i.exec(url.pathname);
  if (!match) return null;
  return match[1].toLowerCase() === "ss" ? { season: match[2] } : { episode: match[2] };
}

const https = (value) => (value ? String(value).replace(/^http:\/\//, "https://") : null);

// "人生彩排第一季 第1集 <long title>", or the show name and the episode's own
// title when that is not a number.
function episodeName(show, episode) {
  const number = String(episode.title ?? "").trim();
  const subtitle = String(episode.long_title ?? "").trim();
  const place = /^\d+(\.\d+)?$/.test(number) ? `第${number}集` : number;
  return [show, place, subtitle].filter(Boolean).join(" ");
}

/**
 * The season of a season or episode page (from bangumiOf):
 * { id, title, episodes: [{ id, url, number, title, duration, thumbnail }] },
 * its main episodes in order, without trailers and other extras.
 */
export async function bangumiSeason(page, { fetchImpl = globalThis.fetch } = {}) {
  const query = page.season ? `season_id=${encodeURIComponent(page.season)}` : `ep_id=${encodeURIComponent(page.episode)}`;
  const response = await fetchImpl(`${SEASON_API}?${query}`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new YoloError("resolve_failed", `Bilibili answered ${response.status}`);
  const body = await response.json();
  if (body?.code !== 0 || !body.result) throw new YoloError("resolve_failed", `Bilibili answered code ${body?.code}: ${body?.message || "no message"}`);
  const show = String(body.result.season_title || body.result.title || "").trim() || null;
  const episodes = (Array.isArray(body.result.episodes) ? body.result.episodes : [])
    .filter((episode) => Number(episode?.ep_id ?? episode?.id) > 0)
    .map((episode) => {
      const id = String(episode.ep_id ?? episode.id);
      return {
        id,
        url: `https://www.bilibili.com/bangumi/play/ep${id}`,
        number: String(episode.title ?? "").trim() || null,
        title: episodeName(show, episode),
        duration: Number(episode.duration) > 0 ? Math.round(Number(episode.duration) / 1000) : null,
        thumbnail: https(episode.cover),
      };
    });
  return { id: String(body.result.season_id ?? page.season ?? ""), title: show, episodes };
}

// The episode a page plays: the one it names, else the season's first.
export function bangumiEpisode(season, page) {
  return (page.episode ? season.episodes.find((episode) => episode.id === page.episode) : season.episodes[0]) ?? null;
}
