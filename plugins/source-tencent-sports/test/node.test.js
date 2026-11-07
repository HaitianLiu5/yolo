import assert from "node:assert/strict";
import { test } from "node:test";
import { createMatchups, matchupArgs } from "../src/matchup.js";
import plugin, { columnsFrom, createTencentSportsSource, parseItemId } from "../src/node.js";
import { beijingDate, createTencentSports, gamePage, orderReplays, pageGame } from "../src/tencent-sports.js";

const NOW = Date.parse("2026-11-05T04:00:00Z");
const raw = (mid, left, right, fields = {}) => ({
  mid, matchType: "2", matchDesc: "NBA常规赛", leftName: left, rightName: right, leftGoal: "0", rightGoal: "0",
  leftBadge: `https://logos.example/${left}.png`, rightBadge: `https://logos.example/${right}.png`, matchPeriod: "2", startTime: "2026-11-05 08:00:00", quarter: "第4节", quarterTime: "", ...fields,
});
const SCHEDULE = {
  "2026-11-04": [raw("100000:1", "公牛", "76人", { leftGoal: "101", rightGoal: "116", startTime: "2026-11-04 08:00:00" })],
  "2026-11-05": [
    raw("100000:2", "76人", "活塞", { leftGoal: "112", rightGoal: "106" }),
    raw("100000:3", "老鹰", "奇才", { matchPeriod: "1", leftGoal: "60", rightGoal: "58", quarter: "第3节", quarterTime: "05:12", startTime: "2026-11-05 11:00:00" }),
    raw("100002:9", "《早安》第12期", "", { matchType: "4", matchDesc: "篮球直播节目" }),
    raw("100002:8", "精彩回顾", "", { matchType: "4", matchDesc: "NBA经典赛", matchPeriod: "0" }),
  ],
  "2026-11-07": [raw("100000:4", "76人", "骑士", { matchPeriod: "0", startTime: "2026-11-07 08:30:00", quarter: "未开始" })],
};
const DETAILS = {
  "100000:2": { matchInfo: SCHEDULE["2026-11-05"][0] },
  "100000:3": { matchInfo: SCHEDULE["2026-11-05"][1], liveId: "111", multiCameras: { cameras: [{ liveID: "222", name: "英文原音" }, { liveID: "111", name: "主" }] } },
  "100000:4": { matchInfo: SCHEDULE["2026-11-07"][0] },
  "100000:5": { matchInfo: raw("100000:5", "雄鹿", "凯尔特人") },
};
const REPLAYS = {
  "100000:2": [
    { vid: "q1", title: "NBA常规赛：76人vs活塞第1节中文解说回放", language: "普通话", duration: "00:30:26" },
    { vid: "cn", title: "NBA常规赛：76人vs活塞中文解说全场回放", language: "普通话", duration: "03:08:04" },
    { vid: "en", title: "NBA常规赛：76人vs活塞英文原声全场回放", language: "英语", duration: "02:30:11" },
  ],
};

function fakeFetch(calls = []) {
  return async (url) => {
    calls.push(String(url));
    const address = new URL(url);
    const mid = address.searchParams.get("mid");
    const data = address.pathname.endsWith("/matchUnion/list") ? SCHEDULE
      : address.pathname.endsWith("/matchDetail") ? DETAILS[mid]
        : { playbackList: REPLAYS[mid] ?? [] };
    return new Response(JSON.stringify({ code: 0, data }));
  };
}

function source({ calls = [], now = () => NOW, picture = async () => Buffer.from("jpeg") } = {}) {
  return createTencentSportsSource({ sports: createTencentSports({ fetchImpl: fakeFetch(calls) }), matchups: { picture }, now });
}

test("the library lists games, not studio shows, live first, then the newest ended, then what is to come", async () => {
  const calls = [];
  const yolo = source({ calls });
  assert.deepEqual(await yolo.libraries(), [{ id: "100000", title: "NBA", type: "event" }]);
  const { total, items } = await yolo.items("100000", { offset: 0, limit: 10 });
  assert.equal(total, 4);
  assert.deepEqual(items.map((item) => item.id), ["100000-3", "100000-2", "100000-1", "100000-4"]);
  assert.match(calls[0], /columnId=100000/);
  assert.match(calls[0], /startTime=2026-10-29&endTime=2026-11-07/, "a week back and two days ahead on Beijing's calendar");
  await assert.rejects(yolo.items("nope", {}), { code: "not_found" });
});

