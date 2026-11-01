import { newId, OWNER_PROFILE, YoloError } from "@useyolo/core";

// Profiles, who is watching (Agent Note 2026-10-31-screen-sessions): the
// owner's, always first, with the reserved id `owner` and no row, then the
// owner's list. A profile owns its history, watched marks, and track
// choices; a screen has a default one (devices.profile_id, NULL for the
// owner's). Family is an entry like any other, made the first time a screen
// is set to it.

export const OWNER_NAME = "Owner";
export const FAMILY_NAME = "Family";
const MAX_PROFILES = 20;

const profileName = (name) => {
  const trimmed = String(name ?? "").trim().slice(0, 40);
  if (!trimmed) throw new YoloError("invalid_request", "A profile needs a name");
  return trimmed;
};

export async function listProfiles(db, userId) {
  const { results } = await db.prepare("SELECT id, name FROM profiles WHERE user_id = ? ORDER BY created_at ASC, rowid ASC").bind(userId).all();
  return [{ id: OWNER_PROFILE, name: OWNER_NAME }, ...results.map((row) => ({ id: row.id, name: row.name }))];
}

export async function getProfile(db, userId, id) {
  if (!id || id === OWNER_PROFILE) return { id: OWNER_PROFILE, name: OWNER_NAME };
  const row = await db.prepare("SELECT id, name FROM profiles WHERE user_id = ? AND id = ?").bind(userId, id).first();
  return row ? { id: row.id, name: row.name } : null;
}

// `ref` is a profile's id or name, as an agent or a page names it; "family"
// names the Family profile and makes it when there is none yet.
export async function resolveProfile(db, userId, ref) {
  const wanted = String(ref ?? "").trim();
  if (!wanted) throw new YoloError("invalid_request", "profile is required");
  const profiles = await listProfiles(db, userId);
  const lower = wanted.toLowerCase();
  const found = profiles.find((profile) => profile.id === wanted)
    ?? profiles.find((profile) => profile.name.toLowerCase() === lower)
    ?? (["me", "owner"].includes(lower) ? profiles[0] : null);
  if (found) return found;
  if (lower === FAMILY_NAME.toLowerCase()) return createProfile(db, userId, { name: FAMILY_NAME });
  throw new YoloError("not_found", `No profile matches "${ref}". The profiles are ${profiles.map((profile) => profile.name).join(", ")}.`);
}

export async function createProfile(db, userId, { name }) {
  const shown = profileName(name);
  const profiles = await listProfiles(db, userId);
  if (profiles.some((profile) => profile.name.toLowerCase() === shown.toLowerCase())) {
    throw new YoloError("invalid_request", `A profile named "${shown}" exists already`);
  }
  if (profiles.length > MAX_PROFILES) throw new YoloError("invalid_request", `At most ${MAX_PROFILES} profiles`);
  const id = newId("prf");
  await db.prepare("INSERT INTO profiles (id, user_id, name, created_at) VALUES (?, ?, ?, ?)").bind(id, userId, shown, Date.now()).run();
  return { id, name: shown };
}

export async function renameProfile(db, userId, id, { name }) {
  if (id === OWNER_PROFILE) throw new YoloError("invalid_request", "The owner's profile keeps its name");
  const shown = profileName(name);
  const others = (await listProfiles(db, userId)).filter((profile) => profile.id !== id);
  if (others.some((profile) => profile.name.toLowerCase() === shown.toLowerCase())) {
    throw new YoloError("invalid_request", `A profile named "${shown}" exists already`);
  }
  const result = await db.prepare("UPDATE profiles SET name = ? WHERE user_id = ? AND id = ?").bind(shown, userId, id).run();
  if (!result.meta?.changes) throw new YoloError("not_found", `Profile ${id} not found`);
  return { id, name: shown };
}

// Its history and track choices go, and its screens become the owner's.
export async function deleteProfile(db, userId, id) {
  if (id === OWNER_PROFILE) throw new YoloError("invalid_request", "The owner's profile cannot be removed");
  const profile = await getProfile(db, userId, id);
  if (!profile) throw new YoloError("not_found", `Profile ${id} not found`);
  await db.batch([
    db.prepare("DELETE FROM profiles WHERE user_id = ? AND id = ?").bind(userId, id),
    db.prepare("DELETE FROM profile_history WHERE user_id = ? AND profile_id = ?").bind(userId, id),
    db.prepare("DELETE FROM profile_track_preferences WHERE user_id = ? AND profile_id = ?").bind(userId, id),
    db.prepare("UPDATE devices SET profile_id = NULL WHERE user_id = ? AND profile_id = ?").bind(userId, id),
  ]);
  return profile;
}
