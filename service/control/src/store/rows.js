import { normalizeSourceRef, OWNER_PROFILE, sourceKey } from "@useyolo/core";

export function parseJson(value, fallback) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Queue items and playlist items share one Item shape
// (Agent Note 2026-10-07-v1-http-api). Their source is a plugin Source, or an
// unclaimed { url } added while the node was offline, which is claimed when it
// plays.
export function itemFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: parseJson(row.source, null),
    title: row.title,
    thumbnail: row.thumbnail ?? null,
    duration: row.duration ?? null,
    metadata: parseJson(row.metadata, {}),
    addedAt: row.added_at,
  };
}

export function itemColumns(input) {
  const source = normalizeSourceRef(input.source);
  const duration = Number(input.duration);
  return {
    source: JSON.stringify(source),
    title: String(input.title || source.url || `Library item ${sourceKey(source)}`).slice(0, 500),
    thumbnail: input.thumbnail ? String(input.thumbnail).slice(0, 2000) : null,
    duration: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null,
    metadata: JSON.stringify(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
  };
}

// Whose rows a history or track-preference call reads and writes (Agent
// Note 2026-10-31-screen-sessions): a user id alone is the owner's profile,
// `{ userId, profileId }` any profile. The owner's rows stay in the tables
// the previous release reads (`history`, `track_preferences`); every other
// profile's are in `profile_<table>`, keyed by its id too. `match` is the
// WHERE clause that picks them, `binds` its values, `alias(name)` the same
// clause for a table under another name.
export function profileScope(owner, table) {
  const userId = typeof owner === "string" ? owner : owner?.userId;
  const profileId = typeof owner === "string" ? OWNER_PROFILE : owner?.profileId ?? OWNER_PROFILE;
  if (profileId === OWNER_PROFILE) {
    return {
      userId, profileId, table, own: true, binds: [userId], match: "user_id = ?", keys: "user_id, source_key",
      alias: (name) => `${name}.user_id = ${table}.user_id`,
      columns: "user_id", values: "?",
    };
  }
  const profileTable = `profile_${table}`;
  return {
    userId, profileId, table: profileTable, own: false, binds: [userId, profileId], match: "user_id = ? AND profile_id = ?",
    keys: "user_id, profile_id, source_key",
    alias: (name) => `${name}.user_id = ${profileTable}.user_id AND ${name}.profile_id = ${profileTable}.profile_id`,
    columns: "user_id, profile_id", values: "?, ?",
  };
}
