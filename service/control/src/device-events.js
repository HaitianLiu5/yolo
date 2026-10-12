import {
  createRateLimit,
  DEVICE_EVENT_TYPE,
  MAX_DEVICE_EVENTS_BODY_BYTES,
  MAX_DEVICE_EVENTS_PER_BATCH,
  redactText,
  sanitizeEventFields,
  YoloError,
} from "@useyolo/core";

// POST /v1/devices/self/events (Agent Note 2026-10-11-device-telemetry): a
// paired device's telemetry. Nothing is stored in D1: every event becomes one
// structured Workers Logs line, `{ kind: "device_event", deviceId, sessionId,
// type, at, … }`, which the Observability query builder filters by field.

// The client sends at most one batch every 10 seconds, plus a keepalive one
// when the page hides or freezes. Per isolate, so best effort; the batch and
// body limits bound what any one request can write.
const BATCH_LIMIT = { max: 12, windowMs: 60_000 };
const MAX_TRACKED_DEVICES = 200;
const limits = new Map();

export function allowDeviceEvents(deviceId, now = Date.now) {
  let allow = limits.get(deviceId);
  if (!allow) {
    if (limits.size >= MAX_TRACKED_DEVICES) limits.delete(limits.keys().next().value);
    allow = createRateLimit(BATCH_LIMIT, now);
    limits.set(deviceId, allow);
  }
  return allow();
}

const byteLength = (text) => new TextEncoder().encode(text).length;
const shortText = (value, max) => (typeof value === "string" && value ? redactText(value).slice(0, max) : null);

// The request body as text → { pageId, dropped, events }, or invalid_request.
export function parseDeviceEvents(text) {
  if (byteLength(text) > MAX_DEVICE_EVENTS_BODY_BYTES) {
    throw new YoloError("invalid_request", `A batch of device events is limited to ${MAX_DEVICE_EVENTS_BODY_BYTES} bytes`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new YoloError("invalid_request", "Request body must be JSON");
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.events)) {
    throw new YoloError("invalid_request", "events must be an array");
  }
  if (body.events.length > MAX_DEVICE_EVENTS_PER_BATCH) {
    throw new YoloError("invalid_request", `At most ${MAX_DEVICE_EVENTS_PER_BATCH} events per batch`);
  }
  return {
    pageId: shortText(body.pageId, 32),
    dropped: Number.isInteger(body.dropped) && body.dropped > 0 ? body.dropped : 0,
    events: body.events,
  };
}

// One log line per valid event. The device id comes from the credential,
// never from the body.
export function logDeviceEvents({ userId, deviceId, batch, log = console.log, now = Date.now() }) {
  let accepted = 0;
  let rejected = 0;
  const base = { kind: "device_event", userId, deviceId, pageId: batch.pageId };
  for (const event of batch.events) {
    if (!event || typeof event !== "object" || typeof event.type !== "string" || !DEVICE_EVENT_TYPE.test(event.type)) {
      rejected += 1;
      continue;
    }
    const at = Number(event.at);
    log({
      ...sanitizeEventFields(event.fields),
      ...base,
      sessionId: shortText(event.sessionId, 64),
      type: event.type,
      at: Number.isFinite(at) && at > 0 ? Math.round(at) : now,
      seq: Number.isInteger(event.seq) ? event.seq : null,
      receivedAt: now,
    });
    accepted += 1;
  }
  if (batch.dropped) log({ ...base, sessionId: null, type: "events_dropped", at: now, count: batch.dropped, receivedAt: now });
  return { accepted, rejected };
}
