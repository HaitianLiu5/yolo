import { YoloError } from "@useyolo/plugin-api";
import { createMatchups } from "./matchup.js";
import { beijingDate, createTencentSports, gamePage, orderChannels, orderReplays, pageGame } from "./tencent-sports.js";

// Tencent Sports' games as libraries of events (Agent Note
// 2026-11-06-event-libraries): this source knows which games there are, and
// hands playing each one to the source that plays its game page.
//
// An item's id is its game ("100000-10022600173"), which plays the game's
// best; a version of it adds the replay ("…~e4102u1uov7") or the live channel
// ("…~live-1782155800"). Every one names the game as its parent, so a game is
// one entry in Continue Watching.

const SOURCE_ID = "tencent-sports";
const COLUMNS = Object.freeze([{ id: "100000", title: "NBA" }]);
const DAYS_BACK = 7;
const DAYS_AHEAD = 2;
const FRESH_MS = 60_000;
const LIVE_PREFIX = "live-";
const STATUS_ORDER = { live: 0, ended: 1, upcoming: 2 };

const idOf = (mid) => mid.replace(":", "-");
const midOf = (id) => id.replace("-", ":");

/** What an item id names: { mid, vid, channel }, or not_found. */
export function parseItemId(id) {
  const match = /^(\d+-\d+)(?:~(\w+(?:-\d+)?))?$/.exec(String(id));
  if (!match) throw new YoloError("not_found", `Not a game: ${id}`);
  const version = match[2] ?? null;
  const channel = version?.startsWith(LIVE_PREFIX) ? version.slice(LIVE_PREFIX.length) : null;
  return { mid: midOf(match[1]), vid: version && !channel ? version : null, channel };
}

const titleOf = (game) => `${game.left.name} vs ${game.right.name}`;

// The Beijing start of a game, for sorting.
const startOf = (game) => Date.parse(game.startsAt ?? "") || 0;

// Live first, then what ended, the newest first, then what is to come, the soonest first.
function byStatus(a, b) {
  const order = (STATUS_ORDER[a.status] ?? 1) - (STATUS_ORDER[b.status] ?? 1);
  if (order) return order;
  return a.status === "ended" ? startOf(b) - startOf(a) : startOf(a) - startOf(b);
}

// What screens show about a game. The score goes apart from the title, which
// stays the game's name while the score changes.
function eventOf(game) {
  const scored = game.status !== "upcoming" && game.left.score != null && game.right.score != null;
  return {
    status: game.status ?? "ended",
    ...(game.startsAt ? { startsAt: game.startsAt } : {}),
    ...(game.competition ? { competition: game.competition } : {}),
    ...(game.status === "live" && game.progress ? { progress: game.progress } : {}),
    sides: [game.left, game.right].map((side) => ({ name: side.name, ...(scored ? { score: side.score } : {}) })),
  };
}

const itemOf = (game) => ({
  id: idOf(game.mid),
  kind: "event",
  title: titleOf(game),
  artwork: "landscape",
  parents: [idOf(game.mid)],
  event: eventOf(game),
});

// A replay's name without the game's, which the page already says:
// "NBA常规赛：76人vs活塞英文原声全场回放" → "英文原声全场回放".
function versionName(game, title) {
  const named = `${game.left.name}vs${game.right.name}`;
  const at = title.indexOf(named);
  return (at >= 0 ? title.slice(at + named.length) : title).trim() || title;
}

