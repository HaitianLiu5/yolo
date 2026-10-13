// The owner's media path settings (Agent Note 2026-10-13-media-off-the-worker),
// the media_settings table: whether the Worker relays media, when the owner
// accepted the relay's warning, and whether remote direct play is on. A
// user without a row has everything off.

const OFF = Object.freeze({ relay: false, relayAcceptedAt: null, remote: false, updatedAt: null });

export async function readMediaSettings(db, userId) {
  const row = await db.prepare("SELECT relay, relay_accepted_at, remote, updated_at FROM media_settings WHERE user_id = ?").bind(userId).first();
  if (!row) return { ...OFF };
  return { relay: row.relay === 1, relayAcceptedAt: row.relay_accepted_at ?? null, remote: row.remote === 1, updatedAt: row.updated_at ?? null };
}

/** Changes the fields given; returns the settings after the change. */
export async function writeMediaSettings(db, userId, changes, now = Date.now()) {
  const next = { ...(await readMediaSettings(db, userId)), ...changes, updatedAt: now };
  await db.prepare(`INSERT INTO media_settings (user_id, relay, relay_accepted_at, remote, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET relay = excluded.relay, relay_accepted_at = excluded.relay_accepted_at, remote = excluded.remote, updated_at = excluded.updated_at`)
    .bind(userId, next.relay ? 1 : 0, next.relayAcceptedAt, next.remote ? 1 : 0, now).run();
  return next;
}

/** Whether any user of the deployment has remote direct play on: the node and its name belong to the deployment. */
export async function remoteWanted(db) {
  return Boolean(await db.prepare("SELECT 1 AS on_ FROM media_settings WHERE remote = 1 LIMIT 1").first("on_"));
}

// Per isolate, the relay switch of the users whose tokens reach /m/*, for
// a short while: a change in settings reaches every isolate within it.
const RELAY_CACHE_MS = 30_000;
const MAX_CACHED = 100;
const relayCache = new Map();

export async function relayEnabled(db, userId, now = Date.now()) {
  const cached = relayCache.get(userId);
  if (cached && now - cached.at < RELAY_CACHE_MS) return cached.on;
  const on = (await readMediaSettings(db, userId)).relay;
  if (relayCache.size >= MAX_CACHED) relayCache.delete(relayCache.keys().next().value);
  relayCache.set(userId, { on, at: now });
  return on;
}

export function forgetRelay(userId) {
  relayCache.delete(userId);
}
