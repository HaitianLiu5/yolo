import { errorBody, isSourceKey, openImageLink, sealImageLink, toYoloError, YoloError } from "@useyolo/core";
import { limitImageRequest } from "./rate-limit.js";
import { imageLinkVersion } from "./store/image-links.js";

// Image links for agents (Agent Note 2026-10-07-remote-mcp-server). A
// `thumbnail` in Yolo's results is a path that needs a device credential
// (/v1/library/items/<id>/artwork) or an image on another host, which
// screens load through /v1/thumbnail. ChatGPT and Claude load images without
// credentials, so MCP results carry each thumbnail as an absolute link on
// PUBLIC_ORIGIN instead: /i/<token>, where the token is sealed with
// NODE_SECRET under its own label and the owner's key version
// (sealImageLink in @useyolo/core). The same image always gets the same
// link, it has no expiry, so it keeps working in old chats, and it names
// nothing in the clear. Resetting image links (a new key version) makes every
// earlier link fail.
//
// Only a thumbnail of Yolo's own results is sealed, and only one that names
// a library item's artwork or an http(s) image, so /i/* is no open proxy: it
// serves what the authenticated routes serve, the artwork through the node
// and an image on another host through the node's thumbnail fetch with all
// its guards against server-side request forgery.

export const IMAGE_LINK_PATH = "/i/";
const ARTWORK_PATH = /^\/v1\/library\/items\/([^/]+)\/artwork$/;
const VARIANT = /^[a-z][a-z0-9-]{0,31}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_IMAGE_URL = 2048;
const BASE = "https://yolo.invalid";
// Raster pictures only: an SVG opened from Yolo's origin could run script.
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
// A link is one image for good, until a reset makes it fail.
const FOREVER = "public, max-age=31536000, immutable";

function parseUrl(value, base) {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function remoteRef(value) {
  if (typeof value !== "string" || !value || value.length > MAX_IMAGE_URL) return null;
  const url = parseUrl(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
  return url.href.length <= MAX_IMAGE_URL ? { kind: "remote", url: url.href } : null;
}

/** What a thumbnail names: a library item's artwork, an image on another host, or null for anything else. */
export function imageRef(value) {
  if (typeof value !== "string" || !value) return null;
  if (!value.startsWith("/v1/")) return remoteRef(value);
  const url = parseUrl(value, BASE);
  if (!url || url.origin !== BASE) return null;
  if (url.pathname === "/v1/thumbnail") return remoteRef(url.searchParams.get("url"));
  const match = ARTWORK_PATH.exec(url.pathname);
  if (!match) return null;
  let itemId;
  try {
    itemId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const variant = url.searchParams.get("variant") || "poster";
  return isSourceKey(itemId) && VARIANT.test(variant) ? { kind: "artwork", itemId, variant } : null;
}

// The sealed payload: whose link it is and the image, as a short JSON array.
const toPayload = (userId, ref) => JSON.stringify(ref.kind === "artwork" ? [userId, "a", ref.itemId, ref.variant] : [userId, "u", ref.url]);

function fromPayload(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || typeof value[0] !== "string" || !USER_ID.test(value[0])) return null;
  const [userId, kind] = value;
  if (kind === "a" && value.length === 4 && isSourceKey(value[2]) && typeof value[3] === "string" && VARIANT.test(value[3])) {
    return { userId, ref: { kind: "artwork", itemId: value[2], variant: value[3] } };
  }
  const ref = kind === "u" && value.length === 3 ? remoteRef(value[2]) : null;
  return ref ? { userId, ref } : null;
}

const isPlain = (value) => value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Links for one MCP request. `version()` reads the owner's key version, once
 * and only when a result has a thumbnail.
 */
export function createImageLinks({ secret, origin, userId, version }) {
  const base = origin ? parseUrl(origin)?.origin ?? null : null;
  let current = null;
  const links = new Map(); // payload → Promise<link>

  /** The absolute link for a thumbnail, or null when it names no image Yolo serves. */
  async function link(value) {
    const ref = imageRef(value);
    if (!ref || !secret || !base || !USER_ID.test(String(userId))) return null;
    const payload = toPayload(userId, ref);
    if (!links.has(payload)) {
      links.set(payload, (async () => {
        current ??= Promise.resolve().then(version);
        return `${base}${IMAGE_LINK_PATH}${await sealImageLink(secret, await current, payload)}`;
      })());
    }
    return links.get(payload);
  }

  /** A copy of a tool's result with every `thumbnail` replaced by its link, or by null. */
  async function present(value) {
    if (Array.isArray(value)) return Promise.all(value.map(present));
    if (!isPlain(value)) return value;
    const entries = await Promise.all(Object.entries(value).map(async ([key, field]) => {
      if (key === "thumbnail" && (field == null || typeof field === "string")) return [key, field ? await link(field).catch(() => null) : field];
      return [key, await present(field)];
    }));
    return Object.fromEntries(entries);
  }

  return { link, present };
}

function refuse(error, status = toYoloError(error).status) {
  return Response.json(errorBody(error), { status, headers: { "cache-control": "no-store" } });
}

/**
 * GET or HEAD /i/<token>: the image a link names, without a credential.
 * `servicesFor(env, userId)` is the service layer (artwork, thumbnail).
 */
export async function serveImageLink(request, env, { servicesFor, now = Date.now() }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = refuse(new YoloError("invalid_request", "Image links answer GET and HEAD"), 405);
    response.headers.set("allow", "GET, HEAD");
    return response;
  }
  const limited = await limitImageRequest(request, env);
  if (limited) return limited;
  const token = new URL(request.url).pathname.slice(IMAGE_LINK_PATH.length);
  const opened = env.NODE_SECRET ? await openImageLink(env.NODE_SECRET, token).catch(() => null) : null;
  const named = opened ? fromPayload(opened.payload) : null;
  if (!named) return refuse(new YoloError("not_found", "No such image"));
  let upstream;
  try {
    const current = await imageLinkVersion(env.DB, named.userId, { atLeast: opened.version, now });
    if (opened.version !== current) return refuse(new YoloError("not_found", "The owner of this Yolo reset its image links"), 410);
    const services = servicesFor(env, named.userId);
    upstream = named.ref.kind === "artwork"
      ? await services.artwork(named.ref.itemId, named.ref.variant)
      : await services.thumbnail(named.ref.url);
  } catch (error) {
    return refuse(error);
  }
  const type = String(upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) {
    await upstream.body?.cancel();
    return refuse(new YoloError("resolve_failed", "The source answered with something other than a picture"));
  }
  if (request.method === "HEAD") await upstream.body?.cancel();
  const length = upstream.headers.get("content-length");
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    headers: {
      "content-type": type,
      ...(length ? { "content-length": length } : {}),
      "cache-control": FOREVER,
      "x-content-type-options": "nosniff",
      // Any page may show it; opened as a page of its own, it can do nothing.
      "cross-origin-resource-policy": "cross-origin",
      "content-security-policy": "default-src 'none'; sandbox",
      "referrer-policy": "no-referrer",
    },
  });
}
