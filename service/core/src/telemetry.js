// Device telemetry (`POST /v1/devices/self/events`,
// Agent Note 2026-10-11-device-telemetry): what a device may send about itself,
// and how both ends keep secrets out of it. The client sanitizes before it
// buffers; the control plane sanitizes again before it writes Workers Logs.

export const DEVICE_EVENTS_PATH = "/v1/devices/self/events";
export const MAX_DEVICE_EVENTS_PER_BATCH = 50;
// Under the 64 KiB a keepalive fetch may carry while the page goes away.
export const MAX_DEVICE_EVENTS_BODY_BYTES = 60 * 1024;
// The largest event is `env` (the browser's description, about 6 KiB).
const MAX_DEVICE_EVENT_BYTES = 8 * 1024;
export const DEVICE_EVENT_TYPE = /^[a-z][a-z0-9_.:-]{0,63}$/i;

const MAX_STRING = 500;
const MAX_DEPTH = 5;
const MAX_KEYS = 60;
const MAX_ITEMS = 100;
// Keys whose values are never sent, at any depth.
const SECRET_KEY = /token|authorization|cookie|ticket|secret|password|credential|passkey/i;

// Media paths carry their token (`/m/<token>/…`); device credentials start
// with `ydt_`; tickets and codes can sit in query strings.
export function redactText(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\/m\/[^/?#\s"'<>]+/g, "/m/<redacted>")
    .replace(/\bydt_[A-Za-z0-9_-]+/g, "ydt_<redacted>")
    .replace(/([?&#](?:ticket|token|access_token|refresh_token|code|device_code|sig|signature)=)[^&#\s"']*/gi, "$1<redacted>");
}

function clean(value, depth) {
  if (value == null) return value ?? null;
  if (typeof value === "string") {
    const text = redactText(value);
    return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "object" || depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => clean(item, depth + 1)).filter((item) => item !== undefined);
  const out = {};
  let keys = 0;
  for (const [key, item] of Object.entries(value)) {
    if (keys >= MAX_KEYS) break;
    if (SECRET_KEY.test(key)) continue;
    const cleaned = clean(item, depth + 1);
    if (cleaned === undefined) continue;
    out[key.slice(0, 64)] = cleaned;
    keys += 1;
  }
  return out;
}

const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

// Plain JSON fields of one event, without secrets, at most
// MAX_DEVICE_EVENT_BYTES: the largest fields go first, and `truncated` names
// them.
export function sanitizeEventFields(fields) {
  const out = clean(fields && typeof fields === "object" && !Array.isArray(fields) ? fields : {}, 0) || {};
  if (size(out) <= MAX_DEVICE_EVENT_BYTES) return out;
  const truncated = [];
  const bySize = Object.keys(out).sort((a, b) => size(out[b]) - size(out[a]));
  for (const key of bySize) {
    delete out[key];
    truncated.push(key);
    if (size({ ...out, truncated }) <= MAX_DEVICE_EVENT_BYTES) break;
  }
  return { ...out, truncated };
}
