import { parseJson } from "./rows.js";

// Track preferences per source key, plus a `default` row holding the most
// recent choice.

export async function getTrackPreferences(db, userId, key) {
  const { results } = await db.prepare(
    "SELECT source_key, selection FROM track_preferences WHERE user_id = ? AND source_key IN (?, 'default')",
  ).bind(userId, key).all();
  const byKey = Object.fromEntries(results.map((row) => [row.source_key, parseJson(row.selection, null)]));
  return { saved: byKey[key] ?? null, fallback: byKey.default ?? null };
}

// An item its source now knows by a new id (Agent Note
// 2026-10-21-moved-library-items): its saved choice moves to the new key,
// unless the new key has one already.
export async function relocateTrackPreferences(db, userId, fromKey, toKey) {
  await db.batch([
    db.prepare(`
      UPDATE track_preferences SET source_key = ?
      WHERE user_id = ? AND source_key = ?
        AND NOT EXISTS (SELECT 1 FROM track_preferences WHERE user_id = ? AND source_key = ?)
    `).bind(toKey, userId, fromKey, userId, toKey),
    db.prepare("DELETE FROM track_preferences WHERE user_id = ? AND source_key = ?").bind(userId, fromKey),
  ]);
}

export async function saveTrackPreferences(db, userId, key, selection) {
  const now = Date.now();
  const json = JSON.stringify(selection);
  const upsert = `
    INSERT INTO track_preferences (user_id, source_key, selection, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, source_key) DO UPDATE SET selection = excluded.selection, updated_at = excluded.updated_at
  `;
  await db.batch([
    db.prepare(upsert).bind(userId, key, json, now),
    db.prepare(upsert).bind(userId, "default", json, now),
  ]);
}