test("a game's title is its name; the score goes apart, and only an event that started has one", async () => {
  const { items } = await source().items("100000", { offset: 0, limit: 10 });
  const [live, ended, , upcoming] = items;
  assert.deepEqual(live, {
    id: "100000-3", kind: "event", title: "老鹰 vs 奇才", artwork: "landscape", parents: ["100000-3"],
    event: {
      status: "live", startsAt: "2026-11-05T11:00:00+08:00", competition: "NBA常规赛", progress: "第3节 05:12",
      sides: [{ name: "老鹰", score: 60 }, { name: "奇才", score: 58 }],
    },
  });
  assert.equal(ended.title, "76人 vs 活塞");
  assert.deepEqual(ended.event.sides, [{ name: "76人", score: 112 }, { name: "活塞", score: 106 }]);
  assert.equal(ended.event.progress, undefined);
  assert.deepEqual(upcoming.event.sides, [{ name: "76人" }, { name: "骑士" }]);
});

test("an ended game's versions: the one it plays first under the game's own id, whole games, then the rest", async () => {
  const { parent, items } = await source().children("100000-2");
  assert.equal(parent.id, "100000-2");
  assert.deepEqual(items.map(({ id, title, duration }) => [id, title, duration]), [
    ["100000-2", "英文原声全场回放", 9011],
    ["100000-2~cn", "中文解说全场回放", 11284],
    ["100000-2~q1", "第1节中文解说回放", 1826],
  ]);
  for (const item of items) assert.deepEqual(item.parents, ["100000-2"], "every version is one entry in Continue Watching");
});

test("a live game's versions are its channels, the English one first", async () => {
  const { items } = await source().children("100000-3");
  assert.deepEqual(items.map(({ id, title, isLive }) => [id, title, isLive]), [
    ["100000-3", "英文原音", true],
    ["100000-3~live-111", "NBA常规赛", true],
  ]);
});

test("claim reads only a game page's address", () => {
  const yolo = source();
  assert.deepEqual(yolo.claim("https://sports.qq.com/kbsweb/game.htm?mid=100000:2"), { id: "100000-2" });
  assert.deepEqual(yolo.claim("https://sports.qq.com/kbsweb/game.htm?mid=100000%3A2&vid=abc"), { id: "100000-2~abc" });
  assert.deepEqual(yolo.claim("https://sports.qq.com/kbsweb/game.htm?mid=100000:2&channel=222"), { id: "100000-2~live-222" });
  assert.equal(yolo.claim("https://sports.qq.com/a/20261105/news.htm"), undefined);
  assert.equal(yolo.claim("https://example.com/game.htm?mid=1:2"), undefined);
});

test("an id names a game and a version, and a page round-trips through it", () => {
  assert.deepEqual(parseItemId("100000-2"), { mid: "100000:2", vid: null, channel: null });
  assert.deepEqual(parseItemId("100000-2~q1"), { mid: "100000:2", vid: "q1", channel: null });
  assert.deepEqual(parseItemId("100000-2~live-111"), { mid: "100000:2", vid: null, channel: "111" });
  assert.throws(() => parseItemId("https://example.com/"), { code: "not_found" });
  assert.equal(gamePage("100000:2"), "https://sports.qq.com/kbsweb/game.htm?mid=100000:2");
  assert.deepEqual(pageGame(gamePage("100000:2", { vid: "q1" })), { mid: "100000:2", vid: "q1", channel: null });
  assert.deepEqual(pageGame(gamePage("100000:2", { channel: "111" })), { mid: "100000:2", vid: null, channel: "111" });
});

test("search finds a team's games, and nothing for another kind", async () => {
  const yolo = source();
  assert.deepEqual((await yolo.search("76人", { limit: 10 })).map((item) => item.id), ["100000-2", "100000-1", "100000-4"]);
  assert.deepEqual((await yolo.search("nba 老鹰", { type: "event", limit: 10 })).map((item) => item.id), ["100000-3"]);
  assert.deepEqual(await yolo.search("76人", { type: "movie", limit: 10 }), []);
});

test("a game plays through its page under its own name; one with nothing to play says so", async () => {
  const yolo = source();
  assert.deepEqual(await yolo.delegate({ plugin: "tencent-sports", id: "100000-2" }), {
    url: "https://sports.qq.com/kbsweb/game.htm?mid=100000:2", title: "76人 vs 活塞", artwork: "landscape", parents: ["100000-2"],
  });
  const version = await yolo.delegate({ plugin: "tencent-sports", id: "100000-2~q1" });
  assert.equal(version.url, "https://sports.qq.com/kbsweb/game.htm?mid=100000:2&vid=q1");
  assert.equal(version.title, "76人 vs 活塞 · 第1节中文解说回放");
  assert.equal((await yolo.delegate({ plugin: "tencent-sports", id: "100000-3~live-222" })).title, "老鹰 vs 奇才 · 英文原音");

  // resolve_failed, so the Hub does not look for it elsewhere in the library.
  await assert.rejects(yolo.delegate({ plugin: "tencent-sports", id: "100000-4" }), { code: "resolve_failed", retryable: false, message: /has not started/ });
  await assert.rejects(yolo.delegate({ plugin: "tencent-sports", id: "100000-5" }), { code: "resolve_failed", retryable: false, message: /replay is not ready/ });
});

