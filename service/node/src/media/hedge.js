// One byte range of an upstream file, read from every URL that serves the
// same bytes (an Input's `url` and its `alternates`) and handed to its readers
// as the bytes arrive (Agent Note 2026-10-11-node-media-pipeline).
//
// An attempt reads the range from one URL, starting at the first byte not yet
// received. When no byte has come for a while, or the leading attempt is too
// slow to finish in time, a second attempt starts on the next URL from that
// offset; whichever reaches the end first completes the range, and the other
// is cancelled. A failed attempt (an error status, a reset, a short or
// mismatched body) is replaced at once, or after a short backoff when its
// replacement is a URL that already failed (250 ms, doubling, at most 2 s).
// At most `maxParallel` attempts run at a time and `maxAttempts` in all, so a
// range never costs more than twice its remaining bytes at once.

// The canvas engine gives up on a segment request after 12 s without network
// progress, the wait for headers included (DEFAULT_INACTIVITY_TIMEOUT_MS in
// clients/player/src/engine/hls-segment-prefetcher.js). The node's thresholds
// are derived from it so that every hedge and failover happens, and a range
// that cannot progress fails, while the device still waits.
export const DEVICE_SEGMENT_TIMEOUT_MS = 12_000;
// Headroom for the passthrough (about 100 ms per request) and the car's LTE.
const DEVICE_MARGIN_MS = 2_000;

export const SEGMENT_TIMING = Object.freeze({
  // No first byte from any running attempt: hedge on the next URL.
  firstByteMs: 1_500,
  // No new byte: hedge, resuming from the byte offset.
  stallMs: 2_000,
  // The leading attempt would need longer than this for the rest: hedge.
  slowMs: 5_000,
  // No progress at all for this long: the range fails, before the device's
  // timeout (a 504, or an aborted body once bytes were sent).
  giveUpMs: DEVICE_SEGMENT_TIMEOUT_MS - DEVICE_MARGIN_MS,
  maxParallel: 2,
  maxAttempts: 6,
});

// Answers that mean this URL will never serve this range.
const REFUSED = new Set([401, 403, 404, 410]);

const codeError = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

function contentRange(response) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers.get("content-range") || "");
  return match ? { start: Number(match[1]), end: Number(match[2]), total: match[3] === "*" ? null : Number(match[3]) } : null;
}

/**
 * Start reading bytes `start`–`end` (inclusive) from `urls`, best first.
 * `exact: false` lets a shorter file shorten the range (a probe of the
 * file's head). `request(url, { start, end, signal })` performs one upstream
 * request. `health` (hosts.js) orders the URLs and learns from each attempt.
 * `onEvent({ type: "hedge" | "failover", from, to, reason })` reports each
 * new attempt after the first.
 */
