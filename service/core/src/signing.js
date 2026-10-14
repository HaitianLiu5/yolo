import { base64url } from "./ids.js";

// HMAC helpers built on WebCrypto, so the same code runs in Workers and Node.
// Three uses (Agent Note 2026-10-07-same-origin-media-passthrough,
// Agent Note 2026-10-07-node-internal-api,
// Agent Note 2026-10-07-remote-mcp-server):
// - media tokens in `/m/{token}/…`, verified by the node without a callback;
// - request signatures on control plane → node calls (defense in depth on top
//   of the Workers VPC binding);
// - image links in `/i/{token}`, the covers agents show.

const encoder = new TextEncoder();
const keyCache = new Map();

async function hmacKey(secret) {
  if (!secret || typeof secret !== "string") throw new TypeError("A shared secret is required");
  let key = keyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(secret, key);
  }
  return key;
}

export async function hmac(secret, message) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message));
  return base64url(new Uint8Array(signature));
}

export async function sha256(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

// Constant-time comparison for equal-length ASCII strings.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const MEDIA_TOKEN_TTL_SECONDS = 12 * 60 * 60;
const ID_PART = /^[A-Za-z0-9_-]{1,64}$/;

export async function signMediaToken(secret, { sessionId, userId, exp }) {
  if (!ID_PART.test(sessionId) || !ID_PART.test(userId)) throw new TypeError("Invalid media token ids");
  const expiry = Math.floor(Number(exp));
  const signature = await hmac(secret, `${sessionId}|${userId}|${expiry}`);
  return `${sessionId}.${userId}.${expiry}.${signature}`;
}

export async function verifyMediaToken(secret, token, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4) return null;
  const [sessionId, userId, expText, signature] = parts;
  const exp = Number(expText);
  if (!ID_PART.test(sessionId) || !ID_PART.test(userId) || !Number.isInteger(exp)) return null;
  if (exp * 1000 <= now) return null;
  const expected = await hmac(secret, `${sessionId}|${userId}|${exp}`);
  return safeEqual(expected, signature) ? { sessionId, userId, exp } : null;
}

// Image links (Agent Note 2026-10-07-remote-mcp-server): an opaque token for
// one image that agents show without a credential, in old chats too, so it
// has no expiry and the same image and key version always give the same
// token. It is a deterministic authenticated encryption (SIV): the tag is
// HMAC-SHA256 over the header and the payload, cut to 16 bytes, and the
// payload is encrypted with AES-CTR using the tag as its counter, so nothing
// it names can be read and any change to a byte fails the tag. Both keys are
// derived from the secret by HKDF under their own label and the key version,
// which the header carries in the clear:
//   format (1 byte) | key version (uint32) | tag (16 bytes) | sealed payload
// A new key version makes every older token fail.
const IMAGE_LINK_FORMAT = 1;
const IMAGE_LINK_LABEL = encoder.encode("yolo image links");
const IMAGE_LINK_HEADER = 5;
const IMAGE_LINK_TAG = 16;
export const MAX_IMAGE_LINK_PAYLOAD = 4096;
const MAX_IMAGE_LINK_TOKEN = Math.ceil(((IMAGE_LINK_HEADER + IMAGE_LINK_TAG + MAX_IMAGE_LINK_PAYLOAD) * 4) / 3);
const MAX_IMAGE_LINK_KEYS = 16;
const imageLinkKeyCache = new Map();

function imageLinkKeys(secret, version) {
  if (!secret || typeof secret !== "string") throw new TypeError("A shared secret is required");
  const cacheKey = `${version}\n${secret}`;
  let keys = imageLinkKeyCache.get(cacheKey);
  if (!keys) {
    keys = (async () => {
      const root = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveBits"]);
      const derive = (use) => crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: IMAGE_LINK_LABEL, info: encoder.encode(`${use} v${version}`) }, root, 256,
      );
      const [mac, enc] = await Promise.all([derive("tag"), derive("seal")]);
      return {
        mac: await crypto.subtle.importKey("raw", mac, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
        enc: await crypto.subtle.importKey("raw", enc, { name: "AES-CTR" }, false, ["encrypt", "decrypt"]),
      };
    })();
    keys.catch(() => imageLinkKeyCache.delete(cacheKey));
    if (imageLinkKeyCache.size >= MAX_IMAGE_LINK_KEYS) imageLinkKeyCache.delete(imageLinkKeyCache.keys().next().value);
    imageLinkKeyCache.set(cacheKey, keys);
  }
  return keys;
}

