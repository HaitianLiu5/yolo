import assert from "node:assert/strict";
import { test } from "node:test";
import { createYtdlpSource, SOURCE_ID } from "../src/node.js";
import { createYtdlp } from "../src/ytdlp.js";

// What Yolo follows for the owner and reads by itself
// (Agent Note 2026-11-04-living-home-and-media-pool), parsing answers recorded
// on 2026-11-06: Tencent Sports' schedule and YouTube's channel tabs.

const NOW = Date.parse("2026-11-05T04:08:00Z"); // 12:08 in Beijing
const quiet = { warn() {}, info() {} };
const game = (fields) => ({
  matchType: "2", matchDesc: "NBA常规赛", isPay: "1", ifHasPlayback: "0", leftId: "13", rightId: "23", leftName: "湖人", rightName: "国王",
  leftBadge: "https://sports3.gtimg.com/NBAteamLogo/LosAngelesLakers.png", rightBadge: "https://sports3.gtimg.com/NBAteamLogo/SacramentoKings.png",
  ...fields,
});
const SCHEDULE = {
  "2026-11-05": [
    game({ mid: "100000:10022600173", webUrl: "https://sports.qq.com/kbsweb/game.htm?mid=100000:10022600173", startTime: "2026-11-05 08:00:00", matchPeriod: "2", ifHasPlayback: "1", leftId: "20", rightId: "8", leftName: "76人", rightName: "活塞", leftGoal: "112", rightGoal: "106", quarter: "第4节", quarterTime: "" }),
    game({ mid: "100000:10022600185", webUrl: "https://sports.qq.com/kbsweb/game.htm?mid=100000:10022600185", startTime: "2026-11-05 11:00:00", matchPeriod: "1", isPay: "0", leftGoal: "51", rightGoal: "46", quarter: "第2节", quarterTime: "03:23" }),
    game({ mid: "100000:10022600186", webUrl: "https://sports.qq.com/kbsweb/game.htm?mid=100000:10022600186", startTime: "2026-11-05 07:00:00", matchPeriod: "2", isPay: "0", leftGoal: "90", rightGoal: "80" }),
    { matchType: "4", mid: "100002:30003082", webUrl: "https://sports.qq.com/kbsweb/game.htm?mid=100002:30003082", title: "《早安Tip-Off》第15期", matchPeriod: "2", startTime: "2026-11-05 10:10:00", isPay: "0" },
  ],
  "2026-11-06": [
    game({ mid: "100000:10022600187", webUrl: "https://sports.qq.com/kbsweb/game.htm?mid=100000:10022600187", startTime: "2026-11-06 10:00:00", matchPeriod: "0", isPay: "0", leftGoal: "0", rightGoal: "0", quarter: "未开始" }),
  ],
};
const DETAIL = { matchInfo: { matchDesc: "NBA常规赛", matchType: "2", leftId: "20", rightId: "8", leftName: "76人", rightName: "活塞", leftGoal: "112", rightGoal: "106", matchPeriod: "2" } };

function tencent() {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    const data = url.includes("matchUnion") ? SCHEDULE : url.includes("matchDetail") ? DETAIL : { playbackList: [], totalList: [] };
    return new Response(JSON.stringify({ code: 0, data }));
  };
  return { asked, fetchImpl };
}

const sourceWith = ({ exec = () => assert.fail("no yt-dlp"), signedIn = true } = {}) => {
  const site = tencent();
  const source = createYtdlpSource(createYtdlp({ exec }), {
    fetchImpl: site.fetchImpl,
    logger: quiet,
    now: () => NOW,
    account: { status: () => ({ signedIn }), session: async () => null },
  });
  return { source, asked: site.asked };
};

test("a game belongs to its competition and its teams, and a game's name never holds its score", async () => {
  const { source } = sourceWith();
  const url = "https://sports.qq.com/kbsweb/game.htm?mid=100000:10022600173";
  assert.deepEqual(await source.follows({ plugin: SOURCE_ID, id: url, url }), [
    { id: "schedule:100000", kind: "schedule", title: "NBA" },
    { id: "team:100000:20", kind: "team", title: "76人", within: "schedule:100000" },
    { id: "team:100000:8", kind: "team", title: "活塞", within: "schedule:100000" },
  ]);
  assert.equal((await source.expand(url)).title, "NBA常规赛 76人 vs 活塞");
});

test("a schedule lists games played and to come, ended ones only with a replay, without its studio programmes", async () => {
  const { source, asked } = sourceWith();
  const { entries } = await source.fresh({ id: "schedule:100000", kind: "schedule", title: "NBA" }, { limit: 30 });
  assert.deepEqual(entries.map((entry) => [entry.title, entry.live.state]), [["76人 vs 活塞", "ended"], ["湖人 vs 国王", "live"], ["湖人 vs 国王", "upcoming"]]);
  const url = new URL(asked.at(-1));
  assert.deepEqual([url.searchParams.get("columnId"), url.searchParams.get("startTime"), url.searchParams.get("endTime")], ["100000", "2026-11-03", "2026-11-06"]);

  const [ended, playing, upcoming] = entries;
  assert.equal(ended.source.url, "https://sports.qq.com/kbsweb/game.htm?mid=100000:10022600173");
  assert.deepEqual(ended.related, ["team:100000:20", "team:100000:8"]);
  assert.equal(ended.paid, true);
  assert.deepEqual(playing.matchup.period, "第2节 03:23");
  assert.equal(playing.live.startsAt, Date.parse("2026-11-05T03:00:00Z"), "Beijing's 11:00");
  assert.equal(upcoming.at, Date.parse("2026-11-06T02:00:00Z"));
  assert.ok(entries.every((entry) => !/\d+[–-]\d+/.test(entry.title)));
});

