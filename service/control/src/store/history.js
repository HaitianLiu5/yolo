import { HISTORY_LIMIT, sourceKey } from "@useyolo/core";
import { parseJson } from "./rows.js";

function entryFromRow(row) {
  return {
    sourceKey: row.source_key,
    source: parseJson(row.source, null),
    title: row.title,
    thumbnail: row.thumbnail ?? null,
    position: row.position,
    duration: row.duration ?? null,
    playCount: row.play_count,
    updatedAt: row.updated_at,
    // Yolo's mark, which playing it again keeps (migration 0011).
    watched: row.watched_at != null,
  };
}

export async function listHistory(db, userId, { limit = 50 } = {}) {
  const capped = Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(Number(limit) || 50)));
  // Ties (two writes in the same millisecond) go to the newer row.
  const { results } = await db.prepare("SELECT * FROM history WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?")
    .bind(userId, capped).all();
  return results.map(entryFromRow);
}

export async function getHistoryEntry(db, userId, key) {
  const row = await db.prepare("SELECT * FROM history WHERE user_id = ? AND source_key = ?").bind(userId, key).first();
  return row ? entryFromRow(row) : null;
}

// Called when playback starts: bump play_count and keep the newest 500.
export async function recordPlay(db, userId, { source, title, thumbnail = null, duration = null, position = 0 }) {
  const key = sourceKey(source);
  const now = Date.now();
  await db.batch([
    db.prepare(`
      INSERT INTO history (user_id, source_key, source, title, thumbnail, position, duration, play_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(user_id, source_key) DO UPDATE SET
        title = excluded.title,
        thumbnail = COALESCE(excluded.thumbnail, history.thumbnail),
        duration = COALESCE(excluded.duration, history.duration),
        position = excluded.position,
        play_count = history.play_count + 1,
        updated_at = excluded.updated_at
    `).bind(userId, key, JSON.stringify(source), String(title || key), thumbnail, position, duration, now),
    db.prepare(`
      DELETE FROM history WHERE user_id = ? AND source_key NOT IN (
        SELECT source_key FROM history WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
      )
    `).bind(userId, userId, HISTORY_LIMIT),
  ]);
  return key;
}

// Progress that reaches the item's last minute (or 5%, isFinished) marks it
// watched; nothing after unmarks it, so a watched item played again from
// the start keeps its mark (Agent Note 2026-10-11-yolo-owns-progress-and-resume).
export async function recordProgress(db, userId, key, { position, duration }) {
  const total = duration ?? null;
  const now = Date.now();
  await db.prepare(`
    UPDATE history SET position = ?, duration = COALESCE(?, duration), updated_at = ?,
      watched_at = COALESCE(watched_at, CASE
        WHEN COALESCE(?, duration) > 0 AND ? >= COALESCE(?, duration) - MIN(60, COALESCE(?, duration) * 0.05) THEN ?
      END)
    WHERE user_id = ? AND source_key = ?
  `).bind(position, total, now, total, position, total, total, now, userId, key).run();
}

// An item its source now knows by a new id (Agent Note
// 2026-10-21-moved-library-items): its entry, with its position and play
// count, moves to the new key, unless the new key has one already; then
// the old entry goes.
export async function relocateHistory(db, userId, fromKey, source) {
  const key = sourceKey(source);
  await db.batch([
    db.prepare(`
      UPDATE history SET source_key = ?, source = ?
      WHERE user_id = ? AND source_key = ?
        AND NOT EXISTS (SELECT 1 FROM history WHERE user_id = ? AND source_key = ?)
    `).bind(key, JSON.stringify(source), userId, fromKey, userId, key),
    db.prepare("DELETE FROM history WHERE user_id = ? AND source_key = ?").bind(userId, fromKey),
  ]);
}

export async function deleteHistory(db, userId, key = null) {
  const result = key
    ? await db.prepare("DELETE FROM history WHERE user_id = ? AND source_key = ?").bind(userId, key).run()
    : await db.prepare("DELETE FROM history WHERE user_id = ?").bind(userId).run();
  return result.meta?.changes ?? 0;
}
