-- Every screen plays on its own, and each session belongs to a profile, who
-- is watching (Agent Note 2026-10-31-screen-sessions).
--   profiles                   the owner's list of profiles other than the
--                              owner's own, which has the reserved id
--                              'owner' and no row
--   devices.profile_id         a screen's default profile; NULL is the owner's
--   queue_items.device_id      the screen whose queue an item is in; the Hub
--                              gives rows without one to the screen that
--                              played last when it first loads
--   history.device_id          the screen that played an entry last
--   profile_history            every other profile's history, as `history`
--                              is the owner's, newest 500 per profile
--   profile_track_preferences  every other profile's track choices, as
--                              `track_preferences` holds the owner's
-- The owner's rows stay in `history` and `track_preferences` with their
-- primary keys, so the previous release's upserts work unchanged. It reads
-- `SELECT *` and never names the new columns or tables: after a rollback it
-- reads every screen's queue rows as one queue and does not see other
-- profiles' history.

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_profiles_user ON profiles(user_id);

ALTER TABLE devices ADD COLUMN profile_id TEXT;
ALTER TABLE queue_items ADD COLUMN device_id TEXT;
CREATE INDEX idx_queue_items_user_device ON queue_items(user_id, device_id, position);
ALTER TABLE history ADD COLUMN device_id TEXT;

CREATE TABLE profile_history (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail TEXT,
  position REAL NOT NULL DEFAULT 0,
  duration REAL,
  play_count INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  watched_at INTEGER,
  show_key TEXT,
  season_key TEXT,
  device_id TEXT,
  PRIMARY KEY (user_id, profile_id, source_key)
);
CREATE INDEX idx_profile_history_updated ON profile_history(user_id, profile_id, updated_at DESC);
CREATE INDEX idx_profile_history_show ON profile_history(user_id, profile_id, show_key) WHERE show_key IS NOT NULL;
CREATE INDEX idx_profile_history_season ON profile_history(user_id, profile_id, season_key) WHERE season_key IS NOT NULL;

CREATE TABLE profile_track_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  selection TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile_id, source_key)
);
