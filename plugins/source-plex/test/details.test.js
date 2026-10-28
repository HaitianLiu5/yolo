import assert from "node:assert/strict";
import { test } from "node:test";
import { detailsFromMetadata } from "../src/plex.js";

// What Plex gives metadata plugins (Agent Note 2026-10-25-metadata-plugins):
// its guids as external ids, and its cast's photos.
test("an item's details carry Plex's external ids and its cast's photos", () => {
  const details = detailsFromMetadata({
    type: "episode", title: "Private Investigator", grandparentTitle: "Nathan For You", parentIndex: 1, index: 8,
    Guid: [{ id: "imdb://tt2297757" }, { id: "tvdb://4567" }, { id: "plex://episode/abc" }],
    Role: [{ tag: "Nathan Fielder", role: "Himself", thumb: "https://metadata-static.plex.tv/people/nathan.jpg" }, { tag: "Someone", thumb: "/library/people/1" }],
  });
  assert.deepEqual(details.ids, { imdb: "tt2297757", tvdb: "4567" });
  assert.deepEqual(details.people.slice(0, 2), [
    { name: "Nathan Fielder", role: "cast", character: "Himself", photo: "https://metadata-static.plex.tv/people/nathan.jpg" },
    { name: "Someone", role: "cast", character: null },
  ]);
});
