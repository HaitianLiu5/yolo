import { DEVICE_KINDS, newId, normalizeCapabilities, YoloError } from "@useyolo/core";
import { parseJson } from "./rows.js";

function deviceFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    capabilities: parseJson(row.capabilities, {}),
    lastSeenAt: row.last_seen_at ?? null,
  };
}

export async function listDevices(db, userId) {
  const { results } = await db.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC")
    .bind(userId).all();
  return results.map(deviceFromRow);
}

export async function getDevice(db, userId, id) {
  const row = await db.prepare("SELECT * FROM devices WHERE user_id = ? AND id = ?").bind(userId, id).first();
  return row ? deviceFromRow(row) : null;
}

// `hello` from a device: create it on first contact, refresh it afterwards.
export async function upsertDevice(db, userId, { id, name, kind, capabilities }) {
  const now = Date.now();
  const deviceKind = DEVICE_KINDS.includes(kind) ? kind : "browser";
  const deviceName = String(name || "Unnamed device").slice(0, 100);
  const caps = JSON.stringify(normalizeCapabilities(capabilities));
  const existing = id ? await getDevice(db, userId, id) : null;
  if (existing) {
    await db.prepare("UPDATE devices SET name = ?, kind = ?, capabilities = ?, last_seen_at = ? WHERE user_id = ? AND id = ?")
      .bind(deviceName, deviceKind, caps, now, userId, id).run();
    return getDevice(db, userId, id);
  }
  const deviceId = newId("dev");
  await db.prepare("INSERT INTO devices (id, user_id, name, kind, capabilities, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(deviceId, userId, deviceName, deviceKind, caps, now, now).run();
  return getDevice(db, userId, deviceId);
}

// `hello` from a paired device: refresh its row, never create one. Null when
// the device was removed (its credential is then revoked too).
export async function updateDevice(db, userId, id, { name, kind, capabilities }) {
  const existing = await getDevice(db, userId, id);
  if (!existing) return null;
  await db.prepare("UPDATE devices SET name = ?, kind = ?, capabilities = ?, last_seen_at = ? WHERE user_id = ? AND id = ?").bind(
    // The owner named it and chose its type when approving it (or renamed it
    // since); what the device guesses about itself does not override that.
    existing.name || String(name || "Unnamed device").slice(0, 100),
    DEVICE_KINDS.includes(existing.kind) ? existing.kind : DEVICE_KINDS.includes(kind) ? kind : "browser",
    JSON.stringify(normalizeCapabilities(capabilities ?? existing.capabilities)),
    Date.now(),
    userId,
    id,
  ).run();
  return getDevice(db, userId, id);
}

export async function touchDevice(db, userId, id) {
  await db.prepare("UPDATE devices SET last_seen_at = ? WHERE user_id = ? AND id = ?").bind(Date.now(), userId, id).run();
}

// The owner's name and type for a device. Either may be left out.
export async function renameDevice(db, userId, id, { name, kind } = {}) {
  const trimmed = name == null ? null : String(name).trim().slice(0, 100);
  if (name != null && !trimmed) throw new YoloError("invalid_request", "name cannot be empty");
  if (kind != null && !DEVICE_KINDS.includes(kind)) throw new YoloError("invalid_request", `kind must be one of ${DEVICE_KINDS.join(", ")}`);
  if (trimmed == null && kind == null) throw new YoloError("invalid_request", "Pass a name, a kind, or both");
  const result = await db.prepare("UPDATE devices SET name = COALESCE(?, name), kind = COALESCE(?, kind) WHERE user_id = ? AND id = ?")
    .bind(trimmed, kind ?? null, userId, id).run();
  if (!result.meta?.changes) throw new YoloError("not_found", `Device ${id} not found`);
  return getDevice(db, userId, id);
}

// Removing a device also deletes its credentials (revocation).
export async function deleteDevice(db, userId, id) {
  const [result] = await db.batch([
    db.prepare("DELETE FROM devices WHERE user_id = ? AND id = ?").bind(userId, id),
    db.prepare("DELETE FROM device_tokens WHERE user_id = ? AND device_id = ?").bind(userId, id),
  ]);
  if (!result.meta?.changes) throw new YoloError("not_found", `Device ${id} not found`);
}
