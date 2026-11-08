-- What Yolo finds by itself for the owner (Agent Note
-- 2026-11-04-living-home-and-media-pool).
--
-- interests: what a profile cares about, as a record the owner can see and
-- correct. Its follows are what the node reads for it.
--   profile_id  'owner' for the owner's profile, else a profile's id
--   key         the interest's identity, for one from a plugin its follow's id
--   kind        "channel", "schedule", or "team"
--   follows     JSON: what the node reads, [{ id, plugin, kind, title, url?, within? }]
--   origin      "history" for now: where it came from
--   state       "active", or "muted", which is never proposed again
--   why         JSON: what brought it, { plays, title }
--
-- feed_dismissed: what a profile said it is not interested in, which the rows
-- leave out. The previous release's code never reads either table.

CREATE TABLE interests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  follows TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'history',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'muted')),
  why TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile_id, key)
);

CREATE TABLE feed_dismissed (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile_id, source_key)
);
