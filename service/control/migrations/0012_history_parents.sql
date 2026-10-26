-- The show and season an episode in history belongs to (Agent Note
-- 2026-10-11-yolo-owns-progress-and-resume), so library listings count
-- the episodes of a show or season the owner watched in Yolo:
--   show_key    the source key of the library item the entry belongs to
--               outermost, such as an episode's show; null for an item
--               that belongs to none, or one not played or listed since.
--   season_key  the next one in, such as the episode's season; null
--               without one.
-- Both come from the source's `parents`, when the item plays or a listing
-- names it. The previous release reads `SELECT *`, never names these
-- columns, and its upsert leaves them as they are, so it keeps working;
-- what it records first has none until it plays again or is listed.

ALTER TABLE history ADD COLUMN show_key TEXT;
ALTER TABLE history ADD COLUMN season_key TEXT;

CREATE INDEX idx_history_user_show ON history(user_id, show_key) WHERE show_key IS NOT NULL;
CREATE INDEX idx_history_user_season ON history(user_id, season_key) WHERE season_key IS NOT NULL;
