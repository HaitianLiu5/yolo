import { createRateLimit, errorBody, YoloError } from "@useyolo/core";

// Per-address limits on what anyone can reach without a credential
// (Agent Note 2026-10-07-control-plane-on-cloudflare-media-node-at-home):
// those requests write KV, query D1, or reach the home node, and nothing else
// bounds them. Two Workers rate-limit bindings (wrangler.jsonc `ratelimits`):
//   PUBLIC_LIMIT        sign-in (/login, /auth/*), pairing (/device, the
//                       device grant), and OAuth (/oauth/*), counted per request
//   MEDIA_DENIED_LIMIT  /m/* requests whose token the node refused (403, or
//                       410 for an expired token or session); an address over
//                       it gets 429 for /m/* at the edge for a minute, without
//                       reaching the node
// /m/* stays authorized by its token alone: a valid token is never counted.
// The bindings' counters are per Cloudflare location and eventually
// consistent, which is enough to stop a flood. A Worker without them limits
// nothing.

const PUBLIC_PATH = /^\/(?:oauth\/|auth\/|login$|device$)/;
const BLOCK_MS = 60_000;
const MAX_BLOCKED = 1_000;
// Addresses over MEDIA_DENIED_LIMIT, per isolate: address → blocked until.
const blocked = new Map();

const clientAddress = (request) => request.headers.get("cf-connecting-ip") || "unknown";

function tooMany(message) {
  return Response.json(errorBody(new YoloError("rate_limited", message)), { status: 429, headers: { "retry-after": String(BLOCK_MS / 1000) } });
}

// A 429 for a public route over its limit, or null to go on.
export async function limitPublicRequest(request, env) {
  if (!env.PUBLIC_LIMIT || !PUBLIC_PATH.test(new URL(request.url).pathname)) return null;
  const { success } = await env.PUBLIC_LIMIT.limit({ key: clientAddress(request) });
  return success ? null : tooMany("Too many requests from this address; retry in a minute");
}

// The node's answer to a token it would not serve; a source's own denial
// carries UPSTREAM_ACCESS_DENIED and is not the token's fault.
const refusedToken = (response) => response.status === 410
  || (response.status === 403 && response.headers.get("x-yolo-error-code") !== "UPSTREAM_ACCESS_DENIED");

// `forward()` passes the request to the node.
export async function guardMedia(request, env, forward) {
  if (!env.MEDIA_DENIED_LIMIT) return forward();
  const address = clientAddress(request);
  const until = blocked.get(address);
  if (until > Date.now()) return tooMany("Too many refused media requests from this address");
  if (until) blocked.delete(address);
  const response = await forward();
  if (!refusedToken(response)) return response;
  const { success } = await env.MEDIA_DENIED_LIMIT.limit({ key: address });
  if (success) return response;
  if (blocked.size >= MAX_BLOCKED) blocked.delete(blocked.keys().next().value);
  blocked.set(address, Date.now() + BLOCK_MS);
  await response.body?.cancel();
  return tooMany("Too many refused media requests from this address");
}

// Frames per agent (Agent Note 2026-10-13-video-frames): the FRAME_LIMIT
// binding counts get_frame and get_storyboard calls, each tool on its own,
// by user and OAuth client, or by paired device. Without the binding, each
// isolate counts on its own.
const FRAME_LIMIT = { max: 20, windowMs: 60_000 };
const MAX_FRAME_KEYS = 1_000;
const frameCounts = new Map();

export function frameLimiter(env, agent) {
  return async (tool = "frame") => {
    const key = `${agent}:${tool}`;
    if (env.FRAME_LIMIT) return (await env.FRAME_LIMIT.limit({ key })).success;
    if (!frameCounts.has(key)) {
      if (frameCounts.size >= MAX_FRAME_KEYS) frameCounts.delete(frameCounts.keys().next().value);
      frameCounts.set(key, createRateLimit(FRAME_LIMIT));
    }
    return frameCounts.get(key)();
  };
}
