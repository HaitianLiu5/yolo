import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJsonClient } from "../src/fetch-json.js";
import { createTvmazeMetadata } from "../src/node.js";

// The TVmaze plugin against a fake TVmaze: no network.
const SHOW = { id: 3136, name: "Nathan for You", premiered: "2013-02-28", url: "https://www.tvmaze.com/shows/3136/nathan-for-you", summary: "<p>A business advisor.</p>", genres: ["Comedy"], image: { medium: "https://static.tvmaze.com/show.jpg" }, externals: { imdb: "tt2297757", thetvdb: 264674 } };
const EPISODE = { name: "Private Investigator / Taxi Company", runtime: 22, airdate: "2013-04-16", summary: "<p>Nathan challenges a private investigator.</p>", image: { medium: "https://static.tvmaze.com/still.jpg" } };
function fakeFetch(seen = []) {
  return async (url) => {
    const { pathname, searchParams } = new URL(url);
    seen.push(`${pathname}?${searchParams}`);
    if (pathname === "/shows/3136") return Response.json({ ...SHOW, _embedded: { cast: [{ person: { name: "Nathan Fielder", image: { medium: "https://static.tvmaze.com/nathan.jpg" } }, character: { name: "Himself" } }] } });
    if (pathname === "/shows/3136/episodebynumber") return searchParams.get("number") === "8" ? Response.json(EPISODE) : new Response("", { status: 404 });
    if (pathname === "/search/shows") return Response.json(searchParams.get("q") === "Nathan For You" ? [{ score: 0.9, show: SHOW }] : []);
    return new Response("", { status: 404 });
  };
}
const hints = (titles, season, episode) => ({ titles, season, episode, part: null, year: null, kind: "episode", agree: [], tags: [] });

test("an id from an earlier plugin finds the episode for certain; a missing episode or a long copy does not", async () => {
  const tvmaze = createTvmazeMetadata({ fetch: fakeFetch() });
  const [found] = await tvmaze.identify({ duration: 1290, ids: { tvmaze: "3136" }, hints: hints(["救援高手"], 1, 8) });
  assert.deepEqual([found.id, found.season, found.episode, found.episodeTitle, found.confidence], ["3136", 1, 8, "Private Investigator / Taxi Company", 1]);
  assert.equal((await tvmaze.identify({ duration: 1290, ids: { tvmaze: "3136" }, hints: hints([], 1, 30) }))[0].confidence, 0.3);
  assert.equal((await tvmaze.identify({ duration: 5400, ids: { tvmaze: "3136" }, hints: hints([], 1, 8) }))[0].confidence, 0.6);
  assert.deepEqual(await tvmaze.identify({ duration: 6000, ids: {}, hints: { ...hints(["Inception"], null, null), kind: "movie" } }), []);
});

test("by name the show is searched, and the episode's record has its still, synopsis, cast photos, and notice", async () => {
  const tvmaze = createTvmazeMetadata({ fetch: fakeFetch() });
  const [found] = await tvmaze.identify({ duration: 1290, ids: {}, hints: hints(["Nathan For You"], 1, 8) });
  assert.equal(found.confidence, 0.95);
  const details = await tvmaze.lookup(found);
  assert.equal(details.title, "Private Investigator / Taxi Company");
  assert.equal(details.description, "Nathan challenges a private investigator.");
  assert.equal(details.still, "https://static.tvmaze.com/still.jpg");
  assert.deepEqual(details.people, [{ name: "Nathan Fielder", role: "cast", character: "Himself", photo: "https://static.tvmaze.com/nathan.jpg" }]);
  assert.deepEqual(details.ids, { tvmaze: "3136", imdb: "tt2297757", tvdb: "264674" });
  assert.match(details.attribution.text, /CC BY-SA/);
});

test("an episode's own TheTVDB number is not read as a show's; a show's that agrees with the name is", async () => {
  // TheTVDB numbers episodes and shows apart: episode 4552917 is also some show's number.
  const other = { id: 99, name: "Another Show", premiered: "2001-01-01", externals: {} };
  const seen = [];
  const base = fakeFetch(seen);
  const fetch = async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname !== "/lookup/shows") return base(url);
    seen.push(`${pathname}?${searchParams}`);
    if (searchParams.get("thetvdb") === "4552917") return Response.json(other);
    if (searchParams.get("thetvdb") === "264674") return Response.json(SHOW);
    return new Response("", { status: 404 });
  };
  const tvmaze = createTvmazeMetadata({ fetch });
  const episode = { duration: 1290, kind: "episode", series: { title: "Nathan For You" }, hints: hints(["Nathan For You"], 1, 8) };
  const [byName] = await tvmaze.identify({ ...episode, ids: { imdb: "tt2779644", tvdb: "4552917" } });
  assert.deepEqual([byName.id, byName.confidence], ["3136", 0.95], "the name search, not the other show");
  const [byId] = await tvmaze.identify({ ...episode, ids: { tvdb: "264674" } });
  assert.deepEqual([byId.id, byId.confidence], ["3136", 1]);
});

test("a 404 is kept for six hours, an answer for thirty days, and an expired file is deleted", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yolo-json-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let time = 0;
  let asked = 0;
  const fetch = async (url) => (asked += 1, url.endsWith("/found") ? Response.json({ id: 1 }) : new Response("", { status: 404 }));
  const client = () => createJsonClient({ name: "Fake", fetch, cacheDir: dir, now: () => time });
  assert.equal(await client()("https://example.test/missing"), null);
  assert.deepEqual(await client()("https://example.test/found"), { id: 1 });
  time = 5 * 3_600_000;
  await client()("https://example.test/missing");
  assert.equal(asked, 2, "both come from the disk");
  time = 7 * 3_600_000;
  await client()("https://example.test/found");
  assert.equal(asked, 2);
  const offline = createJsonClient({ name: "Fake", fetch: async () => { throw new Error("offline"); }, cacheDir: dir, now: () => time });
  await assert.rejects(offline("https://example.test/missing"), /offline/);
  assert.equal(readdirSync(dir).length, 1, "the expired 404's file is gone");

  // A 404 that an earlier release wrote to last thirty days is asked again.
  assert.equal(await client()("https://example.test/missing"), null);
  const kept = readdirSync(dir).map((name) => join(dir, name)).find((path) => JSON.parse(readFileSync(path, "utf8")).value === null);
  writeFileSync(kept, JSON.stringify({ expires: time + 30 * 86_400_000, value: null }));
  assert.equal(await client()("https://example.test/missing"), null);
  assert.equal(asked, 4);
});
