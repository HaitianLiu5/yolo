-- Devices can be of kind 'other' (the owner picks the type on the approval
-- page and can change it later). SQLite cannot change a CHECK constraint in
-- place, so the table is rebuilt with the same columns and rows. No other
-- table references devices(id).

CREATE TABLE devices_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('car', 'browser', 'phone', 'tv', 'other')),
  capabilities TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

INSERT INTO devices_next (id, user_id, name, kind, capabilities, created_at, last_seen_at)
  SELECT id, user_id, name, kind, capabilities, created_at, last_seen_at FROM devices;

DROP TABLE devices;
ALTER TABLE devices_next RENAME TO devices;
CREATE INDEX idx_devices_user ON devices(user_id);
