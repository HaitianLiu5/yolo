import { YoloError } from "@useyolo/core";

// Agents' requests to turn a plugin or a place on, or change a plugin's
// options (Agent Note 2026-10-31-home-cold-start), the plugin_requests
// table. A request applies nothing: it waits up to REQUEST_TTL_MS for the
// owner, who allows it with a fresh passkey assertion, or denies it, once.
// The agent gives the owner the request's link, which is its capability.
// The `code_hash` column, of a short code no page ever asked for, stays
// empty: the previous release's code still writes it.

export const REQUEST_TTL_MS = 10 * 60_000;
// Requests kept for the record after they are decided or expire.
const KEEP_MS = 30 * 24 * 60 * 60_000;

// An option's value may be a key, so a request keeps the values only while
// it waits for the owner. Once it is decided or has expired the stored
// change keeps the option names, with null for each value, and `enabled`:
// the record still says what was asked.
function withoutOptionValues(stored) {
  let change;
  try {
    change = JSON.parse(stored);
  } catch {
    return stored;
  }
  if (!change?.options || typeof change.options !== "object") return stored;
  return JSON.stringify({ ...change, options: Object.fromEntries(Object.keys(change.options).map((name) => [name, null])) });
}

// Clears the option values of the rows among `rows` that no longer wait,
// in D1 and in the rows returned.
async function clearSettled(db, rows, now) {
  return Promise.all(rows.map(async (row) => {
    if (row.status === "pending" && row.expires_at > now) return row;
    const change = withoutOptionValues(row.change);
    if (change === row.change) return row;
    await db.prepare("UPDATE plugin_requests SET change = ? WHERE id = ?").bind(change, row.id).run();
    return { ...row, change };
  }));
}

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

/** A new request. */
export async function createPluginRequest(db, userId, { plugin = null, place = null, change, client = null }, now = Date.now()) {
  if (!plugin === !place) throw new YoloError("invalid_request", "Name a plugin or a place");
  const id = crypto.randomUUID();
  await db.prepare("DELETE FROM plugin_requests WHERE user_id = ? AND expires_at < ?").bind(userId, now - KEEP_MS).run();
  // Requests that ran out with nobody looking lose their option values here.
  const expired = await db.prepare("SELECT * FROM plugin_requests WHERE user_id = ? AND status = 'pending' AND expires_at <= ?").bind(userId, now).all();
  await clearSettled(db, expired.results ?? [], now);
  await db.prepare(`INSERT INTO plugin_requests (id, user_id, target, change, client, code_hash, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, '', 'pending', ?, ?)`)
    .bind(id, userId, place ? `place:${place}` : plugin, JSON.stringify(change ?? {}), client, now, now + REQUEST_TTL_MS).run();
  return present({ id, target: place ? `place:${place}` : plugin, change: JSON.stringify(change ?? {}), client, status: "pending", created_at: now, expires_at: now + REQUEST_TTL_MS }, now);
}

/** The requests still waiting for the owner, newest first. */
export async function pendingPluginRequests(db, userId, now = Date.now()) {
  const { results } = await db.prepare("SELECT * FROM plugin_requests WHERE user_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC")
    .bind(userId, now).all();
  return results.map((row) => present(row, now));
}

export async function getPluginRequest(db, userId, id, now = Date.now()) {
  const row = await db.prepare("SELECT * FROM plugin_requests WHERE user_id = ? AND id = ?").bind(userId, String(id ?? "")).first();
  return row ? present((await clearSettled(db, [row], now))[0], now) : null;
}

/** A request by its id alone, with its owner's `userId`: the link is its capability. */
export async function findPluginRequest(db, id, now = Date.now()) {
  const row = await db.prepare("SELECT * FROM plugin_requests WHERE id = ?").bind(String(id ?? "")).first();
  return row ? { ...present((await clearSettled(db, [row], now))[0], now), userId: row.user_id } : null;
}

/**
 * Decides a pending request once: true when this call took it, false when
 * it was already decided or expired. The stored option values go with the
 * decision, so the caller reads the request before it decides.
 */
export async function decidePluginRequest(db, userId, id, status, { error = null } = {}, now = Date.now()) {
  const result = await db.prepare(`UPDATE plugin_requests SET status = ?, error = ?, decided_at = ?
    WHERE user_id = ? AND id = ? AND status = 'pending' AND expires_at > ?`)
    .bind(status, error, now, userId, String(id ?? ""), now).run();
  const row = await db.prepare("SELECT * FROM plugin_requests WHERE user_id = ? AND id = ?").bind(userId, String(id ?? "")).first();
  if (row) await clearSettled(db, [row], now);
  return (result.meta?.changes ?? 0) > 0;
}

/** After an allowed request failed to apply. */
export async function failPluginRequest(db, userId, id, error, now = Date.now()) {
  await db.prepare("UPDATE plugin_requests SET status = 'failed', error = ?, decided_at = ? WHERE user_id = ? AND id = ?")
    .bind(String(error).slice(0, 500), now, userId, String(id ?? "")).run();
}
