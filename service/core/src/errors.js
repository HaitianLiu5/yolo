// Error codes shared by the HTTP API, MCP tools, and the node's internal API
// (Agent Note 2026-10-07-v1-http-api). Every failure crosses a boundary as
// { error: { code, message, retryable, details? } }; `details` is an object
// a refusal adds for a client to act on (media_unreachable's fixes).

export const ERROR_STATUS = Object.freeze({
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  device_offline: 409,
  node_offline: 503,
  resolve_failed: 502,
  superseded: 409,
  // No media path reaches the device and the owner turned the relay off
  // (Agent Note 2026-10-13-media-off-the-worker).
  media_unreachable: 409,
  rate_limited: 429,
  internal: 500,
});

// Error codes a client may retry after a backoff.
export const RETRYABLE_ERROR_CODES = Object.freeze(["device_offline", "node_offline", "resolve_failed", "rate_limited"]);
const RETRYABLE = new Set(RETRYABLE_ERROR_CODES);

export class YoloError extends Error {
  constructor(code, message, { retryable, cause, details } = {}) {
    super(message, { cause });
    this.name = "YoloError";
    this.code = ERROR_STATUS[code] ? code : "internal";
    this.retryable = retryable ?? RETRYABLE.has(this.code);
    if (details && typeof details === "object") this.details = details;
  }

  get status() {
    return ERROR_STATUS[this.code];
  }
}

export function toYoloError(error) {
  if (error instanceof YoloError) return error;
  return new YoloError("internal", error?.message || String(error), { cause: error });
}

export function errorBody(error) {
  const { code, message, retryable, details } = toYoloError(error);
  return { error: { code, message, retryable, ...(details ? { details } : {}) } };
}

// Rebuild a YoloError from a JSON error body received over HTTP.
export function fromErrorBody(body, fallbackStatus) {
  const error = body?.error;
  if (error && typeof error === "object" && typeof error.code === "string") {
    return new YoloError(error.code, error.message || error.code, { retryable: error.retryable, details: error.details });
  }
  const code = Object.keys(ERROR_STATUS).find((key) => ERROR_STATUS[key] === fallbackStatus) || "internal";
  return new YoloError(code, typeof error === "string" ? error : `Request failed with status ${fallbackStatus}`);
}
