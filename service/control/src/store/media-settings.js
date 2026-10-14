import { relayMode as asRelayMode } from "@useyolo/core";

// The owner's media path settings (Agent Note 2026-10-13-media-off-the-worker),
// the media_settings table: the relay's mode, whether remote direct play is
// on, and when the owner last accepted the relay's warning before the modes
// (kept; it gates nothing). A user without a row has the relay automatic
// and remote access off.
//
// The mode lives in two columns (migration 0008): `relay` says whether the
// Worker relays at all, as the previous release reads it, and `relay_mode`
// tells automatic from on. A row the previous release wrote after a
// rollback changes only `relay`: 0 reads as off, and 1 over a mode of off
// as on.

const DEFAULTS = Object.freeze({ relayMode: "auto", relay: true, relayAcceptedAt: null, remote: false, updatedAt: null });

/** The mode a row says: off without the relay column, else automatic or on. */
export function relayModeOf(row) {
  if (!row) return "auto";
  if (row.relay !== 1) return "off";
  return row.relay_mode === "auto" ? "auto" : "on";
}

// `relay` is whether the Worker relays this user's media: true unless the mode is off.
export async function readMediaSettings(db, userId) {
  const row = await db.prepare("SELECT relay, relay_mode, relay_accepted_at, remote, updated_at FROM media_settings WHERE user_id = ?").bind(userId).first();
  if (!row) return { ...DEFAULTS };
  const mode = relayModeOf(row);
  return { relayMode: mode, relay: mode !== "off", relayAcceptedAt: row.relay_accepted_at ?? null, remote: row.remote === 1, updatedAt: row.updated_at ?? null };
}

/** Changes the fields given ({ relayMode?, remote? }); returns the settings after the change. */
export async function writeMediaSettings(db, userId, changes, now = Date.now()) {
  const before = await readMediaSettings(db, userId);
  const mode = changes.relayMode === undefined ? before.relayMode : asRelayMode(changes.relayMode);
  if (!mode) throw new TypeError(`Unknown relay mode ${changes.relayMode}`);
  const next = { ...before, ...changes, relayMode: mode, relay: mode !== "off", updatedAt: now };
  await db.prepare(`INSERT INTO media_settings (user_id, relay, relay_mode, relay_accepted_at, remote, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET relay = excluded.relay, relay_mode = excluded.relay_mode, relay_accepted_at = excluded.relay_accepted_at, remote = excluded.remote, updated_at = excluded.updated_at`)
    .bind(userId, next.relay ? 1 : 0, mode, next.relayAcceptedAt, next.remote ? 1 : 0, now).run();
  return next;
}

/** Whether any user of the deployment has remote direct play on: the node and its name belong to the deployment. */
export async function remoteWanted(db) {
  return Boolean(await db.prepare("SELECT 1 AS on_ FROM media_settings WHERE remote = 1 LIMIT 1").first("on_"));
}

/** The users with media settings: the Hubs whose screens hear when a media path changes. */
export async function mediaUsers(db) {
  const { results } = await db.prepare("SELECT user_id FROM media_settings").all();
  return (results || []).map((row) => row.user_id);
}

/** The owner (the first user) and their relay mode, for the operator's status; null before the first passkey. */
export async function ownerRelayMode(db) {
  const row = await db.prepare(`SELECT users.id AS user_id, media_settings.relay AS relay, media_settings.relay_mode AS relay_mode
    FROM users LEFT JOIN media_settings ON media_settings.user_id = users.id ORDER BY users.created_at LIMIT 1`).first();
  if (!row) return null;
  return { userId: row.user_id, relayMode: row.relay == null ? "auto" : relayModeOf(row) };
}

// Per isolate, whether the relay serves the users whose tokens reach /m/*,
// for a short while: a change in settings reaches every isolate within it.
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
