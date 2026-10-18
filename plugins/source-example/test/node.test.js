import assert from "node:assert/strict";
import { test } from "node:test";
import register, { createExampleSource, SOURCE_ID } from "../src/node.js";

// How to test a source plugin: register it against a stand-in of the node's
// plugin API, then call the source as the node does. A source plays by
// returning an Input from prepare() (Agent Note 2026-10-11-node-media-pipeline).

const items = [
  { id: "trailer", title: "Big Buck Bunny trailer", url: "https://media.example/trailer.mp4", duration: 33, thumbnail: null },
  { id: "live", title: "A live channel", url: "https://media.example/live/index.m3u8", duration: null, thumbnail: null },
];

test("the plugin registers its source, which lists, claims, and prepares its items", async () => {
  const sources = {};
  register({ options: { title: "Trailers", items }, log: { info() {}, warn() {}, error() {}, debug() {} }, registerSource: (id, impl) => (sources[id] = impl), on: () => () => {} });
  assert.deepEqual(Object.keys(sources), [SOURCE_ID]);
  assert.throws(() => register({ options: { items: [{ id: "x", url: "file:///etc/passwd" }] }, log: console, registerSource() {}, on() {} }), /http\(s\) URL/);

  const source = createExampleSource(items, { title: "Trailers" });
  assert.deepEqual(await source.libraries(), [{ id: "links", title: "Trailers", type: "movie" }]);
  assert.deepEqual((await source.search("bunny")).map((item) => item.id), ["trailer"]);
  assert.deepEqual(source.claim("https://media.example/trailer.mp4"), { id: "trailer" });
  assert.equal(source.claim("https://elsewhere.example/video"), undefined);
  const file = await source.prepare({ plugin: SOURCE_ID, id: "trailer" }, { startTime: null });
  assert.deepEqual([file.input, file.startTime], [{ type: "file", url: "https://media.example/trailer.mp4" }, 0]);
  const hls = await source.prepare({ plugin: SOURCE_ID, id: "live" }, { startTime: 12 });
  assert.deepEqual([hls.input, hls.startTime], [{ type: "hls", url: "https://media.example/live/index.m3u8" }, 12]);
  await assert.rejects(source.describe({ plugin: SOURCE_ID, id: "missing" }), { code: "not_found" });
});
