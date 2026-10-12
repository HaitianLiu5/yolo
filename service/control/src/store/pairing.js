import { DEVICE_KINDS, newId, normalizeCapabilities, randomToken, sha256, YoloError } from "@useyolo/core";

// Device pairing state (migration 0004). See auth/device.js for the flow.

export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
export const POLL_INTERVAL_SECONDS = 5;
// Anyone can ask for a code; keep a bound on what a flood can leave behind.
const MAX_PENDING_CODES = 20;
// User codes avoid vowels and look-alike letters (RFC 8628 §6.1).
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
export const DEVICE_TOKEN_PREFIX = "ydt_";
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export function newUserCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(USER_CODE_LENGTH));
  return [...bytes].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join("");
}

// "bcdf-ghjk", "BCDF GHJK" and "BCDFGHJK" are the same code.
export function normalizeUserCode(value) {
  const code = String(value ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return code.length === USER_CODE_LENGTH && [...code].every((char) => USER_CODE_ALPHABET.includes(char)) ? code : null;
}

export const formatUserCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

function codeFromRow(row) {
  return row && {
    userCode: row.user_code,
    userId: row.user_id,
    deviceName: row.device_name,
    deviceKind: row.device_kind,
    status: row.status,
    deviceId: row.device_id ?? null,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    lastPolledAt: row.last_polled_at ?? null,
  };
}

export async function createDeviceCode(db, userId, { name, kind }, now = Date.now()) {
  await db.prepare("DELETE FROM device_codes WHERE expires_at < ?").bind(now - DEVICE_CODE_TTL_MS).run();
  const pending = await db.prepare("SELECT COUNT(*) AS count FROM device_codes WHERE status = 'pending' AND expires_at > ?").bind(now).first();
  if ((pending?.count ?? 0) >= MAX_PENDING_CODES) throw new YoloError("rate_limited", "Too many devices are waiting to pair; try again in a few minutes");
  const deviceCode = randomToken(32);
  const userCode = newUserCode();
  const deviceName = String(name || "").trim().slice(0, 60) || "Unnamed device";
  const deviceKind = DEVICE_KINDS.includes(kind) ? kind : "browser";
  await db.prepare(`
    INSERT INTO device_codes (device_code_hash, user_id, user_code, device_name, device_kind, status, requested_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).bind(await sha256(deviceCode), userId, userCode, deviceName, deviceKind, now, now + DEVICE_CODE_TTL_MS).run();
  return { deviceCode, userCode, expiresAt: now + DEVICE_CODE_TTL_MS };
}

export async function getCodeByUserCode(db, userCode) {
  return codeFromRow(await db.prepare("SELECT * FROM device_codes WHERE user_code = ?").bind(userCode).first());
}

// The owner's decision. Only a pending, unexpired code can be decided, once.
// Approving creates the device the credential will belong to, with the name
// and type the owner chose on the approval page (the device's own guess by
// default).
export async function decideDeviceCode(db, userId, userCode, { approve, name = null, kind = null }, now = Date.now()) {
  const code = await getCodeByUserCode(db, userCode);
  if (!code || code.userId !== userId) throw new YoloError("not_found", "No device is waiting for this code");
  if (code.expiresAt <= now) throw new YoloError("invalid_request", "This code has expired; start pairing again on the device");
  if (code.status !== "pending") throw new YoloError("invalid_request", "This code was already used");
  if (kind != null && kind !== "" && !DEVICE_KINDS.includes(kind)) throw new YoloError("invalid_request", `kind must be one of ${DEVICE_KINDS.join(", ")}`);
  const deviceName = String(name ?? "").trim().slice(0, 60) || code.deviceName;
  const deviceKind = DEVICE_KINDS.includes(kind) ? kind : code.deviceKind;
  let deviceId = null;
  if (approve) {
    deviceId = newId("dev");
    await db.prepare("INSERT INTO devices (id, user_id, name, kind, capabilities, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .bind(deviceId, userId, deviceName, deviceKind, JSON.stringify(normalizeCapabilities({})), now).run();
  }
  const result = await db.prepare("UPDATE device_codes SET status = ?, device_id = ? WHERE user_code = ? AND status = 'pending'")
    .bind(approve ? "approved" : "denied", deviceId, userCode).run();
  if (!result.meta?.changes) {
    if (deviceId) await db.prepare("DELETE FROM devices WHERE user_id = ? AND id = ?").bind(userId, deviceId).run();
    throw new YoloError("invalid_request", "This code was already used");
  }
  return { ...code, deviceName: approve ? deviceName : code.deviceName, deviceKind: approve ? deviceKind : code.deviceKind, status: approve ? "approved" : "denied", deviceId };
}

// The device's poll (RFC 8628 §3.4–3.5). Returns { token, deviceId } once,
// or throws an OAuth error code: authorization_pending, slow_down,
// access_denied, expired_token, invalid_grant.
export async function pollDeviceCode(db, deviceCode, now = Date.now()) {
  const hash = await sha256(String(deviceCode ?? ""));
  const row = await db.prepare("SELECT * FROM device_codes WHERE device_code_hash = ?").bind(hash).first();
  const code = codeFromRow(row);
  if (!code || code.status === "consumed") throw Object.assign(new Error("Unknown or used device code"), { oauth: "invalid_grant" });
  if (code.expiresAt <= now) throw Object.assign(new Error("The device code expired"), { oauth: "expired_token" });
  if (code.status === "denied") throw Object.assign(new Error("The owner denied this device"), { oauth: "access_denied" });
  if (code.status === "pending") {
    const tooSoon = code.lastPolledAt && now - code.lastPolledAt < (POLL_INTERVAL_SECONDS - 1) * 1000;
    await db.prepare("UPDATE device_codes SET last_polled_at = ? WHERE device_code_hash = ?").bind(now, hash).run();
    throw Object.assign(new Error(tooSoon ? "Polling too fast" : "Waiting for the owner"), { oauth: tooSoon ? "slow_down" : "authorization_pending" });
  }
  // Approved: hand out the credential exactly once.
  const consumed = await db.prepare("UPDATE device_codes SET status = 'consumed' WHERE device_code_hash = ? AND status = 'approved'").bind(hash).run();
  if (!consumed.meta?.changes) throw Object.assign(new Error("Unknown or used device code"), { oauth: "invalid_grant" });
  const token = `${DEVICE_TOKEN_PREFIX}${randomToken(32)}`;
  await db.prepare("INSERT INTO device_tokens (token_hash, user_id, device_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), code.userId, code.deviceId, now).run();
  return { token, deviceId: code.deviceId, userId: code.userId };
}

// A device credential → { userId, deviceId }, or null. The device must still
// exist: removing it revokes the credential at once.
export async function resolveDeviceToken(db, token, now = Date.now()) {
  if (typeof token !== "string" || !token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  const hash = await sha256(token);
  const row = await db.prepare(`
    SELECT t.user_id, t.device_id, t.last_used_at FROM device_tokens t
    JOIN devices d ON d.id = t.device_id AND d.user_id = t.user_id
    WHERE t.token_hash = ?
  `).bind(hash).first();
  if (!row) return null;
  if (!row.last_used_at || now - row.last_used_at > TOUCH_INTERVAL_MS) {
    await db.prepare("UPDATE device_tokens SET last_used_at = ? WHERE token_hash = ?").bind(now, hash).run();
  }
  return { userId: row.user_id, deviceId: row.device_id };
}

export async function revokeDeviceTokens(db, userId, deviceId) {
  const result = await db.prepare("DELETE FROM device_tokens WHERE user_id = ? AND device_id = ?").bind(userId, deviceId).run();
  return result.meta?.changes ?? 0;
}
