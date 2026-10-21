import { newId, randomToken, sha256 } from "@useyolo/core";
import { parseJson } from "./rows.js";

// Share links (Agent Note 2026-10-20-share-links), the share_links table: a
// link plays one item in a friend's browser for 7 days, until the owner
// revokes it. Only the token's hash is stored, as for device credentials.

export const SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60_000;
// 16 random bytes, 22 base64url characters in the link.
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const KEEP_ENDED_MS = 30 * 24 * 60 * 60_000;
const MAX_LINKS = 200;

export const isShareToken = (value) => typeof value === "string" && TOKEN.test(value);

/** Where a link stands at `now`: active, expired, or revoked. */
export function shareStatus(link, now = Date.now()) {
  if (link.revokedAt) return "revoked";
  return link.expiresAt <= now ? "expired" : "active";
}

function linkFromRow(row) {
  return row && {
    id: row.id,
    userId: row.user_id,
    source: parseJson(row.source, null),
    title: row.title,
    thumbnail: row.thumbnail ?? null,
    duration: row.duration ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? null,
    plays: row.plays,
    lastPlayedAt: row.last_played_at ?? null,
  };
}

/** A new link for a claimed source; the token is in the result and nowhere else. */
export async function createShareLink(db, userId, { source, title, thumbnail = null, duration = null, createdBy = null }, now = Date.now()) {
  const id = newId("shr");
  const token = randomToken(16);
  const expiresAt = now + SHARE_LINK_TTL_MS;
  await db.batch([
    db.prepare(`INSERT INTO share_links (id, user_id, token_hash, source, title, thumbnail, duration, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, userId, await sha256(token), JSON.stringify(source), title, thumbnail, duration, createdBy, now, expiresAt),
    // A link ends when it expires or is revoked, whichever comes first.
    db.prepare("DELETE FROM share_links WHERE user_id = ? AND MIN(expires_at, COALESCE(revoked_at, expires_at)) < ?")
      .bind(userId, now - KEEP_ENDED_MS),
    db.prepare(`DELETE FROM share_links WHERE user_id = ? AND id NOT IN (
      SELECT id FROM share_links WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`)
      .bind(userId, userId, MAX_LINKS),
  ]);
  return { id, token, expiresAt };
}

/** The link a token opens, whatever its status, or null for none. */
export async function findShareLink(db, token) {
  if (!isShareToken(token)) return null;
  return linkFromRow(await db.prepare("SELECT * FROM share_links WHERE token_hash = ?").bind(await sha256(token)).first());
}

export async function listShareLinks(db, userId) {
  const { results } = await db.prepare("SELECT * FROM share_links WHERE user_id = ? ORDER BY created_at DESC, rowid DESC").bind(userId).all();
  return results.map(linkFromRow);
}

/** Revokes one of the user's links; returns it, or null when there is none. */
export async function revokeShareLink(db, userId, id, now = Date.now()) {
  await db.prepare("UPDATE share_links SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ? AND id = ?").bind(now, userId, id).run();
  return linkFromRow(await db.prepare("SELECT * FROM share_links WHERE user_id = ? AND id = ?").bind(userId, id).first());
}

/** A friend started the link's item (not a rebuild of their stream). */
export async function noteSharePlay(db, id, now = Date.now()) {
  await db.prepare("UPDATE share_links SET plays = plays + 1, last_played_at = ? WHERE id = ?").bind(now, id).run();
}