export function downloadRange({
  urls,
  start,
  end,
  exact = true,
  maxBytes = Infinity,
  request,
  health = null,
  timing = SEGMENT_TIMING,
  onEvent = () => {},
  now = () => performance.now(),
}) {
  const t = { ...SEGMENT_TIMING, ...timing };
  const ranked = health ? health.rank(urls) : [...urls];
  const attempts = [];
  const refused = new Set();
  const chunks = [];
  let length = end - start + 1;
  let received = 0;
  let state = "running";
  let failure = null;
  let contentType = null;
  let total = null;
  const startedAt = now();
  let lastProgressAt = startedAt;
  let lastStartAt = startedAt;
  let waiters = [];
  let lastError = null;
  let scheduled = null;

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Nobody may be listening yet; a reader learns of a failure from its own call.
  ready.catch(() => {});
  done.catch(() => {});

  const notify = () => {
    const pending = waiters;
    waiters = [];
    for (const wake of pending) wake();
  };
  const changed = () => new Promise((resolve) => waiters.push(resolve));

  const running = () => attempts.filter((attempt) => attempt.state === "running");

  // Attempts that stalled or were too slow and did not finish count against
  // their host (a failed attempt already did).
  function blame() {
    for (const attempt of attempts) if (attempt.suspect && (attempt.state === "running" || attempt.state === "cancelled")) health?.fault(attempt.url);
  }

  function finish() {
    state = "done";
    clearInterval(ticker);
    clearTimeout(scheduled);
    blame();
    for (const attempt of running()) cancel(attempt);
    resolveReady(api);
    resolveDone(Buffer.concat(chunks, received));
    notify();
  }

  function fail(error) {
    if (state !== "running") return;
    state = "failed";
    failure = error;
    clearInterval(ticker);
    clearTimeout(scheduled);
    blame();
    for (const attempt of running()) cancel(attempt);
    rejectReady(error);
    rejectDone(error);
    notify();
  }

  function cancel(attempt) {
    if (attempt.state !== "running") return;
    attempt.state = "cancelled";
    attempt.controller.abort(codeError("Superseded by another attempt", "HEDGE_CANCELLED"));
  }

  // Bytes at `position` (offset in the range) from one attempt: only those
  // past what has been received count.
  function accept(attempt, position, chunk) {
    attempt.lastByteAt = now();
    attempt.firstByteAt ??= attempt.lastByteAt;
    attempt.bytes += chunk.byteLength;
    const from = received - position;
    if (from >= chunk.byteLength || state !== "running") return;
    let piece = from > 0 ? chunk.subarray(from) : chunk;
    if (received + piece.byteLength > length) piece = piece.subarray(0, length - received);
    chunks.push(piece);
    received += piece.byteLength;
    lastProgressAt = attempt.lastByteAt;
    if (received === piece.byteLength) resolveReady(api);
    if (received >= length) {
      attempt.state = "won";
      health?.success(attempt.url, { bytes: attempt.bytes, ms: now() - attempt.startedAt });
      finish();
      return;
    }
    notify();
  }

  async function run(attempt) {
    const from = attempt.offset;
    try {
      const response = await request(attempt.url, { start: start + from, end: start + length - 1, signal: attempt.controller.signal });
      if (attempt.state !== "running") {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (response.status !== 206 && !(response.status === 200 && from === 0)) {
        await response.body?.cancel().catch(() => {});
        throw codeError(`Upstream answered ${response.status}`, response.status === 403 ? "UPSTREAM_ACCESS_DENIED" : "UPSTREAM_STATUS", { status: response.status });
      }
      const range = response.status === 206 ? contentRange(response) : null;
      if (range && range.start !== start + from) throw codeError(`Upstream sent bytes from ${range.start}, not ${start + from}`, "SEGMENT_INTEGRITY");
      const size = range?.total ?? (response.status === 200 ? Number(response.headers.get("content-length")) || null : null);
      total ??= size;
      if (!exact && size != null && start + length > size) length = Math.max(received, size - start);
      if (range && range.end !== start + length - 1) {
        throw codeError(`Upstream sent bytes to ${range.end}, not ${start + length - 1}`, "SEGMENT_INTEGRITY");
      }
      if (length > maxBytes) throw codeError("The range exceeds the size limit", "SEGMENT_INTEGRITY");
      contentType ??= response.headers.get("content-type");
      if (!response.body) throw codeError("The upstream response has no body", "SEGMENT_INTEGRITY");
      let position = from;
      for await (const chunk of response.body) {
        if (attempt.state !== "running") return;
        accept(attempt, position, chunk);
        position += chunk.byteLength;
        if (position >= length) return;
      }
      if (attempt.state === "running") throw codeError(`Incomplete range: ${position} of ${length} bytes`, "SEGMENT_INTEGRITY");
    } catch (error) {
      if (attempt.state !== "running") return;
      attempt.state = "failed";
      lastError = error;
      if (REFUSED.has(error.status)) refused.add(attempt.url);
      health?.fault(attempt.url);
      if (state === "running" && !running().length) next("failover", error.code || error.message);
    }
  }

  // The URL for a new attempt: one this range has not refused, preferably
  // not running and tried the fewest times, in health order.
  function pick() {
    const usable = ranked.filter((url) => !refused.has(url));
    const busy = new Set(running().map((attempt) => attempt.url));
    const pool = usable.filter((url) => !busy.has(url));
    const tries = (url) => attempts.filter((attempt) => attempt.url === url).length;
    return (pool.length ? pool : usable).map((url, index) => ({ url, index })).sort((a, b) => (tries(a.url) - tries(b.url)) || (a.index - b.index))[0]?.url ?? null;
  }

  function next(type, reason) {
    if (attempts.length >= t.maxAttempts) {
      if (!running().length) fail(lastError || codeError("Every upstream attempt failed", "UPSTREAM_FAILED"));
      return;
    }
    const url = pick();
    if (!url) {
      // Every URL refused this range.
      if (!running().length) fail(lastError || codeError("No upstream URL is left to try", "UPSTREAM_FAILED"));
      return;
    }
    const previous = attempts.at(-1);
    const tries = attempts.filter((attempt) => attempt.url === url).length;
    const launch = () => {
      scheduled = null;
      if (state !== "running") return;
      const attempt = { url, offset: received, state: "running", controller: new AbortController(), startedAt: now(), firstByteAt: null, lastByteAt: null, bytes: 0, suspect: false };
      attempts.push(attempt);
      lastStartAt = attempt.startedAt;
      if (previous) onEvent({ type, from: previous.url, to: url, reason, offset: received });
      void run(attempt);
    };
    if (type === "failover" && tries) scheduled = setTimeout(launch, Math.min(2_000, 250 * 2 ** (tries - 1)));
    else launch();
  }

  // Why the running attempts need help, or null.
  function trouble() {
    const at = now();
    const active = running();
    if (at - lastStartAt < t.firstByteMs) return null;
    if (!received && active.every((attempt) => attempt.firstByteAt == null)) return { reason: `no first byte in ${t.firstByteMs}ms`, culprits: active };
    if (at - lastProgressAt >= t.stallMs) return { reason: `no new byte for ${t.stallMs}ms`, culprits: active };
    const leader = active.reduce((best, attempt) => ((attempt.lastByteAt ?? -1) > (best?.lastByteAt ?? -1) ? attempt : best), null);
    if (active.length < t.maxParallel && leader?.firstByteAt != null && at - leader.firstByteAt >= t.firstByteMs) {
      const rate = leader.bytes / (at - leader.firstByteAt);
      if ((length - received) / rate > t.slowMs) return { reason: `${Math.round(rate * 8)} kbps leaves the rest for over ${t.slowMs}ms`, culprits: [leader] };
    }
    return null;
  }

  function tick() {
    if (state !== "running") return;
    if (now() - lastProgressAt >= t.giveUpMs) {
      fail(codeError(`No upstream progress for ${t.giveUpMs}ms`, "UPSTREAM_TIMEOUT"));
      return;
    }
    if (scheduled || attempts.length >= t.maxAttempts) return;
    const problem = trouble();
    if (!problem) return;
    for (const attempt of problem.culprits) attempt.suspect = true;
    const active = running();
    if (active.length >= t.maxParallel) {
      // Make room: the attempt that has been quiet the longest goes.
      const quietest = active.reduce((worst, attempt) => ((attempt.lastByteAt ?? attempt.startedAt) < (worst.lastByteAt ?? worst.startedAt) ? attempt : worst));
      cancel(quietest);
    }
    next("hedge", problem.reason);
  }

  const tickMs = Math.max(5, Math.min(250, Math.floor(Math.min(t.firstByteMs, t.stallMs) / 5)));
  const ticker = setInterval(tick, tickMs);
  ticker.unref?.();

  const api = {
    ready,
    done,
    get length() {
      return length;
    },
    get received() {
      return received;
    },
    get contentType() {
      return contentType;
    },
    // The whole file's size, from the first answer that said it.
    get total() {
      return total;
    },
    get attempts() {
      return attempts.length;
    },
    // Every byte from the start of the range, then the rest as it arrives;
    // the stream errors if the range fails.
    stream() {
      let index = 0;
      return new ReadableStream({
        async pull(controller) {
          for (;;) {
            if (index < chunks.length) {
              controller.enqueue(chunks[index++]);
              return;
            }
            if (state === "done") {
              controller.close();
              return;
            }
            if (state === "failed") {
              controller.error(failure);
              return;
            }
            await changed();
          }
        },
      });
    },
  };

  if (length <= 0) fail(codeError("Empty byte range", "SEGMENT_INTEGRITY"));
  else if (length > maxBytes && exact) fail(codeError("The range exceeds the size limit", "SEGMENT_INTEGRITY"));
  else if (!ranked.length) fail(codeError("No upstream URL", "UPSTREAM_FAILED"));
  else next("first", null);
  return api;
}
