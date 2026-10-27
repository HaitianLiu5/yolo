import assert from "node:assert/strict";
import { test } from "node:test";
import { bangumiOf } from "../src/bilibili-bangumi.js";
import { createYtdlpSource, SOURCE_ID } from "../src/node.js";

// Bilibili seasons (bilibili-bangumi.js): a season page plays its first
// episode, an episode is named after its show, and the episodes are its run.

const SEASON = "https://www.bilibili.com/bangumi/play/ss46459";
const EPISODE = (id) => `https://www.bilibili.com/bangumi/play/ep${id}`;
const RESULT = {
  season_id: 46459,
  season_title: "人生彩排第一季",
  episodes: [785447, 785448, 785449].map((id, index) => ({ ep_id: id, title: String(index + 1), long_title: index === 2 ? "终章" : "", duration: 1_600_000 + index, cover: `http://i0.hdslb.com/${id}.jpg` })),
  section: [{ title: "预告", episodes: [{ ep_id: 900001, title: "预告" }] }],
};

function bilibili({ result = RESULT, fail = false } = {}) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (fail) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify({ code: 0, result }));
  };
  const played = [];
  const ytdlp = { info: async (url) => (played.push(url), { title: "1", duration: 1600 }) };
  return { asked, played, source: createYtdlpSource(ytdlp, { fetchImpl, logger: { warn() {}, info() {} } }) };
}
const item = (url) => ({ plugin: SOURCE_ID, id: url, url });

test("season and episode pages are recognized on Bilibili's hosts", () => {
  assert.deepEqual(bangumiOf(SEASON), { season: "46459" });
  assert.deepEqual(bangumiOf("https://m.bilibili.com/bangumi/play/ep785449?spm_id_from=x"), { episode: "785449" });
  assert.equal(bangumiOf("https://www.bilibili.com/video/BV1GJ411x7h7"), null);
});

test("a season page plays its first episode, and an episode is named after its show and its number", async () => {
  const { played, source, asked } = bilibili();
  assert.deepEqual([(await source.describe(item(SEASON))).title, played.at(-1)], ["人生彩排第一季 第1集", EPISODE(785447)]);
  assert.equal((await source.describe(item(EPISODE(785449)))).title, "人生彩排第一季 第3集 终章");
  assert.match(asked[0], /season_id=46459/);
  assert.match(asked[1], /ep_id=785449/);
});

test("a season's episodes are its run, without its trailers; a season page is its first episode", async () => {
  const { source } = bilibili();
  const run = await source.sequence(item(EPISODE(785448)));
  assert.equal(run.title, "人生彩排第一季");
  assert.equal(run.index, 1);
  assert.deepEqual(run.items.map((entry) => [entry.label, entry.source.url, entry.duration]), [
    ["E1", EPISODE(785447), 1600], ["E2", EPISODE(785448), 1600], ["E3", EPISODE(785449), 1600],
  ]);
  assert.equal(run.items[0].thumbnail, "https://i0.hdslb.com/785447.jpg");
  assert.equal((await source.sequence(item(SEASON))).index, 0);
  assert.equal((await source.expand(SEASON)).items.length, 3);
});

test("an episode still plays under yt-dlp's name when Bilibili's season API fails; a season page does not", async () => {
  const { source, played } = bilibili({ fail: true });
  assert.equal((await source.describe(item(EPISODE(785449)))).title, "1");
  assert.equal(played.at(-1), EPISODE(785449));
  await assert.rejects(source.describe(item(SEASON)), /Bilibili answered 503/);
});
