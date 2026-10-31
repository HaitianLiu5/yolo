import { HISTORY_LIMIT, isSourceKey, sourceKey } from "@useyolo/core";
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

// With `byShow`, a show (or another run an entry belongs to, its
// `show_key`) gives only its newest entry, which names it as `showKey`
// (Agent Note 2026-10-11-yolo-owns-progress-and-resume).
export async function listHistory(db, userId, { limit = 50, byShow = false } = {}) {
  const capped = Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(Number(limit) || 50)));
  // Ties (two writes in the same millisecond) go to the newer row.
  const newest = byShow
    ? ` AND (show_key IS NULL OR rowid = (
        SELECT rowid FROM history AS other WHERE other.user_id = history.user_id AND other.show_key = history.show_key
        ORDER BY other.updated_at DESC, other.rowid DESC LIMIT 1))`
    : "";
  const { results } = await db.prepare(`SELECT * FROM history WHERE user_id = ?${newest} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
    .bind(userId, capped).all();
  return results.map((row) => (byShow && row.show_key ? { ...entryFromRow(row), showKey: row.show_key } : entryFromRow(row)));
}

export async function getHistoryEntry(db, userId, key) {
  const row = await db.prepare("SELECT * FROM history WHERE user_id = ? AND source_key = ?").bind(userId, key).first();
  return row ? entryFromRow(row) : null;
}

// Whether an entry counts as watched: Yolo's mark, or a position at the
// end that the previous release left unmarked (isFinished in @useyolo/core).
const WATCHED = "(watched_at IS NOT NULL OR (duration > 0 AND position >= duration - MIN(60, duration * 0.05)))";
// D1 binds at most 100 values to a statement.
const KEYS_PER_STATEMENT = 90;

// The source keys an item belongs to, outermost first, as the node names
// them (`parents`): its show, then its season (migration 0012).
function parentKeys(parents) {
  const [show = null, season = null] = (Array.isArray(parents) ? parents : []).filter(isSourceKey);
  return { show, season };
}

function chunks(values, size = KEYS_PER_STATEMENT) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

// Called when playback starts: bump play_count and keep the newest 500.
// `parents` are the show and season the item belongs to, when its source
// says; an entry keeps the ones it has when they are missing.
export async function recordPlay(db, userId, { source, title, thumbnail = null, duration = null, position = 0, parents = null }) {
  const key = sourceKey(source);
  const now = Date.now();
  const { show, season } = parentKeys(parents);
  await db.batch([
    db.prepare(`
      INSERT INTO history (user_id, source_key, source, title, thumbnail, position, duration, play_count, updated_at, show_key, season_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(user_id, source_key) DO UPDATE SET
        title = excluded.title,
        thumbnail = COALESCE(excluded.thumbnail, history.thumbnail),
        duration = COALESCE(excluded.duration, history.duration),
        position = excluded.position,
        play_count = history.play_count + 1,
        updated_at = excluded.updated_at,
        show_key = COALESCE(excluded.show_key, history.show_key),
        season_key = CASE WHEN excluded.show_key IS NULL THEN history.season_key ELSE excluded.season_key END
    `).bind(userId, key, JSON.stringify(source), String(title || key), thumbnail, position, duration, now, show, season),
    db.prepare(`
      DELETE FROM history WHERE user_id = ? AND source_key NOT IN (
        SELECT source_key FROM history WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
      )
    `).bind(userId, userId, HISTORY_LIMIT),
  ]);
  return key;
}

// The entries of the items a listing names, by source key.
export async function historyEntries(db, userId, keys) {
  const entries = new Map();
  for (const part of chunks([...new Set(keys)])) {
    const { results } = await db.prepare(`SELECT * FROM history WHERE user_id = ? AND source_key IN (${part.map(() => "?").join(", ")})`)
      .bind(userId, ...part).all();
    for (const row of results) entries.set(row.source_key, { ...entryFromRow(row), showKey: row.show_key ?? null });
  }
  return entries;
}

// How many entries of each show or season (by its source key) are watched.
export async function watchedCounts(db, userId, keys) {
  const counts = new Map();
  // Each key is bound twice, once for shows and once for seasons.
  for (const part of chunks([...new Set(keys)], KEYS_PER_STATEMENT / 2)) {
    const marks = part.map(() => "?").join(", ");
    const { results } = await db.prepare(`
      SELECT show_key AS parent, COUNT(*) AS watched FROM history WHERE user_id = ? AND show_key IN (${marks}) AND ${WATCHED} GROUP BY show_key
      UNION ALL
      SELECT season_key AS parent, COUNT(*) AS watched FROM history WHERE user_id = ? AND season_key IN (${marks}) AND ${WATCHED} GROUP BY season_key
    `).bind(userId, ...part, userId, ...part).all();
    for (const row of results) counts.set(row.parent, (counts.get(row.parent) ?? 0) + row.watched);
  }
  return counts;
}

// A listing names the show and season of entries played before Yolo kept
// them (or by the previous release): they are filled in, never replaced.
export async function fillParents(db, userId, items) {
  const statements = items.flatMap(({ key, parents }) => {
    const { show, season } = parentKeys(parents);
    if (!show) return [];
    return [db.prepare("UPDATE history SET show_key = ?, season_key = ? WHERE user_id = ? AND source_key = ? AND show_key IS NULL")
      .bind(show, season, userId, key)];
  });
  if (statements.length) await db.batch(statements);
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

// With `withShow`, a key also removes the entries of the show it names.
export async function deleteHistory(db, userId, key = null, { withShow = false } = {}) {
  const result = key
    ? await db.prepare(`DELETE FROM history WHERE user_id = ? AND (source_key = ?${withShow ? " OR show_key = ?" : ""})`)
      .bind(userId, key, ...(withShow ? [key] : [])).run()
    : await db.prepare("DELETE FROM history WHERE user_id = ?").bind(userId).run();
  return result.meta?.changes ?? 0;
}
