-- The account's language (Agent Note 2026-11-06-account-language): what every
-- screen on Automatic shows, unless it chose its own. One row per user,
-- written from settings; a user without a row has chosen none, and each
-- screen follows its browser.
--   language  a BCP 47 tag, such as "zh-Hans"
-- The previous release's code never reads this table.

CREATE TABLE language_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
