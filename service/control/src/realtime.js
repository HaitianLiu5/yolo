import { errorBody, fromErrorBody, YoloError } from "@useyolo/core";

// WebSocket auth (Agent Note 2026-10-07-hub-and-realtime-channel): POST
// /v1/realtime/ticket with a bearer token returns a one-time ticket valid for
// 30 seconds, then the client opens wss://…/v1/realtime?ticket=….
//
// A ticket is `<hub id>.<secret>`. The user's Hub Durable Object keeps the
// secret's hash (HubCore.issueTicket) and redeems it on the upgrade, so a
// connection costs no KV write. The hub id is the Durable Object id, which
// HUB.idFromString accepts only for ids of this namespace: a made-up ticket
// is refused here without waking any Hub.

export const TICKET_HEADER = "x-yolo-ticket";

export async function issueRealtimeTicket(env, userId, { deviceId = null } = {}) {
  const id = env.HUB.idFromName(userId);
  const result = await env.HUB.get(id).call(userId, "issueTicket", [deviceId]);
  if (!result?.ok) throw fromErrorBody(result, 500);
  return { ticket: `${id.toString()}.${result.value.secret}`, expiresAt: result.value.expiresAt };
}

// The Hub a ticket names, and the secret it redeems; null for anything else.
function ticketHub(env, ticket) {
  const dot = String(ticket ?? "").indexOf(".");
  if (dot < 1) return null;
  try {
    return { id: env.HUB.idFromString(ticket.slice(0, dot)), secret: ticket.slice(dot + 1) };
  } catch {
    return null;
  }
}

export async function handleRealtime(request, env) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Response.json(errorBody(new YoloError("invalid_request", "Expected a WebSocket upgrade")), { status: 426 });
  }
  const hub = ticketHub(env, new URL(request.url).searchParams.get("ticket"));
  if (!hub?.secret) return Response.json(errorBody(new YoloError("unauthorized", "Missing or expired ticket")), { status: 401 });
  // The Hub learns the device only from the ticket it stored.
  const headers = new Headers(request.headers);
  headers.delete("x-yolo-user");
  headers.delete("x-yolo-device");
  headers.set(TICKET_HEADER, hub.secret);
  return env.HUB.get(hub.id).fetch(new Request(request, { headers }));
}
