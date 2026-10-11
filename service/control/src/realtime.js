import { errorBody, randomToken, sha256, YoloError } from "@useyolo/core";

// WebSocket auth (yolo-v1.md §3): POST /v1/realtime/ticket with a bearer
// token returns a one-time ticket valid for 30 seconds, then the client opens
// wss://…/v1/realtime?ticket=….

const TICKET_TTL_MS = 30_000;
const ticketKey = async (ticket) => `yolo:ticket:${await sha256(ticket)}`;

// A paired device's ticket carries its device id, so its connection can only
// ever be that device (Hub.hello).
export async function issueRealtimeTicket(env, userId, { deviceId = null } = {}) {
  const ticket = randomToken();
  const expiresAt = Date.now() + TICKET_TTL_MS;
  // KV's minimum TTL is 60s; expiresAt enforces the 30s lifetime.
  await env.OAUTH_KV.put(await ticketKey(ticket), JSON.stringify({ userId, deviceId, expiresAt }), { expirationTtl: 60 });
  return { ticket, expiresAt };
}

// → { userId, deviceId } or null.
export async function redeemRealtimeTicket(env, ticket) {
  if (!ticket) return null;
  const key = await ticketKey(ticket);
  const value = JSON.parse((await env.OAUTH_KV.get(key)) || "null");
  if (!value) return null;
  await env.OAUTH_KV.delete(key);
  return value.expiresAt > Date.now() ? { userId: value.userId, deviceId: value.deviceId ?? null } : null;
}

export async function handleRealtime(request, env) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Response.json(errorBody(new YoloError("invalid_request", "Expected a WebSocket upgrade")), { status: 426 });
  }
  const redeemed = await redeemRealtimeTicket(env, new URL(request.url).searchParams.get("ticket"));
  if (!redeemed) return Response.json(errorBody(new YoloError("unauthorized", "Missing or expired ticket")), { status: 401 });
  const stub = env.HUB.get(env.HUB.idFromName(redeemed.userId));
  const headers = new Headers(request.headers);
  headers.set("x-yolo-user", redeemed.userId);
  headers.delete("x-yolo-device");
  if (redeemed.deviceId) headers.set("x-yolo-device", redeemed.deviceId);
  return stub.fetch(new Request(request, { headers }));
}
