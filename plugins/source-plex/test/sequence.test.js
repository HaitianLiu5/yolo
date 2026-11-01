import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlex, itemFromMetadata } from "../src/plex.js";

// What plays after an episode (Agent Note 2026-10-23-up-next): its show's
// episodes in order, across seasons, from one listing.

const SHOW = [
  { ratingKey: "201", type: "episode", grandparentTitle: "Nathan For You", parentIndex: 1, index: 8, title: "Finale", duration: 1_320_000 },
  { ratingKey: "301", type: "episode", grandparentTitle: "Nathan For You", parentIndex: 2, index: 1, title: "Mechanic", duration: 1_260_000 },
  { ratingKey: "302", type: "episode", grandparentTitle: "Nathan For You", parentIndex: 2, index: 2, title: "Toy Company", duration: 1_290_000 },
];

function fakePlex() {
  const paths = [];
  const fetchImpl = async (url) => {
    const { pathname } = new URL(url);
    paths.push(pathname);
    if (pathname === "/library/metadata/100/allLeaves") return Response.json({ MediaContainer: { Metadata: SHOW } });
    const key = /^\/library\/metadata\/(\d+)$/.exec(pathname)?.[1];
    const item = key === "900"
      ? { ratingKey: "900", type: "movie", title: "Film" }
      : { ...SHOW.find((episode) => episode.ratingKey === key), grandparentRatingKey: "100" };
    return Response.json({ MediaContainer: { Metadata: [item] } });
  };
  return { paths, plex: createPlex({ url: "http://plex.test:32400", token: "t0k", fetchImpl }) };
}

test("an episode's run is its show's episodes across seasons; a movie is in none", async () => {
  const { paths, plex } = fakePlex();
  const run = await plex.sequence("201");
  assert.equal(run.title, "Nathan For You");
  assert.equal(run.index, 0);
  assert.deepEqual(run.items[1], { source: { id: "301" }, title: "Nathan For You S2E1 — Mechanic", artwork: "landscape", duration: 1260, label: "S2 · E1" });
  assert.deepEqual(paths, ["/library/metadata/201", "/library/metadata/100/allLeaves"]);

  assert.equal((await plex.sequence("302")).index, 2);
  assert.equal(await plex.sequence("900"), null);
});

// Yolo counts a show's and a season's episodes watched in Yolo by the
// parents an episode names (Agent Note 2026-10-11-yolo-owns-progress-and-resume).
test("an episode names its show and season, a season its show, and a movie none", () => {
  assert.deepEqual(itemFromMetadata({ ...SHOW[0], grandparentRatingKey: 100, parentRatingKey: 110 }).parents, ["100", "110"]);
  assert.deepEqual(itemFromMetadata({ ratingKey: "110", type: "season", title: "Season 1", parentRatingKey: "100", leafCount: 8, viewedLeafCount: 2 }).parents, ["100"]);
  assert.equal(itemFromMetadata({ ratingKey: "900", type: "movie", title: "Film" }).parents, undefined);
});
