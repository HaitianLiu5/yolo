import { YoloError } from "@useyolo/core";

// Whether the owner answered the home's cold start, "Where do you usually
// watch?" (Agent Note 2026-10-31-home-cold-start), the home_setup table: one
// row per user, so a skip on one screen counts on every screen. A user
// without a row has a new home.

export const SETUP_STATES = Object.freeze(["new", "done", "skipped"]);

/** { state: "new", "done", or "skipped", updatedAt }: a screen follows a change by its time. */
export async function readHomeSetup(db, userId) {
  const row = await db.prepare("SELECT state, updated_at FROM home_setup WHERE user_id = ?").bind(userId).first();
  return { state: row?.state ?? "new", updatedAt: row?.updated_at ?? null };
}

/** Sets the state; "new" forgets it, so screens show the guide again. Returns readHomeSetup()'s shape. */
export async function writeHomeSetup(db, userId, state, now = Date.now()) {
  if (!SETUP_STATES.includes(state)) throw new YoloError("invalid_request", "state must be new, done, or skipped");
  if (state === "new") {
    await db.prepare("DELETE FROM home_setup WHERE user_id = ?").bind(userId).run();
    return { state: "new", updatedAt: null };
  }
  await db.prepare(`INSERT INTO home_setup (user_id, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)
    .bind(userId, state, now).run();
  return { state, updatedAt: now };
}
