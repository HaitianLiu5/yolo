-- Whether the owner has watched an item (Agent Note
-- 2026-10-11-yolo-owns-progress-and-resume), kept by Yolo rather than read
-- from the position, so playing a watched item again keeps its mark:
--   watched_at  when progress first reached the item's last minute (or 5%,
--               @useyolo/core's isFinished), or its end; null until then.
--               Playing it again, from the start or anywhere, never clears
--               it; deleting the entry does.
-- Rows already finished are marked watched at their last update. The
-- previous release reads `SELECT *` and never names this column, so it
-- keeps working, and leaves the mark of what it finishes unset.

ALTER TABLE history ADD COLUMN watched_at INTEGER;

UPDATE history SET watched_at = updated_at
  WHERE duration > 0 AND position >= duration - MIN(60, duration * 0.05);
