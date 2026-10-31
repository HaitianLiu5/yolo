import { HISTORY_LIMIT, isSourceKey, sourceKey } from "@useyolo/core";
import { parseJson, profileScope } from "./rows.js";

// Each function takes `owner`, whose history it is: a user id for the
// owner's profile, or { userId, profileId } (rows.js profileScope(), Agent
// Note 2026-10-31-screen-sessions).

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
    // The screen that played it last (migration 0015).
    deviceId: row.device_id ?? null,
  };
}

// With `byShow`, a show (or another run an entry belongs to, its
// `show_key`) gives only its newest entry, which names it as `showKey`
// (Agent Note 2026-10-11-yolo-owns-progress-and-resume).
export async function listHistory(db, owner, { limit = 50, byShow = false } = {}) {
  const scope = profileScope(owner, "history");
  const capped = Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(Number(limit) || 50)));
  // Ties (two writes in the same millisecond) go to the newer row.
  const newest = byShow
    ? ` AND (show_key IS NULL OR rowid = (
        SELECT rowid FROM ${scope.table} AS other WHERE ${scope.alias("other")} AND other.show_key = ${scope.table}.show_key
        ORDER BY other.updated_at DESC, other.rowid DESC LIMIT 1))`
    : "";
  const { results } = await db.prepare(`SELECT * FROM ${scope.table} WHERE ${scope.match}${newest} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
    .bind(...scope.binds, capped).all();
  return results.map((row) => (byShow && row.show_key ? { ...entryFromRow(row), showKey: row.show_key } : entryFromRow(row)));
}

export async function getHistoryEntry(db, owner, key) {
  const scope = profileScope(owner, "history");
  const row = await db.prepare(`SELECT * FROM ${scope.table} WHERE ${scope.match} AND source_key = ?`).bind(...scope.binds, key).first();
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

function chunks(values) {
  const out = [];
  for (let i = 0; i < values.length; i += KEYS_PER_STATEMENT) out.push(values.slice(i, i + KEYS_PER_STATEMENT));
  return out;
}

// Called when playback starts: bump play_count and keep the newest 500.
// `parents` are the show and season the item belongs to, when its source
// says; an entry keeps the ones it has when they are missing. `deviceId` is
// the screen it plays on.
export async function recordPlay(db, owner, { source, title, thumbnail = null, duration = null, position = 0, parents = null, deviceId = null }) {
  const scope = profileScope(owner, "history");
  const { table } = scope;
  const key = sourceKey(source);
  const now = Date.now();
  const { show, season } = parentKeys(parents);
  await db.batch([
    db.prepare(`
      INSERT INTO ${table} (${scope.columns}, source_key, source, title, thumbnail, position, duration, play_count, updated_at, show_key, season_key, device_id)
      VALUES (${scope.values}, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(${scope.keys}) DO UPDATE SET
        title = excluded.title,
        thumbnail = COALESCE(excluded.thumbnail, ${table}.thumbnail),
        duration = COALESCE(excluded.duration, ${table}.duration),
        position = excluded.position,
        play_count = ${table}.play_count + 1,
        updated_at = excluded.updated_at,
        show_key = COALESCE(excluded.show_key, ${table}.show_key),
        season_key = CASE WHEN excluded.show_key IS NULL THEN ${table}.season_key ELSE excluded.season_key END,
        device_id = COALESCE(excluded.device_id, ${table}.device_id)
    `).bind(...scope.binds, key, JSON.stringify(source), String(title || key), thumbnail, position, duration, now, show, season, deviceId),
    db.prepare(`
      DELETE FROM ${table} WHERE ${scope.match} AND source_key NOT IN (
        SELECT source_key FROM ${table} WHERE ${scope.match} ORDER BY updated_at DESC LIMIT ?
      )
    `).bind(...scope.binds, ...scope.binds, HISTORY_LIMIT),
  ]);
  return key;
}

// The entries of the items a listing names, by source key.
export async function historyEntries(db, owner, keys) {
  const scope = profileScope(owner, "history");
  const entries = new Map();
  for (const part of chunks([...new Set(keys)])) {
    const { results } = await db.prepare(`SELECT * FROM ${scope.table} WHERE ${scope.match} AND source_key IN (${part.map(() => "?").join(", ")})`)
      .bind(...scope.binds, ...part).all();
    for (const row of results) entries.set(row.source_key, { ...entryFromRow(row), showKey: row.show_key ?? null });
  }
  return entries;
}

// How many entries of each show or season (by its source key) are watched.
export async function watchedCounts(db, owner, keys) {
  const scope = profileScope(owner, "history");
  const counts = new Map();
  for (const part of chunks([...new Set(keys)])) {
    const marks = part.map(() => "?").join(", ");
    const { results } = await db.prepare(`
      SELECT show_key AS parent, COUNT(*) AS watched FROM ${scope.table} WHERE ${scope.match} AND show_key IN (${marks}) AND ${WATCHED} GROUP BY show_key
      UNION ALL
      SELECT season_key AS parent, COUNT(*) AS watched FROM ${scope.table} WHERE ${scope.match} AND season_key IN (${marks}) AND ${WATCHED} GROUP BY season_key
    `).bind(...scope.binds, ...part, ...scope.binds, ...part).all();
    for (const row of results) counts.set(row.parent, (counts.get(row.parent) ?? 0) + row.watched);
  }
  return counts;
}

// A listing names the show and season of entries played before Yolo kept
// them (or by the previous release): they are filled in, never replaced.
export async function fillParents(db, owner, items) {
  const scope = profileScope(owner, "history");
  const statements = items.flatMap(({ key, parents }) => {
    const { show, season } = parentKeys(parents);
    if (!show) return [];
    return [db.prepare(`UPDATE ${scope.table} SET show_key = ?, season_key = ? WHERE ${scope.match} AND source_key = ? AND show_key IS NULL`)
      .bind(show, season, ...scope.binds, key)];
  });
  if (statements.length) await db.batch(statements);
}

// Progress that reaches the item's last minute (or 5%, isFinished) marks it
// watched; nothing after unmarks it, so a watched item played again from
// the start keeps its mark (Agent Note 2026-10-11-yolo-owns-progress-and-resume).
export async function recordProgress(db, owner, key, { position, duration }) {
  const scope = profileScope(owner, "history");
  const total = duration ?? null;
  const now = Date.now();
  await db.prepare(`
    UPDATE ${scope.table} SET position = ?, duration = COALESCE(?, duration), updated_at = ?,
      watched_at = COALESCE(watched_at, CASE
        WHEN COALESCE(?, duration) > 0 AND ? >= COALESCE(?, duration) - MIN(60, COALESCE(?, duration) * 0.05) THEN ?
      END)
    WHERE ${scope.match} AND source_key = ?
  `).bind(position, total, now, total, position, total, total, now, ...scope.binds, key).run();
}

// An item its source now knows by a new id (Agent Note
// 2026-10-21-moved-library-items): its entry, with its position and play
// count, moves to the new key, unless the new key has one already; then
// the old entry goes. In every profile's history.
export async function relocateHistory(db, userId, fromKey, source) {
  const key = sourceKey(source);
  await db.batch([
    db.prepare(`
      UPDATE history SET source_key = ?, source = ?
      WHERE user_id = ? AND source_key = ?
        AND NOT EXISTS (SELECT 1 FROM history WHERE user_id = ? AND source_key = ?)
    `).bind(key, JSON.stringify(source), userId, fromKey, userId, key),
    db.prepare("DELETE FROM history WHERE user_id = ? AND source_key = ?").bind(userId, fromKey),
    db.prepare(`
      UPDATE profile_history SET source_key = ?, source = ?
      WHERE user_id = ? AND source_key = ?
        AND NOT EXISTS (SELECT 1 FROM profile_history AS other
          WHERE other.user_id = profile_history.user_id AND other.profile_id = profile_history.profile_id AND other.source_key = ?)
    `).bind(key, JSON.stringify(source), userId, fromKey, key),
    db.prepare("DELETE FROM profile_history WHERE user_id = ? AND source_key = ?").bind(userId, fromKey),
  ]);
}

// With `withShow`, a key also removes the entries of the show it names.
export async function deleteHistory(db, owner, key = null, { withShow = false } = {}) {
  const scope = profileScope(owner, "history");
  const result = key
    ? await db.prepare(`DELETE FROM ${scope.table} WHERE ${scope.match} AND (source_key = ?${withShow ? " OR show_key = ?" : ""})`)
      .bind(...scope.binds, key, ...(withShow ? [key] : [])).run()
    : await db.prepare(`DELETE FROM ${scope.table} WHERE ${scope.match}`).bind(...scope.binds).run();
  return result.meta?.changes ?? 0;
}