test("without the owner's sign-in, a schedule leaves out paid games", async () => {
  const { source } = sourceWith({ signedIn: false });
  const { entries } = await source.fresh({ id: "schedule:100000", kind: "schedule", title: "NBA" }, { limit: 30 });
  assert.deepEqual(entries.map((entry) => entry.live.state), ["live", "upcoming"]);
  assert.ok(entries.every((entry) => !entry.paid));
});

const CHANNEL = { id: "channel:UCu2Fxqf37DAZ0ZhIsd1FZwA", kind: "channel", title: "Capcom Fighters JP", url: "https://www.youtube.com/channel/UCu2Fxqf37DAZ0ZhIsd1FZwA" };
const thumbnails = (id) => [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }, { url: `https://i.ytimg.com/vi/${id}/hq720.jpg` }];
const watch = (id, fields) => ({ id, url: `https://www.youtube.com/watch?v=${id}`, thumbnails: thumbnails(id), ...fields });
const STREAMS = {
  channel: "Capcom Fighters JP",
  entries: [
    watch("farFuture", { title: "Division F 第8節", live_status: "is_upcoming", duration: null, timestamp: null }),
    watch("nextWeek", { title: "Division S 第8節", live_status: "is_upcoming", duration: null, timestamp: null }),
    watch("thisWeek", { title: "Division F 第7節", live_status: "is_upcoming", duration: null, timestamp: null }),
    watch("onAir", { title: "Division S 第7節", live_status: "is_live", duration: null, timestamp: null }),
    watch("bHJ4IMV5cro", { title: "Division S 第6節", live_status: "was_live", duration: 15413, timestamp: 1793404800 }),
  ],
};
const VIDEOS = { channel: "Capcom Fighters JP", entries: [watch("af9XFrFXEdE", { title: "Daigo vs. Mizuha", duration: 680, timestamp: 1793750400 })] };

function youtube({ streams = STREAMS } = {}) {
  const runs = [];
  const exec = (binary, args, options, callback) => {
    const target = args.at(-1);
    runs.push(args);
    if (target.endsWith("/streams")) return streams ? callback(null, JSON.stringify(streams)) : callback(new Error("x"), "", "ERROR: This channel does not have a streams tab");
    if (target.endsWith("/videos")) return callback(null, JSON.stringify(VIDEOS));
    return callback(null, JSON.stringify({ channel: "Capcom Fighters JP", channel_id: "UCu2Fxqf37DAZ0ZhIsd1FZwA", channel_url: CHANNEL.url, release_timestamp: target.includes("thisWeek") ? 1794303000 : 1794900000 }));
  };
  return { runs, exec };
}

test("a YouTube video belongs to its channel; other sites' videos to nothing, asking nobody", async () => {
  const { runs, exec } = youtube();
  const { source } = sourceWith({ exec });
  const url = "https://www.youtube.com/watch?v=bHJ4IMV5cro";
  assert.deepEqual(await source.follows({ plugin: SOURCE_ID, id: url, url }), [CHANNEL]);
  assert.ok(runs[0].includes("--ignore-no-formats-error"));
  const elsewhere = "https://www.bilibili.com/video/BV1xrnz6gEVD/";
  assert.deepEqual(await source.follows({ plugin: SOURCE_ID, id: elsewhere, url: elsewhere }), []);
  assert.equal(runs.length, 1);
});

test("a channel lists what is on air, its next two broadcasts with their times, and its newest uploads, read without the owner's cookies", async () => {
  const { runs, exec } = youtube();
  const source = createYtdlpSource(createYtdlp({ exec, cookies: ["--cookies", "/secret"] }), { logger: quiet, now: () => NOW });
  const { entries } = await source.fresh(CHANNEL, { limit: 30 });
  assert.deepEqual(entries.map((entry) => [entry.source.url.split("=")[1], entry.live?.state ?? null]), [
    ["af9XFrFXEdE", null], ["nextWeek", "upcoming"], ["thisWeek", "upcoming"], ["onAir", "live"], ["bHJ4IMV5cro", null],
  ]);
  const byId = Object.fromEntries(entries.map((entry) => [entry.source.url.split("=")[1], entry]));
  assert.equal(byId.thisWeek.live.startsAt, 1794303000000);
  assert.equal(byId.thisWeek.at, 1794303000000);
  assert.equal(byId.bHJ4IMV5cro.duration, 15413);
  assert.equal(byId.bHJ4IMV5cro.at, 1793404800000);
  assert.equal(byId.bHJ4IMV5cro.thumbnail, "https://i.ytimg.com/vi/bHJ4IMV5cro/hq720.jpg");
  assert.deepEqual(byId.bHJ4IMV5cro.by, { title: "Capcom Fighters JP", url: CHANNEL.url });
  assert.ok(runs.every((args) => !args.includes("/secret")), "no cookies on what Yolo reads by itself");
});

test("a channel without a streams tab still lists its uploads, and one with neither fails", async () => {
  const { exec } = youtube({ streams: null });
  const source = createYtdlpSource(createYtdlp({ exec }), { logger: quiet, now: () => NOW });
  const { entries } = await source.fresh(CHANNEL, { limit: 30 });
  assert.deepEqual(entries.map((entry) => entry.title), ["Daigo vs. Mizuha"]);

  const refused = createYtdlpSource(createYtdlp({ exec: (binary, args, options, callback) => callback(new Error("x"), "", "ERROR: gone") }), { logger: quiet });
  await assert.rejects(refused.fresh(CHANNEL, { limit: 30 }), /gone/);
});
