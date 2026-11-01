import { parseJson, profileScope } from "./rows.js";

// Track preferences per source key, plus a `default` row holding the most
// recent choice. Each function takes `owner`, whose choices they are: a
// user id for the owner's profile, or { userId, profileId } (rows.js
// profileScope(), Agent Note 2026-10-31-screen-sessions).

export async function getTrackPreferences(db, owner, key) {
  const scope = profileScope(owner, "track_preferences");
  const { results } = await db.prepare(
    `SELECT source_key, selection FROM ${scope.table} WHERE ${scope.match} AND source_key IN (?, 'default')`,
  ).bind(...scope.binds, key).all();
  const byKey = Object.fromEntries(results.map((row) => [row.source_key, parseJson(row.selection, null)]));
  return { saved: byKey[key] ?? null, fallback: byKey.default ?? null };
}

// An item its source now knows by a new id (Agent Note
// 2026-10-21-moved-library-items): its saved choice moves to the new key,
// unless the new key has one already. In every profile's choices.
export async function relocateTrackPreferences(db, userId, fromKey, toKey) {
  await db.batch([
    db.prepare(`
      UPDATE track_preferences SET source_key = ?
      WHERE user_id = ? AND source_key = ?
        AND NOT EXISTS (SELECT 1 FROM track_preferences WHERE user_id = ? AND source_key = ?)
    `).bind(toKey, userId, fromKey, userId, toKey),
    db.prepare("DELETE FROM track_preferences WHERE user_id = ? AND source_key = ?").bind(userId, fromKey),
    db.prepare(`
      UPDATE profile_track_preferences SET source_key = ?
      WHERE user_id = ? AND source_key = ?
        AND NOT EXISTS (SELECT 1 FROM profile_track_preferences AS other
          WHERE other.user_id = profile_track_preferences.user_id AND other.profile_id = profile_track_preferences.profile_id AND other.source_key = ?)
    `).bind(toKey, userId, fromKey, toKey),
    db.prepare("DELETE FROM profile_track_preferences WHERE user_id = ? AND source_key = ?").bind(userId, fromKey),
  ]);
}

export async function saveTrackPreferences(db, owner, key, selection) {
  const scope = profileScope(owner, "track_preferences");
  const now = Date.now();
  const json = JSON.stringify(selection);
  const upsert = `
    INSERT INTO ${scope.table} (${scope.columns}, source_key, selection, updated_at) VALUES (${scope.values}, ?, ?, ?)
    ON CONFLICT(${scope.keys}) DO UPDATE SET selection = excluded.selection, updated_at = excluded.updated_at
  `;
  await db.batch([
    db.prepare(upsert).bind(...scope.binds, key, json, now),
    db.prepare(upsert).bind(...scope.binds, "default", json, now),
  ]);
}
