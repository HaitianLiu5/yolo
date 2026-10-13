import assert from "node:assert/strict";
import { test } from "node:test";
import plexPlugin, { SOURCE_ID } from "../src/node.js";
import { createPlex, itemFromMetadata, tracksFromPart } from "../src/plex.js";

// Just enough of the node's plugin API to run the factory and its handlers.
function fakeYolo({ options = {}, env = {} } = {}) {
  const sources = new Map();
  const handlers = { start: [], shutdown: [] };
  const warnings = [];
  const yolo = {
    plugin: { name: "@useyolo/source-plex", version: "0.2.0" },
    options,
    env,
    log: { debug() {}, info() {}, warn: (...args) => warnings.push(args.join(" ")), error() {} },
    registerSource: (id, impl) => sources.set(id, impl),
    on: (event, handler) => handlers[event].push(handler),
  };
  return {
    yolo,
    sources,
    warnings,
    start: async () => {
      for (const handler of handlers.start) await handler();
    },
  };
}

function fakePlex(routes) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const { pathname, search } = new URL(url);
    seen.push({ path: pathname + search, token: init.headers["x-plex-token"] });
    const route = routes[pathname];
    return route ? Response.json(route) : new Response("", { status: 404 });
  };
  return { seen, plex: createPlex({ url: "http://plex.test:32400", token: "t0k", fetchImpl }) };
}

test("Plex metadata maps to library items with local ids and artwork variants", () => {
  const episode = itemFromMetadata({ ratingKey: "7", type: "episode", grandparentTitle: "Show", parentIndex: 1, index: 2, title: "Pilot", duration: 1_800_000, viewOffset: 60_000 });
  assert.equal(episode.id, "7");
  assert.equal(episode.title, "Show S1E2 — Pilot");
  assert.equal(episode.duration, 1800);
  assert.equal(episode.resumeAt, 60);
  assert.equal(episode.artwork, "landscape");
  assert.deepEqual([episode.season, episode.episode], [1, 2]);
  const show = itemFromMetadata({ ratingKey: 8, type: "show", title: "Show", leafCount: 10, viewedLeafCount: 3 });
  assert.deepEqual([show.id, show.artwork, show.episodes, show.watchedEpisodes], ["8", "poster", 10, 3]);
});

test("Plex streams map to subtitle and audio tracks", () => {
  const tracks = tracksFromPart({ Stream: [
    { id: 1, streamType: 2, language: "English", languageCode: "eng", displayTitle: "English (AAC)", selected: true },
    { id: 2, streamType: 3, codec: "srt", languageCode: "chi", displayTitle: "Chinese" },
    { id: 3, streamType: 3, codec: "pgs", languageCode: "eng", displayTitle: "English (PGS)" },
  ] });
  assert.deepEqual(tracks.audio.map((track) => [track.id, track.default]), [["plex:1", true]]);
  assert.deepEqual(tracks.subtitles.map((track) => [track.id, track.format]), [["plex:2", "text"], ["plex:3", "image"]]);
});

test("the client searches, lists, and describes through the Plex API", async () => {
  const { plex, seen } = fakePlex({
    "/hubs/search": { MediaContainer: { Hub: [{ Metadata: [{ ratingKey: "42", type: "movie", title: "Alien", year: 1979 }, { ratingKey: "9", type: "artist", title: "Band" }] }] } },
    "/library/sections": { MediaContainer: { Directory: [{ key: 1, title: "Movies", type: "movie" }] } },
    "/library/metadata/42": { MediaContainer: { Metadata: [{ ratingKey: "42", type: "movie", title: "Alien", duration: 7_020_000, viewOffset: 1_234_000 }] } },
  });
  assert.deepEqual((await plex.search("Alien", { limit: 5 })).map((item) => [item.id, item.title]), [["42", "Alien"]]);
  assert.deepEqual(await plex.libraries(), [{ id: "1", title: "Movies", type: "movie" }]);
  // resumeAt is Plex's own watch position, Yolo's fallback when it has none.
  assert.deepEqual(await plex.describe("42"), { title: "Alien", artwork: "poster", duration: 7020, isLive: false, resumeAt: 1234 });
  assert.ok(seen.every((call) => call.token === "t0k"));
  await assert.rejects(plex.describe("../etc"), { code: "invalid_request" });
});

