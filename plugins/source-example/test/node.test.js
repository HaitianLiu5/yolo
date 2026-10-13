import assert from "node:assert/strict";
import { test } from "node:test";
import register, { createExampleSource, SOURCE_ID } from "../src/node.js";

const items = [
  { id: "trailer", title: "Big Buck Bunny trailer", url: "https://media.example/trailer.mp4", duration: 33, thumbnail: null },
  { id: "live", title: "A live channel", url: "https://media.example/live/index.m3u8", duration: null, thumbnail: null },
];

// The node API a plugin sees, reduced to what this plugin uses.
function fakeYolo(options) {
  const sources = {};
  return {
    sources,
    options,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    registerSource: (id, impl) => { sources[id] = impl; },
    on: () => () => {},
  };
}

test("the plugin registers one source from its options", () => {
  const yolo = fakeYolo({ title: "Trailers", items });
  register(yolo);
  assert.deepEqual(Object.keys(yolo.sources), [SOURCE_ID]);
  assert.throws(() => register(fakeYolo({ items: [{ id: "x", url: "file:///etc/passwd" }] })), /http\(s\) URL/);
});

test("the library lists, pages, and searches the items", async () => {
  const source = createExampleSource(items, { title: "Trailers" });
  assert.deepEqual(await source.libraries(), [{ id: "links", title: "Trailers", type: "movie" }]);
  const page = await source.items("links", { offset: 1, limit: 1 });
  assert.equal(page.total, 2);
  assert.deepEqual(page.items.map((item) => item.id), ["live"]);
  assert.deepEqual((await source.search("bunny")).map((item) => item.id), ["trailer"]);
  await assert.rejects(source.items("other"), { code: "not_found" });
});

test("a listed URL is claimed, and prepare returns the Input the node serves", async () => {
  const source = createExampleSource(items);
  assert.deepEqual(source.claim("https://media.example/trailer.mp4"), { id: "trailer" });
  assert.equal(source.claim("https://elsewhere.example/video"), undefined);
  const file = await source.prepare({ plugin: SOURCE_ID, id: "trailer" }, { startTime: null });
  assert.deepEqual(file.input, { type: "file", url: "https://media.example/trailer.mp4" });
  assert.equal(file.startTime, 0);
  const hls = await source.prepare({ plugin: SOURCE_ID, id: "live" }, { startTime: 12 });
  assert.deepEqual(hls.input, { type: "hls", url: "https://media.example/live/index.m3u8" });
  assert.equal(hls.startTime, 12);
  await assert.rejects(source.describe({ plugin: SOURCE_ID, id: "missing" }), { code: "not_found" });
});
