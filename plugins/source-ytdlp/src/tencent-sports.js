import { YoloError } from "@useyolo/plugin-api";
import { BROWSER_USER_AGENT } from "./formats.js";

// Tencent Sports game pages (sports.qq.com/kbsweb/game.htm?mid=…), which
// yt-dlp does not read. A game's replays are Tencent Video videos that yt-dlp
// plays from their v.qq.com pages, and the game's own replay list names them:
// a game page plays the replay with the original English commentary of the
// whole game, else the whole game in any language, else the first replay; a
// page whose `vid` names one of them plays that one. The list itself answers
// from anywhere; playing a replay can need the owner's egress rules for
// Tencent's play-info API (Agent Note 2026-10-13-node-egress-proxy).

const REPLAYS_API = "https://matchweb.sports.qq.com/kbs/matchVideoAll";
const DETAIL_API = "https://matchweb.sports.qq.com/kbs/matchDetail";
const TIMEOUT_MS = 8_000;
const HEADERS = { "user-agent": BROWSER_USER_AGENT, referer: "https://sports.qq.com/" };

// The game's id when `value` is a Tencent Sports game page, else null.
export function gameOf(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return null;
  }
  if (!/^(www\.|m\.|w\.)?sports\.qq\.com$/i.test(url.hostname) || !/\/game\.htm$/i.test(url.pathname)) return null;
  const mid = url.searchParams.get("mid");
  return mid && /^[\w:-]+$/.test(mid) ? { mid, vid: url.searchParams.get("vid") || null } : null;
}

// "02:26:13" or "27:44" → seconds.
export function seconds(value) {
  const parts = String(value ?? "").split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0) || null;
}

const isWhole = (replay) => /全场/.test(replay.title);
const isEnglish = (replay) => /英文|英语|English/i.test(`${replay.title} ${replay.language}`);

// The replay a game page plays: the one its `vid` names, else the whole game
// in English, else the whole game, else the first.
export function preferredReplay(replays, vid = null) {
  return (vid && replays.find((replay) => replay.vid === vid))
    || replays.find((replay) => isWhole(replay) && isEnglish(replay))
    || replays.find(isWhole)
    || replays[0]
    || null;
}

// The Tencent Video page yt-dlp plays a replay from, under its cover when the
// list names one.
const videoPage = (vid, cover) => (cover ? `https://v.qq.com/x/cover/${cover}/${vid}.html` : `https://v.qq.com/x/page/${vid}.html`);

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new YoloError("resolve_failed", `Tencent Sports answered ${response.status}`);
  const body = await response.json();
  if (body?.code !== 0) throw new YoloError("resolve_failed", `Tencent Sports answered code ${body?.code}: ${body?.msg || "no message"}`);
  return body.data;
}

/**
 * A game's replays, in the list's order, with the game's name:
 * { title, replays: [{ vid, url, title, language, duration, thumbnail }] }.
 * The game's name is "<competition> <home> <score>–<score> <away>", or null
 * when its details do not answer.
 */
export async function gameReplays(mid, { fetchImpl = globalThis.fetch } = {}) {
  const query = `?mid=${encodeURIComponent(mid)}`;
  const [videos, detail] = await Promise.all([
    getJson(`${REPLAYS_API}${query}`, fetchImpl),
    getJson(`${DETAIL_API}${query}`, fetchImpl).catch(() => null),
  ]);
  const replays = (Array.isArray(videos?.playbackList) ? videos.playbackList : [])
    .filter((entry) => entry?.vid && /^\w+$/.test(entry.vid))
    .map((entry) => ({
      vid: entry.vid,
      url: videoPage(entry.vid, /^\w+$/.test(String(entry.covers ?? "")) ? entry.covers : null),
      title: String(entry.title || entry.vid),
      language: String(entry.language || ""),
      duration: seconds(entry.duration),
      thumbnail: entry.pic || null,
    }));
  const info = detail?.matchInfo ?? detail ?? {};
  const score = info.leftGoal != null && info.rightGoal != null ? ` ${info.leftGoal}–${info.rightGoal} ` : " vs ";
  const title = info.leftName && info.rightName ? `${info.matchDesc ? `${info.matchDesc} ` : ""}${info.leftName}${score}${info.rightName}` : null;
  return { title, replays };
}
