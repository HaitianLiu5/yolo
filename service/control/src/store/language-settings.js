import { YoloError } from "@useyolo/core";

import { LANGUAGE_TAG } from "./voice-settings.js";

// The account's language (Agent Note 2026-11-06-account-language), the
// language_settings table: what every screen on Automatic shows. A user
// without a row has chosen none.

/** The account's language, or null when none is chosen. */
export async function readAccountLanguage(db, userId) {
  const row = await db.prepare("SELECT language FROM language_settings WHERE user_id = ?").bind(userId).first();
  return row?.language ?? null;
}

/** Replaces the account's language; null forgets it. Returns it as kept. */
export async function writeAccountLanguage(db, userId, language, now = Date.now()) {
  if (language === null) {
    await db.prepare("DELETE FROM language_settings WHERE user_id = ?").bind(userId).run();
    return null;
  }
  if (typeof language !== "string" || !LANGUAGE_TAG.test(language)) {
    throw new YoloError("invalid_request", "language must be a language tag, such as \"zh-Hans\", or null");
  }
  await db.prepare(`INSERT INTO language_settings (user_id, language, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET language = excluded.language, updated_at = excluded.updated_at`)
    .bind(userId, language, now).run();
  return language;
}
