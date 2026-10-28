import assert from "node:assert/strict";
import { test } from "node:test";
import { createTmdbMetadata } from "../src/node.js";
import { API, ATTRIBUTION } from "../src/tmdb.js";

// The TMDB plugin against a fake TMDB: it confirms what the model or the
// parser said and describes the work. No network.

const NATHAN = { id: 53347, name: "Nathan For You", original_name: "Nathan For You", first_air_date: "2013-02-28", poster_path: "/show.jpg", backdrop_path: "/back.jpg", overview: "A comedian helps businesses." };
const routes = {
  "/search/tv": ({ query }) => ({
    results: fold(query) === "nathanforyou" ? [NATHAN]
      : fold(query) === "twin" ? [{ id: 1, name: "Twin", first_air_date: "1990-04-08" }, { id: 2, name: "Twin", first_air_date: "2019-10-01" }]
        : [],
  }),
  "/tv/53347/season/1": () => ({ episodes: [{ episode_number: 7, name: "Episode 7", runtime: 22 }, { episode_number: 8, name: "Private Investigator / Taxi Company", runtime: 22 }] }),
  "/tv/1/season/1": () => ({ episodes: [{ episode_number: 2, runtime: 48 }] }),
  "/tv/2/season/1": () => ({ episodes: [{ episode_number: 2, runtime: 45 }] }),
  "/tv/53347": () => ({ ...NATHAN, genres: [{ name: "Comedy" }], external_ids: { imdb_id: "tt2297757" }, aggregate_credits: { cast: [{ name: "Nathan Fielder", profile_path: "/nathan.jpg", roles: [{ character: "Himself" }] }] } }),
  "/tv/53347/season/1/episode/8": () => ({ name: "Private Investigator / Taxi Company", overview: "Nathan helps a private investigator.", air_date: "2013-04-16", still_path: "/still.jpg", vote_average: 8.2, credits: { guest_stars: [] } }),
  "/find/tt2297757": () => ({ tv_episode_results: [{ show_id: 53347, name: "Private Investigator / Taxi Company", season_number: 1, episode_number: 8 }] }),
};
const fold = (text) => String(text).toLowerCase().replace(/\s+/g, "");

function fakeTmdb(seen = []) {
  return async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    seen.push({ path: pathname.replace("/3", ""), query: Object.fromEntries(searchParams), init });
    const route = routes[pathname.replace("/3", "")];
    return route ? Response.json(route(Object.fromEntries(searchParams))) : new Response("{}", { status: 404 });
  };
}

const hints = (titles, season, episode) => ({ titles, season, episode, part: null, year: null, kind: "episode", agree: [], tags: [] });
const subject = (extra = {}) => ({ sourceKey: "web:BV1-8", duration: 1320, ids: {}, hints: hints(["Nathan For You", "救援高手"], 1, 8), identity: null, ...extra });
const identity = (show, season, episode, year = null) => ({ kind: "episode", show: { title: show, originalTitle: show, year }, title: null, season, episode, episodeTitle: null, confidence: 0.97, reason: "" });

test("the model's show, season, and episode are confirmed against the season's episodes and the runtime", async () => {
  const seen = [];
  const tmdb = createTmdbMetadata({ key: "0123456789abcdef0123456789abcdef", fetch: fakeTmdb(seen) });
  const [best] = await tmdb.identify(subject({ identity: identity("Nathan for You", 1, 8, 2013) }), { language: "en" });
  assert.deepEqual(best, { id: "tv/53347", kind: "episode", title: "Nathan For You", year: 2013, season: 1, episode: 8, episodeTitle: "Private Investigator / Taxi Company", confidence: 0.96, ids: { tmdb: "tv/53347" } });
  assert.equal(seen[0].query.api_key, "0123456789abcdef0123456789abcdef");
  assert.equal(seen[0].query.query, "Nathan for You");

  // An episode the season does not have, or a copy far longer than it, is no match.
  const [missing] = await tmdb.identify(subject({ identity: identity("Nathan for You", 1, 30) }), { language: "en" });
  assert.ok(missing.confidence < 0.85);
  const [long] = await tmdb.identify(subject({ duration: 5400, identity: identity("Nathan for You", 1, 8) }), { language: "en" });
  assert.ok(long.confidence < 0.85);
});

test("without a model the parser's names find the same record; two shows of one name stay close", async () => {
  const tmdb = createTmdbMetadata({ key: "k", fetch: fakeTmdb() });
  assert.equal((await tmdb.identify(subject(), { language: "en" }))[0].confidence, 0.95);
  const twins = await tmdb.identify(subject({ duration: 2800, hints: hints(["Twin"], 1, 2) }), { language: "en" });
  assert.equal(twins.length, 2);
  assert.ok(twins[0].confidence - twins[1].confidence < 0.15, "for the owner to choose");
});

test("an external id needs no search, and a v4 token goes in a header", async () => {
  const seen = [];
  const tmdb = createTmdbMetadata({ key: "eyJhbGciOi.payload.signature", fetch: fakeTmdb(seen) });
  const [found] = await tmdb.identify(subject({ ids: { imdb: "tt2297757" } }), { language: "en" });
  assert.deepEqual([found.id, found.season, found.episode, found.confidence], ["tv/53347", 1, 8, 1]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.headers.authorization, "Bearer eyJhbGciOi.payload.signature");
  assert.equal(seen[0].query.api_key, undefined);
});

test("an episode's record has the show around it, sized pictures, cast photos, and TMDB's notice", async () => {
  const tmdb = createTmdbMetadata({ key: "k", fetch: fakeTmdb(), language: "zh-CN" });
  const details = await tmdb.lookup({ id: "tv/53347", kind: "episode", season: 1, episode: 8 }, { language: "en" });
  assert.equal(details.kind, "episode");
  assert.equal(details.title, "Private Investigator / Taxi Company");
  assert.deepEqual(details.series, { title: "Nathan For You", season: 1, episode: 8, episodeTitle: "Private Investigator / Taxi Company" });
  assert.equal(details.show.poster, "https://image.tmdb.org/t/p/w342/show.jpg");
  assert.equal(details.still, "https://image.tmdb.org/t/p/w300/still.jpg");
  assert.deepEqual(details.people[0], { name: "Nathan Fielder", role: "cast", character: "Himself", photo: "https://image.tmdb.org/t/p/w185/nathan.jpg" });
  assert.deepEqual(details.ids, { tmdb: "tv/53347", imdb: "tt2297757" });
  assert.deepEqual(details.attribution, ATTRIBUTION);
});

test("without a key the plugin does nothing and says how to get one", async () => {
  const tmdb = createTmdbMetadata({ key: null, fetch: async () => assert.fail(`fetched ${API}`) });
  assert.deepEqual(await tmdb.identify(subject(), { language: "en" }), []);
  assert.equal(tmdb.health().configured, false);
  assert.match(tmdb.health().reason, /themoviedb\.org/);
});
