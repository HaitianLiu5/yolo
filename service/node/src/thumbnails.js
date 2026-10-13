import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { YoloError } from "@useyolo/core";

// Thumbnails for screens (Agent Note 2026-10-07-node-internal-api). A
// source's `thumbnail` is an image on another host, such as a video site's
// image server; a screen that loaded it itself would show that host the
// screen's address. The node fetches it instead, and screens get it from
// Yolo's own origin through /v1/thumbnail.
//
// The URL comes from a plugin, a stored row, or any holder of a read token, so
// the fetch guards against server-side request forgery:
// - http(s) only, without credentials, at most MAX_URL_LENGTH characters;
// - every address a name resolves to must be public. The check runs in the
//   socket's own lookup, so the address checked is the address connected to
//   (DNS rebinding cannot slip between them), and a literal address is
//   checked before connecting;
// - each redirect is checked the same way, at most MAX_REDIRECTS of them;
// - the answer must be a raster image (no SVG) of at most `maxBytes`, and the
//   whole fetch must finish within `timeoutMs`.
// Images are kept in memory up to `maxCacheBytes`, least recently used
// first, and one fetch per URL runs at a time.

export const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// Addresses that are not on the public internet: this host, private and
// shared networks, link-local, documentation and benchmark ranges, multicast,
// and reserved space.
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) NOT_PUBLIC.addSubnet(network, prefix, "ipv6");

// The eight 16-bit words of an IPv6 address.
function ipv6Words(address) {
  let text = address.toLowerCase().replace(/%.*$/, "");
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const middle = tail === undefined ? [] : Array(8 - front.length - back.length).fill("0");
  return [...front, ...middle, ...back].map((word) => Number.parseInt(word, 16));
}

// The IPv4 address an IPv6 address stands for: IPv4-mapped (::ffff:a.b.c.d)
// or the well-known NAT64 prefix (64:ff9b::a.b.c.d).
function embeddedIPv4(words) {
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const nat64 = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0);
  if (!mapped && !nat64) return null;
  return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join(".");
}

export function isPublicAddress(address) {
  try {
    const family = isIP(String(address).replace(/%.*$/, ""));
    if (family === 4) return !NOT_PUBLIC.check(address, "ipv4");
    if (family !== 6) return false;
    const ipv4 = embeddedIPv4(ipv6Words(address));
    return ipv4 ? !NOT_PUBLIC.check(ipv4, "ipv4") : !NOT_PUBLIC.check(address, "ipv6");
  } catch {
    return false;
  }
}

const refused = (what) => new YoloError("forbidden", `${what} is not a public address; Yolo fetches thumbnails only from the public internet`);
const failed = (message) => new YoloError("resolve_failed", `Thumbnail unavailable: ${message}`, { retryable: false });

function parse(value) {
  const text = String(value ?? "");
  if (!text || text.length > MAX_URL_LENGTH) throw new YoloError("invalid_request", `url must be an http(s) URL of at most ${MAX_URL_LENGTH} characters`);
  const url = URL.parse(text);
  if (!url || !/^https?:$/.test(url.protocol)) throw new YoloError("invalid_request", "url must be an http(s) URL");
  if (url.username || url.password) throw new YoloError("invalid_request", "url must not carry credentials");
  return url;
}

export function createThumbnails({
  lookup = dnsLookup,
  isPublic = isPublicAddress,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxCacheBytes = DEFAULT_CACHE_BYTES,
} = {}) {
  const cache = new Map(); // href → { type, body }
  let cachedBytes = 0;
  const pending = new Map(); // href → Promise<{ type, body }>

  // dns.lookup, refusing a name with any address that is not public.
  const publicLookup = (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [];
      const bad = list.find(({ address }) => !isPublic(address));
      if (!list.length || bad) return callback(refused(hostname));
      if (options?.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };

  function request(url, signal) {
    const literal = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(literal) && !isPublic(literal)) return Promise.reject(refused(literal));
    return new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const outgoing = client.get(url, {
        agent: false,
        lookup: publicLookup,
        signal,
        headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8", "user-agent": "Mozilla/5.0 (compatible; Yolo)" },
      }, resolve);
      outgoing.on("error", reject);
    });
  }

  async function readBody(response) {
    const declared = Number(response.headers["content-length"]);
    if (declared > maxBytes) throw failed(`larger than ${maxBytes} bytes`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > maxBytes) throw failed(`larger than ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }

  async function download(first) {
    const signal = AbortSignal.timeout(timeoutMs);
    let url = first;
    for (let hops = 0; ; hops += 1) {
      let response;
      try {
        response = await request(url, signal);
      } catch (error) {
        if (error instanceof YoloError) throw error;
        throw failed(signal.aborted ? `no answer within ${timeoutMs} ms` : error.code || "the request failed");
      }
      try {
        if (REDIRECTS.has(response.statusCode) && response.headers.location) {
          if (hops >= MAX_REDIRECTS) throw failed(`more than ${MAX_REDIRECTS} redirects`);
          url = parse(new URL(response.headers.location, url).href);
          continue;
        }
        if (response.statusCode !== 200) throw failed(`the image server answered ${response.statusCode}`);
        const type = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (!IMAGE_TYPES.has(type)) throw failed(`${type || "no type"} is not an image type Yolo shows`);
        return { type, body: await readBody(response) };
      } catch (error) {
        if (error instanceof YoloError) throw error;
        throw failed(signal.aborted ? `not complete within ${timeoutMs} ms` : error.code || "the request failed");
      } finally {
        response.destroy();
      }
    }
  }

  function remember(href, image) {
    if (image.body.length > maxCacheBytes) return;
    cache.set(href, image);
    cachedBytes += image.body.length;
    for (const [key, value] of cache) {
      if (cachedBytes <= maxCacheBytes) break;
      cache.delete(key);
      cachedBytes -= value.body.length;
    }
  }

  return {
    /** The image at `url` as { type, body }, from memory or fetched now. */
    async get(value) {
      const url = parse(value);
      const { href } = url;
      const cached = cache.get(href);
      if (cached) {
        cache.delete(href);
        cache.set(href, cached);
        return cached;
      }
      if (!pending.has(href)) {
        const fetching = download(url).then((image) => {
          remember(href, image);
          return image;
        }).finally(() => pending.delete(href));
        pending.set(href, fetching);
      }
      return pending.get(href);
    },
  };
}