/** @param {{ sports: ReturnType<typeof createTencentSports>, matchups: ReturnType<typeof createMatchups>, columns?: Array<{ id: string, title: string }>, now?: () => number }} deps */
export function createTencentSportsSource({ sports, matchups, columns = COLUMNS, now = () => Date.now() }) {
  // Asked again after a minute, since games start and end and scores change;
  // a site that stops answering leaves what it last said.
  function fresh(read) {
    const kept = new Map();
    return async (key) => {
      const entry = kept.get(key);
      if (entry && now() - entry.at < FRESH_MS) return entry.value;
      try {
        const value = await read(key);
        kept.set(key, { at: now(), value });
        return value;
      } catch (error) {
        if (entry) return entry.value;
        throw error;
      }
    };
  }
  const scheduleOf = fresh(async (column) => {
    const games = await sports.schedule(column, { from: beijingDate(now(), -DAYS_BACK), to: beijingDate(now(), DAYS_AHEAD) });
    return games.sort(byStatus);
  });
  const gameOf = fresh((mid) => sports.game(mid));
  const replaysOf = fresh((mid) => sports.replays(mid));

  // A game's versions, the one it plays first under the game's own id, so
  // that version and the game keep one progress.
  async function versionsOf(game) {
    const id = idOf(game.mid);
    if (game.status === "live") {
      return orderChannels(game.channels).map((channel, index) => ({
        id: index ? `${id}~${LIVE_PREFIX}${channel.id}` : id,
        kind: "event",
        title: channel.name || game.competition || titleOf(game),
        artwork: "landscape",
        parents: [id],
        isLive: true,
      }));
    }
    return orderReplays(await replaysOf(game.mid)).map((replay, index) => ({
      id: index ? `${id}~${replay.vid}` : id,
      kind: "event",
      title: versionName(game, replay.title),
      artwork: "landscape",
      duration: replay.duration,
      parents: [id],
    }));
  }

  async function named(source) {
    const { mid, vid, channel } = parseItemId(source.id);
    const game = await gameOf(mid);
    return { mid, vid, channel, game };
  }

  // What a version is called while it plays: the game, then the version.
  async function fullTitle({ mid, vid, channel, game }) {
    if (channel) return `${titleOf(game)} · ${game.channels.find((entry) => entry.id === channel)?.name || game.competition}`;
    const replay = vid ? (await replaysOf(mid)).find((entry) => entry.vid === vid) : null;
    return replay ? `${titleOf(game)} · ${versionName(game, replay.title)}` : titleOf(game);
  }

  return {
    health: () => ({ configured: true, columns: columns.length }),

    // Fast and offline: only the page's own address is read.
    claim(url) {
      const page = pageGame(url);
      if (!page) return undefined;
      const version = page.vid ?? (page.channel ? `${LIVE_PREFIX}${page.channel}` : null);
      return { id: version ? `${idOf(page.mid)}~${version}` : idOf(page.mid) };
    },

    libraries: async () => columns.map((column) => ({ id: column.id, title: column.title, type: "event" })),

    async items(libraryId, { offset = 0, limit = 50 } = {}) {
      if (!columns.some((column) => column.id === String(libraryId))) throw new YoloError("not_found", `No library ${libraryId}`);
      const games = await scheduleOf(String(libraryId));
      return { total: games.length, offset, items: games.slice(offset, offset + limit).map(itemOf) };
    },

    async children(itemId) {
      const { mid } = parseItemId(itemId);
      const game = await gameOf(mid);
      return { parent: itemOf(game), items: await versionsOf(game) };
    },

    // A team's or a competition's name finds its games.
    async search(query, { type = null, limit = 20 } = {}) {
      if (type && type !== "event") return [];
      const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const found = [];
      for (const column of columns) {
        const games = await scheduleOf(column.id);
        found.push(...games.filter((game) => {
          const name = [game.left.name, game.right.name, game.competition, column.title].join(" ").toLowerCase();
          return words.every((word) => name.includes(word));
        }));
      }
      return found.slice(0, limit).map(itemOf);
    },

    async describe(source) {
      const item = await named(source);
      const replay = item.vid ? (await replaysOf(item.mid)).find((entry) => entry.vid === item.vid) : null;
      return { title: await fullTitle(item), artwork: "landscape", duration: replay?.duration ?? null, isLive: item.game.status === "live" && !item.vid };
    },

    async details(source) {
      const item = await named(source);
      const { mid, vid, channel, game } = item;
      return { title: await fullTitle(item), kind: "event", date: game.startsAt, url: gamePage(mid, { vid, channel }), event: eventOf(game) };
    },

    // The game page plays it, through the source that claims the page. A game
    // with nothing to play yet says so here: it is not gone from the library.
    async delegate(source) {
      const item = await named(source);
      const { mid, vid, channel, game } = item;
      if (!vid && game.status === "upcoming") throw new YoloError("resolve_failed", "This game has not started yet", { retryable: false });
      if (!vid && game.status === "ended" && !(await replaysOf(mid)).length) {
        throw new YoloError("resolve_failed", "This game's replay is not ready yet", { retryable: false });
      }
      return { url: gamePage(mid, { vid, channel }), title: await fullTitle(item), artwork: "landscape", parents: [idOf(mid)] };
    },

    async artwork(itemId, variant) {
      const { mid } = parseItemId(itemId);
      const game = await gameOf(mid);
      if (!game.left.logo || !game.right.logo) throw new YoloError("not_found", "This game has no logos");
      const picture = await matchups.picture(game.left.logo, game.right.logo, variant).catch((error) => {
        throw new YoloError("not_found", `This game has no picture: ${error.message}`);
      });
      return new Response(picture, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
    },
  };
}

// The leagues the owner chose (the plugin's `columns`), else the NBA.
export function columnsFrom(value) {
  const chosen = (Array.isArray(value) ? value : []).filter((column) => /^\d+$/.test(String(column?.id ?? "")) && column.title).map((column) => ({ id: String(column.id), title: String(column.title) }));
  return chosen.length ? chosen : COLUMNS;
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function tencentSportsPlugin(yolo) {
  const fetchImpl = yolo.fetch ?? globalThis.fetch;
  yolo.registerSource(SOURCE_ID, createTencentSportsSource({
    sports: createTencentSports({ fetchImpl }),
    matchups: createMatchups({ fetchImpl, cacheDir: yolo.cacheDir ?? null, ffmpeg: String(yolo.options?.ffmpeg || yolo.env?.FFMPEG_PATH || "ffmpeg") }),
    columns: columnsFrom(yolo.options?.columns),
  }));
}
