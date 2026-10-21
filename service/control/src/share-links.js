import {
  errorBody, LOAD_REASONS, MEDIA_TOKEN_TTL_SECONDS, newId, normalizeCapabilities, signMediaToken, toYoloError, YoloError,
} from "@useyolo/core";
import { mediaWelcome } from "./edge/paths.js";
import { createImageLinks } from "./image-links.js";
import { limitShareRequest } from "./rate-limit.js";
import { imageLinkVersion } from "./store/image-links.js";
import { findShareLink, noteSharePlay, shareStatus } from "./store/share-links.js";

// Share links (Agent Note 2026-10-20-share-links). The owner sends a friend
// /s/<token>; the player's page there (clients/player/src/share.js) plays
// that one item without pairing, through two routes that answer without a
// credential and never reach the Hub, so a friend's stream changes nothing
// the owner's screens show or Yolo keeps: no playback state, history,
// queue, or track preferences, and no Plex watch position (the node writes
// that only from the Hub's reports).
//   GET  /v1/share/<token>         the item's title, cover, and duration, the
//                                  link's expiry, and the media paths a
//                                  friend may try
//   POST /v1/share/<token>/stream  a stream of it, prepared by the node for
//                                  the friend's browser
// A friend is never on the owner's home network as far as Yolo knows, so
// the paths are remote direct play, when the owner turned it on, then the
// relay, as the owner's relay mode allows. The node keeps friends' sessions
// apart from the owner's and plays at most two of them at once.

export const SHARE_API_PATH = "/v1/share/";
export const SHARE_PAGE_PATH = "/s/";
const PREPARE_TIMEOUT_MS = 60_000;
const MIN_VIDEO_KBPS = 100;
const MAX_VIDEO_KBPS = 50_000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 16 * 1024;
const ROUTE = /^\/v1\/share\/([^/]+)(\/stream)?$/;

function refuse(error, status = toYoloError(error).status) {
  return Response.json(errorBody(error), { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

// The friend's page says these in place of the player; the owner's own
// words for why are in settings.
const ENDED = {
  expired: "This share link has expired. Ask for a new one.",
  revoked: "This video is no longer shared. Ask for a new link.",
};

async function openLink(db, token, now) {
  const link = await findShareLink(db, token);
  if (!link) throw new YoloError("not_found", "No video is shared at this link");
  const status = shareStatus(link, now);
  if (status !== "active") throw Object.assign(new YoloError("not_found", ENDED[status]), { gone: true });
  return link;
}

// Remote direct play when the owner turned it on, and the relay's mode;
// never the LAN listener, whose name and address are the home's.
async function friendMedia(env, userId) {
  const media = await mediaWelcome(env, userId);
  return { media, paths: media.paths.filter((entry) => entry.path === "wan"), relayMode: media.relayMode ?? "auto" };
}

async function readBody(request) {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new YoloError("invalid_request", "The request is too large");
  if (!(request.headers.get("content-type") || "").includes("application/json")) return {};
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value : {};
  } catch {
    throw new YoloError("invalid_request", "Request body must be JSON");
  }
}

const number = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);

function viewportOf(value) {
  if (!value || typeof value !== "object") return null;
  return { width: number(value.width), height: number(value.height), devicePixelRatio: number(value.devicePixelRatio) };
}

function limitsOf(maxVideoKbps) {
  const value = Number(maxVideoKbps);
  if (maxVideoKbps == null || !Number.isFinite(value) || value < MIN_VIDEO_KBPS) return null;
  return { maxVideoKbps: Math.min(MAX_VIDEO_KBPS, Math.floor(value)) };
}

// The item as the friend's page knows it: its title, cover, and duration,
// and a stand-in source naming the link, which the page sends back with each
// rebuild, never the owner's source.
const itemOf = (link, cover) => ({
  source: { plugin: "share", id: link.id }, title: link.title, thumbnail: cover, duration: link.duration,
});

async function coverOf(env, request, link) {
  if (!link.thumbnail || !env.NODE_SECRET) return null;
  const origin = new URL(env.PUBLIC_ORIGIN || request.url).origin;
  const images = createImageLinks({
    secret: env.NODE_SECRET, origin, userId: link.userId, version: () => imageLinkVersion(env.DB, link.userId),
  });
  return images.link(link.thumbnail).catch(() => null);
}

async function describeLink(request, env, link) {
  const { paths, relayMode } = await friendMedia(env, link.userId);
  return Response.json({
    item: itemOf(link, await coverOf(env, request, link)),
    expiresAt: link.expiresAt,
    media: { paths, relayMode },
  }, { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

async function streamLink(request, env, link, { node, now, log }) {
  const input = await readBody(request);
  const reason = LOAD_REASONS.includes(input.reason) && input.reason !== "transfer" ? input.reason : "play";
  const { media, paths } = await friendMedia(env, link.userId);
  const relayOff = (media.relayMode ?? "auto") === "off";
  const wan = input.network === "wan" && paths.length > 0;
  if (!wan && relayOff) {
    throw new YoloError("media_unreachable", "The owner's Yolo cannot send this video to you right now. Try again later.");
  }
  const sessionId = newId("ses");
  const exp = Math.min(Math.floor(now / 1000) + MEDIA_TOKEN_TTL_SECONDS, Math.floor(link.expiresAt / 1000));
  const replaces = typeof input.sessionId === "string" && SESSION_ID.test(input.sessionId) ? input.sessionId : null;
  const startTime = Math.max(0, Number(input.startTime) || 0);
  const descriptor = await node.post("/internal/v1/prepare", {
    sessionId,
    source: link.source,
    capabilities: normalizeCapabilities(input.capabilities ?? {}),
    viewport: viewportOf(input.viewport),
    startTime,
    reason,
    tracks: { preferences: {} },
    limits: limitsOf(input.maxVideoKbps),
    network: wan ? "wan" : "relay",
    mediaToken: await signMediaToken(env.NODE_SECRET, { sessionId, userId: link.userId, exp }),
    share: link.id,
    ...(replaces ? { replaces } : {}),
  }, { timeoutMs: PREPARE_TIMEOUT_MS });
  log({ kind: "share", event: "stream", userId: link.userId, shareId: link.id, sessionId, reason, network: descriptor.network ?? null });
  if (reason === "play") await noteSharePlay(env.DB, link.id, now).catch(() => {});
  const cover = await coverOf(env, request, link);
  return Response.json({
    // The node's thumbnail is an owner route that needs a credential.
    stream: { ...descriptor, thumbnail: cover },
    item: itemOf(link, cover),
    startTime: Number(descriptor.startTime ?? startTime) || 0,
    autoplay: input.autoplay !== false,
    reason,
  }, { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

/**
 * /v1/share/<token> and /v1/share/<token>/stream, without a credential.
 * `node` is the node client (node-client.js).
 */
export async function serveShareLink(request, env, { node, now = Date.now(), log = (record) => console.log(record) }) {
  const match = ROUTE.exec(new URL(request.url).pathname);
  const method = match?.[2] ? "POST" : "GET";
  if (!match) return refuse(new YoloError("not_found", "No such endpoint"));
  if (request.method !== method) {
    const response = refuse(new YoloError("invalid_request", `This share route answers ${method}`), 405);
    response.headers.set("allow", method);
    return response;
  }
  const limited = await limitShareRequest(request, env);
  if (limited) return limited;
  try {
    const link = await openLink(env.DB, match[1], now);
    return match[2] ? await streamLink(request, env, link, { node, now, log }) : await describeLink(request, env, link);
  } catch (error) {
    return refuse(error, error?.gone ? 410 : undefined);
  }
}
