-- Share links (Agent Note 2026-10-20-share-links): a link the owner sends a
-- friend, /s/<token>, which plays one item in the friend's browser without
-- pairing, for 7 days or until the owner revokes it.
--   token_hash      sha256 of the link's token; the token itself is never
--                   stored, so a link cannot be shown again, only revoked
--   source          the item, a claimed Source as JSON
--   title, thumbnail, duration   what the friend's page shows, read when
--                   the link was made
--   created_by      who made it: "device:<id>" for a paired screen,
--                   "client:<id>" for an agent's OAuth client
--   expires_at      7 days after created_at
--   revoked_at      when the owner revoked it in settings
--   plays, last_played_at   how often friends started it, and when last
-- Making a link drops the user's links that ended over 30 days ago and keeps
-- the newest 200. The previous release never reads this table.

CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail TEXT,
  duration REAL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  plays INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER
);
CREATE INDEX idx_share_links_user_created ON share_links(user_id, created_at DESC);
