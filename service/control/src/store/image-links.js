// The key version of image links (Agent Note 2026-10-07-remote-mcp-server),
// the image_links table: every cover link an agent gets is sealed with it,
// and a reset adds one, so every earlier link stops working. A user without
// a row is at version 1.

export async function readImageLinks(db, userId) {
  const row = await db.prepare("SELECT key_version, reset_at FROM image_links WHERE user_id = ?").bind(userId).first();
  return { version: row?.key_version ?? 1, resetAt: row?.reset_at ?? null };
}

/** The owner's reset: the next key version; returns the state after it. */
export async function resetImageLinks(db, userId, now = Date.now()) {
  await db.prepare(`INSERT INTO image_links (user_id, key_version, reset_at) VALUES (?, 2, ?)
    ON CONFLICT (user_id) DO UPDATE SET key_version = image_links.key_version + 1, reset_at = excluded.reset_at`)
    .bind(userId, now).run();
  versions.get(db)?.delete(userId);
  return readImageLinks(db, userId);
}

// The operator's reset of every user's links (`npm run yolo -- image-links
// reset`), run as it is by `wrangler d1 execute`, so it takes no parameters.
export const RESET_ALL_IMAGE_LINKS_SQL = `INSERT INTO image_links (user_id, key_version, reset_at)
  SELECT id, 2, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM users WHERE true
  ON CONFLICT (user_id) DO UPDATE SET key_version = image_links.key_version + 1, reset_at = excluded.reset_at;`;

// Per isolate and database, each user's version for a short while, for
// /i/* requests: a reset elsewhere reaches every isolate within it, and a
// link of a newer version than the one kept reads D1 again, so a link given
// just after a reset works at once. Sealing new links reads D1 (`fresh`).
const VERSION_CACHE_MS = 30_000;
const MAX_CACHED = 100;
const versions = new WeakMap(); // db → Map(userId → { version, at })

export async function imageLinkVersion(db, userId, { fresh = false, atLeast = 0, now = Date.now() } = {}) {
  let byUser = versions.get(db);
  if (!byUser) {
    byUser = new Map();
    versions.set(db, byUser);
  }
  const cached = byUser.get(userId);
  if (!fresh && cached && now - cached.at < VERSION_CACHE_MS && cached.version >= atLeast) return cached.version;
  const { version } = await readImageLinks(db, userId);
  byUser.delete(userId);
  if (byUser.size >= MAX_CACHED) byUser.delete(byUser.keys().next().value);
  byUser.set(userId, { version, at: now });
  return version;
}
