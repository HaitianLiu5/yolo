import assert from "node:assert/strict";
import { test } from "node:test";
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
