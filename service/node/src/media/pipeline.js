import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { errorBody, readsSplitFiles, toYoloError, verifyMediaToken, waitsForLiveRunway, YoloError } from "@useyolo/core";
import { silentLogger } from "../log.js";
import { createSegmentCache, isCacheableResponse, MIN_CACHE_BYTES } from "./cache.js";
import { buildDashHls, parseMp4Structure } from "./dash.js";
import { downloadRange, SEGMENT_TIMING } from "./hedge.js";
import {
  buildLiveWindow,
  filterVariants,
  isMasterPlaylist,
  rewriteHlsUris,
  rewriteTranscodePlaylist,
  sequenceForTime,
  trimToStartOffset,
} from "./hls.js";
import { createHostHealth } from "./hosts.js";
import { normalizeInput } from "./input.js";
import { startTranscode, TRANSCODE_STARTUP_TIMEOUT_MS } from "./transcode.js";
import { fetchTextWithRetry, fetchWithRetry } from "./upstream.js";

// The media node's delivery pipeline
// (Agent Note 2026-10-11-node-media-pipeline). A source plugin's prepare()
// describes a stream as an Input; this module turns it into something the
// device can play from `/m/{token}/…` URLs, and serves those URLs, both
// through the control plane's passthrough and on the LAN listener (lan.js):
//
//   file   progressive MP4/WebM → byte-range proxy with a disk cache
//   hls    HLS → rewritten playlists, proxied segments, optional live window
//   split  separate audio/video MP4 → fMP4 HLS over byte ranges (or ffmpeg)
//
// Every path starts with the media token the control plane signed for the
// session (HMAC of sessionId|userId|exp with NODE_SECRET). The token is the
// only credential: the node checks it locally and serves only sessions it
// holds, so a stopped session's URLs stop working.
//
// A `file` Input or a `split` track may list `alternates`: other URLs of the
// same bytes (CDN mirror hosts). The node ranks them by what it has seen of
// each host lately (hosts.js), across sessions. A split segment is read with
// hedged attempts and streamed to the device as its bytes arrive (hedge.js),
// within the device's segment timeout; a `file` request moves to the next URL
// when one stalls, times out or fails. refresh() is for expired URLs and is
// too slow (it re-resolves the item, at most once per 30 s) for a stalled
// mirror.

export const SESSION_EXPIRED = "SESSION_EXPIRED";
const MAX_PLAYLIST_BYTES = 16 * 1024 * 1024;
const REFRESH_SKEW_MS = 5 * 60_000;
const REFRESH_COOLDOWN_MS = 30_000;
const STOP_GRACE_MS = 10_000;
const IDLE_SESSION_MS = 2 * 60 * 60_000;
const MAX_SESSIONS = 8;
const MAX_RESOURCES = 20_000;
const PROBE_BYTES = 128 * 1024;
// A `file` request with another URL waiting gets this long for headers.
const FILE_FAILOVER_MS = 6_000;
const DASH_SEGMENT_MAX_BYTES = 32 * 1024 * 1024;
const DASH_PREFETCH_AHEAD = 6;
const LIVE_SEGMENT_WAIT_MS = 20_000;
const LIVE_POLL_MS = 500;
const TRANSCODER_RETRY_DELAYS_MS = [0, 250, 500, 1000];
// A live window for a player that does not wait for unpublished segments
// (a <video> element): it ends at the newest segment and reaches this far
// back, which bounds the playlist it reloads every few seconds.
const LIVE_WINDOW_BEHIND_SECONDS = 5 * 60;
const TRANSCODER_BUDGET_MS = 8_000;
const DEFAULT_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.92 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-us,en;q=0.5",
});
const PLAYLIST_HEADERS = { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store", "access-control-allow-origin": "*" };
const COPIED_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "last-modified", "etag"];

const json = (body, status, headers = {}) => Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const fail = (error) => {
  const yolo = toYoloError(error);
  return json(errorBody(yolo), yolo.status);
};

export function sessionExpiredResponse(message = "This playback session has ended") {
  return json({ error: { code: "not_found", message, retryable: true }, code: SESSION_EXPIRED }, 410, {
    "x-yolo-error-code": SESSION_EXPIRED,
  });
}

// Signed CDN URLs often carry their expiry; refresh them shortly before.
export function urlExpiry(url) {
  try {
    const params = new URL(url).searchParams;
    const value = Number(params.get("expire") || params.get("expires") || params.get("deadline"));
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? value * 1000 : value;
  } catch {
    return null;
  }
}

// The canvas engine marks read-ahead requests, which must not move a live
// cursor, with `?prefetch=1`.
export const isPrefetchRequest = (request) => new URL(request.url).searchParams.get("prefetch") === "1";

const isAbort = (error) => error?.name === "AbortError" || error?.code === "ERR_STREAM_PREMATURE_CLOSE" || error?.code === "ECONNRESET";

// The host of an upstream URL, for logs.
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

// --- The pipeline ------------------------------------------------------------

