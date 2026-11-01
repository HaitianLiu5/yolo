-- The home's cold start and agents' plugin requests (Agent Note
-- 2026-10-31-home-cold-start).
--
-- home_setup: whether the owner answered "Where do you usually watch?", one
-- row per user, so no other screen asks again. A user without a row has a
-- new home, and a screen shows the guide.
--   state  "done" (chose a place, or "Just ask my agent") or "skipped"
-- Every user before this migration ran an earlier release and keeps the
-- plugins it loaded, so the migration marks them done.
--
-- plugin_requests: an agent's request over MCP to turn a plugin or a place
-- on, or change a plugin's options, which waits for the owner's passkey. It
-- lasts 10 minutes and works once.
--   target      the plugin's package name, or "place:<id>"
--   change      the change as JSON: { enabled?, options? }
--   client      the OAuth client's name that asked
--   code_hash   SHA-256 of the short code the agent gives the owner
--   status      "pending", "allowed", "denied", or "failed"
-- The previous release's code never reads either table.

CREATE TABLE home_setup (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('done', 'skipped')),
  updated_at INTEGER NOT NULL
);

INSERT INTO home_setup (user_id, state, updated_at)
  SELECT id, 'done', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM users;

CREATE TABLE plugin_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  change TEXT NOT NULL,
  client TEXT,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'allowed', 'denied', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE INDEX plugin_requests_user ON plugin_requests (user_id, status, expires_at);
