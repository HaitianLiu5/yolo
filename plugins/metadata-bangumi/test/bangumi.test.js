import assert from "node:assert/strict";
import { test } from "node:test";
import { createBangumiMetadata, subjectSeason } from "../src/node.js";

// The Bangumi plugin against a fake Bangumi: no network.
const SUBJECTS = [
  { id: 55770, name: "進撃の巨人", name_cn: "进击的巨人", date: "2013-04-06" },
  { id: 80993, name: "進撃の巨人 OAD", name_cn: "进击的巨人 OAD", date: "2013-12-09" },
  { id: 118335, name: "進撃の巨人 Season 2", name_cn: "进击的巨人 第二季", date: "2017-04-01" },
];
function fakeFetch(seen = []) {
  return async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    seen.push({ pathname, init });
    if (pathname === "/v0/search/subjects") {
      const { keyword } = JSON.parse(init.body);
      return Response.json({ data: SUBJECTS.filter((entry) => keyword.startsWith("进击的巨人") && (keyword.includes("第二季") ? entry.id === 118335 : entry.id !== 118335)) });
    }
    if (pathname === "/v0/episodes") return Response.json({ data: [{ sort: 3, ep: 3, name: "絶望の中で鈍く光る", name_cn: "绝望之中的暗淡光芒", duration_seconds: 1469, airdate: "2013-04-20", desc: "脚本：瀬古浩司" }, { sort: 1, ep: 1, name: "獣の巨人", name_cn: "兽之巨人", duration_seconds: 1440 }].filter((entry) => searchParams.get("subject_id") !== "80993" || entry.ep === 3) });
    if (pathname === "/v0/subjects/55770") return Response.json({ ...SUBJECTS[0], summary: "人类与巨人的战斗。", images: { common: "https://lain.bgm.tv/cover.jpg" }, rating: { score: 8.2 }, tags: [{ name: "热血" }] });
    if (pathname === "/v0/subjects/55770/characters") return Response.json([{ name: "エレン・イェーガー", relation: "主角", actors: [{ name: "梶裕貴", images: { medium: "https://lain.bgm.tv/kaji.jpg" } }] }]);
    return new Response("", { status: 404 });
  };
}
const hints = (titles, season, episode) => ({ titles, season, episode, part: null, year: null, kind: "episode", agree: [], tags: [] });

test("the exact name's subject matches; one that only contains it, such as the OAD, stays a candidate", async () => {
  const seen = [];
  const bangumi = createBangumiMetadata({ fetch: fakeFetch(seen) });
  assert.deepEqual(await bangumi.identify({ duration: 1460, ids: {}, hints: hints(["进击的巨人"], 1, 3) }, { language: "en" }), [], "it answers Chinese and Japanese owners");
  const found = await bangumi.identify({ duration: 1460, ids: {}, hints: hints(["进击的巨人"], 1, 3) }, { language: "zh-CN" });
  assert.deepEqual(found.map(({ id, confidence }) => [id, confidence]), [["55770", 0.95], ["80993", 0.7]]);
  assert.match(seen[0].init.headers["user-agent"], /Yolo/);
  const [second] = await bangumi.identify({ duration: 1440, ids: {}, hints: hints(["进击的巨人"], 2, 1) }, { language: "ja" });
  assert.equal(second.id, "118335", "season 2 is its own subject");
});

test("an episode's record has its title in Chinese, the subject's synopsis on the show, and the voice actors' pictures", async () => {
  const bangumi = createBangumiMetadata({ fetch: fakeFetch() });
  const details = await bangumi.lookup({ id: "55770", kind: "episode", season: 1, episode: 3 });
  assert.equal(details.title, "绝望之中的暗淡光芒");
  assert.equal(details.description, undefined, "not the staff list: an episode database gives the synopsis");
  assert.equal(details.show.description, "人类与巨人的战斗。");
  assert.deepEqual(details.people, [{ name: "梶裕貴", role: "cast", character: "エレン・イェーガー", photo: "https://lain.bgm.tv/kaji.jpg" }]);
  assert.equal(details.attribution.url, "https://bgm.tv/subject/55770");
  assert.deepEqual([subjectSeason(["救援高手 第一季"]), subjectSeason(["Show 2nd Season"]), subjectSeason(["Show"])], [1, 2, 1]);
});
