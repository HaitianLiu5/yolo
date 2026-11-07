import { YoloError } from "@useyolo/plugin-api";

// What Tencent Sports says about its games, which answers from anywhere and
// needs no sign-in: a column's schedule, a game's details with its live
// channels, and its replay list. A column is a league (100000 is the NBA).
// Times are Beijing time, and so are the schedule's days.

const SCHEDULE_API = "https://matchweb.sports.qq.com/matchUnion/list";
const DETAIL_API = "https://matchweb.sports.qq.com/kbs/matchDetail";
const REPLAYS_API = "https://matchweb.sports.qq.com/kbs/matchVideoAll";
const TIMEOUT_MS = 8_000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const HEADERS = { "user-agent": USER_AGENT, referer: "https://sports.qq.com/" };
// matchType 2 is a game; 4 is a studio show or an old game shown again.
const GAME_TYPE = "2";
// matchPeriod: 0 before the game, 1 while it is played, 2 after it.
const STATUSES = { 0: "upcoming", 1: "live", 2: "ended" };

// A game page, which built-in link playback plays: its `vid` names a replay,
// its `channel` a live channel, and neither plays the game's best.
export function gamePage(mid, { vid = null, channel = null } = {}) {
  const extra = vid ? `&vid=${encodeURIComponent(vid)}` : channel ? `&channel=${encodeURIComponent(channel)}` : "";
  return `https://sports.qq.com/kbsweb/game.htm?mid=${mid}${extra}`;
}

// The game a page names, when `value` is a game page.
export function pageGame(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return null;
  }
  if (!/^(www\.|m\.|w\.)?sports\.qq\.com$/i.test(url.hostname) || !/\/game\.htm$/i.test(url.pathname)) return null;
  const mid = url.searchParams.get("mid");
  return mid && /^\d+:\d+$/.test(mid) ? { mid, vid: url.searchParams.get("vid") || null, channel: url.searchParams.get("channel") || null } : null;
}

// "02:26:13" or "27:44" → seconds.
function seconds(value) {
  const parts = String(value ?? "").split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0) || null;
}

const number = (value) => (value === "" || value == null || !Number.isFinite(Number(value)) ? null : Number(value));

// "2026-11-05 08:00:00" in Beijing time → an ISO date-time.
const isoTime = (value) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(value ?? "")) ? `${String(value).slice(0, 19).replace(" ", "T")}+08:00` : null);

// The date `days` from `now` on Beijing's calendar, "YYYY-MM-DD".
export function beijingDate(now, days = 0) {
  return new Date(now + (days * 24 + 8) * 3_600_000).toISOString().slice(0, 10);
}

// A game as the schedule or its details name it.
function readGame(raw) {
  if (!raw?.mid || !raw.leftName || !raw.rightName) return null;
  const status = STATUSES[Number(raw.matchPeriod)] ?? null;
  return {
    mid: String(raw.mid),
    competition: String(raw.matchDesc || "") || null,
    left: { name: String(raw.leftName), logo: raw.leftBadge || null, score: number(raw.leftGoal) },
    right: { name: String(raw.rightName), logo: raw.rightBadge || null, score: number(raw.rightGoal) },
    status,
    startsAt: isoTime(raw.startTime),
    progress: [raw.quarter, raw.quarterTime].filter(Boolean).join(" ") || null,
  };
}

const isWhole = (replay) => /全场/.test(replay.title);
const isEnglish = (replay) => /英文|英语|English/i.test(`${replay.title} ${replay.language}`);

/** The game's replays, the one a game page plays first, then the rest of the whole games, then the others. */
export function orderReplays(replays) {
  const rank = (replay) => (isWhole(replay) ? (isEnglish(replay) ? 0 : 1) : 2);
  return replays.map((replay, index) => ({ replay, index })).sort((a, b) => rank(a.replay) - rank(b.replay) || a.index - b.index).map(({ replay }) => replay);
}

/** The live channels, the one a game page plays first: the original English commentary, else the main one. */
export function orderChannels(channels) {
  const isOriginal = (channel) => /英文|英语|English|原音/i.test(channel.name);
  const first = channels.find(isOriginal) ?? channels[0];
  return first ? [first, ...channels.filter((channel) => channel !== first)] : [];
}

export function createTencentSports({ fetchImpl = globalThis.fetch } = {}) {
  async function getJson(url) {
    const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new YoloError("resolve_failed", `Tencent Sports answered ${response.status}`);
    const body = await response.json();
    if (Number(body?.code) !== 0) throw new YoloError("resolve_failed", `Tencent Sports answered code ${body?.code}: ${body?.msg || "no message"}`);
    return body.data;
  }

  return {
    /** The games of a column between two Beijing dates. */
    async schedule(column, { from, to }) {
      const query = new URLSearchParams({ columnId: column, startTime: from, endTime: to });
      const days = await getJson(`${SCHEDULE_API}?${query}`);
      const games = [];
      for (const list of Object.values(days && typeof days === "object" ? days : {})) {
        for (const raw of Array.isArray(list) ? list : []) {
          if (String(raw?.matchType) !== GAME_TYPE) continue;
          const game = readGame(raw);
          if (game) games.push(game);
        }
      }
      return games;
    },

    /** One game, with the channels it can be watched live on while it is played. */
    async game(mid) {
      const detail = await getJson(`${DETAIL_API}?mid=${encodeURIComponent(mid)}`);
      const game = readGame({ mid, ...(detail?.matchInfo ?? detail) });
      if (!game) throw new YoloError("not_found", `No game ${mid}`);
      const main = /^\d+$/.test(String(detail?.liveId ?? "")) ? [{ id: String(detail.liveId), name: "" }] : [];
      const cameras = (Array.isArray(detail?.multiCameras?.cameras) ? detail.multiCameras.cameras : [])
        .map((camera) => ({ id: String(camera?.liveID ?? ""), name: String(camera?.name || "") }))
        .filter((camera) => /^\d+$/.test(camera.id) && !main.some((channel) => channel.id === camera.id));
      return { ...game, channels: game.status === "live" ? [...main, ...cameras] : [] };
    },

    /** A game's replays, in the list's order. */
    async replays(mid) {
      const videos = await getJson(`${REPLAYS_API}?mid=${encodeURIComponent(mid)}`);
      return (Array.isArray(videos?.playbackList) ? videos.playbackList : [])
        .filter((entry) => entry?.vid && /^\w+$/.test(entry.vid))
        .map((entry) => ({ vid: entry.vid, title: String(entry.title || entry.vid), language: String(entry.language || ""), duration: seconds(entry.duration) }));
    },
  };
}
