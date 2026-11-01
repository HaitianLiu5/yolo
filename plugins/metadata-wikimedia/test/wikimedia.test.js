import assert from "node:assert/strict";
import { test } from "node:test";
import { createWikimediaMetadata, languageOf } from "../src/node.js";

// The Wikimedia plugin against a fake Wikidata and Wikipedia: no network.
const claim = (value) => ({ mainsnak: { datavalue: { value } } });
const ENTITIES = {
  Q10935299: {
    id: "Q10935299",
    labels: { en: { value: "Nathan for You" }, "zh-cn": { value: "救援高手" } },
    aliases: {},
    claims: { P31: [claim({ id: "Q5398426" })], P580: [claim({ time: "+2013-02-28T00:00:00Z" })], P345: [claim("tt2297757")], P4983: [claim("58957")], P8600: [claim("3136")] },
    sitelinks: { enwiki: { title: "Nathan for You" } },
  },
  Q25188: {
    id: "Q25188",
    labels: { en: { value: "Inception" }, zh: { value: "全面啟動" }, "zh-cn": { value: "盗梦空间" } },
    aliases: {},
    claims: { P31: [claim({ id: "Q11424" })], P577: [claim({ time: "+2010-07-08T00:00:00Z" })], P2047: [claim({ amount: "+148" })], P161: [claim({ id: "Q38111" })], P136: [claim({ id: "Q471839" })], P4947: [claim("27205")], P4529: [claim("3541415")] },
    sitelinks: { enwiki: { title: "Inception" }, zhwiki: { title: "盗梦空间" } },
  },
  Q38111: { id: "Q38111", labels: { "zh-cn": { value: "莱昂纳多·迪卡普里奥" } }, claims: { P18: [claim("Leonardo DiCaprio.jpg")] } },
  Q471839: { id: "Q471839", labels: { "zh-cn": { value: "科幻电影" } }, claims: {} },
};
function fakeFetch(seen = []) {
  return async (url, init) => {
    const parsed = new URL(url);
    seen.push({ url: parsed, init });
    const params = parsed.searchParams;
    if (parsed.hostname === "www.wikidata.org" && params.get("action") === "wbsearchentities") {
      const search = params.get("search");
      return Response.json({ search: ["救援高手", "Nathan For You", "Nathan for You"].includes(search) ? [{ id: "Q10935299" }] : search === "Inception" ? [{ id: "Q25188" }] : [] });
    }
    if (parsed.hostname === "www.wikidata.org" && params.get("action") === "wbgetentities") {
      return Response.json({ entities: Object.fromEntries(params.get("ids").split("|").filter((id) => ENTITIES[id]).map((id) => [id, ENTITIES[id]])) });
    }
    if (parsed.hostname === "www.wikidata.org" && params.get("action") === "query") {
      return Response.json({ query: { search: params.get("srsearch") === "haswbstatement:P345=tt2297757" ? [{ title: "Q10935299" }] : [] } });
    }
    if (parsed.hostname === "zh.wikipedia.org") return Response.json({ extract: "《盗梦空间》是一部2010年的科幻片。", thumbnail: { source: "https://upload.wikimedia.org/zh/inception.jpg" }, content_urls: { desktop: { page: "https://zh.wikipedia.org/wiki/盗梦空间" } } });
    if (parsed.hostname === "en.wikipedia.org") return Response.json({ extract: "Nathan for You is an American comedy series.", thumbnail: { source: "https://upload.wikimedia.org/en/nathan.png" } });
    return new Response("", { status: 404 });
  };
}
const hints = (titles, season, episode, kind = "episode", year = null) => ({ titles, season, episode, part: null, year, kind, agree: [], tags: [] });

test("a Chinese title finds the show and passes on the other databases' ids", async () => {
  const wikimedia = createWikimediaMetadata({ fetch: fakeFetch() });
  const [found] = await wikimedia.identify({ duration: 1290, ids: {}, hints: hints(["救援高手"], 1, 8) }, { language: "zh-CN" });
  assert.deepEqual([found.id, found.kind, found.title, found.season, found.episode, found.confidence], ["Q10935299", "episode", "救援高手", 1, 8, 0.95]);
  assert.deepEqual(found.ids, { wikidata: "Q10935299", imdb: "tt2297757", tmdb: "tv/58957", tvmaze: "3136" });
  // An episode's record is the show around it; the episode is another plugin's.
  const details = await wikimedia.lookup(found, { language: "zh-CN" });
  assert.deepEqual(details.series, { title: "救援高手", season: 1, episode: 8 });
  assert.equal(details.show.description, "Nathan for You is an American comedy series.");
  assert.equal(details.description, undefined);
  assert.equal(details.people, undefined);
});

test("a film is described in the owner's language with its cast's photos, and an IMDb id needs no search", async () => {
  const seen = [];
  const wikimedia = createWikimediaMetadata({ fetch: fakeFetch(seen) });
  const [film] = await wikimedia.identify({ duration: 8888, ids: {}, hints: hints(["Inception"], null, null, null, 2010) }, { language: "zh-CN" });
  assert.deepEqual([film.title, film.year, film.ids.tmdb, film.ids.douban], ["盗梦空间", 2010, "movie/27205", "3541415"]);
  const details = await wikimedia.lookup(film, { language: "zh-CN" });
  assert.equal(details.description, "《盗梦空间》是一部2010年的科幻片。");
  assert.deepEqual(details.people, [{ name: "莱昂纳多·迪卡普里奥", role: "cast", photo: "https://commons.wikimedia.org/wiki/Special:FilePath/Leonardo%20DiCaprio.jpg?width=185" }]);
  assert.deepEqual(details.genres, ["科幻电影"]);
  assert.equal(seen.find(({ url }) => url.hostname === "zh.wikipedia.org").init.headers["accept-language"], "zh-cn");

  const [byId] = await wikimedia.identify({ duration: 1290, ids: { imdb: "tt2297757" }, hints: hints([], 1, 8) }, { language: "en" });
  assert.deepEqual([byId.id, byId.confidence, byId.title], ["Q10935299", 1, "Nathan for You"]);
  // A copy far shorter than the film is not it.
  const [short] = await wikimedia.identify({ duration: 600, ids: {}, hints: hints(["Inception"], null, null, null) }, { language: "en" });
  assert.ok(short.confidence < 0.85);
  assert.deepEqual(languageOf("zh-TW").labels, ["zh-tw", "zh-hant", "zh", "en"]);
});
