import { YoloError } from "@useyolo/core";

// The languages the owner speaks to Yolo (Agent Note
// 2026-10-18-agent-from-the-screen), the voice_settings table: at most four
// BCP 47 tags, first first. A user without a row has chosen none.

export const MAX_VOICE_LANGUAGES = 4;
const TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function parse(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter((tag) => typeof tag === "string" && TAG.test(tag)) : [];
  } catch {
    return [];
  }
}

/** The owner's languages, first first; [] when they chose none. */
export async function readVoiceLanguages(db, userId) {
  const row = await db.prepare("SELECT languages FROM voice_settings WHERE user_id = ?").bind(userId).first();
  return row ? parse(row.languages) : [];
}

/** Replaces the owner's languages; [] forgets them. Returns them as kept. */
export async function writeVoiceLanguages(db, userId, languages, now = Date.now()) {
  if (!Array.isArray(languages) || languages.some((tag) => typeof tag !== "string" || !TAG.test(tag))) {
    throw new YoloError("invalid_request", "languages must be a list of language tags, such as [\"zh-Hans\", \"en\"]");
  }
  const kept = [...new Set(languages)];
  if (kept.length > MAX_VOICE_LANGUAGES) throw new YoloError("invalid_request", `Choose at most ${MAX_VOICE_LANGUAGES} languages`);
  if (!kept.length) {
    await db.prepare("DELETE FROM voice_settings WHERE user_id = ?").bind(userId).run();
    return [];
  }
  await db.prepare(`INSERT INTO voice_settings (user_id, languages, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET languages = excluded.languages, updated_at = excluded.updated_at`)
    .bind(userId, JSON.stringify(kept), now).run();
  return kept;
}
