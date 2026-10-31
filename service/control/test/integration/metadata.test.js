import assert from "node:assert/strict";
import { test } from "node:test";
import { createV1App } from "../../src/api/v1.js";
import { createImageLinks } from "../../src/image-links.js";
import { createServices } from "../../src/services.js";
import { createDefaultNode, createTestControlPlane, USER } from "../helpers/fakes.js";

// An item's details with the work it was matched to, and the owner's
// corrections (Agent Note 2026-10-25-metadata-plugins), over the real
// service layer and D1 schema, with a fake node.

const CANDIDATES = [
  { plugin: "db", id: "tv/2", kind: "show", title: "Twin", year: 1990, confidence: 0.9 },
  { plugin: "db", id: "tv/3", kind: "show", title: "Twin", year: 2019, confidence: 0.88 },
];

function metadataNode() {
  const node = createDefaultNode();
  node.routes["GET /internal/v1/details"] = ({ match }) => {
    const chosen = match ? JSON.parse(match) : null;
    if (chosen?.none) return { kind: "video", title: "Twin S01E02", metadata: { origin: "owner" } };
    if (chosen) return { kind: "episode", title: `Twin S1E2 — ${chosen.candidate.year}`, poster: "https://img.example/twin.jpg", metadata: { plugin: chosen.plugin, id: chosen.candidate.id, origin: "owner" } };
    return { kind: "video", title: "Twin S01E02", metadata: { origin: "auto", candidates: CANDIDATES } };
  };
  node.routes["GET /internal/v1/tracks"] = () => ({ subtitles: [], audio: [] });
  node.routes["GET /internal/v1/metadata/search"] = ({ q }) => ({ results: q === "Twin" ? CANDIDATES : [] });
  return node;
}

test("a screen reads an item's details, and the owner's match is passed to the node and kept in D1", async () => {
  const plane = createTestControlPlane({ node: metadataNode() });
  const app = createV1App({ getContext: () => ({ services: plane.services, scopes: ["read"], userId: USER }) });

  const details = await (await app.request("/v1/library/items/library%3A1")).json();
  assert.equal(details.id, "library:1");
  assert.deepEqual(details.metadata.candidates.map(({ year }) => year), [1990, 2019]);

  const found = await plane.services.searchMetadata({ query: "Twin", kind: "show" });
  const matched = await plane.services.matchItem({ itemId: "library:1", candidate: found.results[1] });
  assert.equal(matched.title, "Twin S1E2 — 2019");
  const sent = plane.node.calls.filter((call) => call.path === "/internal/v1/details").at(-1);
  assert.deepEqual(JSON.parse(sent.query.match), { plugin: "db", candidate: { id: "tv/3", kind: "show", title: "Twin", year: 2019, confidence: 0.88 } });

  // The choice is the owner's: a new service layer over the same D1 reads it.
  const again = createServices({ db: plane.db, userId: USER, hub: plane.hub, node: plane.node, log: () => {} });
  assert.equal((await again.item({ itemId: "library:1" })).title, "Twin S1E2 — 2019");
  assert.deepEqual((await again.matchItem({ itemId: "library:1", none: true })).metadata, { origin: "owner" });
  assert.deepEqual((await again.matchItem({ itemId: "library:1", clear: true })).metadata.candidates.length, 2);
  await assert.rejects(again.matchItem({ itemId: "library:1" }), (error) => error.code === "invalid_request");
  await assert.rejects(again.matchItem({ itemId: "library:1", candidate: { id: "tv/3" } }), (error) => error.code === "invalid_request");
});

test("MCP results carry every picture of a matched work as an image link", async () => {
  const links = createImageLinks({ secret: "s".repeat(32), origin: "https://yolo.example", userId: USER, version: async () => 1 });
  const shown = await links.present({
    thumbnail: "https://img.example/thumb.jpg",
    poster: "https://img.example/poster.jpg",
    show: { poster: "/v1/library/items/library%3A1/artwork?variant=m-local-poster" },
    people: [{ name: "Nathan Fielder", photo: "https://img.example/nathan.jpg" }, { name: "No photo" }],
    upload: { url: "https://www.bilibili.com/video/BV1" },
  });
  for (const value of [shown.thumbnail, shown.poster, shown.show.poster, shown.people[0].photo]) assert.match(value, /^https:\/\/yolo\.example\/i\//);
  assert.equal(shown.people[1].photo, undefined);
  assert.equal(shown.upload.url, "https://www.bilibili.com/video/BV1", "a page's address is no picture");
});
