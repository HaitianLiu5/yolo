import assert from "node:assert/strict";
import { test } from "node:test";
import { YoloError } from "@useyolo/core";
import { createSourceRegistry } from "../src/sources.js";

// What every source's run looks like to the control plane (Agent Note
// 2026-10-23-up-next): from the item asked about on, sources and artwork
// presented as for any library item.

test("a run starts at the item asked about, at most 50 ahead, and a source without one says none", async () => {
  const sources = createSourceRegistry();
  const episodes = Array.from({ length: 60 }, (_, n) => ({ source: { id: String(n) }, title: `E${n}`, label: ` S1 · E${n} `, artwork: "landscape", duration: 1200 }));
  sources.add("shows", { sequence: async ({ id }) => ({ title: "Show", index: Number(id), items: episodes }) }, "shows");
  sources.add("clips", {}, "clips");

  const run = await sources.sequence({ plugin: "shows", id: "3" });
  assert.equal(run.title, "Show");
  assert.equal(run.items.length, 51);
  assert.deepEqual(run.items[0].source, { plugin: "shows", id: "3" });
  assert.deepEqual(run.items[1], { source: { plugin: "shows", id: "4" }, title: "E4", label: "S1 · E4", thumbnail: "/v1/library/items/shows%3A4/artwork?variant=landscape", duration: 1200 });
  assert.equal((await sources.sequence({ plugin: "shows", id: "59" })).items.length, 1);
  assert.equal(await sources.sequence({ plugin: "clips", id: "x" }), null);
});

test("a run that does not hold the item is none", async () => {
  const sources = createSourceRegistry();
  sources.add("shows", { sequence: async () => ({ items: [{ source: { id: "1" } }], index: 4 }) }, "shows");
  assert.equal(await sources.sequence({ plugin: "shows", id: "1" }), null);
});

// The show and season an item belongs to reach the control plane as source
// keys (Agent Note 2026-10-11-yolo-owns-progress-and-resume).
test("an item's parents are source keys, at most two, in listings and when it plays", async () => {
  const sources = createSourceRegistry();
  const episode = { id: "7", kind: "episode", title: "E7", parents: ["100", "101", "102"] };
  sources.add("shows", {
    children: async () => ({ parent: { id: "100", kind: "show", title: "Show" }, items: [episode, { id: "8", kind: "episode", title: "E8", parents: "100" }] }),
    prepare: async () => ({ input: { type: "file", url: "http://media.test/7.mp4" }, parents: ["100", "", 101] }),
  }, "shows");
  const { parent, items } = await sources.children("shows:100");
  assert.equal(parent.parents, undefined);
  assert.deepEqual(items.map((item) => item.parents), [["shows:100", "shows:101"], undefined]);
  assert.deepEqual((await sources.prepare({ plugin: "shows", id: "7" }, {})).parents, ["shows:100"]);
});

// A source that knows which items there are hands playing them to the source
// that plays their pages (Agent Note 2026-11-06-event-libraries).
test("a delegated item plays through the source that claims its URL, under its own id, name, and parents", async () => {
  const sources = createSourceRegistry();
  const asked = [];
  sources.add("games", {
    claim: () => ({ id: "ignored" }),
    delegate: async ({ id }) => (id === "own" ? null : { url: "https://page.test/1", title: "A vs B", artwork: "landscape", parents: ["g1"] }),
    prepare: async () => ({ input: { type: "file", url: "http://media.test/own.mp4" }, title: "Own" }),
    chapters: async () => [{ start: 5, title: "Its own" }],
  }, "games");
  sources.add("links", {
    claim: (url) => ({ id: "link", url }),
    prepare: async (source, context) => {
      asked.push(["prepare", source, context.startTime]);
      return { input: { type: "hls", url: "http://media.test/1.m3u8" }, title: "The page's title", thumbnail: "https://pic.test/1.jpg", isLive: true, duration: 90 };
    },
    warm: async (source) => asked.push(["warm", source]),
    tracks: async () => ({ subtitles: [{ id: "s1" }], audio: [] }),
    subtitle: async (source, track) => `WEBVTT ${source.id} ${track}`,
    chapters: async () => [{ start: 1, title: "The page's" }],
    storyboard: async () => ({ sheets: [] }),
    comments: async () => ({ comments: [], start: 0, end: null }),
  }, "links");
  const game = { plugin: "games", id: "g1" };

  const prepared = await sources.prepare(game, { startTime: 12 });
  assert.deepEqual(asked.shift(), ["prepare", { plugin: "links", id: "link", url: "https://page.test/1" }, 12]);
  assert.equal(prepared.title, "A vs B");
  assert.deepEqual(prepared.parents, ["games:g1"]);
  assert.equal(prepared.thumbnail, "/v1/library/items/games%3Ag1/artwork?variant=landscape", "the item's picture, under its own id");
  assert.deepEqual([prepared.isLive, prepared.duration, prepared.input.type], [true, 90, "hls"]);

  assert.equal(sources.canWarm(game), true);
  await sources.warm(game, {});
  assert.deepEqual(asked.shift(), ["warm", { plugin: "links", id: "link", url: "https://page.test/1" }]);

  // What it does not implement comes from the source that plays it; what it does stays its own.
  assert.deepEqual((await sources.tracks(game)).subtitles, [{ id: "s1" }]);
  assert.equal(await sources.subtitle(game, "s1"), "WEBVTT link s1");
  assert.deepEqual((await sources.chapters(game)).chapters.map((chapter) => chapter.title), ["Its own"]);
  assert.deepEqual(await sources.storyboard(game), { sheets: [] });
  assert.equal(sources.hasComments(game), true);
  assert.deepEqual((await sources.comments(game, {})).comments, []);

  // Null plays it with its own prepare.
  assert.equal((await sources.prepare({ plugin: "games", id: "own" }, {})).title, "Own");
});

test("a delegated item no other source claims does not play, and a source's refusal stands", async () => {
  const sources = createSourceRegistry();
  sources.add("games", {
    claim: () => ({ id: "x" }),
    delegate: async ({ id }) => {
      if (id === "soon") throw new YoloError("resolve_failed", "This game has not started yet", { retryable: false });
      return { url: id === "bad" ? "not a url" : "https://page.test/1" };
    },
  }, "games");
  await assert.rejects(sources.prepare({ plugin: "games", id: "g1" }, {}), { code: "resolve_failed", message: /No other source/ });
  await assert.rejects(sources.prepare({ plugin: "games", id: "soon" }, {}), { message: /has not started/ });
  await assert.rejects(sources.prepare({ plugin: "games", id: "bad" }, {}), { code: "internal" });
  assert.deepEqual(await sources.tracks({ plugin: "games", id: "g1" }).catch((error) => error.code), "resolve_failed");
});