const validVersion = (version) => Number.isInteger(version) && version > 0 && version <= 0xffffffff;

function imageLinkHeader(version) {
  const header = new Uint8Array(IMAGE_LINK_HEADER);
  header[0] = IMAGE_LINK_FORMAT;
  new DataView(header.buffer).setUint32(1, version);
  return header;
}

async function imageLinkTag(keys, header, payload) {
  const message = new Uint8Array(header.length + payload.length);
  message.set(header);
  message.set(payload, header.length);
  return new Uint8Array(await crypto.subtle.sign("HMAC", keys.mac, message)).slice(0, IMAGE_LINK_TAG);
}

const aesCtr = (counter) => ({ name: "AES-CTR", counter, length: 64 });

function fromBase64url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The token for `payload` (a string) under key version `version`. */
export async function sealImageLink(secret, version, payload) {
  if (!validVersion(version)) throw new TypeError("An image link's key version is a positive integer");
  const plain = encoder.encode(typeof payload === "string" ? payload : "");
  if (!plain.length || plain.length > MAX_IMAGE_LINK_PAYLOAD) throw new TypeError("An image link needs a payload of at most 4096 bytes");
  const keys = await imageLinkKeys(secret, version);
  const header = imageLinkHeader(version);
  const tag = await imageLinkTag(keys, header, plain);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(aesCtr(tag), keys.enc, plain));
  const token = new Uint8Array(header.length + tag.length + sealed.length);
  token.set(header);
  token.set(tag, header.length);
  token.set(sealed, header.length + tag.length);
  return base64url(token);
}

/** { version, payload } when `token` is one of this secret's image links, else null. */
export async function openImageLink(secret, token) {
  if (typeof token !== "string" || token.length > MAX_IMAGE_LINK_TOKEN) return null;
  const bytes = fromBase64url(token);
  if (!bytes || bytes.length <= IMAGE_LINK_HEADER + IMAGE_LINK_TAG || bytes[0] !== IMAGE_LINK_FORMAT) return null;
  const version = new DataView(bytes.buffer).getUint32(1);
  if (!validVersion(version)) return null;
  const header = bytes.slice(0, IMAGE_LINK_HEADER);
  const tag = bytes.slice(IMAGE_LINK_HEADER, IMAGE_LINK_HEADER + IMAGE_LINK_TAG);
  const keys = await imageLinkKeys(secret, version);
  const plain = new Uint8Array(await crypto.subtle.decrypt(aesCtr(tag), keys.enc, bytes.slice(IMAGE_LINK_HEADER + IMAGE_LINK_TAG)));
  const expected = await imageLinkTag(keys, header, plain);
  let diff = 0;
  for (let i = 0; i < IMAGE_LINK_TAG; i += 1) diff |= expected[i] ^ tag[i];
  if (diff !== 0) return null;
  try {
    return { version, payload: new TextDecoder("utf-8", { fatal: true }).decode(plain) };
  } catch {
    return null;
  }
}

export const SIGNATURE_HEADER = "x-yolo-signature";
export const TIMESTAMP_HEADER = "x-yolo-timestamp";
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function canonicalRequest({ method, path, timestamp, bodyHash }) {
  return [timestamp, String(method).toUpperCase(), path, bodyHash].join("\n");
}

export async function signNodeRequest(secret, { method, path, body = "", timestamp = Date.now() }) {
  const bodyHash = await sha256(body);
  const signature = await hmac(secret, canonicalRequest({ method, path, timestamp, bodyHash }));
  return { [TIMESTAMP_HEADER]: String(timestamp), [SIGNATURE_HEADER]: signature };
}

export async function verifyNodeRequest(secret, { method, path, body = "", headers, now = Date.now() }) {
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]);
  const timestamp = Number(get(TIMESTAMP_HEADER));
  const signature = get(SIGNATURE_HEADER);
  if (!Number.isFinite(timestamp) || !signature) return false;
  if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) return false;
  const bodyHash = await sha256(body);
  const expected = await hmac(secret, canonicalRequest({ method, path, timestamp, bodyHash }));
  return safeEqual(expected, signature);
}
