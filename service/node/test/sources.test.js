import assert from "node:assert/strict";
import { test } from "node:test";
import { createSourceRegistry } from "../src/sources.js";

// What every source's run looks like to the control plane (Agent Note
// 2026-10-23-up-next): from the item asked about on, sources and artwork
// presented as for any library item.

test("a run starts at the item asked about, at most 50 ahead, and a source without one says none", async () => {
  const sources = createSourceRegistry();
  const episodes = Array.from({ length: 60 }, (_, n) => ({ source: { id: String(n) }, title: `E${n}`, artwork: "landscape", duration: 1200 }));
  sources.add("shows", { sequence: async ({ id }) => ({ title: "Show", index: Number(id), items: episodes }) }, "shows");
  sources.add("clips", {}, "clips");

  const run = await sources.sequence({ plugin: "shows", id: "3" });
  assert.equal(run.title, "Show");
  assert.equal(run.items.length, 51);
  assert.deepEqual(run.items[0].source, { plugin: "shows", id: "3" });
  assert.deepEqual(run.items[1], { source: { plugin: "shows", id: "4" }, title: "E4", thumbnail: "/v1/library/items/shows%3A4/artwork?variant=landscape", duration: 1200 });
  assert.equal((await sources.sequence({ plugin: "shows", id: "59" })).items.length, 1);
  assert.equal(await sources.sequence({ plugin: "clips", id: "x" }), null);
});

test("a run that does not hold the item is none", async () => {
  const sources = createSourceRegistry();
  sources.add("shows", { sequence: async () => ({ items: [{ source: { id: "1" } }], index: 4 }) }, "shows");
  assert.equal(await sources.sequence({ plugin: "shows", id: "1" }), null);
});
