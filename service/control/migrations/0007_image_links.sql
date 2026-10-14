-- Image links for agents (Agent Note 2026-10-07-remote-mcp-server): the key
-- version that every cover link an agent gets is sealed with, one row per
-- user.
--   key_version  a user without a row is at version 1; each reset adds one,
--                and every link sealed with an older version stops working
--   reset_at     when the owner (settings, POST /v1/owner/image-links/reset)
--                or the operator (npm run yolo -- image-links reset) last
--                reset image links
-- The previous release never reads this table.

CREATE TABLE image_links (
  user_id TEXT PRIMARY KEY,
  key_version INTEGER NOT NULL DEFAULT 1,
  reset_at INTEGER
);
