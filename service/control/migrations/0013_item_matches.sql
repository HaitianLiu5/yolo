-- The owner's own match of an item to a work (Agent Note
-- 2026-10-25-metadata-plugins): the record a metadata plugin holds that the
-- owner chose for it, or their refusal of every match. The node's caches of
-- identifications can be deleted at any time; this is the one choice that
-- cannot be rebuilt.
--   plugin     the metadata plugin's id; null with candidate for a refusal
--   candidate  the plugin's Candidate as JSON, or null
-- The previous release's code never reads this table.

CREATE TABLE item_matches (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  plugin TEXT,
  candidate TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, source_key)
);
