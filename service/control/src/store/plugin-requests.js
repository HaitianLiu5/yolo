import { YoloError } from "@useyolo/core";

// Agents' requests to turn a plugin or a place on, or change a plugin's
// options (Agent Note 2026-10-31-home-cold-start), the plugin_requests
// table. A request applies nothing: it waits up to REQUEST_TTL_MS for the
// owner, who allows it with a fresh passkey assertion, or denies it, once.
// The agent gives the owner a link and a short code, of which only the
// code's hash is kept.

export const REQUEST_TTL_MS = 10 * 60_000;
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const CODE_LENGTH = 6;
// Requests kept for the record after they are decided or expire.
const KEEP_MS = 30 * 24 * 60 * 60_000;

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

export const normalizeCode = (value) => String(value ?? "").toUpperCase().replace(/[^A-Z]/g, "");

const present = (row, now = Date.now()) => {
  let change = {};
  try {
    change = JSON.parse(row.change);
  } catch {
    // An unreadable change is shown as none.
  }
  const place = row.target.startsWith("place:") ? row.target.slice("place:".length) : null;
  return {
    id: row.id,
    ...(place ? { place } : { plugin: row.target }),
    change,
    client: row.client ?? null,
    status: row.status === "pending" && row.expires_at <= now ? "expired" : row.status,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at ?? null,
  };
};

/** A new request; returns it with its short `code`, which only this answer carries. */
export async function createPluginRequest(db, userId, { plugin = null, place = null, change, client = null }, now = Date.now()) {
  if (!plugin === !place) throw new YoloError("invalid_request", "Name a plugin or a place");
  const id = crypto.randomUUID();
  const code = randomCode();
  await db.prepare("DELETE FROM plugin_requests WHERE user_id = ? AND expires_at < ?").bind(userId, now - KEEP_MS).run();
  await db.prepare(`INSERT INTO plugin_requests (id, user_id, target, change, client, code_hash, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .bind(id, userId, place ? `place:${place}` : plugin, JSON.stringify(change ?? {}), client, await sha256(code), now, now + REQUEST_TTL_MS).run();
  return { ...present({ id, target: place ? `place:${place}` : plugin, change: JSON.stringify(change ?? {}), client, status: "pending", created_at: now, expires_at: now + REQUEST_TTL_MS }, now), code };
}

/** The requests still waiting for the owner, newest first. */
export async function pendingPluginRequests(db, userId, now = Date.now()) {
  const { results } = await db.prepare("SELECT * FROM plugin_requests WHERE user_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC")
    .bind(userId, now).all();
  return results.map((row) => present(row, now));
}

export async function getPluginRequest(db, userId, id, now = Date.now()) {
  const row = await db.prepare("SELECT * FROM plugin_requests WHERE user_id = ? AND id = ?").bind(userId, String(id ?? "")).first();
  return row ? present(row, now) : null;
}

/** A request by its id alone, with its owner's `userId`: the link is its capability. */
export async function findPluginRequest(db, id, now = Date.now()) {
  const row = await db.prepare("SELECT * FROM plugin_requests WHERE id = ?").bind(String(id ?? "")).first();
  return row ? { ...present(row, now), userId: row.user_id } : null;
}

/** The pending request whose short code this is, or null. */
export async function findPluginRequestByCode(db, userId, code, now = Date.now()) {
  const normalized = normalizeCode(code);
  if (normalized.length !== CODE_LENGTH) return null;
  const row = await db.prepare("SELECT * FROM plugin_requests WHERE user_id = ? AND code_hash = ? AND status = 'pending' AND expires_at > ?")
    .bind(userId, await sha256(normalized), now).first();
  return row ? present(row, now) : null;
}

/**
 * Decides a pending request once: true when this call took it, false when
 * it was already decided or expired.
 */
export async function decidePluginRequest(db, userId, id, status, { error = null } = {}, now = Date.now()) {
  const result = await db.prepare(`UPDATE plugin_requests SET status = ?, error = ?, decided_at = ?
    WHERE user_id = ? AND id = ? AND status = 'pending' AND expires_at > ?`)
    .bind(status, error, now, userId, String(id ?? ""), now).run();
  return (result.meta?.changes ?? 0) > 0;
}

/** After an allowed request failed to apply. */
export async function failPluginRequest(db, userId, id, error, now = Date.now()) {
  await db.prepare("UPDATE plugin_requests SET status = 'failed', error = ?, decided_at = ? WHERE user_id = ? AND id = ?")
    .bind(String(error).slice(0, 500), now, userId, String(id ?? "")).run();
}