test("artwork uses the image paths Plex reports, so episodes get a landscape image", async () => {
  // Episodes have no art of their own: Plex reports the show's art for them
  // (e.g. 9914 → /library/metadata/9910/art), so /library/metadata/9914/art
  // does not exist.
  const images = new Set(["/library/metadata/9914/thumb/1", "/library/metadata/9910/art/2", "/library/metadata/42/thumb/3", "/library/metadata/42/art/3"]);
  const requested = [];
  const fetchImpl = async (url) => {
    const { pathname, searchParams } = new URL(url);
    const metadata = {
      "/library/metadata/9914": { ratingKey: "9914", type: "episode", thumb: "/library/metadata/9914/thumb/1", art: "/library/metadata/9910/art/2", grandparentThumb: "/library/metadata/9910/thumb/2" },
      "/library/metadata/42": { ratingKey: "42", type: "movie", thumb: "/library/metadata/42/thumb/3", art: "/library/metadata/42/art/3" },
      "/library/metadata/7": { ratingKey: "7", type: "movie" },
    }[pathname];
    if (metadata) return Response.json({ MediaContainer: { Metadata: [metadata] } });
    if (pathname === "/photo/:/transcode") {
      requested.push(searchParams.get("url"));
      if (images.has(searchParams.get("url"))) return new Response("jpeg", { headers: { "content-type": "image/jpeg" } });
    }
    return new Response("", { status: 404 });
  };
  const plex = createPlex({ url: "http://plex.test:32400", token: "t0k", fetchImpl });
  assert.equal((await plex.artwork("9914", "landscape")).status, 200);
  assert.equal((await plex.artwork("9914", "poster")).status, 200);
  assert.equal((await plex.artwork("42", "landscape")).status, 200);
  assert.equal((await plex.artwork("42", "poster")).status, 200);
  assert.deepEqual(requested, ["/library/metadata/9914/thumb/1", "/library/metadata/9914/thumb/1", "/library/metadata/42/art/3", "/library/metadata/42/thumb/3"]);
  await assert.rejects(plex.artwork("7", "landscape"), { code: "not_found" });
});

test("without a token the library fails clearly and health says why", async () => {
  const host = fakeYolo();
  plexPlugin(host.yolo, { readToken: () => "" });
  await host.start();
  const source = host.sources.get(SOURCE_ID);
  assert.deepEqual(await source.health(), { configured: false });
  await assert.rejects(source.libraries(), { code: "not_found", message: /PLEX_URL, PLEX_TOKEN/ });
  assert.match(host.warnings.join("\n"), /No Plex token/);
});

test("options win over the environment, and the environment over the Plex app's preferences", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push([new URL(url).origin, init.headers["x-plex-token"]]);
    return Response.json({});
  });
  const host = fakeYolo({ options: { url: "http://other.test:32400", token: "opt" }, env: { PLEX_URL: "http://plex.test:32400", PLEX_TOKEN: "env" } });
  plexPlugin(host.yolo, { readToken: () => assert.fail("a configured token is used as is") });
  const source = host.sources.get(SOURCE_ID);
  assert.equal(source.claim, undefined, "Plex claims no URLs, so it never takes one from a later plugin");
  await host.start();
  assert.deepEqual(await source.health(), { configured: true, online: true });
  assert.deepEqual(seen, [["http://other.test:32400", "opt"]]);
  assert.deepEqual(host.warnings, []);

  const fromEnv = fakeYolo({ env: { PLEX_URL: "http://plex.test:32400", PLEX_TOKEN: "env" } });
  plexPlugin(fromEnv.yolo, { readToken: () => assert.fail("PLEX_TOKEN is set") });
  await fromEnv.start();
  await fromEnv.sources.get(SOURCE_ID).health();
  assert.deepEqual(seen.at(-1), ["http://plex.test:32400", "env"]);
});
