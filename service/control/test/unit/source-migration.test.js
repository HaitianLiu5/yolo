import assert from "node:assert/strict";
import { test } from "node:test";
import { listHistory } from "../../src/store/history.js";
import { getPlaylist } from "../../src/store/playlists.js";
import { applyMigration, createTestD1 } from "../helpers/d1.js";
import { createTestControlPlane, onlineScreen, USER } from "../helpers/fakes.js";

// Migration 0003 rewrites rows saved before source plugins, which name the
// kinds that became the Plex and yt-dlp plugins (scripts/provider-names.js allows this file).

const PLEX = JSON.stringify({ kind: "plex", ratingKey: "9896" });
const VIDEO_URL = "https://youtu.be/abc?si=share";
const VIDEO = JSON.stringify({ kind: "url", url: VIDEO_URL });
const CANONICAL = "https://youtube.com/watch?v=abc";

function legacyDatabase() {
  const db = createTestD1({ before: "0003_plugin_sources.sql" });
  const run = (sql, ...params) => db.raw.prepare(sql).run(...params);
  run("INSERT INTO users (id, user_id, display_name, created_at) VALUES (?, ?, 'Owner', 0)", USER, USER);
  run("INSERT INTO playlists (id, user_id, name, created_at, updated_at) VALUES ('pl_1', ?, 'Trip', 0, 0)", USER);
  for (const [n, source] of [[1, PLEX], [2, VIDEO]]) {
    run("INSERT INTO queue_items (id, user_id, source, title, metadata, position, added_at) VALUES (?, ?, ?, 't', '{}', ?, 0)", `itm_${n}`, USER, source, n);
    run("INSERT INTO playlist_items (id, user_id, playlist_id, source, title, metadata, position, added_at) VALUES (?, ?, 'pl_1', ?, 't', '{}', ?, 0)", `pli_${n}`, USER, source, n);
  }
  const history = "INSERT INTO history (user_id, source_key, source, title, position, duration, updated_at) VALUES (?, ?, ?, 't', ?, 7200, ?)";
  run(history, USER, "plex:9896", PLEX, 120, 2);
  run(history, USER, `url:${CANONICAL}`, VIDEO, 300, 1);
  for (const key of ["plex:9896", `url:${CANONICAL}`, "default"]) {
    run("INSERT INTO track_preferences (user_id, source_key, selection, updated_at) VALUES (?, ?, '{\"subtitles\":[],\"audio\":null}', 0)", USER, key);
  }
  return db;
}

test("migration 0003 turns pre-plugin rows into plugin sources and keeps their keys; without it an old row points to it", async () => {
  const unmigrated = createTestControlPlane({ db: legacyDatabase() });
  const car = await onlineScreen(unmigrated);
  await assert.rejects(unmigrated.services.enqueuePlaylist("pl_1", { device: car.id }), /migration 0003/);

  const db = legacyDatabase();
  applyMigration(db.raw, "0003_plugin_sources.sql");
  const converted = [{ plugin: "plex", id: "9896" }, { url: VIDEO_URL }];
  assert.deepEqual(db.raw.prepare("SELECT source FROM queue_items ORDER BY position").all().map((row) => JSON.parse(row.source)), converted);
  assert.deepEqual((await getPlaylist(db, USER, "pl_1")).items.map((item) => item.source), converted);
  assert.deepEqual((await listHistory(db, USER)).map((entry) => [entry.sourceKey, entry.source, entry.position]), [
    ["plex:9896", { plugin: "plex", id: "9896" }, 120],
    [`ytdlp:${CANONICAL}`, { plugin: "ytdlp", id: CANONICAL, url: VIDEO_URL }, 300],
  ]);
  assert.deepEqual(db.raw.prepare("SELECT source_key FROM track_preferences ORDER BY source_key").all().map((row) => row.source_key),
    ["default", "plex:9896", `ytdlp:${CANONICAL}`]);
});
