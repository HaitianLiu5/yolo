import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestControlPlane } from "../helpers/setup.js";

test("play requires exactly one reference and rejects guessed ids", async () => {
  const plane = createTestControlPlane();
  await assert.rejects(plane.services.play({}), { code: "invalid_request" });
  await assert.rejects(plane.services.play({ url: "https://a.test", itemId: "library:1" }), { code: "invalid_request" });
  await assert.rejects(plane.services.play({ itemId: "The Matrix" }), /search or browse/);
});

test("search resolves URLs through node metadata", async () => {
  const plane = createTestControlPlane();
  const { results } = await plane.services.search({ query: "https://video.test/abc" });
  assert.equal(results[0].kind, "url");
  assert.equal(results[0].title, "A video");
  assert.deepEqual(results[0].source, { plugin: "web", id: "https://video.test/abc", url: "https://video.test/abc" });
  const library = await plane.services.search({ query: "Alien", type: "movie" });
  assert.equal(library.results[0].id, "library:42");
  assert.deepEqual(plane.node.calls.at(-1).query, { q: "Alien", type: "movie", limit: 20 });
});

test("playlist import creates a playlist and can enqueue it", async () => {
  const plane = createTestControlPlane();
  plane.node.routes["POST /internal/v1/playlists/expand"] = () => ({
    title: "Mix",
    items: [
      { source: { plugin: "web", id: "https://example.com/1" }, title: "One", duration: 60 },
      { source: { plugin: "web", id: "https://example.com/2" }, title: "Two", duration: 60 },
    ],
  });
  const result = await plane.services.importPlaylist({ url: "https://example.com/list", enqueue: true });
  assert.equal(result.playlist.name, "Mix");
  assert.equal(result.imported, 2);
  assert.equal(result.queued, 2);
  const enqueued = await plane.services.enqueuePlaylist(result.playlist.id, { position: "next" });
  assert.equal(enqueued.added, 2);
  assert.deepEqual(enqueued.queue.map((item) => item.title), ["One", "Two", "One", "Two"]);
});
