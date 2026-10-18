import { errorBody, toYoloError, YoloError } from "@useyolo/core";
import { nodeFetch } from "./node-client.js";
import { relayEnabled } from "./store/media-settings.js";

// /m/{token}/… is passed through to the node unchanged
// (Agent Note 2026-10-07-same-origin-media-passthrough): the relay, the last
// media path, served unless the token's user turned it off in settings
// (Agent Note 2026-10-13-media-off-the-worker); then 403 RELAY_OFF without
// reaching the node. Which streams take the relay is the screens' and the
// Hub's choice, not this passthrough's. The token in the path is the
// credential; the node verifies it locally.
const FORWARDED_HEADERS = ["range", "if-none-match", "if-modified-since", "accept"];

// The user a media token names (sessionId.userId.exp.signature), unverified:
// it only picks whose relay switch applies.
function tokenUser(pathname) {
  const user = /^\/m\/[A-Za-z0-9_-]{1,64}\.([A-Za-z0-9_-]{1,64})\.\d+\.[A-Za-z0-9_-]+\//.exec(pathname)?.[1];
  return user ?? null;
}

export async function relayMedia(request, env, { relayOn = (userId) => relayEnabled(env.DB, userId) } = {}) {
  const userId = tokenUser(new URL(request.url).pathname);
  if (!userId || !(await relayOn(userId))) {
    const error = new YoloError("forbidden", "The relay is off: this screen plays from the home node directly, or the owner turns the relay to Automatic in Yolo's settings");
    return Response.json(errorBody(error), { status: 403, headers: { "x-yolo-error-code": "RELAY_OFF", "cache-control": "no-store" } });
  }
  return proxyMedia(request, env);
}

async function proxyMedia(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const url = new URL(request.url);
  const headers = {};
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  try {
    const upstream = await nodeFetch(env, url.pathname + url.search, {
      method: request.method, headers, raw: true, passthrough: true, timeoutMs: 30_000, signal: request.signal,
    });
    return new Response(upstream.body, upstream);
  } catch (error) {
    const yolo = toYoloError(error);
    return Response.json(errorBody(yolo), { status: yolo.status });
  }
}