test("describe and details say what a game is now, with no score in its name", async () => {
  const yolo = source();
  assert.deepEqual(await yolo.describe({ plugin: "tencent-sports", id: "100000-3" }), { title: "老鹰 vs 奇才", artwork: "landscape", duration: null, isLive: true });
  assert.deepEqual(await yolo.describe({ plugin: "tencent-sports", id: "100000-2~en" }), { title: "76人 vs 活塞 · 英文原声全场回放", artwork: "landscape", duration: 9011, isLive: false });
  const details = await yolo.details({ plugin: "tencent-sports", id: "100000-2" });
  assert.equal(details.kind, "event");
  assert.equal(details.date, "2026-11-05T08:00:00+08:00");
  assert.equal(details.event.status, "ended");
});

test("a minute later the site is asked again, and what it last said stands while it does not answer", async () => {
  let at = NOW;
  const calls = [];
  const sports = createTencentSports({ fetchImpl: fakeFetch(calls) });
  const yolo = createTencentSportsSource({ sports, matchups: {}, now: () => at });
  await yolo.items("100000", {});
  await yolo.items("100000", {});
  assert.equal(calls.length, 1);
  at += 61_000;
  await yolo.items("100000", {});
  assert.equal(calls.length, 2);
  sports.schedule = async () => {
    throw new Error("down");
  };
  at += 61_000;
  assert.equal((await yolo.items("100000", {})).total, 4);
});

test("a game's picture is its two logos, in the shape asked for; one that cannot be made is not_found", async () => {
  const asked = [];
  const yolo = source({
    picture: async (...args) => {
      asked.push(args);
      return Buffer.from("jpeg");
    },
  });
  const response = await yolo.artwork("100000-2~q1", "poster");
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(asked, [["https://logos.example/76人.png", "https://logos.example/活塞.png", "poster"]]);
  const broken = source({
    picture: async () => {
      throw new Error("no ffmpeg");
    },
  });
  await assert.rejects(broken.artwork("100000-2", "landscape"), { code: "not_found" });
});

test("a picture is made once, from both logos, and kept", async () => {
  const ran = [];
  const matchups = createMatchups({
    fetchImpl: async () => new Response(Buffer.from("png")),
    run: async (ffmpeg, args) => {
      ran.push(args);
      return Buffer.from("jpeg");
    },
  });
  const [one, two] = await Promise.all([matchups.picture("https://a/1.png", "https://a/2.png"), matchups.picture("https://a/1.png", "https://a/2.png")]);
  assert.deepEqual([one.toString(), two.toString(), ran.length], ["jpeg", "jpeg", 1]);
  assert.deepEqual(matchupArgs("a", "b", "poster").slice(2, 6), ["-i", "a", "-i", "b"]);
  assert.match(matchupArgs("a", "b", "poster").join(" "), /s=400x600/);
  assert.match(matchupArgs("a", "b", "unknown").join(" "), /s=640x360/);
  const refused = createMatchups({ fetchImpl: async () => new Response("", { status: 404 }), run: async () => Buffer.from("jpeg") });
  await assert.rejects(refused.picture("https://a/1.png", "https://a/2.png"), /404/);
});

test("the replay a page plays first: whole in English, whole in any language, then the rest in order", () => {
  const titles = (list) => orderReplays(list).map((replay) => replay.vid);
  assert.deepEqual(titles(REPLAYS["100000:2"]), ["en", "cn", "q1"]);
  assert.deepEqual(titles([{ vid: "a", title: "第1节", language: "" }, { vid: "b", title: "第2节", language: "" }]), ["a", "b"]);
});

test("Beijing's date, and the leagues the owner chose", () => {
  assert.equal(beijingDate(Date.parse("2026-11-05T16:30:00Z")), "2026-11-06");
  assert.equal(beijingDate(Date.parse("2026-11-05T15:30:00Z"), -1), "2026-11-04");
  assert.deepEqual(columnsFrom(undefined), [{ id: "100000", title: "NBA" }]);
  assert.deepEqual(columnsFrom([{ id: 100008, title: "CBA" }, { id: "x", title: "no" }]), [{ id: "100008", title: "CBA" }]);
});

test("the plugin registers one source with what the node gives it", () => {
  const registered = [];
  plugin({ options: {}, fetch: fakeFetch(), registerSource: (id, impl) => registered.push([id, impl]) });
  assert.equal(registered[0][0], "tencent-sports");
  assert.equal(typeof registered[0][1].delegate, "function");
});
