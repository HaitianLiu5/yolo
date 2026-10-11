import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import Database from "better-sqlite3";
import { buildImportSql } from "./import-sql.js";
import { preferenceFromDriveIn, thumbnailFromDriveIn } from "./mapping.js";

// The one-time export of Drive-In's data into Yolo's D1 schema.

const plexItem = (id) => ({ plugin: "plex", id });
const webVideo = (url) => ({ plugin: "ytdlp", id: url, url });

const MIGRATIONS_DIR = new URL("../../service/control/migrations/", import.meta.url);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"));

// What the official yt-dlp plugin answers: the canonical URL as the id.
const claim = async (url) => {
  if (url.includes("unclaimable")) throw new Error("No source plugin on the media node handles this URL");
  return webVideo(url.replace("www.", "").replace(/[?&]t=\d+/, ""));
};

test("the generated SQL loads into the D1 schema with plugin sources", async () => {
  const { sql, skipped } = await buildImportSql({
    userId: "usr_owner",
    now: 1_000,
    claim,
    queue: [
      { id: "q_1", source_type: "url", url: "https://youtu.be/abc", title: "It's a video", thumbnail: "/api/thumb?url=https%3A%2F%2Fi.ytimg.com%2Fx.jpg", duration: 60, metadata: "{}", position: 3, added_at: 5 },
      { id: "q_2", source_type: "plex", rating_key: "42", title: "Movie", thumbnail: "/api/plex/thumb?path=x", position: 4, added_at: 6 },
    ],
    playlists: [{ id: "pl_1", name: "Trip", description: null, created_at: 1, updated_at: 2 }],
    playlistItems: [{ id: "pi_1", playlist_id: "pl_1", source_type: "url", url: "https://example.com/a", title: "A", metadata: "{}", added_at: 7 }],
    history: [
      { title: "Movie", plex: { ratingKey: "42" }, progress: 120, duration: 6000, playedAt: 9 },
      { title: "Dup", plex: { ratingKey: "42" }, playedAt: 8 },
      { title: "Zoo", url: "https://www.youtube.com/watch?v=abc&t=3", viewCount: 2, playedAt: 7 },
      { title: "Lost", url: "https://unclaimable.test/v", playedAt: 6 },
      { title: "Broken", url: null },
    ],
    preferences: [
      { source: "default", selection: JSON.stringify([{ id: "en", language: "en", title: "English", delivery: "external" }]) },
      { source: "plex:42", selection: JSON.stringify([]) },
      { source: "https://www.youtube.com/watch?v=abc", selection: JSON.stringify([{ id: "zh", language: "zh" }]) },
      { source: "not a url", selection: "[]" },
    ],
  });
  assert.deepEqual(skipped, ["https://unclaimable.test/v: No source plugin on the media node handles this URL"]);
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  db.exec(sql);
  const queue = db.prepare("SELECT * FROM queue_items ORDER BY position").all();
  assert.deepEqual(queue.map((row) => [row.title, JSON.parse(row.source), row.thumbnail]), [
    ["It's a video", { url: "https://youtu.be/abc" }, "https://i.ytimg.com/x.jpg"],
    ["Movie", plexItem("42"), "/v1/library/items/plex%3A42/artwork?variant=landscape"],
  ]);
  const history = db.prepare("SELECT * FROM history ORDER BY updated_at DESC").all();
  assert.deepEqual(history.map((row) => [row.source_key, row.position, row.play_count]), [
    ["plex:42", 120, 1],
    ["ytdlp:https://youtube.com/watch?v=abc", 0, 2],
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = 'pl_1'").get().n, 1);
  assert.deepEqual(db.prepare("SELECT source_key FROM track_preferences ORDER BY source_key").all().map((row) => row.source_key), [
    "default", "plex:42", "ytdlp:https://youtube.com/watch?v=abc",
  ]);
});

test("Drive-In thumbnails and preferences map to Yolo's", async () => {
  assert.equal(thumbnailFromDriveIn("https://x.test/a.jpg", { url: "https://x.test/v" }), "https://x.test/a.jpg");
  assert.equal(thumbnailFromDriveIn("/weird", { url: "https://x.test/v" }), null);
  const preference = preferenceFromDriveIn({ source: "plex:1", selection: JSON.stringify([{ id: "123", language: "zh", title: "简体", delivery: "burn-in" }]) });
  assert.deepEqual(preference.ref, plexItem("1"));
  assert.deepEqual(preference.selection.subtitles[0], { id: "plex:123", language: "zh", name: "简体", format: "image" });
  assert.equal(preferenceFromDriveIn({ source: "default", selection: "{" }), null);
  await assert.rejects(buildImportSql({ userId: "root'; DROP TABLE users", claim }), /user id/);
});
