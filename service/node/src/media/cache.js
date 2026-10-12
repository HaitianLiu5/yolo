import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { silentLogger } from "../log.js";

// Disk cache for media bytes (proxied segments and byte ranges), ported from
// the Drive-In server. Rewinding a car's player over a weak link must not
// download the same bytes again, so completed responses are kept up to
// SEGMENT_CACHE_MAX_BYTES and evicted least-recently-used.
//
// A cache entry is addressed by what the bytes are, not where they came from:
// signed CDN URLs change on every resolve, so a source plugin may give an
// upstream resource an identity (Input.cacheKey,
// Agent Note 2026-10-11-node-media-pipeline) and the key becomes
// `<identity>:<range>`. Without one the key is a hash of the URL and the range,
// which keeps different origins, queries and ranges apart.

export const MIN_CACHE_BYTES = 10 * 1024;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024 * 1024;
const EVICT_DEBOUNCE_MS = 60_000;

const sha256Hex = (value) => createHash("sha256").update(String(value)).digest("hex");

export function normalizeRange(rangeHeader = "") {
  const match = String(rangeHeader).match(/^bytes=(\d+)?-(\d+)?$/i);
  return { start: match?.[1] || "*", end: match?.[2] || "*" };
}

export function cacheKeyFor(url, rangeHeader = "", identity = null) {
  if (identity) {
    const range = normalizeRange(rangeHeader);
    const logicalKey = `${identity}:${range.start}-${range.end}`;
    return { kind: "logical", logicalKey, filenameKey: sha256Hex(logicalKey) };
  }
  const hash = sha256Hex(`${url}\n${rangeHeader || ""}`);
  return { kind: "hash", logicalKey: `hash:${hash}`, filenameKey: hash };
}

