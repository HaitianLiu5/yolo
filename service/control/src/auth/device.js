import { toYoloError } from "@useyolo/core";
import { getOwner } from "../store/users.js";
import {
  createDeviceCode,
  decideDeviceCode,
  DEVICE_CODE_TTL_MS,
  formatUserCode,
  getCodeByUserCode,
  normalizeUserCode,
  pollDeviceCode,
  POLL_INTERVAL_SECONDS,
} from "../store/pairing.js";
import { deviceCodeForm, deviceConfirmPage, messagePage } from "./pages.js";
import { getSession } from "./session.js";

// Pairing a device that has no keyboard (decision 15): the OAuth 2.0 Device
// Authorization Grant (RFC 8628). workers-oauth-provider does not implement
// it, so the control plane does:
//
// 1. The device POSTs /oauth/device_authorization and shows a QR code of
//    verification_uri_complete plus the short user code.
// 2. The owner opens /device?code=… on a phone, signs in with the passkey if
//    needed, sees the device's name, type and request time, can change the
//    name and type (the device only guesses: the Tesla browser's user agent
//    is plain desktop Chrome), and presses Allow (or Deny). Codes expire
//    after 10 minutes and are used once.
// 3. The device polls POST /oauth/token with grant_type device_code and gets
//    a device credential once. It works for /v1 and /v1/realtime (not /mcp),
//    and removing the device revokes it.

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_SCOPES = Object.freeze(["read", "control", "manage"]);

const origin = (env, request) => new URL(env.PUBLIC_ORIGIN || request.url).origin;
const noStore = { "cache-control": "no-store" };

async function formOrJson(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) return request.json().catch(() => ({}));
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    return Object.fromEntries((await request.formData().catch(() => new FormData())).entries());
  }
  return {};
}

function oauthError(error, description, status = 400) {
  return Response.json({ error, error_description: description }, { status, headers: noStore });
}

// POST /oauth/device_authorization (RFC 8628 §3.1–3.2). Yolo extensions:
// device_name and device_kind, shown to the owner before they approve.
export async function deviceAuthorization(request, env) {
  const body = await formOrJson(request);
  const owner = await getOwner(env.DB);
  if (!owner) return oauthError("invalid_request", "Yolo is not set up yet: create the owner passkey at /login first");
  try {
    const { deviceCode, userCode } = await createDeviceCode(env.DB, owner.id, { name: body.device_name, kind: body.device_kind });
    const base = origin(env, request);
    return Response.json({
      device_code: deviceCode,
      user_code: formatUserCode(userCode),
      verification_uri: `${base}/device`,
      verification_uri_complete: `${base}/device?code=${formatUserCode(userCode)}`,
      expires_in: DEVICE_CODE_TTL_MS / 1000,
      interval: POLL_INTERVAL_SECONDS,
    }, { headers: noStore });
  } catch (error) {
    const yolo = toYoloError(error);
    return oauthError(yolo.code === "rate_limited" ? "slow_down" : "invalid_request", yolo.message, yolo.status);
  }
}

// The device grant on POST /oauth/token, or null for any other grant (the
// OAuth provider handles those). The request is cloned, so the provider can
// still read it.
export async function deviceTokenRequest(request, env) {
  const body = await formOrJson(request.clone());
  if (body.grant_type !== DEVICE_GRANT_TYPE) return null;
  if (!body.device_code) return oauthError("invalid_request", "device_code is required");
  try {
    const { token, deviceId } = await pollDeviceCode(env.DB, body.device_code);
    return Response.json({
      access_token: token,
      token_type: "Bearer",
      scope: DEVICE_SCOPES.join(" "),
      device_id: deviceId,
    }, { headers: noStore });
  } catch (error) {
    if (error.oauth) return oauthError(error.oauth, error.message);
    throw error;
  }
}

// Advertise the device grant next to the provider's own metadata.
export async function withDeviceMetadata(response, env, request) {
  if (!response.ok || !(response.headers.get("content-type") || "").includes("json")) return response;
  const metadata = await response.json();
  metadata.device_authorization_endpoint = `${origin(env, request)}/oauth/device_authorization`;
  metadata.grant_types_supported = [...new Set([...(metadata.grant_types_supported || []), DEVICE_GRANT_TYPE])];
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(metadata), { status: response.status, headers });
}

// The /device pages, mounted on the auth app (auth/app.js).
export function registerDevicePages(app) {
  const db = (c) => c.env.DB;

  async function owner(c) {
    const session = await getSession(c.env.OAUTH_KV, c.req.raw);
    if (session) return session;
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }

  app.get("/device", async (c) => {
    const session = await owner(c);
    if (session instanceof Response) return session;
    const raw = c.req.query("code");
    if (!raw) return c.html(deviceCodeForm());
    const userCode = normalizeUserCode(raw);
    const code = userCode ? await getCodeByUserCode(db(c), userCode) : null;
    if (!code || code.userId !== session.userId) return c.html(deviceCodeForm("No device is waiting for that code. Check the code on the device's screen."), 404);
    if (code.status !== "pending") return messagePage("Code already used", "This pairing code was already used. Start pairing again on the device.");
    if (code.expiresAt <= Date.now()) return messagePage("Code expired", "Pairing codes last 10 minutes. Start pairing again on the device.");
    return c.html(deviceConfirmPage({ ...code, userCode: formatUserCode(code.userCode) }));
  });

  app.post("/device", async (c) => {
    const session = await getSession(c.env.OAUTH_KV, c.req.raw);
    if (!session) return messagePage("Signed out", "Sign in again, then scan the code on the device once more.", 401);
    // The session cookie is SameSite=Lax; also refuse cross-site posts.
    const from = c.req.header("origin");
    if (from && from !== origin(c.env, c.req.raw) && from !== new URL(c.req.url).origin) {
      return messagePage("Not allowed", "This approval did not come from Yolo's own page.", 403);
    }
    const form = await c.req.raw.formData();
    const userCode = normalizeUserCode(form.get("code"));
    if (!userCode) return c.html(deviceCodeForm("That is not a pairing code."), 400);
    const approve = form.get("decision") === "approve";
    try {
      // The owner's name and type for the device (the page fills in the
      // device's own guess).
      const decided = await decideDeviceCode(db(c), session.userId, userCode, {
        approve, name: form.get("name"), kind: form.get("kind"),
      });
      return approve
        ? messagePage("Device allowed", `${decided.deviceName} can now play on Yolo. It connects within a few seconds. You can remove it later from Yolo's device list.`, 200)
        : messagePage("Device denied", `${decided.deviceName} was not paired.`, 200);
    } catch (error) {
      const yolo = toYoloError(error);
      if (yolo.code === "internal") throw error;
      return messagePage("Cannot pair", yolo.message, yolo.status);
    }
  });

  app.post("/oauth/device_authorization", (c) => deviceAuthorization(c.req.raw, c.env));
}

