import { logPlayerEvent } from "./player-log.js";

// Slow and failed media requests in the runtime log: a fetch of a segment,
// playlist, or file under /m/ that took longer than 3 seconds
// (`network_segment_slow`, from the fetch itself or the browser's resource
// timing, which also sees the <video> engine's requests) or failed
// (`network_segment_fetch_error`).

const SLOW_MS = 3_000;
// Resource timings already logged, until there are this many.
const SEEN_MAX = 500;

function isMediaRequest(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url, location.origin);
    return parsed.pathname.startsWith("/m/") || /\.(m4s|mp4|m3u8|mpd|ts)(\?|$)/i.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
}

function timeFetches(fetch) {
  globalThis.fetch = async (...args) => {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    const startedAt = performance.now();
    try {
      const response = await fetch(...args);
      const durationMs = performance.now() - startedAt;
      if (durationMs > SLOW_MS && isMediaRequest(url)) {
        logPlayerEvent("network_segment_slow", {
          url,
          durationMs: Math.round(durationMs),
          observer: "fetch",
          status: response.status,
          contentLength: Number(response.headers?.get?.("content-length")) || null,
        });
      }
      return response;
    } catch (error) {
      if (isMediaRequest(url)) {
        logPlayerEvent("network_segment_fetch_error", {
          url,
          durationMs: Math.round(performance.now() - startedAt),
          error: error.message || String(error),
        });
      }
      throw error;
    }
  };
}

function observeResourceTimings() {
  const seen = new Set();
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!isMediaRequest(entry.name) || entry.duration <= SLOW_MS) continue;
      const key = `${entry.name}:${entry.startTime}`;
      if (seen.has(key)) continue;
      if (seen.size >= SEEN_MAX) seen.clear();
      seen.add(key);
      logPlayerEvent("network_segment_slow", {
        observer: "performance-resource",
        url: entry.name,
        durationMs: Math.round(entry.duration),
        transferSize: entry.transferSize || 0,
        encodedBodySize: entry.encodedBodySize || 0,
        decodedBodySize: entry.decodedBodySize || 0,
      });
    }
  });
  try {
    observer.observe({ type: "resource", buffered: true });
  } catch {
    observer.observe({ entryTypes: ["resource"] });
  }
}

let watching = false;

/** Starts timing the page's media requests, once. */
export function watchMediaRequests() {
  if (watching) return;
  watching = true;
  if (typeof globalThis.fetch === "function") timeFetches(globalThis.fetch.bind(globalThis));
  try {
    observeResourceTimings();
  } catch {}
}
