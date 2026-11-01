-- The languages the owner speaks to Yolo (Agent Note
-- 2026-10-18-agent-from-the-screen), first first: voice input chooses among
-- them alone and leans to the first. One row per user, written from
-- settings; a user without a row has chosen none, and a recording is heard
-- in its screen's language.
--   languages  a JSON array of BCP 47 tags, such as ["zh-Hans", "en"]
-- The previous release's code never reads this table.

CREATE TABLE voice_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  languages TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
