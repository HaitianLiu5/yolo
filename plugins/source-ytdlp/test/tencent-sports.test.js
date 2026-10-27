import assert from "node:assert/strict";
import { test } from "node:test";
import { createYtdlpSource, SOURCE_ID } from "../src/node.js";
import { gameOf, preferredReplay, seconds } from "../src/tencent-sports.js";
import { createYtdlp } from "../src/ytdlp.js";

// Tencent Sports game pages play a replay from the game's own list
// (tencent-sports.js); yt-dlp plays the replay's Tencent Video page.

const GAME = "https://sports.qq.com/kbsweb/game.htm?mid=100000:10022600106";
const replay = (vid, title, language = "普通话", duration = "00:27:44") => ({ vid, title, language, duration, covers: "mzc00200ju2nn13", pic: `https://pic.test/${vid}.jpg` });
const LIST = [
  replay("w4102fupx2h", "NBA常规赛：雄鹿vs76人第1节中文解说回放"),
  replay("c33683pmhzs", "NBA常规赛：雄鹿vs76人中文解说全场回放", "普通话", "03:03:22"),
  replay("k4102qb14o2", "NBA常规赛：雄鹿vs76人第1节英文原声回放", "英语"),
  replay("s4102uroddb", "NBA常规赛：雄鹿vs76人英文原声全场回放", "英语", "02:26:13"),
];

function tencent(list = LIST) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    const data = url.includes("matchVideoAll") ? { playbackList: list, totalList: [] } : { matchInfo: { matchDesc: "NBA常规赛", leftName: "雄鹿", rightName: "76人", leftGoal: "116", rightGoal: "127" } };
    return new Response(JSON.stringify({ code: 0, data }));
  };
  return { asked, fetchImpl };
}

test("a game page is recognized by its mid, and a vid in it names one replay", () => {
  assert.deepEqual(gameOf(GAME), { mid: "100000:10022600106", vid: null });
  assert.deepEqual(gameOf(`${GAME}&vid=w4102fupx2h`), { mid: "100000:10022600106", vid: "w4102fupx2h" });
  assert.equal(gameOf("https://sports.qq.com/a/20261025/000001.htm"), null);
  assert.equal(gameOf("https://v.qq.com/x/page/s4102uroddb.html"), null);
  assert.deepEqual([seconds("02:26:13"), seconds("27:44"), seconds("")], [8773, 1664, null]);
});

test("a game plays the whole game with English commentary, else the whole game, else its first replay", () => {
  assert.equal(preferredReplay(LIST).vid, "s4102uroddb");
  assert.equal(preferredReplay(LIST.slice(0, 3)).vid, "c33683pmhzs");
  assert.equal(preferredReplay(LIST.slice(0, 1)).vid, "w4102fupx2h");
  assert.equal(preferredReplay(LIST, "k4102qb14o2").vid, "k4102qb14o2");
  assert.equal(preferredReplay([]), null);
});

test("a game page plays its preferred replay's Tencent Video page under the replay's name, and expands to every replay", async () => {
  const calls = [];
  const exec = (binary, args, options, callback) => {
    calls.push(args.at(-1));
    callback(null, JSON.stringify({ title: "vqq-video video #s4102uroddb", protocol: "m3u8_native", url: "https://cdn.test/playlist?vkey=1" }), "");
  };
  const { fetchImpl } = tencent();
  const source = createYtdlpSource(createYtdlp({ exec }), { fetchImpl, logger: { warn() {}, info() {} } });
  const game = { plugin: SOURCE_ID, id: GAME, url: GAME };

  const described = await source.describe(game);
  assert.deepEqual([described.title, described.duration, described.thumbnail], ["NBA常规赛：雄鹿vs76人英文原声全场回放", 8773, "https://pic.test/s4102uroddb.jpg"]);
  assert.equal((await source.details(game)).title, "NBA常规赛：雄鹿vs76人英文原声全场回放");
  const prepared = await source.prepare(game, { capabilities: { video: ["avc1"], audio: ["mp4a"], maxHeight: 720 }, limits: { maxVideoKbps: 4800 } });
  assert.deepEqual([prepared.title, prepared.input.type, prepared.duration], ["NBA常规赛：雄鹿vs76人英文原声全场回放", "hls", null]);
  assert.deepEqual([...new Set(calls)], ["https://v.qq.com/x/cover/mzc00200ju2nn13/s4102uroddb.html"]);

  const expanded = await source.expand(GAME);
  assert.equal(expanded.title, "NBA常规赛 雄鹿 116–127 76人");
  assert.deepEqual(expanded.items.map((item) => item.source.url.split("/").pop()), ["s4102uroddb.html", "w4102fupx2h.html", "c33683pmhzs.html", "k4102qb14o2.html"]);

  const empty = createYtdlpSource(createYtdlp({ exec }), { fetchImpl: tencent([]).fetchImpl, logger: { warn() {}, info() {} } });
  await assert.rejects(empty.describe(game), /no replay yet/);
});
