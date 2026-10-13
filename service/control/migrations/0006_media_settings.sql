-- The owner's media paths (Agent Note 2026-10-13-media-off-the-worker): one
-- row per user, written from settings.
--   relay              whether the Worker's /m/* passthrough serves media
--   relay_accepted_at  when the owner confirmed the warning about
--                      Cloudflare's terms that turning the relay on shows
--   remote             whether remote direct play is on: the node's remote
--                      listener, its router port, and its DNS-only record
-- A user without a row has both off, so a new instance starts with the relay
-- off. An instance from before this migration played away from home only
-- through the relay: its existing users keep the relay on until the owner
-- turns it off.

CREATE TABLE media_settings (
  user_id TEXT PRIMARY KEY,
  relay INTEGER NOT NULL DEFAULT 0,
  relay_accepted_at INTEGER,
  remote INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

INSERT INTO media_settings (user_id, relay, relay_accepted_at, remote, updated_at)
  SELECT id, 1, NULL, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM users;
