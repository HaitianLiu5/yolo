import { RETRYABLE_ERROR_CODES } from "@useyolo/core";
import { isNetworkFailure } from "./network.js";

// Requests the player makes for its own playback (a fresh stream after a
// failure, the resume after a reload or a wake, a seek outside the stream)
// go through here. Three rules come from the car waking up after sleeping
// (production, 2026-10-12):
//
// 1. Wait until the realtime channel is open and the Hub has welcomed it.
//    A request the Hub sees before the socket's hello finds the device
//    offline, and the `load` it would send has nowhere to go.
// 2. One recovery at a time. The media error (410 SESSION_EXPIRED) and the
//    welcome after the reconnect both want a fresh stream; a second request
//    would replace the first one's session and come back `superseded`.
// 3. Retry what can heal by itself (the device or the node coming back, a
//    rate limit, the network: the codes @useyolo/core marks retryable) with
//    a bounded backoff, then give up with a message that says so.

export const STREAM_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000]);
// The whole budget, waits for the realtime channel included.
export const STREAM_REQUEST_BUDGET_MS = 45_000;
export const REALTIME_WAIT_MS = 20_000;
const RATE_LIMITED_MIN_DELAY_MS = 5_000;

// The server's retryable codes, and a realtime channel that is not up yet.
const RETRYABLE = new Set([...RETRYABLE_ERROR_CODES, "realtime_unavailable"]);

export function isRetryableStreamError(error) {
  if (!error || error.code === "superseded") return false;
  return RETRYABLE.has(error.code) || error.retryable === true || error.status === 429 || error.status === 503 || isNetworkFailure(error);
}

export class StreamRequestError extends Error {
  constructor(message, { code, attempts, cause }) {
    super(message, { cause });
    this.name = "StreamRequestError";
    this.code = code;
    this.attempts = attempts;
    this.network = isNetworkFailure(cause);
  }
}

/**
 * @param {object} options
 * @param {(options: { timeoutMs: number }) => Promise<void>} options.whenReady
 *   resolves once the realtime channel is open and welcomed
 * @param {(reason: string) => void} [options.replaceChannel] drops a
 *   connection the Hub does not see (it said device_offline)
 * @param {() => void} [options.onSuperseded] a request was refused as
 *   superseded: Yolo has another stream for this screen, whose `load` comes
 *   over the realtime connection, which may have died unnoticed (ping it)
 * @param {(type: string, fields: object) => void} [options.onEvent] telemetry
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 */
export function createStreamRequester({
  whenReady,
  replaceChannel = () => {},
  onSuperseded = () => {},
  onEvent = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  retryDelaysMs = STREAM_RETRY_DELAYS_MS,
  budgetMs = STREAM_REQUEST_BUDGET_MS,
  realtimeWaitMs = REALTIME_WAIT_MS,
}) {
  let recovery = null;

  const emit = (type, fields) => {
    try {
      onEvent(type, fields);
    } catch {
      // Telemetry never fails a request.
    }
  };

  // `attempt()` sends the request and returns its result, or null when it is
  // no longer wanted (another stream arrived meanwhile); it runs only once
  // the realtime channel is ready, so it reads the current state then.
  async function run(attempt, { label, reason }) {
    const startedAt = now();
    const deadline = startedAt + budgetMs;
    for (let tries = 1; ; tries += 1) {
      try {
        const waitStartedAt = now();
        await whenReady({ timeoutMs: Math.max(1, Math.min(realtimeWaitMs, deadline - now())) });
        const waitedMs = now() - waitStartedAt;
        if (waitedMs > 0) emit("stream_request_waited", { reason, attempt: tries, waitedMs });
        const result = await attempt();
        emit(result === null ? "stream_request_skipped" : "stream_request_ok", { reason, attempt: tries, elapsedMs: now() - startedAt });
        return result;
      } catch (error) {
        const code = error?.code || (isNetworkFailure(error) ? "network" : "internal");
        const delayMs = Math.max(
          retryDelaysMs[Math.min(tries - 1, retryDelaysMs.length - 1)] ?? 0,
          code === "rate_limited" ? RATE_LIMITED_MIN_DELAY_MS : 0,
        );
        const retry = isRetryableStreamError(error) && tries <= retryDelaysMs.length && now() + delayMs < deadline;
        emit(retry ? "stream_request_retry" : "stream_request_failed", {
          reason, attempt: tries, code, message: error?.message || String(error), status: error?.status ?? null,
          elapsedMs: now() - startedAt, ...(retry ? { delayMs } : {}),
        });
        if (!retry) {
          if (code === "superseded") {
            try {
              onSuperseded();
            } catch {
              // A ping never fails a request.
            }
          }
          if (!isRetryableStreamError(error) || tries === 1) throw error;
          const seconds = Math.round((now() - startedAt) / 1000);
          throw new StreamRequestError(`${error?.message || String(error)} (gave up after ${tries} tries in ${seconds} s)`, {
            code, attempts: tries, cause: error,
          });
        }
        // The Hub does not see our socket although we think it is open: it
        // died while the page slept. Replace it before the next try.
        if (code === "device_offline") replaceChannel("device_offline");
        await sleep(delayMs);
      }
    }
  }

  // "recovery" is single-flight: a second recovery joins the first. One that
  // was no longer wanted (null) or found its stream replaced already
  // (superseded) wanted another stream than the second may: the second goes
  // itself then. The welcome that names a stream whose `load` a reconnect
  // lost asks for it while a recovery of the stream on screen is on its way.
  function request(attempt, { label = "Playback request", reason = "play" } = {}) {
    if (reason !== "recovery") return run(attempt, { label, reason });
    if (recovery) {
      emit("stream_request_joined", { reason });
      const again = () => request(attempt, { label, reason });
      return recovery.then((result) => (result === null ? again() : result), (error) => {
        if (error?.code === "superseded") return again();
        throw error;
      });
    }
    recovery = run(attempt, { label, reason }).finally(() => {
      recovery = null;
    });
    return recovery;
  }

  return {
    /**
     * @param {() => Promise<any>} attempt
     * @param {{ label?: string, reason?: string }} [options] reason
     *   "recovery" is single-flight (see above).
     */
    request,
    get recoveryPending() {
      return Boolean(recovery);
    },
  };
}
