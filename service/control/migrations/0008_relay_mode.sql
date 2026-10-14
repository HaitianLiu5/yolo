-- The relay's three modes (Agent Note 2026-10-13-media-off-the-worker), one
-- per user in media_settings:
--   relay_mode  'auto'  the relay carries a screen's media only when no
--                       direct path works for it (the default)
--               'on'    the relay is allowed as a path of its own
--               'off'   the Worker never relays media
--   relay       stays whether the Worker relays at all: 0 for 'off', 1
--               for 'auto' and 'on'. The previous release reads only this
--               column, so it relays for 'auto' too, as the fallback its
--               screens already take last.
-- A user without a row is 'auto'; relay_accepted_at gates nothing anymore.
--
-- The mapping:
-- - relay = 1 becomes 'on': the owner kept it on, or turned it on.
-- - relay = 0 becomes 'off' only after an explicit choice by the owner:
--   relay_accepted_at is set (they turned the relay on, then off), or the
--   user existed before 0006 was written (2026-10-13 23:03:23 UTC,
--   1791932603000 ms), so 0006 gave them the relay on and only the owner
--   turned it off. relay_accepted_at alone misses that second case, since
--   0006 wrote no acceptance time; updated_at cannot tell it apart either,
--   because turning remote access on writes a row with relay = 0 too.
-- - Every other relay = 0 row was written when the owner turned remote
--   access on with the relay off by default: it becomes 'auto'.

ALTER TABLE media_settings ADD COLUMN relay_mode TEXT NOT NULL DEFAULT 'auto' CHECK (relay_mode IN ('auto', 'on', 'off'));

UPDATE media_settings SET relay_mode = 'on' WHERE relay = 1;

UPDATE media_settings SET relay_mode = 'off'
  WHERE relay = 0
    AND (relay_accepted_at IS NOT NULL OR user_id IN (SELECT id FROM users WHERE created_at < 1791932603000));

UPDATE media_settings SET relay = 1 WHERE relay = 0 AND relay_mode = 'auto';