export function createMediaPipeline({
  secret,
  runtimeDir,
  logger = silentLogger,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  stopGraceMs = STOP_GRACE_MS,
  idleSessionMs = IDLE_SESSION_MS,
  segmentTiming = SEGMENT_TIMING,
  fileFailoverMs = FILE_FAILOVER_MS,
  health = createHostHealth(),
} = {}) {
  if (!secret) throw new Error("The media pipeline needs NODE_SECRET to check media tokens");
  const maxVideoKbps = (() => {
    const value = Number(env.STREAM_MAX_VIDEO_BITRATE_KBPS || 4800);
    return Number.isFinite(value) && value >= 500 && value <= 20_000 ? Math.floor(value) : 4800;
  })();
  const transcodeByDefault = ["1", "true", "yes", "on"].includes(String(env.DASH_TRANSCODE ?? "").trim().toLowerCase());
  const transcodeRoot = resolve(runtimeDir, ".hls-cache");
  const cache = createSegmentCache({
    dir: resolve(runtimeDir, ".segment-cache"),
    maxBytes: Number(env.SEGMENT_CACHE_MAX_BYTES) > 0 ? Math.floor(Number(env.SEGMENT_CACHE_MAX_BYTES)) : undefined,
    logger,
  });
  const fetchOptions = { fetchFn: fetchImpl, logger };

  const sessions = new Map(); // sessionId → session
  const prefetch = { queue: [], keys: new Set(), active: 0, foreground: 0 };
  const dashFetches = new Map(); // cache filename → in-flight segment promise
  let sweeper = null;
  let failovers = 0;
  let hedges = 0;

  // --- Sessions ----------------------------------------------------------

  function newSession({ sessionId, token, userId, source, descriptor, request }) {
    return {
      id: sessionId,
      token,
      userId,
      source,
      descriptor,
      request,
      input: descriptor.input,
      delivery: null,
      resources: new Map(),
      byUrl: new Map(),
      nextResource: 0,
      dash: null,
      transcode: null,
      selected: { subtitles: [...(descriptor.tracks?.selected?.subtitles || [])], audio: descriptor.tracks?.selected?.audio ?? null },
      subtitleIds: [],
      createdAt: now(),
      lastAccessAt: now(),
      stopping: false,
      refreshing: null,
      lastRefreshAt: 0,
    };
  }

  function register(session, kind, { alternates = [], ...fields }) {
    const known = fields.url && session.byUrl.get(`${kind}:${fields.url}`);
    if (known && session.resources.has(known)) return known;
    const id = String(session.nextResource++);
    const mirrors = alternates.length ? [fields.url, ...alternates] : null;
    session.resources.set(id, { id, kind, ...fields, mirrors, expiresAt: urlExpiry(fields.url || "") });
    if (fields.url) session.byUrl.set(`${kind}:${fields.url}`, id);
    // A long live stream keeps adding segments; forget the oldest.
    if (session.resources.size > MAX_RESOURCES) {
      const oldest = session.resources.keys().next().value;
      const resource = session.resources.get(oldest);
      session.resources.delete(oldest);
      if (resource?.url) session.byUrl.delete(`${resource.kind}:${resource.url}`);
    }
    return id;
  }

  // What the playing device reads (Agent Note 2026-10-12-two-playback-engines).
  // A caller that gave no capabilities gets the canvas engine's deliveries.
  const deviceOf = (session) => session.request?.capabilities || null;
  const readsSplit = (session) => !deviceOf(session) || readsSplitFiles(deviceOf(session));
  const waitsForRunway = (session) => !deviceOf(session) || waitsForLiveRunway(deviceOf(session));

  const base = (session) => `/m/${session.token}`;
  const paths = {
    file: (session, id) => `${base(session)}/f/${id}`,
    playlist: (session, id) => `${base(session)}/p/${id}.m3u8`,
    live: (session, id, sequence) => `${base(session)}/l/${id}/${sequence}`,
    dashPlaylist: (session, track) => `${base(session)}/dash/${track}.m3u8`,
    dashInit: (session, track) => `${base(session)}/dash/${track}/init.mp4`,
    dashSegment: (session, track, index) => `${base(session)}/dash/${track}/${index}.m4s`,
    transcode: (session, name) => `${base(session)}/x/${name}`,
    subtitle: (session, index) => `${base(session)}/sub/${index}.vtt`,
  };

  async function release(session) {
    session.stopping = true;
    if (sessions.get(session.id) === session) sessions.delete(session.id);
    prefetch.queue = prefetch.queue.filter((item) => {
      if (item.session !== session) return true;
      prefetch.keys.delete(item.key);
      return false;
    });
    await Promise.allSettled([
      session.transcode?.stop(),
      Promise.resolve().then(() => session.descriptor.stop?.()),
    ]);
  }

  // Keep serving a replaced or stopped session briefly: a player that has
  // not yet received its next `load` may still be fetching.
  function retire(session) {
    if (session.retiring) return;
    session.retiring = true;
    session.stopping = true;
    const timer = setTimeout(() => {
      release(session).catch((error) => logger.warn({ sessionId: session.id, err: error.message }, "Session release failed"));
    }, stopGraceMs);
    timer.unref?.();
  }

  function sweep() {
    const cutoff = now() - idleSessionMs;
    for (const session of sessions.values()) {
      if (session.lastAccessAt < cutoff) {
        logger.info({ sessionId: session.id }, "Releasing idle media session");
        void release(session);
      }
    }
  }

  // --- Upstream requests -------------------------------------------------

  function requestHeaders(resource, range) {
    const headers = { ...(resource.headers || DEFAULT_HEADERS) };
    if (range) {
      // Byte offsets refer to the original representation: never negotiate
      // compression for ranged media requests.
      for (const name of Object.keys(headers)) if (name.toLowerCase() === "accept-encoding") delete headers[name];
      headers.Range = range;
      headers["Accept-Encoding"] = "identity";
    }
    return headers;
  }

  // Ask the source for fresh upstream URLs (signed CDN URLs expire), at most
  // once per cooldown, shared by every resource of the session.
  async function refresh(session) {
    const fn = session.descriptor.refresh;
    if (typeof fn !== "function") return false;
    if (session.refreshing) {
      await session.refreshing;
      return true;
    }
    if (now() - session.lastRefreshAt < REFRESH_COOLDOWN_MS) return false;
    session.lastRefreshAt = now();
    session.refreshing = (async () => {
      const next = normalizeInput(await fn(), "refresh()");
      const update = (role, value) => {
        for (const resource of session.resources.values()) {
          if (resource.role !== role) continue;
          pointAt(session, resource, value.url);
          if (value.headers) resource.headers = value.headers;
          resource.mirrors = value.alternates?.length ? [value.url, ...value.alternates] : null;
        }
      };
      if (next.type === "split") {
        update("video", next.video);
        update("audio", next.audio);
      } else {
        update("main", next);
      }
      logger.info({ sessionId: session.id }, "Refreshed upstream URLs");
    })();
    try {
      await session.refreshing;
      return true;
    } catch (error) {
      logger.warn({ sessionId: session.id, err: error.message }, "Upstream refresh failed");
      return false;
    } finally {
      session.refreshing = null;
    }
  }

  function pointAt(session, resource, url) {
    session.byUrl.delete(`${resource.kind}:${resource.url}`);
    resource.url = url;
    resource.expiresAt = urlExpiry(url);
    session.byUrl.set(`${resource.kind}:${resource.url}`, resource.id);
  }

  // The URLs of a resource in the order to try them now.
  const urlsOf = (resource) => (resource.mirrors ? health.rank(resource.mirrors) : [resource.url]);

  // A `file` request leaves `from` for `to` (Input `alternates`).
  function failover(session, resource, from, to, reason) {
    health.fault(from);
    failovers += 1;
    logger.warn({ sessionId: session.id, role: resource.role, from: hostOf(from), to: hostOf(to), reason }, "Switched to an alternate upstream URL");
  }

  // `failFast`: another URL of the same bytes is waiting, so do not spend
  // seconds retrying this one (one try, a short header timeout, and a
  // denial is returned rather than refreshed).
  async function fetchResource(session, resource, { url = resource.url, range = null, method = "GET", signal, label = "media", failFast = false } = {}) {
    if (resource.expiresAt && resource.expiresAt - now() <= REFRESH_SKEW_MS) await refresh(session);
    const attempt = (target) => fetchWithRetry(target, {
      method,
      headers: requestHeaders(resource, range),
      redirect: "follow",
      signal,
    }, { label, ...fetchOptions, ...(failFast ? { retries: 0, responseTimeoutMs: fileFailoverMs } : {}) });
    let upstream = await attempt(url);
    if (upstream.status === 403 && session.descriptor.refresh && !failFast) {
      await upstream.body?.cancel().catch(() => {});
      if (await refresh(session)) upstream = await attempt(resource.url);
    }
    return upstream;
  }

  const failoverStatus = (status) => status >= 500 || [403, 404, 408, 410, 429].includes(status);

  // A transcoder (Input.transcoder) answers 404 for a segment it has not
  // written yet, and also for a session it dropped. Retry briefly, and ask
  // the source whether its session still exists before giving up.
  // The budget bounds waiting for headers, not a slow but progressing body.
  async function fetchTranscoderSegment(session, resource, { range, method }) {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new Error("The transcoder did not answer in time")), TRANSCODER_BUDGET_MS);
    try {
      for (let attempt = 0; attempt < TRANSCODER_RETRY_DELAYS_MS.length; attempt += 1) {
        if (TRANSCODER_RETRY_DELAYS_MS[attempt]) await delay(TRANSCODER_RETRY_DELAYS_MS[attempt], undefined, { signal: budget.signal });
        const upstream = await fetchImpl(resource.url, { method, headers: requestHeaders(resource, range), signal: budget.signal });
        if (upstream.status !== 404) return upstream;
        await upstream.body?.cancel().catch(() => {});
        if (await sourceHealth(session) === "expired") return sessionExpiredResponse("The source ended this playback session");
      }
      return new Response(null, { status: 404 });
    } finally {
      clearTimeout(timer);
    }
  }

  async function sourceHealth(session) {
    if (typeof session.descriptor.health !== "function") return "unknown";
    try {
      return await Promise.race([session.descriptor.health(), delay(3_000).then(() => "unknown")]);
    } catch {
      return "unknown";
    }
  }

  // --- Serving: files ----------------------------------------------------

  function copyHeaders(upstream, extra = {}) {
    const headers = new Headers({ "access-control-allow-origin": "*", ...extra });
    for (const name of COPIED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return headers;
  }

  async function serveFile(session, resource, request) {
    const range = request.headers.get("range") || "";
    const method = request.method === "HEAD" ? "HEAD" : "GET";
    const identity = resource.cacheKey ? resource.cacheKey(resource.url) : null;
    if (resource.cache !== false && method === "GET") {
      const hit = cache.get(resource.url, range, identity);
      if (hit) {
        cache.stats.hits += 1;
        return cache.respond(hit);
      }
      cache.stats.misses += 1;
    }
    const urls = urlsOf(resource);
    let upstream;
    for (let index = 0; ; index += 1) {
      const failFast = !resource.transcoder && index < urls.length - 1;
      try {
        upstream = resource.transcoder
          ? await fetchTranscoderSegment(session, resource, { range: range || null, method })
          : await fetchResource(session, resource, { url: urls[index], range: range || null, method, label: "media-file", failFast });
      } catch (error) {
        if (failFast && !isAbort(error)) {
          failover(session, resource, urls[index], urls[index + 1], error.code || "error");
          continue;
        }
        throw error;
      }
      if (failFast && failoverStatus(upstream.status)) {
        await upstream.body?.cancel().catch(() => {});
        failover(session, resource, urls[index], urls[index + 1], `status ${upstream.status}`);
        continue;
      }
      break;
    }
    if (upstream.headers.get("x-yolo-error-code")) return upstream;
    if (upstream.status >= 400) {
      await upstream.body?.cancel().catch(() => {});
      return json(errorBody(new YoloError(upstream.status === 403 ? "forbidden" : "resolve_failed", `Upstream answered ${upstream.status}`)), upstream.status, {
        ...(upstream.status === 403 ? { "x-yolo-error-code": "UPSTREAM_ACCESS_DENIED" } : {}),
      });
    }
    const headers = copyHeaders(upstream);
    if (!upstream.body || method === "HEAD") return new Response(null, { status: upstream.status, headers });
    const identityNow = resource.cacheKey ? resource.cacheKey(resource.url) : null;
    const body = resource.cache !== false && isCacheableResponse(resource.url, upstream, range)
      ? cache.tee(upstream, cache.paths(resource.url, range, identityNow))
      : upstream.body;
    return new Response(body, { status: upstream.status, headers });
  }

  // --- Serving: HLS playlists --------------------------------------------

  async function loadPlaylist(session, resource) {
    if (resource.manifest) return { status: 200, body: resource.manifest };
    const { response, body } = await fetchTextWithRetry(resource.url, {
      headers: requestHeaders(resource, null),
      redirect: "follow",
    }, { retries: resource.transcoder ? 0 : 2, label: "hls-playlist", maxBytes: MAX_PLAYLIST_BYTES, timeoutMs: resource.transcoder ? 8_000 : 15_000, ...fetchOptions });
    if (response.status === 403 && session.descriptor.refresh && resource.role === "main" && await refresh(session)) {
      return loadPlaylist(session, resource);
    }
    return { status: response.status, body, finalUrl: response.url || resource.url };
  }

  function childOf(session, resource, uri, baseUrl) {
    const absolute = /^https?:\/\//i.test(uri) ? uri : new URL(uri, baseUrl).href;
    const playlist = /\.m3u8(?:[?#]|$)/i.test(absolute);
    const id = register(session, playlist ? "playlist" : "file", {
      url: absolute,
      headers: resource.headers,
      cacheKey: resource.cacheKey,
      cache: resource.cache,
      transcoder: resource.transcoder,
      trimToStart: resource.trimToStart,
      live: resource.live,
      liveAt: resource.liveAt,
      role: "child",
    });
    // A live seek asks the parent for a new position; children follow it.
    if (resource.liveAt != null) session.resources.get(id).liveAt = resource.liveAt;
    return playlist ? paths.playlist(session, id) : paths.file(session, id);
  }

  async function servePlaylist(session, resource, url) {
    const loaded = await loadPlaylist(session, resource);
    if (loaded.status === 404 && resource.transcoder && await sourceHealth(session) === "expired") {
      return sessionExpiredResponse("The source ended this playback session");
    }
    if (loaded.status < 200 || loaded.status >= 300) {
      return json(errorBody(new YoloError("resolve_failed", `Upstream playlist answered ${loaded.status}`)), loaded.status >= 400 ? loaded.status : 502);
    }
    let body = loaded.body;
    const master = isMasterPlaylist(body);
    if (master) body = filterVariants(body, resource.maxBandwidth);

    const at = url.searchParams.get("at");
    const live = !master && resource.live ? resource.live.parse(body) : null;
    if (live) {
      const requested = sequenceForTime(live, at ?? resource.liveAt);
      resource.liveIndex = live;
      resource.liveCursor = requested ?? resource.liveCursor ?? null;
      body = buildLiveWindow(live, {
        cursorSequence: resource.liveCursor,
        segmentPath: (sequence) => paths.live(session, resource.id, sequence),
        // A native HLS player takes a playlist's last segment for the live
        // edge: no runway of unpublished segments, and a longer look back.
        ...(waitsForRunway(session) ? {} : { cursorSequence: live.latestSequence, windowAheadSeconds: 0, windowBehindSeconds: LIVE_WINDOW_BEHIND_SECONDS }),
      });
    } else {
      if (!master && resource.trimToStart) {
        body = trimToStartOffset(body, { onTrim: (detail) => logger.info({ sessionId: session.id, ...detail }, "Trimmed placeholder segments before the start offset") });
      }
      if (at != null && Number.isFinite(Number(at))) resource.liveAt = Number(at);
      const baseUrl = loaded.finalUrl || resource.url;
      body = rewriteHlsUris(body, (uri) => childOf(session, resource, uri, baseUrl));
    }
    return new Response(body, { headers: PLAYLIST_HEADERS });
  }

  // A sequence the window advertised but the source has not published yet:
  // poll the source playlist until it appears (or give up).
  async function serveLiveSegment(session, resource, sequence, request) {
    const index = resource.liveIndex;
    if (!index || !Number.isInteger(sequence) || sequence < 0) return json(errorBody(new YoloError("not_found", "Unknown live segment")), 404);
    if (sequence > index.latestSequence + Math.ceil(180 / index.segmentDuration)) {
      return json(errorBody(new YoloError("not_found", "Unknown live segment")), 404);
    }
    const deadline = now() + LIVE_SEGMENT_WAIT_MS;
    while (sequence > resource.liveIndex.latestSequence && now() < deadline) {
      try {
        const loaded = await loadPlaylist(session, resource);
        const next = loaded.status === 200 ? resource.live.parse(loaded.body) : null;
        if (next) resource.liveIndex = next;
      } catch {
        // Keep the previous index and retry.
      }
      if (sequence <= resource.liveIndex.latestSequence) break;
      await delay(LIVE_POLL_MS);
    }
    const upstream = sequence <= resource.liveIndex.latestSequence ? resource.liveIndex.segmentUrl(sequence) : null;
    if (!upstream) return json(errorBody(new YoloError("not_found", "Unknown live segment")), 404);
    if (!isPrefetchRequest(request)) resource.liveCursor = sequence;
    const id = register(session, "file", { url: upstream, headers: resource.headers, cacheKey: resource.cacheKey, cache: resource.cache, role: "child" });
    return serveFile(session, session.resources.get(id), request);
  }

  // --- Serving: DASH split ------------------------------------------------

  // Bytes `start`–`end` of a resource from its URLs, hedged and streamed
  // (hedge.js); resolves with the download once its first byte arrived. URLs
  // near expiry are refreshed first, and a range that every URL refused is
  // tried once more with fresh URLs from the source.
  async function openRange(session, resource, start, end, { exact = true } = {}) {
    if (resource.expiresAt && resource.expiresAt - now() <= REFRESH_SKEW_MS) await refresh(session);
    for (let refreshed = false; ;) {
      const download = downloadRange({
        urls: resource.mirrors || [resource.url],
        start,
        end,
        exact,
        maxBytes: DASH_SEGMENT_MAX_BYTES,
        health,
        timing: segmentTiming,
        request: (url, range) => fetchImpl(url, { headers: requestHeaders(resource, `bytes=${range.start}-${range.end}`), redirect: "follow", signal: range.signal }),
        onEvent: ({ type, from, to, reason, offset }) => {
          const fields = { sessionId: session.id, role: resource.role, from: hostOf(from), to: hostOf(to), offset, reason };
          if (type === "hedge") {
            hedges += 1;
            logger.info(fields, "Hedged an upstream range");
          } else {
            failovers += 1;
            logger.warn(fields, "Switched to an alternate upstream URL");
          }
        },
      });
      try {
        await download.ready;
        return download;
      } catch (error) {
        if (error.code === "UPSTREAM_ACCESS_DENIED" && !refreshed && await refresh(session)) {
          refreshed = true;
          continue;
        }
        throw error;
      }
    }
  }

  async function probe(session, resource) {
    try {
      const download = await openRange(session, resource, 0, PROBE_BYTES - 1, { exact: false });
      const buffer = await download.done;
      return parseMp4Structure(buffer, download.total ?? buffer.length);
    } catch (error) {
      throw error instanceof YoloError ? error : new YoloError("resolve_failed", `The source failed while probing the stream: ${error.message}`);
    }
  }

  // One download per segment at a time, shared by every request for it (the
  // device's, its retry, the node's read-ahead). A completed segment goes to
  // the disk cache, and later requests are served from there.
  function dashSegment(session, resource, range) {
    const identity = resource.cacheKey ? resource.cacheKey(resource.url) : null;
    const hit = cache.get(resource.url, range, identity);
    if (hit) return Promise.resolve({ entry: hit });
    const target = cache.paths(resource.url, range, identity);
    let pending = dashFetches.get(target.filenameKey);
    if (!pending) {
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
      pending = openRange(session, resource, Number(start), Number(end));
      const key = target.filenameKey;
      dashFetches.set(key, pending);
      pending.then((download) => download.done.then((buffer) => {
        try {
          if (buffer.length >= MIN_CACHE_BYTES) cache.store(target, { status: 206, headers: new Headers({ "content-type": download.contentType || "video/mp4" }) }, buffer);
        } catch (error) {
          logger.warn({ err: error.message }, "Segment cache write failed");
        }
      }, (error) => {
        logger.warn({ sessionId: session.id, role: resource.role, range, err: error.message }, "Segment failed after its first bytes");
      }), () => {}).finally(() => {
        if (dashFetches.get(key) === pending) dashFetches.delete(key);
      });
    }
    return pending.then((download) => ({ download }));
  }

  function segmentRange(track, segment) {
    if (segment === "init") return `bytes=0-${track.info.initEnd}`;
    const index = Math.min(segment, track.info.segments.length - 1);
    const { start, end } = track.info.segments[index];
    return `bytes=${start}-${end}`;
  }

  // Warm the next few segments, one download at a time, after foreground work.
  function enqueuePrefetch(session, trackName, index) {
    const track = session.dash.tracks[trackName];
    for (let offset = 1; offset <= DASH_PREFETCH_AHEAD; offset += 1) {
      const next = index + offset;
      if (next >= track.info.segments.length) break;
      const range = segmentRange(track, next);
      const key = `${session.id}|${trackName}|${next}`;
      if (prefetch.keys.has(key)) continue;
      const resource = session.resources.get(track.resource);
      if (cache.get(resource.url, range, resource.cacheKey ? resource.cacheKey(resource.url) : null)) continue;
      prefetch.keys.add(key);
      const item = { session, trackName, range, key };
      // Video first: a frozen picture is worse than briefly silent audio.
      const firstAudio = prefetch.queue.findIndex((queued) => queued.trackName !== "video");
      if (trackName === "video" && firstAudio !== -1) prefetch.queue.splice(firstAudio, 0, item);
      else prefetch.queue.push(item);
    }
    pumpPrefetch();
  }

  function pumpPrefetch() {
    while (!prefetch.foreground && !prefetch.active && prefetch.queue.length) {
      const item = prefetch.queue.shift();
      if (item.session.stopping) {
        prefetch.keys.delete(item.key);
        continue;
      }
      prefetch.active += 1;
      const resource = item.session.resources.get(item.session.dash.tracks[item.trackName].resource);
      dashSegment(item.session, resource, item.range)
        .then((result) => result.download?.done)
        .catch((error) => logger.debug({ err: error.message }, "Segment prefetch failed"))
        .finally(() => {
          prefetch.active -= 1;
          prefetch.keys.delete(item.key);
          pumpPrefetch();
        });
    }
  }

  async function serveDash(session, rest) {
    if (!session.dash) return json(errorBody(new YoloError("not_found", "No split stream in this session")), 404);
    if (rest === "master.m3u8") return new Response(session.dash.playlists.master, { headers: PLAYLIST_HEADERS });
    const playlist = /^(video|audio)\.m3u8$/.exec(rest);
    if (playlist) return new Response(session.dash.playlists[playlist[1]], { headers: PLAYLIST_HEADERS });
    const segment = /^(video|audio)\/(init\.mp4|\d+\.m4s)$/.exec(rest);
    if (!segment) return json(errorBody(new YoloError("not_found", "Unknown segment")), 404);
    const track = session.dash.tracks[segment[1]];
    const index = segment[2] === "init.mp4" ? "init" : Number.parseInt(segment[2], 10);
    const resource = session.resources.get(track.resource);
    // Read-ahead waits until this segment has arrived in full.
    prefetch.foreground += 1;
    let arrived = Promise.resolve();
    let result;
    try {
      result = await dashSegment(session, resource, segmentRange(track, index));
      if (result.download) arrived = result.download.done.catch(() => {});
    } catch (error) {
      const denied = error.code === "UPSTREAM_ACCESS_DENIED";
      const status = denied ? 403 : error.code === "UPSTREAM_TIMEOUT" ? 504 : 502;
      return json({ ...errorBody(new YoloError(denied ? "forbidden" : "resolve_failed", error.message)), code: error.code || null }, status, {
        ...(denied ? { "x-yolo-error-code": "UPSTREAM_ACCESS_DENIED" } : {}),
      });
    } finally {
      void arrived.then(() => {
        prefetch.foreground -= 1;
        pumpPrefetch();
      });
    }
    if (index !== "init") enqueuePrefetch(session, segment[1], index);
    if (result.entry) return cache.respond(result.entry, { status: 200, rangeHeaders: false });
    // The bytes go to the device as they arrive: its time to first byte is
    // the upstream's, not the whole segment's.
    const { download } = result;
    return new Response(download.stream(), {
      headers: { "content-type": download.contentType || "video/mp4", "content-length": String(download.length), "access-control-allow-origin": "*" },
    });
  }

  // --- Serving: ffmpeg output ---------------------------------------------

  async function serveTranscode(session, name) {
    const job = session.transcode;
    if (!job) return json(errorBody(new YoloError("not_found", "No transcode in this session")), 404);
    if (name === "playlist.m3u8") {
      if (!await job.ready({ timeoutMs: TRANSCODE_STARTUP_TIMEOUT_MS, pollMs: 120 })) {
        return json(errorBody(new YoloError("resolve_failed", "The transcode is not ready")), 503);
      }
      const body = readFileSync(job.playlistPath, "utf8");
      return new Response(rewriteTranscodePlaylist(body, (file) => paths.transcode(session, file)), { headers: PLAYLIST_HEADERS });
    }
    if (!/^(?:init\.mp4|[A-Za-z0-9._-]+\.m4s)$/i.test(name)) return json(errorBody(new YoloError("invalid_request", "Bad segment name")), 400);
    const file = resolve(job.dir, name);
    if (!existsSync(file)) return json(errorBody(new YoloError("not_found", "Segment not found")), 404);
    return new Response(Readable.toWeb(createReadStream(file)), {
      headers: { "content-type": "video/mp4", "content-length": String(statSync(file).size), "cache-control": "no-cache" },
    });
  }

  // --- Serving: subtitles -------------------------------------------------

  async function serveSubtitle(session, index) {
    const trackId = session.subtitleIds[index];
    if (trackId == null || typeof session.descriptor.subtitle !== "function") {
      return json(errorBody(new YoloError("not_found", "Unknown subtitle")), 404);
    }
    const result = await session.descriptor.subtitle(trackId);
    if (result && typeof result === "object" && result.pending) {
      return json({ status: "preparing", message: "The subtitle is being prepared" }, 425, { "retry-after": String(result.retryAfter || 5) });
    }
    if (typeof result !== "string") return json(errorBody(new YoloError("not_found", "Subtitle unavailable")), 404);
    return new Response(result, { headers: { "content-type": "text/vtt; charset=utf-8", "cache-control": "private, max-age=3600" } });
  }

  // --- Building a delivery -------------------------------------------------

  // ffmpeg joins both files into one fMP4 HLS stream; null when it did not
  // start in time.
  async function transcodeSplit(session, input) {
    const job = startTranscode({
      dir: resolve(transcodeRoot, session.id), video: input.video, audio: input.audio, maxVideoKbps: session.request?.limits?.maxVideoKbps || maxVideoKbps, logger,
    });
    if (await job.ready()) {
      session.transcode = job;
      return { type: "hls", url: paths.transcode(session, "playlist.m3u8") };
    }
    logger.warn({ sessionId: session.id, errors: job.errors.slice(-3) }, "Transcode did not start in time");
    await job.stop();
    return null;
  }

  async function buildSplit(session, input) {
    const transcoded = input.transcode || transcodeByDefault;
    if (transcoded) {
      const delivery = await transcodeSplit(session, input);
      if (delivery) return delivery;
      logger.warn({ sessionId: session.id }, "Serving the split files instead of a transcode");
    }
    const fields = (track, role) => ({ url: track.url, headers: track.headers || null, cacheKey: track.cacheKey, cache: true, role, alternates: track.alternates || [] });
    const video = register(session, "file", fields(input.video, "video"));
    const audio = register(session, "file", fields(input.audio, "audio"));
    const [videoInfo, audioInfo] = await Promise.all([probe(session, session.resources.get(video)), probe(session, session.resources.get(audio))]);
    const playlists = buildDashHls({
      video: input.video,
      audio: input.audio,
      videoInfo,
      audioInfo,
      paths: {
        playlist: (track) => paths.dashPlaylist(session, track),
        init: (track) => paths.dashInit(session, track),
        segment: (track, index) => paths.dashSegment(session, track, index),
      },
    });
    if (!playlists) {
      // No segment index: the canvas engine reads both files with byte
      // ranges; a <video> element needs the one stream ffmpeg makes.
      if (readsSplit(session)) return { type: "split-mp4", videoUrl: paths.file(session, video), audioUrl: paths.file(session, audio) };
      const delivery = transcoded ? null : await transcodeSplit(session, input);
      if (delivery) return delivery;
      throw new YoloError("resolve_failed", "These separate audio and video files have no segment index, and the transcode to one stream did not start");
    }
    session.dash = {
      playlists,
      tracks: { video: { resource: video, info: videoInfo }, audio: { resource: audio, info: audioInfo } },
    };
    return { type: "hls", url: paths.dashPlaylist(session, "master") };
  }

  async function buildDelivery(session) {
    const { input } = session;
    if (input.type === "file") {
      const id = register(session, "file", { url: input.url, headers: input.headers, cacheKey: input.cacheKey, cache: input.cache, role: "main", alternates: input.alternates });
      return { type: "mp4", url: paths.file(session, id) };
    }
    if (input.type === "hls") {
      const id = register(session, "playlist", {
        url: input.url,
        headers: input.headers,
        cacheKey: input.cacheKey,
        cache: input.cache,
        manifest: input.manifest,
        maxBandwidth: input.maxBandwidth,
        trimToStart: input.trimToStart,
        live: input.live,
        transcoder: input.transcoder,
        role: "main",
      });
      return { type: "hls", url: paths.playlist(session, id) };
    }
    return buildSplit(session, input);
  }

  // Tracks as the device sees them: VTT tracks get a URL in this session.
  function presentTracks(session) {
    const tracks = session.descriptor.tracks || { subtitles: [], audio: [] };
    const strip = ({ id, kind, language, name, auto, format, default: isDefault, delivery }) => ({
      id: String(id), kind, language: language ?? "", name: name ?? "", auto: Boolean(auto), format: format || "text", default: Boolean(isDefault), delivery: delivery || "vtt",
    });
    const subtitles = (tracks.subtitles || []).map((track) => {
      const presented = strip({ kind: "subtitle", ...track });
      if (presented.delivery === "vtt") {
        let index = session.subtitleIds.indexOf(presented.id);
        if (index === -1) index = session.subtitleIds.push(presented.id) - 1;
        presented.url = paths.subtitle(session, index);
      }
      return presented;
    });
    return {
      subtitles,
      audio: (tracks.audio || []).map((track) => strip({ kind: "audio", ...track, delivery: "stream" })),
      selected: { subtitles: session.selected.subtitles.map(String), audio: session.selected.audio == null ? null : String(session.selected.audio) },
    };
  }

  // The bitrate cap this stream was prepared with: the node's ceiling, or the
  // device's adaptive-quality cap below it, or a lower one the source chose
  // to start under (descriptor `maxVideoKbps`), which the device can step up
  // from (Agent Note 2026-10-11-adaptive-quality).
  function limitsOf(session) {
    const limits = session.request?.limits ?? null;
    const started = Math.floor(Number(session.descriptor.maxVideoKbps));
    if (!limits || !(started > 0) || started >= limits.maxVideoKbps) return limits;
    return { ...limits, maxVideoKbps: started, capped: true };
  }

  function present(session) {
    const { descriptor } = session;
    return {
      sessionId: session.id,
      delivery: session.delivery,
      profile: descriptor.profile ?? null,
      title: descriptor.title ?? null,
      duration: Number(descriptor.duration) > 0 ? Number(descriptor.duration) : null,
      isLive: Boolean(descriptor.isLive),
      liveDvr: descriptor.isLive && session.input.type === "hls" && session.input.live ? { available: true, defaultLatencySeconds: 30 } : null,
      thumbnail: descriptor.thumbnail ?? null,
      startTime: Math.max(0, Number(descriptor.startTime) || 0),
      // The source's stream may begin at `startTime`, not at 0: its
      // placeholder segments before it are dropped (Input `trimToStart`).
      trimToStart: session.input.type === "hls" && session.input.trimToStart === true,
      tracks: presentTracks(session),
      limits: limitsOf(session),
    };
  }

  // --- Public API -----------------------------------------------------------

  return {
    maxVideoKbps,

    get size() {
      return sessions.size;
    },

    init() {
      cache.init();
      mkdirSync(transcodeRoot, { recursive: true });
      // ffmpeg output of sessions from an earlier run is useless now.
      for (const name of readdirSync(transcodeRoot)) {
        if (name.startsWith("ses_")) rmSync(resolve(transcodeRoot, name), { recursive: true, force: true });
      }
      sweeper ??= setInterval(sweep, 60_000);
      sweeper.unref?.();
    },

    async close() {
      clearInterval(sweeper);
      sweeper = null;
      await Promise.allSettled([...sessions.values()].map(release));
    },

    status() {
      return {
        sessions: sessions.size,
        transcodes: [...sessions.values()].filter((session) => session.transcode).length,
        cache: { ...cache.stats },
        failovers,
        hedges,
        hosts: health.snapshot(),
      };
    },

    has: (sessionId) => sessions.has(sessionId),
    session: (sessionId) => sessions.get(sessionId) || null,

    // Start serving what a source's prepare() returned. Preparing an existing
    // session id replaces it: the old resources stay readable briefly.
    async open({ sessionId, mediaToken, source, descriptor, request = {} }) {
      const token = await verifyMediaToken(secret, mediaToken, now());
      if (!token || token.sessionId !== sessionId) throw new YoloError("invalid_request", "A media token for this session is required");
      const session = newSession({ sessionId, token: mediaToken, userId: token.userId, source, descriptor: { ...descriptor, input: normalizeInput(descriptor.input) }, request });
      try {
        session.delivery = await buildDelivery(session);
      } catch (error) {
        await release(session);
        throw error;
      }
      const previous = sessions.get(sessionId);
      sessions.set(sessionId, session);
      if (previous) retire(previous);
      // Bound the work a stream of prepares can leave behind.
      const live = [...sessions.values()].filter((candidate) => !candidate.stopping);
      for (const old of live.slice(0, Math.max(0, live.length - MAX_SESSIONS))) retire(old);
      return present(session);
    },

    present: (sessionId) => {
      const session = sessions.get(sessionId);
      return session ? present(session) : null;
    },

    // Switch text subtitles inside a session (no new stream).
    selectSubtitles(sessionId, subtitles) {
      const session = sessions.get(sessionId);
      if (!session) throw new YoloError("not_found", `Session ${sessionId} is not active on this node`);
      session.selected.subtitles = subtitles.map(String);
      return presentTracks(session);
    },

    async progress(sessionId, report) {
      const session = sessions.get(sessionId);
      if (!session) return { ok: false };
      session.lastAccessAt = now();
      await session.descriptor.progress?.(report);
      return { ok: true };
    },

    async stop(sessionId) {
      const session = sessions.get(sessionId);
      if (session) retire(session);
      return { ok: true };
    },

    // GET/HEAD /m/{token}/… from the control plane's passthrough.
    async handle(request) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      const url = new URL(request.url);
      const match = /^\/m\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (!match) return json(errorBody(new YoloError("not_found", "No such media path")), 404);
      const [, token, rest] = match;
      const claims = await verifyMediaToken(secret, token, now());
      if (!claims) {
        // An expired token is a session to rebuild; a forged one is not.
        const parts = token.split(".");
        const expired = parts.length === 4 && Number(parts[2]) * 1000 <= now();
        return expired ? sessionExpiredResponse("The media token expired") : json(errorBody(new YoloError("forbidden", "Bad media token")), 403);
      }
      const session = sessions.get(claims.sessionId);
      if (!session || session.userId !== claims.userId) return sessionExpiredResponse();
      session.lastAccessAt = now();
      try {
        let found;
        if ((found = /^f\/(\d+)$/.exec(rest))) {
          const resource = session.resources.get(found[1]);
          return resource ? await serveFile(session, resource, request) : json(errorBody(new YoloError("not_found", "Unknown media resource")), 404);
        }
        if ((found = /^p\/(\d+)\.m3u8$/.exec(rest))) {
          const resource = session.resources.get(found[1]);
          return resource ? await servePlaylist(session, resource, url) : json(errorBody(new YoloError("not_found", "Unknown playlist")), 404);
        }
        if ((found = /^l\/(\d+)\/(\d+)$/.exec(rest))) {
          const resource = session.resources.get(found[1]);
          return resource ? await serveLiveSegment(session, resource, Number(found[2]), request) : json(errorBody(new YoloError("not_found", "Unknown playlist")), 404);
        }
        if ((found = /^dash\/(.+)$/.exec(rest))) return await serveDash(session, found[1]);
        if ((found = /^x\/([^/]+)$/.exec(rest))) return await serveTranscode(session, found[1]);
        if ((found = /^sub\/(\d+)\.vtt$/.exec(rest))) return await serveSubtitle(session, Number(found[1]));
        return json(errorBody(new YoloError("not_found", "No such media path")), 404);
      } catch (error) {
        if (isAbort(error)) return new Response(null, { status: 499 });
        logger.warn({ sessionId: session.id, path: rest, err: error.message }, "Media request failed");
        return fail(error.code && !(error instanceof YoloError) ? new YoloError("resolve_failed", error.message) : error);
      }
    },
  };
}
