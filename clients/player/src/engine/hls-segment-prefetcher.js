const SEGMENT_PATTERN = /\.(?:m4s|mp4|ts)(?:[?#]|$)/i;
// The node's live-window tags: #EXT-X-YOLO-DVR-START, -LIVE-EDGE, and
// -PLAY-START.
const LIVE_TAG = /^#EXT-X-YOLO-(DVR-START|LIVE-EDGE|PLAY-START):(.*)$/;
const PLAYLIST_PATTERN = /\.m3u8(?:[?#]|$)/i;
// The media node derives its segment hedging and give-up thresholds from this
// value (DEVICE_SEGMENT_TIMEOUT_MS in service/node/src/media/hedge.js,
// Agent Note 2026-10-11-node-media-pipeline); change both together.
const DEFAULT_INACTIVITY_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_CYCLE_MAX_DELAY_MS = 30_000;

class SegmentInactivityError extends Error {
  constructor(timeoutMs) {
    super(`HLS segment made no network progress for ${timeoutMs}ms`);
    this.name = "SegmentInactivityError";
    this.code = "HLS_SEGMENT_INACTIVITY";
  }
}

function segmentDownloadFailure() {
  const error = new Error("HLS segment network fetch failed after bounded retries");
  error.code = "HLS_SEGMENT_FETCH_FAILED";
  return error;
}

// Yolo's media node answers 410 SESSION_EXPIRED for a stream it no longer
// serves (the node restarted, or the source dropped its transcode).
function sessionExpiredError(response) {
  if (response.status !== 410 || response.headers.get("X-Yolo-Error-Code") !== "SESSION_EXPIRED") return null;
  const error = new Error("The playback session expired");
  error.code = "SESSION_EXPIRED";
  return error;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponseBytes(response, controller, timeoutMs) {
  if (!response.body?.getReader) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      let timer = null;
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new SegmentInactivityError(timeoutMs);
            controller.abort(error);
            reject(error);
          }, timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (result.done) break;
      const chunk = result.value instanceof Uint8Array
        ? result.value
        : new Uint8Array(result.value);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

// A playlist's last path segment ("audio.m3u8"): it names the playlist in
// telemetry without the media token earlier in the path.
function playlistName(url) {
  try {
    return new URL(url).pathname.split("/").at(-1).slice(0, 40);
  } catch {
    return null;
  }
}

function requestUrl(input, baseUrl) {
  if (typeof input === "string") return new URL(input, baseUrl).href;
  if (input instanceof URL) return input.href;
  return input?.url ? new URL(input.url, baseUrl).href : "";
}

// A read-ahead request says so with `?prefetch=1` on every origin (the node
// keeps a live cursor on foreground requests only). A query, not a header:
// on the node's LAN origin a custom header would make every segment request
// wait for a CORS preflight (Agent Note 2026-10-12-lan-direct-play).
export function prefetchRequest(url) {
  const target = new URL(url);
  target.searchParams.set("prefetch", "1");
  return { url: target.href, headers: {} };
}

function responseFromCache(entry) {
  return new Response(entry.bytes, {
    status: entry.status,
    statusText: entry.statusText,
    headers: entry.headers,
  });
}

export class HlsSegmentPrefetcher {
  constructor({
    ahead = 90,
    targetAheadSeconds = 210,
    maxBytes = 128 * 1024 * 1024,
    maxConcurrent = 1,
    inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    retryCycleMaxDelayMs = DEFAULT_RETRY_CYCLE_MAX_DELAY_MS,
    fetchImpl = globalThis.fetch,
    baseUrl = globalThis.location?.href || "http://localhost/",
    logger = console,
    onSessionExpired = () => {},
  } = {}) {
    this.ahead = ahead;
    this.targetAheadSeconds = targetAheadSeconds;
    this.maxBytes = maxBytes;
    this.maxConcurrent = maxConcurrent;
    this.inactivityTimeoutMs = inactivityTimeoutMs;
    this.maxRetries = maxRetries;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.retryCycleMaxDelayMs = retryCycleMaxDelayMs;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.logger = logger;
    this.onSessionExpired = onSessionExpired;
    this.playlists = new Map();
    this.segmentIndexes = new Map();
    // Completed media and in-flight work have different lifecycles. A seek
    // may cancel obsolete work, but must never discard reusable bytes.
    this.segmentCache = new Map();
    this.jobs = new Map();
    this.controllers = new Set();
    this.awaitingPlaylistUpdate = false;
    this.throughputSamples = [];
    this.ewmaThroughputBps = 0;
    this.completedDownloads = 0;
    // When the newest throughput sample finished: an estimate this old
    // describes a link the read-ahead stopped using (quality.js).
    this.lastDownloadAt = 0;
    this.segmentSizeSamples = [];
    // Each playlist's recent segment sizes: audio and video segments differ
    // several times over, and an estimate from both overshot the cap.
    this.segmentSizesByPlaylist = new Map();
    this.peakCachedBytes = 0;
    this.peakBufferedAheadSeconds = 0;
    this.peakManagedBytesEstimate = 0;
    this.byteCapHitCount = 0;
    // What eviction removed: segments at or behind a playlist's position
    // (history), segments ahead of it, and their bytes.
    this.evictedBehindCount = 0;
    this.evictedAheadCount = 0;
    this.evictedBytes = 0;
    this.networkRetryCount = 0;
    this.timeoutCount = 0;
    this.failureCount = 0;
    this.retryTimer = null;
    this.retryTimerAt = 0;
    this.lastFailure = null;
    this.atByteCap = false;
    this.generation = 0;
    this.destroyed = false;
    // A hidden player's buffer (mediabunny-player.js suspend()): what is
    // cached stays, and nothing new is fetched ahead until resume().
    this.suspended = false;
  }

  suspend() {
    if (this.destroyed || this.suspended) return;
    this.suspended = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryTimerAt = 0;
  }

  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    this.pumpPrefetches();
  }

  async fetch(input, init = {}) {
    const url = requestUrl(input, this.baseUrl);
    if (!url) return this.fetchImpl(input, init);

    if (PLAYLIST_PATTERN.test(url)) {
      const controller = new AbortController();
      const externalSignal = init.signal || input?.signal;
      const forwardAbort = () => controller.abort(externalSignal.reason || new Error("Fetch aborted"));
      externalSignal?.addEventListener("abort", forwardAbort, { once: true });
      let response = null;
      try {
        let headerTimer = null;
        response = await Promise.race([
          this.fetchImpl(input, { ...init, signal: controller.signal }),
          new Promise((_, reject) => {
            headerTimer = setTimeout(() => {
              const error = new SegmentInactivityError(this.inactivityTimeoutMs);
              controller.abort(error);
              reject(error);
            }, this.inactivityTimeoutMs);
          }),
        ]).finally(() => clearTimeout(headerTimer));
        const bytes = await readResponseBytes(response, controller, this.inactivityTimeoutMs);
        const bufferedResponse = new Response(bytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        if (response.ok) {
          const body = new TextDecoder().decode(bytes);
          this.updatePlaylist(body, response.url || url);
        }
        const expired = sessionExpiredError(response);
        if (expired) throw expired;
        return bufferedResponse;
      } catch (error) {
        const reason = controller.signal.reason;
        const timedOut = error?.code === "HLS_SEGMENT_INACTIVITY"
          || reason?.code === "HLS_SEGMENT_INACTIVITY";
        if (timedOut) this.timeoutCount += 1;
        this.lastFailure = {
          playlistUrl: url,
          segmentIndex: null,
          error: error?.message || String(error),
          attempt: 1,
          at: Date.now(),
        };
        throw error;
      } finally {
        externalSignal?.removeEventListener("abort", forwardAbort);
        try {
          if (response && !response.bodyUsed) await response.body?.cancel();
        } catch {}
      }
    }

    const cached = this.segmentCache.get(url);
    let job = this.jobs.get(url);
    const segmentRef = this.segmentIndexes.get(url);
    const playlist = segmentRef ? this.playlists.get(segmentRef.playlistUrl) : null;
    if (!segmentRef && !cached && !job) return this.fetchImpl(input, init);
    const advanced = segmentRef && playlist
      ? this.advancePlaylist(playlist, segmentRef.index, url)
      : false;

    if (cached) {
      cached.lastAccessedAt = performance.now();
      if (advanced && !this.awaitingPlaylistUpdate) {
        this.scheduleAhead(segmentRef.playlistUrl, segmentRef.index + 1);
      }
      return responseFromCache(cached);
    }

    if (playlist?.terminalError) throw playlist.terminalError;

    if (!job && segmentRef) {
      job = {
        url,
        playlistUrl: segmentRef.playlistUrl,
        index: segmentRef.index,
        state: "queued",
        promise: null,
        controller: null,
      };
      this.jobs.set(url, job);
    }
    if (job) {
      if (job.state === "queued" || job.state === "retry_wait") {
        this.startPrefetchEntry(job, { foreground: true });
      }
      if (advanced && !this.awaitingPlaylistUpdate && segmentRef) {
        this.scheduleAhead(segmentRef.playlistUrl, segmentRef.index + 1);
      }
      const downloaded = await job.promise;
      const completed = this.segmentCache.get(url) || downloaded;
      if (completed) return responseFromCache(completed);
      if (job.terminalError) throw job.terminalError;
      // Playback waited on a read-ahead the node refused: it asks itself,
      // and that answer counts.
      if (job.refusedAhead && job.state === "retry_wait" && !this.destroyed) return this.fetch(input, init);
      // Cancelled by a seek or a newer playlist, not failed: no code, so the
      // reader may ask again (mediabunny-player.js retries uncoded errors).
      if (!job.exhausted) throw new Error("HLS segment download was cancelled");
      throw segmentDownloadFailure();
    }
  }

  advancePlaylist(playlist, index, url) {
    if (index < playlist.currentIndex) return false;
    playlist.currentIndex = index;
    playlist.currentUrl = url;
    for (const [pendingUrl, entry] of this.jobs) {
      if (entry.playlistUrl !== playlist.url || entry.index >= index) continue;
      entry.controller?.abort();
      this.jobs.delete(pendingUrl);
    }
    return true;
  }

  updatePlaylist(body, playlistUrl) {
    const segments = [];
    const ended = /^#EXT-X-ENDLIST\s*$/m.test(body);
    let pendingDuration = null;
    const liveTags = {};
    let playlistStartTime = null;
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
        const value = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length)) / 1000;
        // HLS may repeat this tag before every segment. The seek origin is the
        // first segment in this playlist window, not the last timestamp seen.
        if (playlistStartTime === null && Number.isFinite(value)) playlistStartTime = value;
      } else if (LIVE_TAG.test(line)) {
        const [, name, raw] = LIVE_TAG.exec(line);
        const value = Number(raw);
        if (Number.isFinite(value)) liveTags[name] = value;
      } else if (line.startsWith("#EXTINF:")) {
        const duration = Number(line.slice("#EXTINF:".length).split(",", 1)[0]);
        pendingDuration = Number.isFinite(duration) && duration >= 0 ? duration : null;
      } else if (
        line
        && !line.startsWith("#")
        && (pendingDuration !== null || SEGMENT_PATTERN.test(line))
      ) {
        segments.push({
          url: new URL(line, playlistUrl).href,
          duration: pendingDuration ?? 5,
        });
        pendingDuration = null;
      }
    }
    if (!segments.length) return;
    const liveTag = (name) => liveTags[name] ?? null;
    const liveDvrStartTime = liveTag("DVR-START");
    const liveEdgeTime = liveTag("LIVE-EDGE");
    const livePlayStartTime = liveTag("PLAY-START");

    const previous = this.playlists.get(playlistUrl);
    const unchanged = segments.length === previous?.segments.length
      && segments.every((segment, index) => (
        segment.url === previous.segments[index]?.url
        && segment.duration === previous.segments[index]?.duration
      ));
    if (unchanged) {
      previous.ended = ended;
      previous.liveDvrStartTime = liveDvrStartTime;
      previous.liveEdgeTime = liveEdgeTime;
      previous.livePlayStartTime = livePlayStartTime;
      previous.playlistStartTime = playlistStartTime;
      previous.liveEdgeObservedAt = performance.now();
      this.awaitingPlaylistUpdate = false;
      return;
    }

    const nextIndexes = new Map(segments.map((segment, index) => [segment.url, index]));
    for (const [url, entry] of this.jobs) {
      if (entry.playlistUrl !== playlistUrl) continue;
      const nextIndex = nextIndexes.get(url);
      if (nextIndex !== undefined) {
        entry.index = nextIndex;
        entry.orphanedAt = null;
        continue;
      }
      entry.controller?.abort();
      this.jobs.delete(url);
    }

    if (previous) {
      for (const segment of previous.segments) this.segmentIndexes.delete(segment.url);
    }
    const playlist = {
      url: playlistUrl,
      segments,
      ended,
      currentUrl: previous?.currentUrl || null,
      currentIndex: previous?.currentUrl ? nextIndexes.get(previous.currentUrl) ?? -1 : -1,
      liveDvrStartTime,
      liveEdgeTime,
      livePlayStartTime,
      playlistStartTime,
      liveEdgeObservedAt: performance.now(),
    };
    this.playlists.set(playlistUrl, playlist);
    for (const [url, index] of nextIndexes) {
      this.segmentIndexes.set(url, { playlistUrl, index });
    }
    this.awaitingPlaylistUpdate = false;
    this.pumpPrefetches();
  }

  scheduleAhead(playlistUrl, startIndex) {
    const playlist = this.playlists.get(playlistUrl);
    if (!playlist) return;
    let scheduledSeconds = 0;
    const endIndex = Math.min(playlist.segments.length, startIndex + this.ahead);
    // The end of the latest read-ahead window, for telemetry: a window that
    // stops short of the playlist while playback moves on shows here.
    playlist.scheduledThrough = Math.min(startIndex, playlist.segments.length) - 1;
    for (let index = startIndex; index < endIndex; index += 1) {
      playlist.scheduledThrough = index;
      const url = playlist.segments[index].url;
      if (!this.segmentCache.has(url) && !this.jobs.has(url)) {
        this.jobs.set(url, {
          url,
          playlistUrl,
          index,
          state: "queued",
          promise: null,
          controller: null,
        });
      }
      scheduledSeconds += playlist.segments[index].duration;
      if (scheduledSeconds >= this.targetAheadSeconds) break;
    }
    this.pumpPrefetches();
  }

  pumpPrefetches() {
    if (this.destroyed || this.suspended) return;
    this.startQueuedPrefetches();
    this.scheduleRetryPump();
  }

  startQueuedPrefetches() {
    const now = performance.now();
    const queued = [...this.jobs.values()]
      .filter((entry) => !this.playlists.get(entry.playlistUrl)?.terminalError)
      .filter((entry) => entry.state === "queued" || (
        entry.state === "retry_wait" && (entry.retryAt || 0) <= now
      ))
      .sort((a, b) => this.jobSecondsAhead(a) - this.jobSecondsAhead(b) || a.index - b.index);
    // Room is made only for a wanted segment, and only from history or from
    // segments that start after it: at the cap, trading a segment the window
    // holds for a farther one would only be undone by the next read.
    if (this.cachedBytes >= this.maxBytes) {
      this.evictReadyCache(Math.max(1, this.estimateFor(queued[0])), { makingRoomFor: queued[0] ?? null });
      if (this.cachedBytes >= this.maxBytes) {
        this.markByteCapReached();
        return;
      }
    }
    let active = [...this.jobs.values()].filter((entry) => entry.state === "pending").length;
    if (active >= this.maxConcurrent) return;
    for (const entry of queued) {
      if (active >= this.maxConcurrent) break;
      const estimate = this.estimateFor(entry);
      if (
        estimate > 0
        && this.cachedBytes + this.pendingEstimatedBytes + estimate > this.maxBytes
      ) {
        this.evictReadyCache(
          this.cachedBytes + this.pendingEstimatedBytes + estimate - this.maxBytes,
          { makingRoomFor: entry },
        );
        if (this.cachedBytes + this.pendingEstimatedBytes + estimate > this.maxBytes) {
          this.markByteCapReached();
          break;
        }
      }
      entry.estimatedByteLength = estimate;
      this.atByteCap = false;
      this.startPrefetchEntry(entry);
      active += 1;
    }
  }

  startPrefetchEntry(entry, { foreground = false } = {}) {
    if (!entry || !["queued", "retry_wait"].includes(entry.state)) return entry?.promise || null;
    entry.state = "pending";
    entry.exhausted = false;
    entry.refusedAhead = false;
    entry.startedAt = performance.now();
    entry.promise = this.prefetch(entry, this.generation, { foreground }).then((result) => {
      const stillCurrent = !this.destroyed && this.jobs.get(entry.url) === entry;
      if (result && stillCurrent) {
        this.segmentCache.set(entry.url, {
          ...result,
          url: entry.url,
          playlistUrl: entry.playlistUrl,
          index: entry.index,
          byteLength: result.bytes.byteLength,
          cachedAt: performance.now(),
          lastAccessedAt: performance.now(),
        });
        this.jobs.delete(entry.url);
      } else if (stillCurrent && entry.terminalError) {
        entry.state = "failed";
        this.failureCount += 1;
      } else if (stillCurrent) {
        entry.state = "retry_wait";
        entry.failureCycles = (entry.failureCycles || 0) + 1;
        const retryDelayMs = Math.min(
          this.retryCycleMaxDelayMs,
          this.retryBaseDelayMs * 2 ** Math.min(entry.failureCycles, 8),
        );
        entry.retryAt = performance.now() + retryDelayMs;
        this.failureCount += 1;
      } else {
        entry.state = "failed";
      }
      entry.estimatedByteLength = 0;
      entry.startedAt = 0;
      if (result) {
        this.updateCachePeaks();
        this.trimReadyCacheToBudget();
      }
      return result;
    }).finally(() => {
      this.pumpPrefetches();
      this.scheduleRetryPump();
    });
    this.updateCachePeaks();
    return entry.promise;
  }

  async prefetch(entry, generation, { foreground = false } = {}) {
    const { url, playlistUrl, index: segmentIndex } = entry;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (generation !== this.generation || this.destroyed) return null;
      const controller = new AbortController();
      entry.controller = controller;
      this.controllers.add(controller);
      const startedAt = performance.now();
      let response = null;
      try {
        let headerTimer = null;
        const marked = foreground ? { url, headers: {} } : prefetchRequest(url);
        response = await Promise.race([
          this.fetchImpl(marked.url, {
            headers: {
              Range: "bytes=0-",
              ...marked.headers,
            },
            ...(foreground ? {} : { priority: "low" }),
            signal: controller.signal,
          }),
          new Promise((_, reject) => {
            headerTimer = setTimeout(() => {
              const error = new SegmentInactivityError(this.inactivityTimeoutMs);
              controller.abort(error);
              reject(error);
            }, this.inactivityTimeoutMs);
          }),
        ]).finally(() => clearTimeout(headerTimer));
        if (generation !== this.generation || this.destroyed) return null;
        if (!response.ok) {
          const expired = sessionExpiredError(response);
          if (expired) {
            entry.terminalError = expired;
            const playlist = this.playlists.get(playlistUrl);
            const alreadyReported = Boolean(playlist?.terminalError);
            if (playlist) playlist.terminalError = expired;
            if (!alreadyReported) this.onSessionExpired(expired);
          }
          if (response.status === 401 || response.status === 403) {
            if (foreground) {
              const error = new Error(`Video source denied access (HTTP ${response.status}). Reload after the source is repaired.`);
              error.code = "UPSTREAM_ACCESS_DENIED";
              entry.terminalError = error;
              const playlist = this.playlists.get(playlistUrl);
              if (playlist) playlist.terminalError = error;
            } else {
              // A read-ahead's refusal, up to 210 seconds early, is not final,
              // since the node may have fresh links by then: the segment
              // waits for its next retry cycle. Playback that needs it first
              // asks for it itself, and that refusal is final (Agent Note
              // 2026-10-16-refused-read-ahead).
              entry.refusedAhead = true;
            }
          }
          const retryable = response.status === 408
            || response.status === 425
            || response.status === 429
            || response.status >= 500;
          try { await response.body?.cancel(); } catch {}
          if (!retryable) {
            this.rememberFailure(entry, `HTTP ${response.status}`, attempt + 1);
            entry.exhausted = true;
            return null;
          }
          throw new Error(`HLS segment returned ${response.status}`);
        }
        const bytes = await readResponseBytes(response, controller, this.inactivityTimeoutMs);
        this.recordDownload(bytes.byteLength, performance.now() - startedAt, segmentIndex, playlistUrl);
        return {
          bytes,
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
        };
      } catch (error) {
        const reason = controller.signal.reason;
        const timedOut = error?.code === "HLS_SEGMENT_INACTIVITY"
          || reason?.code === "HLS_SEGMENT_INACTIVITY";
        const cancelled = controller.signal.aborted && !timedOut;
        if (timedOut) this.timeoutCount += 1;
        if (cancelled || generation !== this.generation || this.destroyed) return null;
        this.rememberFailure(entry, error?.message || String(error), attempt + 1);
        if (attempt >= this.maxRetries) {
          this.logger.warn("[hls-prefetch] Segment download failed after retries:", error);
          entry.exhausted = true;
          return null;
        }
        this.networkRetryCount += 1;
        await wait(this.retryBaseDelayMs * 2 ** attempt);
      } finally {
        entry.controller = null;
        this.controllers.delete(controller);
        try {
          if (response && !response.bodyUsed) await response.body?.cancel();
        } catch {}
      }
    }
    return null;
  }

  rememberFailure(entry, error, attempt) {
    this.lastFailure = {
      playlistUrl: entry.playlistUrl,
      segmentIndex: entry.index,
      error,
      attempt,
      at: Date.now(),
    };
  }

  // A timer only for the earliest retry not yet due. A due job the cap or
  // the one download slot holds back starts on the next pump that a read
  // ahead (scheduleAhead), a finished download, a seek, or resume() brings,
  // or when playback asks for its segment itself; a timer for it would only
  // spin (Agent Note 2026-04-04-canvas-playback-engine).
  scheduleRetryPump() {
    if (this.destroyed || this.suspended) return;
    const now = performance.now();
    const retryAt = [...this.jobs.values()]
      .filter((entry) => !this.playlists.get(entry.playlistUrl)?.terminalError)
      .filter((entry) => entry.state === "retry_wait" && (entry.retryAt || 0) > now)
      .reduce((earliest, entry) => Math.min(earliest, entry.retryAt), Infinity);
    if (!Number.isFinite(retryAt)) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retryTimerAt = 0;
      return;
    }
    if (this.retryTimer && this.retryTimerAt <= retryAt) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimerAt = retryAt;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryTimerAt = 0;
      this.pumpPrefetches();
    }, Math.max(0, retryAt - now));
  }

  recordDownload(byteLength, durationMs, segmentIndex, playlistUrl = null) {
    if (!Number.isFinite(byteLength) || byteLength <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return;
    const bitsPerSecond = Math.min(100_000_000, (byteLength * 8 * 1000) / Math.max(20, durationMs));
    this.ewmaThroughputBps = this.ewmaThroughputBps
      ? this.ewmaThroughputBps * 0.65 + bitsPerSecond * 0.35
      : bitsPerSecond;
    this.throughputSamples.push(bitsPerSecond);
    if (this.throughputSamples.length > 8) this.throughputSamples.shift();
    this.segmentSizeSamples.push(byteLength);
    if (this.segmentSizeSamples.length > 8) this.segmentSizeSamples.shift();
    if (playlistUrl) {
      const sizes = this.segmentSizesByPlaylist.get(playlistUrl) || [];
      sizes.push(byteLength);
      if (sizes.length > 8) sizes.shift();
      this.segmentSizesByPlaylist.set(playlistUrl, sizes);
    }
    this.completedDownloads += 1;
    this.lastDownloadAt = performance.now();
    this.lastDownload = {
      segmentIndex,
      playlistUrl,
      byteLength,
      durationMs,
      bitsPerSecond,
    };
  }

  getStats() {
    const sorted = [...this.throughputSamples].sort((a, b) => a - b);
    const conservativeSample = sorted.length
      ? sorted[Math.floor((sorted.length - 1) * 0.25)]
      : 0;
    const throughputBps = conservativeSample && this.ewmaThroughputBps
      ? Math.min(conservativeSample, this.ewmaThroughputBps)
      : conservativeSample || this.ewmaThroughputBps;
    const activePlaylists = [...this.playlists.values()]
      .filter((playlist) => playlist.currentIndex >= 0);
    const playlistStats = activePlaylists.map((playlist) => {
      let bufferedAheadSeconds = 0;
      let readySegments = 0;
      let pendingSegments = 0;
      for (let index = playlist.currentIndex + 1; index < playlist.segments.length; index += 1) {
        const entry = this.segmentCache.get(playlist.segments[index].url);
        if (!entry) break;
        bufferedAheadSeconds += playlist.segments[index].duration;
        readySegments += 1;
      }
      for (let index = playlist.currentIndex + 1; index < playlist.segments.length; index += 1) {
        const entry = this.jobs.get(playlist.segments[index].url);
        if (["pending", "queued", "retry_wait"].includes(entry?.state)) pendingSegments += 1;
      }
      return {
        playlistUrl: playlist.url,
        currentIndex: playlist.currentIndex,
        // Count the current segment here, not in the forward-buffer metric.
        // An ENDLIST tail needs no more network runway once all bytes exist.
        remainingCached: playlist.ended && playlist.segments
          .slice(playlist.currentIndex)
          .every((segment) => this.segmentCache.has(segment.url)),
        bufferedAheadSeconds,
        readySegments,
        pendingSegments,
      };
    });
    const bufferedAheadSeconds = playlistStats.length
      ? Math.min(...playlistStats.map((stats) => stats.bufferedAheadSeconds))
      : 0;
    // Every registered playlist, small enough for each health heartbeat
    // (Agent Note 2026-10-11-device-telemetry): where reads put it, how
    // long it is, where its read-ahead window ends, and its jobs by state.
    const jobsByPlaylist = new Map();
    let orphanJobs = 0;
    for (const entry of this.jobs.values()) {
      const counts = jobsByPlaylist.get(entry.playlistUrl);
      if (!counts && !this.playlists.has(entry.playlistUrl)) {
        orphanJobs += 1;
        continue;
      }
      const next = counts || { queued: 0, pending: 0, retry: 0, failed: 0 };
      const state = entry.state === "retry_wait" ? "retry" : entry.state;
      if (state in next) next[state] += 1;
      jobsByPlaylist.set(entry.playlistUrl, next);
    }
    const playlists = [...this.playlists.values()].slice(0, 8).map((playlist) => ({
      name: playlistName(playlist.url),
      current: playlist.currentIndex,
      segments: playlist.segments.length,
      scheduledThrough: Number.isInteger(playlist.scheduledThrough) ? playlist.scheduledThrough : null,
      ahead: Math.round(this.playlistAheadSeconds(playlist) * 10) / 10,
      ...(jobsByPlaylist.get(playlist.url) || { queued: 0, pending: 0, retry: 0, failed: 0 }),
    }));
    let readySegments = 0;
    let pendingSegments = 0;
    for (const stats of playlistStats) {
      readySegments += stats.readySegments;
      pendingSegments += stats.pendingSegments;
    }
    const cachedBytes = this.cachedBytes;
    const cachedSegments = this.segmentCache.size;
    const activeDownloads = [...this.jobs.values()]
      .filter((entry) => entry.state === "pending").length;
    const queuedSegments = [...this.jobs.values()]
      .filter((entry) => entry.state === "queued").length;
    const retryWaitingSegments = [...this.jobs.values()]
      .filter((entry) => entry.state === "retry_wait").length;
    const oldestActiveDownloadMs = [...this.jobs.values()]
      .filter((entry) => entry.state === "pending" && entry.startedAt)
      .reduce((oldest, entry) => Math.max(oldest, performance.now() - entry.startedAt), 0);
    this.updateCachePeaks(bufferedAheadSeconds);
    const managedBytesEstimate = cachedBytes + this.pendingEstimatedBytes;
    const livePlaylists = activePlaylists.filter((playlist) => (
      Number.isFinite(playlist.liveDvrStartTime) && Number.isFinite(playlist.liveEdgeTime)
    ));
    const liveDvrStartTime = livePlaylists.length
      ? Math.min(...livePlaylists.map((playlist) => playlist.liveDvrStartTime))
      : null;
    const liveEdgeTime = livePlaylists.length
      ? Math.max(...livePlaylists.map((playlist) => (
          playlist.liveEdgeTime + Math.max(0, performance.now() - playlist.liveEdgeObservedAt) / 1000
        )))
      : null;
    const livePlayStartTime = livePlaylists.length
      ? Math.max(...livePlaylists.map((playlist) => playlist.livePlayStartTime || playlist.liveDvrStartTime))
      : null;
    return {
      throughputKbps: throughputBps ? Math.round(throughputBps / 1000) : 0,
      sampleCount: this.throughputSamples.length,
      throughputSampleAgeMs: this.lastDownloadAt ? Math.round(performance.now() - this.lastDownloadAt) : null,
      bufferedAheadSeconds,
      allRemainingSegmentsCached: playlistStats.length > 0
        && playlistStats.every((stats) => stats.remainingCached),
      readySegments,
      pendingSegments,
      activeDownloads,
      queuedSegments,
      retryWaitingSegments,
      oldestActiveDownloadMs: Math.round(oldestActiveDownloadMs),
      cachedBytes,
      cachedSegments,
      maxBytes: this.maxBytes,
      targetAheadSeconds: this.targetAheadSeconds,
      maxAheadSegments: this.ahead,
      cacheUtilization: this.maxBytes > 0 ? cachedBytes / this.maxBytes : 0,
      peakCachedBytes: this.peakCachedBytes,
      peakBufferedAheadSeconds: this.peakBufferedAheadSeconds,
      managedBytesEstimate,
      peakManagedBytesEstimate: this.peakManagedBytesEstimate,
      byteCapHitCount: this.byteCapHitCount,
      evictions: { behind: this.evictedBehindCount, ahead: this.evictedAheadCount, bytes: this.evictedBytes },
      activePlaylistCount: activePlaylists.length,
      playlistStats,
      playlists,
      orphanJobs,
      completedDownloads: this.completedDownloads,
      networkRetryCount: this.networkRetryCount,
      timeoutCount: this.timeoutCount,
      failureCount: this.failureCount,
      lastFailure: this.lastFailure,
      lastDownload: this.lastDownload || null,
      liveDvrStartTime,
      liveEdgeTime,
      livePlayStartTime,
    };
  }

  get cachedBytes() {
    let bytes = 0;
    for (const entry of this.segmentCache.values()) bytes += entry.byteLength || 0;
    return bytes;
  }

  get pendingEstimatedBytes() {
    let bytes = 0;
    for (const entry of this.jobs.values()) {
      if (entry.state === "pending") bytes += entry.estimatedByteLength || this.averageSegmentBytes;
    }
    return bytes;
  }

  // What a job's segment will take: the largest of its playlist's recent
  // segments, so a download the cap check let through rarely overshoots it
  // (the trim then would evict the segment just fetched).
  estimateFor(entry) {
    const sizes = entry && this.segmentSizesByPlaylist.get(entry.playlistUrl);
    return sizes?.length ? Math.max(...sizes) : this.averageSegmentBytes;
  }

  // Media seconds ahead of its playlist's position: the read-ahead fills its
  // playlists in media time, not in segments, which differ in length.
  jobSecondsAhead(entry) {
    const playlist = this.playlists.get(entry.playlistUrl);
    return playlist && Number.isInteger(entry.index) ? this.secondsAhead(playlist, entry.index) : Infinity;
  }

  get averageSegmentBytes() {
    if (!this.segmentSizeSamples.length) return 0;
    return this.segmentSizeSamples.reduce((sum, bytes) => sum + bytes, 0) / this.segmentSizeSamples.length;
  }

  // Cached media in a row after the playlist's position.
  playlistAheadSeconds(playlist) {
    let seconds = 0;
    for (let index = playlist.currentIndex + 1; index < playlist.segments.length; index += 1) {
      if (!this.segmentCache.has(playlist.segments[index].url)) break;
      seconds += playlist.segments[index].duration;
    }
    return seconds;
  }

  contiguousBufferedAheadSeconds() {
    const activePlaylists = [...this.playlists.values()]
      .filter((playlist) => playlist.currentIndex >= 0);
    if (!activePlaylists.length) return 0;
    return Math.min(...activePlaylists.map((playlist) => this.playlistAheadSeconds(playlist)));
  }

  updateCachePeaks(bufferedAheadSeconds = this.contiguousBufferedAheadSeconds()) {
    const cachedBytes = this.cachedBytes;
    const managedBytesEstimate = cachedBytes + this.pendingEstimatedBytes;
    this.peakCachedBytes = Math.max(this.peakCachedBytes, cachedBytes);
    this.peakBufferedAheadSeconds = Math.max(this.peakBufferedAheadSeconds, bufferedAheadSeconds);
    this.peakManagedBytesEstimate = Math.max(this.peakManagedBytesEstimate, managedBytesEstimate);
  }

  markByteCapReached() {
    if (!this.atByteCap) this.byteCapHitCount += 1;
    this.atByteCap = true;
  }

  // Media seconds from a playlist's position to the start of a segment, so
  // segments of playlists with different segment lengths compare.
  secondsAhead(playlist, index) {
    if (!playlist.starts) {
      let start = 0;
      playlist.starts = playlist.segments.map((segment) => {
        const at = start;
        start += segment.duration;
        return at;
      });
    }
    const from = playlist.starts[Math.max(0, playlist.currentIndex + 1)] ?? 0;
    return (playlist.starts[index] ?? 0) - from;
  }

  // `makingRoomFor`, a job: evict history, then only segments that start
  // after the job's segment; null: history only. Left out (the trim after a
  // download, which keeps the cap): history, then the farthest segments.
  evictReadyCache(bytesNeeded = 0, { makingRoomFor } = {}) {
    let bytesToFree = Math.max(0, Number(bytesNeeded) || 0);
    const overBudget = Math.max(0, this.cachedBytes - this.maxBytes);
    bytesToFree = Math.max(bytesToFree, overBudget);
    if (bytesToFree <= 0 && this.cachedBytes < this.maxBytes) return 0;

    const protectedUrls = new Set();
    for (const playlist of this.playlists.values()) {
      if (playlist.currentIndex < -1) continue;
      for (
        let index = Math.max(0, playlist.currentIndex + 1);
        index < Math.min(playlist.segments.length, playlist.currentIndex + 7);
        index += 1
      ) {
        protectedUrls.add(playlist.segments[index].url);
      }
    }

    const rank = (entry) => {
      const playlist = this.playlists.get(entry.playlistUrl);
      if (!playlist || !Number.isInteger(entry.index)) {
        return [0, -(Number(entry.index) || 0), entry.lastAccessedAt || 0];
      }
      const distance = entry.index - playlist.currentIndex;
      // Evict far-behind data first, then distant future data. The six nearest
      // forward segments are protected so cache pressure cannot starve startup.
      return distance <= 0
        ? [1, distance, entry.lastAccessedAt || 0]
        : [2, -distance, entry.lastAccessedAt || 0];
    };
    let laterThan = -Infinity;
    if (makingRoomFor !== undefined) {
      const playlist = makingRoomFor && this.playlists.get(makingRoomFor.playlistUrl);
      laterThan = playlist && Number.isInteger(makingRoomFor.index)
        ? this.secondsAhead(playlist, makingRoomFor.index)
        : Infinity;
    }
    const evictable = (entry) => rank(entry)[0] !== 2
      || this.secondsAhead(this.playlists.get(entry.playlistUrl), entry.index) > laterThan;
    const candidates = [...this.segmentCache.entries()]
      .filter(([url, entry]) => !protectedUrls.has(url) && evictable(entry))
      .sort((a, b) => {
        const left = rank(a[1]);
        const right = rank(b[1]);
        return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
      });
    // Room for a job is all or nothing: evicting what cannot make enough room
    // would throw away part of the window and still leave the job waiting.
    if (makingRoomFor !== undefined) {
      const available = candidates.reduce((sum, [, entry]) => sum + (entry.byteLength || 0), 0);
      if (available < bytesToFree) return 0;
    }
    let freed = 0;
    for (const [url, entry] of candidates) {
      if (freed >= bytesToFree && this.cachedBytes < this.maxBytes) break;
      this.segmentCache.delete(url);
      freed += entry.byteLength || 0;
      if (rank(entry)[0] === 2) this.evictedAheadCount += 1;
      else this.evictedBehindCount += 1;
      this.evictedBytes += entry.byteLength || 0;
    }
    if (freed > 0 || overBudget > 0) this.markByteCapReached();
    return freed;
  }

  trimReadyCacheToBudget() {
    if (this.cachedBytes <= this.maxBytes) return;
    this.evictReadyCache(this.cachedBytes - this.maxBytes);
  }

  handleSeek(mediaTime) {
    this.cancelJobs();
    for (const playlist of this.playlists.values()) {
      const targetIndex = this.segmentIndexAtTime(playlist, mediaTime);
      playlist.currentIndex = Math.max(-1, targetIndex - 1);
      playlist.currentUrl = playlist.currentIndex >= 0
        ? playlist.segments[playlist.currentIndex]?.url || null
        : null;
      this.scheduleAhead(playlist.url, targetIndex);
    }
    this.awaitingPlaylistUpdate = false;
    this.pumpPrefetches();
  }

  segmentIndexAtTime(playlist, mediaTime) {
    if (!playlist?.segments?.length) return 0;
    const requested = Number(mediaTime);
    if (!Number.isFinite(requested)) return Math.max(0, playlist.currentIndex);
    const timelineStart = Number.isFinite(playlist.playlistStartTime)
      ? playlist.playlistStartTime
      : 0;
    const relativeTime = Math.max(0, requested - timelineStart);
    let elapsed = 0;
    for (let index = 0; index < playlist.segments.length; index += 1) {
      elapsed += playlist.segments[index].duration;
      if (relativeTime < elapsed) return index;
    }
    return playlist.segments.length - 1;
  }

  cancelJobs() {
    this.generation += 1;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retryTimerAt = 0;
    }
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.jobs.clear();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelJobs();
    this.segmentCache.clear();
    this.playlists.clear();
    this.segmentIndexes.clear();
  }
}
