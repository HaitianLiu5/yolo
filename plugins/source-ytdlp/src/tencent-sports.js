import { YoloError } from "@useyolo/plugin-api";
import { BROWSER_USER_AGENT } from "./formats.js";

// Tencent Sports game pages (sports.qq.com/kbsweb/game.htm?mid=…), which
// yt-dlp does not read. A game's replays are Tencent Video videos that yt-dlp
// plays from their v.qq.com pages, and the game's own replay list names them:
// a game page plays the replay with the original English commentary of the
// whole game, else the whole game in any language, else the first replay; a
// page whose `vid` names one of them plays that one. While the game is played,
// its details name its live channels (tencent-live.js). The list itself
// answers from anywhere; playing a replay can need the owner's egress rules
// for Tencent's play-info API (Agent Note 2026-10-13-node-egress-proxy).

const REPLAYS_API = "https://matchweb.sports.qq.com/kbs/matchVideoAll";
const DETAIL_API = "https://matchweb.sports.qq.com/kbs/matchDetail";
const SCHEDULE_API = "https://matchweb.sports.qq.com/matchUnion/list";
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

// The live channel a game page plays: the original English commentary
// ("英文原音"), else the game's main channel.
export const preferredChannel = (channels) => channels.find((channel) => /英文|英语|English|原音/i.test(channel.name)) || channels[0] || null;

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

// matchPeriod: 0 before the game, 1 while it is played, 2 after it.
const PERIODS = { 0: "upcoming", 1: "live", 2: "ended" };
const channelId = (value) => (/^\d+$/.test(String(value ?? "")) ? String(value) : null);

// The live channels a game's details name while it is played, its main
// channel first: [{ id, name, thumbnail }].
function liveChannels(detail) {
  const main = channelId(detail?.liveId);
  const cameras = (Array.isArray(detail?.multiCameras?.cameras) ? detail.multiCameras.cameras : [])
    .map((camera) => ({ id: channelId(camera?.liveID), name: String(camera?.name || ""), thumbnail: camera?.pic?.["640x360"] || null }))
    .filter((camera) => camera.id && camera.id !== main);
  return [...(main ? [{ id: main, name: "", thumbnail: detail.coverPicture || detail.matchPic || null }] : []), ...cameras];
}

// A game's competition without its stage: "NBA常规赛" and "NBA杯小组赛东部B组"
// are both "NBA".
const competitionOf = (desc) => String(desc || "").replace(/(常规赛|季前赛|季后赛|总决赛|附加赛|杯.*)$/, "").trim() || String(desc || "").trim();

/**
 * A game's replays, in the list's order, with the game's name and state:
 * { title, period, channels, competition, teams, isGame, replays: [{ vid, url,
 * title, language, duration, thumbnail }] }. The game's name is "<stage>
 * <home> vs <away>", never its score, which stays in history and would spoil
 * the replay (Agent Note 2026-11-04-living-home-and-media-pool), or null when
 * its details do not answer; `period` is "upcoming", "live", "ended", or
 * null; `channels` are its live channels while it is played ([{ id, name,
 * thumbnail }]), else none; `competition` and `teams` ([{ id, name }]) are what
 * the game belongs to; `isGame` is false for a studio programme on the schedule.
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
  const title = info.leftName && info.rightName ? `${info.matchDesc ? `${info.matchDesc} ` : ""}${info.leftName} vs ${info.rightName}` : null;
  const period = PERIODS[info.matchPeriod] ?? null;
  const teams = [[info.leftId, info.leftName], [info.rightId, info.rightName]].filter(([id, name]) => id && name).map(([id, name]) => ({ id: String(id), name: String(name) }));
  return {
    title,
    period,
    channels: period === "live" ? liveChannels(detail) : [],
    competition: competitionOf(info.matchDesc) || null,
    teams,
    isGame: !info.matchType || String(info.matchType) === GAME_TYPE,
    replays,
  };
}

// matchType of a game on the schedule; studio programmes have others.
const GAME_TYPE = "2";
const DAY_MS = 86_400_000;
// The schedule's days and times are Beijing's.
const BEIJING_MS = 8 * 3_600_000;
const beijingDay = (ms) => new Date(ms + BEIJING_MS).toISOString().slice(0, 10);
const beijingTime = (text) => {
  const parsed = Date.parse(`${String(text).replace(" ", "T")}+08:00`);
  return Number.isFinite(parsed) ? parsed : null;
};

// The column a game's id starts with: its competition on the schedule.
export const columnOf = (mid) => String(mid).split(":")[0];
export const scheduleFollowId = (column) => `schedule:${column}`;
export const teamFollowId = (column, team) => `team:${column}:${team}`;

/**
 * A competition's games from two days ago to tomorrow, as feed entries
 * without their source ({ url, … }). A game that ended lists only once it has
 * a replay; a paid one only with the owner's sign-in. Scores go only in
 * `matchup`, where Yolo keeps them only while a game is played.
 */
export async function gameSchedule(column, { now = Date.now(), signedIn = false, fetchImpl = globalThis.fetch } = {}) {
  const query = new URLSearchParams({ columnId: column, startTime: beijingDay(now - 2 * DAY_MS), endTime: beijingDay(now + DAY_MS) });
  const data = await getJson(`${SCHEDULE_API}?${query}`, fetchImpl);
  const games = Object.values(data && typeof data === "object" ? data : {}).flat();
  return games.filter((game) => {
    if (String(game?.matchType) !== GAME_TYPE || !game.leftName || !game.rightName || !gameOf(game.webUrl)) return false;
    if (String(game.isPay) === "1" && !signedIn) return false;
    return PERIODS[game.matchPeriod] !== "ended" || String(game.ifHasPlayback) === "1";
  }).map((game) => {
    const startsAt = beijingTime(game.startTime);
    return {
      url: game.webUrl,
      title: `${game.leftName} vs ${game.rightName}`,
      at: startsAt,
      live: { state: PERIODS[game.matchPeriod] ?? "upcoming", startsAt },
      matchup: {
        left: { name: game.leftName, badge: game.leftBadge, score: game.leftGoal },
        right: { name: game.rightName, badge: game.rightBadge, score: game.rightGoal },
        period: [game.quarter, game.quarterTime].filter(Boolean).join(" "),
      },
      related: [game.leftId, game.rightId].filter(Boolean).map((team) => teamFollowId(column, team)),
      ...(String(game.isPay) === "1" ? { paid: true } : {}),
    };
  });
}
