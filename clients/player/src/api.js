import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER } from "@useyolo/core";
import { requestJson } from "./network.js";

// The player's side of Yolo's /v1 API
// (Agent Note 2026-10-07-v1-http-api). Every call carries the device credential
// this browser got when it was paired (pairing.js); a 401 means the owner
// removed the device, so it pairs again. Every call also names the client
// protocol this page speaks (Agent Note 2026-10-19-client-protocol).

const STORAGE_KEY = "yolo.device";
let credential = load();
let onUnauthorized = () => {};

function load() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return value?.token ? value : null;
  } catch {
    return null;
  }
}

export function getCredential() {
  return credential;
}

export function saveCredential(value) {
  credential = value;
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode: the credential lives for this page only.
  }
}

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

export class ApiError extends Error {
  constructor(message, { code = "internal", status = 0, retryable = false, details = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    // What a refusal adds for this page to act on (media_unreachable's fixes).
    if (details && typeof details === "object") this.details = details;
  }
}

export function authHeaders(extra = {}) {
  const headers = { ...extra, [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL) };
  return credential ? { ...headers, Authorization: `Bearer ${credential.token}` } : headers;
}

// JSON in, JSON out. Throws ApiError with the server's error code.
export async function api(path, { method = "GET", body, timeoutMs = 15_000, label = `${method} ${path}`, retries } = {}) {
  const response = await requestJson(`${location.origin}${path}`, {
    method,
    headers: authHeaders(body === undefined ? {} : { "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { label, timeoutMs, ...(retries !== undefined ? { retries } : {}) });
  if (response.status === 401) {
    onUnauthorized();
    throw new ApiError("This device is no longer paired", { code: "unauthorized", status: 401 });
  }
  if (!response.ok) {
    const error = response.data?.error;
    throw new ApiError(error?.message || `${label} failed with ${response.status}`, {
      code: error?.code || "internal",
      status: response.status,
      retryable: Boolean(error?.retryable),
      details: error?.details ?? null,
    });
  }
  return response.data;
}
