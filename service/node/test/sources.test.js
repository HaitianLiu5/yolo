import assert from "node:assert/strict";
import { test } from "node:test";
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
