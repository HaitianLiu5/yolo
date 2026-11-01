import { parseJson } from "./rows.js";

// The owner's matches of items to works (Agent Note
// 2026-10-25-metadata-plugins), per source key: the record they chose,
// { plugin, candidate }, or { none: true } when they refused every match.

export async function getItemMatch(db, userId, key) {
  const row = await db.prepare("SELECT plugin, candidate FROM item_matches WHERE user_id = ? AND source_key = ?").bind(userId, key).first();
  if (!row) return null;
  const candidate = parseJson(row.candidate, null);
  return row.plugin && candidate ? { plugin: row.plugin, candidate } : { none: true };
}

export async function setItemMatch(db, userId, key, match, now = Date.now()) {
  const none = Boolean(match?.none);
  await db.prepare(`
    INSERT INTO item_matches (user_id, source_key, plugin, candidate, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, source_key) DO UPDATE SET plugin = excluded.plugin, candidate = excluded.candidate, created_at = excluded.created_at
  `).bind(userId, key, none ? null : match.plugin, none ? null : JSON.stringify(match.candidate), now).run();
}

/** Forgets the owner's match, so the item is identified again. */
export async function clearItemMatch(db, userId, key) {
  await db.prepare("DELETE FROM item_matches WHERE user_id = ? AND source_key = ?").bind(userId, key).run();
}

// An item its source now knows by a new id (Agent Note
// 2026-10-21-moved-library-items): its match moves with it, unless the new
// key has one already.
export async function relocateItemMatch(db, userId, fromKey, toKey) {
  await db.batch([
    db.prepare(`
      UPDATE item_matches SET source_key = ?
      WHERE user_id = ? AND source_key = ?
        AND NOT EXISTS (SELECT 1 FROM item_matches WHERE user_id = ? AND source_key = ?)
    `).bind(toKey, userId, fromKey, userId, toKey),
    db.prepare("DELETE FROM item_matches WHERE user_id = ? AND source_key = ?").bind(userId, fromKey),
  ]);
}