// Media bodies worth caching: complete or ranged responses, not playlists or
// manifests (they change), not tiny bodies.
export function isCacheableResponse(url, upstream, rangeHeader) {
  if (upstream.status !== 200 && upstream.status !== 206) return false;
  if (/\.(m3u8|mpd)(\?|#|$)/i.test(String(url))) return false;
  const type = (upstream.headers.get("content-type") || "").toLowerCase();
  if (type.includes("mpegurl") || type.includes("application/dash+xml")) return false;
  const length = Number.parseInt(upstream.headers.get("content-length") || "", 10);
  if (Number.isFinite(length) && length >= 0 && length < MIN_CACHE_BYTES) return false;
  return !rangeHeader || rangeHeader.startsWith("bytes=");
}

const safeUnlink = (path) => {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
};

export function createSegmentCache({ dir, maxBytes = DEFAULT_MAX_BYTES, logger = silentLogger } = {}) {
  const targetBytes = Math.floor(maxBytes * 0.9);
  const stats = { sizeBytes: 0, hits: 0, misses: 0, evictions: 0 };
  let evictionTimer = null;
  let lastEviction = 0;

  function paths(url, rangeHeader = "", identity = null) {
    const key = cacheKeyFor(url, rangeHeader, identity);
    return { ...key, dataPath: resolve(dir, `${key.filenameKey}.dat`), metaPath: resolve(dir, `${key.filenameKey}.meta`) };
  }

  function purge(target) {
    safeUnlink(target.dataPath);
    safeUnlink(target.metaPath);
  }

  function get(url, rangeHeader = "", identity = null) {
    const target = paths(url, rangeHeader, identity);
    if (!existsSync(target.dataPath) || !existsSync(target.metaPath)) return null;
    try {
      const meta = JSON.parse(readFileSync(target.metaPath, "utf8"));
      const stat = statSync(target.dataPath);
      // Access time drives eviction order.
      utimesSync(target.dataPath, new Date(), stat.mtime);
      return { ...target, meta, sizeBytes: stat.size };
    } catch (error) {
      logger.warn({ key: target.logicalKey, err: error.message }, "Cache read failed");
      purge(target);
      return null;
    }
  }

  function init() {
    mkdirSync(dir, { recursive: true });
    let total = 0;
    const files = readdirSync(dir);
    const valid = new Set();
    for (const file of files) {
      if (!file.endsWith(".dat")) continue;
      const dataPath = resolve(dir, file);
      const metaPath = resolve(dir, `${file.slice(0, -4)}.meta`);
      if (!existsSync(metaPath)) {
        safeUnlink(dataPath);
        continue;
      }
      try {
        total += statSync(dataPath).size;
        valid.add(file.slice(0, -4));
      } catch {
        safeUnlink(dataPath);
        safeUnlink(metaPath);
      }
    }
    for (const file of files) {
      if (file.endsWith(".meta") && !valid.has(file.slice(0, -5))) safeUnlink(resolve(dir, file));
    }
    stats.sizeBytes = total;
  }

  function evict() {
    if (stats.sizeBytes <= maxBytes) return;
    const candidates = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".meta")) continue;
      const metaPath = resolve(dir, file);
      const dataPath = resolve(dir, `${file.slice(0, -5)}.dat`);
      try {
        const stat = statSync(dataPath);
        candidates.push({ dataPath, metaPath, sizeBytes: stat.size, atimeMs: stat.atimeMs });
      } catch {
        safeUnlink(metaPath);
      }
    }
    candidates.sort((a, b) => a.atimeMs - b.atimeMs);
    let freed = 0;
    let count = 0;
    while (stats.sizeBytes > targetBytes && candidates.length) {
      const candidate = candidates.shift();
      purge(candidate);
      stats.sizeBytes = Math.max(0, stats.sizeBytes - candidate.sizeBytes);
      stats.evictions += 1;
      freed += candidate.sizeBytes;
      count += 1;
    }
    if (count) logger.info({ filesEvicted: count, bytesFreed: freed, sizeBytes: stats.sizeBytes }, "Cache eviction");
  }

  function scheduleEviction() {
    if (evictionTimer) return;
    const wait = Math.max(0, EVICT_DEBOUNCE_MS - (Date.now() - lastEviction));
    evictionTimer = setTimeout(() => {
      evictionTimer = null;
      lastEviction = Date.now();
      try {
        evict();
      } catch (error) {
        logger.warn({ err: error.message }, "Cache eviction failed");
      }
    }, wait);
    evictionTimer.unref?.();
  }

  function finalize(target, upstream, bytes) {
    const meta = {
      status: upstream.status,
      contentType: upstream.headers.get("content-type") || "application/octet-stream",
      contentLength: Number.parseInt(upstream.headers.get("content-length") || "", 10) || bytes,
      contentRange: upstream.headers.get("content-range") || null,
      cacheKey: target.logicalKey,
    };
    writeFileSync(target.metaPath, JSON.stringify(meta));
    stats.sizeBytes += bytes;
    scheduleEviction();
  }

  return {
    stats,
    paths,
    get,
    init,
    purge,

    // Store a body that is already in memory (DASH segments are verified
    // whole before they are served).
    store(target, upstream, buffer) {
      writeFileSync(target.dataPath, buffer);
      finalize(target, upstream, buffer.length);
    },

    // A Response for a cache entry. `status` overrides the stored status, and
    // `rangeHeaders: false` drops Content-Range (a segment served whole).
    respond(entry, { status = null, rangeHeaders = true } = {}) {
      const meta = entry.meta || {};
      const headers = new Headers({ "access-control-allow-origin": "*", "x-yolo-cache": "hit" });
      if (meta.contentType) headers.set("content-type", meta.contentType);
      headers.set("content-length", String(entry.sizeBytes));
      if (rangeHeaders && meta.contentRange) headers.set("content-range", meta.contentRange);
      if (rangeHeaders) headers.set("accept-ranges", "bytes");
      return new Response(Readable.toWeb(createReadStream(entry.dataPath)), { status: status ?? meta.status ?? 200, headers });
    },

    // Pass an upstream body through while writing it to the cache. A body the
    // client abandons, or one that fails, is not kept.
    tee(upstream, target) {
      const reader = upstream.body.getReader();
      const file = createWriteStream(target.dataPath);
      let failed = false;
      file.on("error", () => {
        failed = true;
      });
      let bytes = 0;
      const discard = () => {
        failed = true;
        file.destroy();
        purge(target);
      };
      return new ReadableStream({
        async pull(controller) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (error) {
            discard();
            controller.error(error);
            return;
          }
          if (chunk.done) {
            controller.close();
            if (failed) return purge(target);
            file.end();
            try {
              await once(file, "finish");
              if (bytes >= MIN_CACHE_BYTES) finalize(target, upstream, bytes);
              else purge(target);
            } catch {
              purge(target);
            }
            return;
          }
          bytes += chunk.value.byteLength;
          controller.enqueue(chunk.value);
          if (!failed && !file.write(chunk.value)) await once(file, "drain").catch(() => {});
        },
        cancel(reason) {
          discard();
          return reader.cancel(reason).catch(() => {});
        },
      });
    },

    clear() {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      stats.sizeBytes = 0;
    },
  };
}
