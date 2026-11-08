-- Devices can be of kind 'tablet': an iPad or another tablet, which the
-- owner picks on the approval page and the iPad app suggests. SQLite cannot
-- change a CHECK constraint in place, so the table is rebuilt with the same
-- columns and rows, as in 0005. No other table references devices(id). The
-- previous release's code runs on it unchanged: it draws a 'tablet' row with
-- the icon it uses for a type it does not know, and a hello from that screen
-- puts back the type the screen names itself.

CREATE TABLE devices_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('car', 'browser', 'phone', 'tablet', 'tv', 'other')),
  capabilities TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  profile_id TEXT
);

INSERT INTO devices_next (id, user_id, name, kind, capabilities, created_at, last_seen_at, profile_id)
  SELECT id, user_id, name, kind, capabilities, created_at, last_seen_at, profile_id FROM devices;

DROP TABLE devices;
ALTER TABLE devices_next RENAME TO devices;
CREATE INDEX idx_devices_user ON devices(user_id);
