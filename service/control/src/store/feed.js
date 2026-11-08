import { isSourceKey } from "@useyolo/core";
import { parseJson, profileScope } from "./rows.js";

// What the node needs to find things for a profile, and what the profile said
// about them (Agent Note 2026-11-04-living-home-and-media-pool). `profileId`
// is a profile's id, the owner's included.

const DIGEST_PLAYS = 200;
const DIGEST_WINDOW_MS = 30 * 24 * 3_600_000;
const MAX_INTERESTS = 200;
// Past this many, the oldest come back rather than the table growing for ever;
// by then the node has long stopped listing what they were.
const MAX_DISMISSED = 500;
const DIGEST_EVERY_MINUTES = 30;

/** Whether the cron's run at `scheduledTime` is one that sends digests. */
export const feedDigestDue = (scheduledTime) => new Date(scheduledTime).getUTCMinutes() % DIGEST_EVERY_MINUTES === 0;

export async function feedUsers(db) {
  const { results } = await db.prepare("SELECT id FROM users").all();
  return (results || []).map((row) => row.id);
}

/** A profile's recent plays, newest first, as the node reads them. */
export async function digestPlays(db, owner, { now = Date.now() } = {}) {
  const scope = profileScope(owner, "history");
  const { results } = await db.prepare(`SELECT source, title, position, duration, updated_at, watched_at FROM ${scope.table}
    WHERE ${scope.match} AND updated_at >= ? ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
    .bind(...scope.binds, now - DIGEST_WINDOW_MS, DIGEST_PLAYS).all();
  return results.map((row) => ({
    source: parseJson(row.source, null), title: row.title, position: row.position, duration: row.duration ?? null, at: row.updated_at, watched: row.watched_at != null,
  })).filter((play) => play.source);
}

export async function listInterests(db, userId, profileId) {
  const { results } = await db.prepare("SELECT key, title, kind, follows, state, why FROM interests WHERE user_id = ? AND profile_id = ? ORDER BY created_at ASC LIMIT ?")
    .bind(userId, profileId, MAX_INTERESTS).all();
  return results.map((row) => ({ key: row.key, title: row.title, kind: row.kind, follows: parseJson(row.follows, []), state: row.state, why: parseJson(row.why, null) }));
}

// What a profile's plays propose. One it has already, muted above all, stays
// as it is.
export async function addInterests(db, userId, profileId, interests, { now = Date.now() } = {}) {
  const valid = (Array.isArray(interests) ? interests : []).filter((interest) => typeof interest?.key === "string" && interest.key && interest.title && interest.kind);
  if (!valid.length) return;
  await db.batch(valid.map((interest) => db.prepare(`INSERT INTO interests (user_id, profile_id, key, title, kind, follows, origin, state, why, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'history', 'active', ?, ?, ?) ON CONFLICT(user_id, profile_id, key) DO NOTHING`)
    .bind(userId, profileId, interest.key, String(interest.title).slice(0, 200), String(interest.kind), JSON.stringify(interest.follows ?? []), JSON.stringify(interest.why ?? null), now, now)));
}

/** True when the profile has this interest. */
export async function muteInterest(db, userId, profileId, key, { now = Date.now() } = {}) {
  const { meta } = await db.prepare("UPDATE interests SET state = 'muted', updated_at = ? WHERE user_id = ? AND profile_id = ? AND key = ?")
    .bind(now, userId, profileId, key).run();
  return meta.changes > 0;
}

export async function dismissItem(db, userId, profileId, key, { now = Date.now() } = {}) {
  if (!isSourceKey(key)) return;
  await db.batch([
    db.prepare(`INSERT INTO feed_dismissed (user_id, profile_id, source_key, dismissed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, profile_id, source_key) DO UPDATE SET dismissed_at = excluded.dismissed_at`).bind(userId, profileId, key, now),
    db.prepare(`DELETE FROM feed_dismissed WHERE user_id = ? AND profile_id = ? AND source_key NOT IN (
      SELECT source_key FROM feed_dismissed WHERE user_id = ? AND profile_id = ? ORDER BY dismissed_at DESC LIMIT ?)`).bind(userId, profileId, userId, profileId, MAX_DISMISSED),
  ]);
}

export async function dismissedKeys(db, userId, profileId) {
  const { results } = await db.prepare("SELECT source_key FROM feed_dismissed WHERE user_id = ? AND profile_id = ?").bind(userId, profileId).all();
  return new Set(results.map((row) => row.source_key));
}
