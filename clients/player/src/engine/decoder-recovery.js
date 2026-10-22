// What the canvas engine does when a decoder fails (Agent Note
// 2026-04-04-canvas-playback-engine): it recovers in place, from the encoded
// buffer it already holds, and only its last step asks Yolo for a new
// stream. Each track that fails climbs its own ladder; a failure of that
// track before it decoded past the place it failed is the same failure
// again, and climbs one step:
//
//   1. restart: a new decoder, from the end of what is decoded, on the
//      buffered segments; no request leaves the screen.
//   2. refetch_software: the segment at that place fetched again from the
//      same session, read through a new Mediabunny input, and the picture
//      decoded in software up to the next key frame, then in hardware again.
//   3. skip_to_key: the track goes on from the next key frame after that
//      place (for sound, the next packet), on the decoder it had.
//   4. new_stream: the player's recovery, a new stream at the position.
//
// A step that gives nothing out before its deadline has failed too. Each
// step's end is one `decoder_recovery` event (Agent Note
// 2026-10-11-device-telemetry). This module only decides; the engine acts.

export const RECOVERY_STEPS = Object.freeze({
  1: Object.freeze({ action: "restart", deadlineMs: 4_000 }),
  2: Object.freeze({ action: "refetch_software", deadlineMs: 15_000 }),
  3: Object.freeze({ action: "skip_to_key", deadlineMs: 8_000 }),
  4: Object.freeze({ action: "new_stream", deadlineMs: null }),
});
export const NEW_STREAM_STEP = 4;
// A screen whose decoders keep failing at new places is not healed by
// restarting them: a fourth ladder within the window goes straight to a new
// stream, which the player's backoff rate-limits.
const MAX_LADDERS = 3;
export const LADDER_WINDOW_MS = 10 * 60_000;
// While the picture's decoder restarts or skips (steps 1 and 3), the sound
// plays on over the last picture this long; then the engine waits for both
// as for any stall. A refetch waits for the network as any stall does.
export const VIDEO_HOLD_MS = 2_000;

// Errors with Yolo's string codes are the network's or the session's, which
// the player's recovery keeps handling. A decoder's own error callback
// (decoder-probe.js) or WebCodecs' error names mark a decoder failure; the
// message is the fallback when the probe found no decoder to watch.
const DECODER_ERROR_NAMES = new Set(["EncodingError", "DataError", "OperationError"]);

export function isDecoderError(error, decoder = null) {
  if (!error) return false;
  if (typeof error.code === "string" && error.code) return false;
  if (decoder?.reportedError === true) return true;
  if (DECODER_ERROR_NAMES.has(String(error.name || ""))) return true;
  return /decod/i.test(String(error.message || ""));
}

export class DecoderRecovery {
  constructor({ now = () => performance.now(), maxLadders = MAX_LADDERS, windowMs = LADDER_WINDOW_MS } = {}) {
    this.now = now;
    this.maxLadders = maxLadders;
    this.windowMs = windowMs;
    // The open ladder of each track, until it decodes past its place.
    this.ladders = { video: null, audio: null };
    // When each ladder of the window opened.
    this.opened = [];
    this.nextToken = 1;
  }

  /**
   * A decoder of `track` failed at `at` (media seconds): `cause` "error",
   * or "timeout" when its step gave nothing out in time. `detail` is kept
   * for the step's event. Returns the step to take,
   * `{ step, action, deadlineMs, track, at, token, ended }`, where `ended`
   * is the step this failure ended, or null. Step 4 asks for a new stream
   * and closes the ladder.
   */
  fail(track, { at, cause = "error", detail = null } = {}) {
    const now = this.now();
    const open = this.ladders[track];
    let step = 1;
    let spot = Number(at);
    let failedAt = now;
    let ended = null;
    if (open) {
      ended = this.end(open, cause === "timeout" ? "timeout" : "failed", now);
      step = open.step + 1;
      // Past the place means past every place it failed at.
      spot = Number.isFinite(spot) ? Math.max(spot, open.at) : open.at;
      failedAt = open.failedAt;
    } else {
      this.opened = this.opened.filter((time) => now - time < this.windowMs);
      if (this.opened.length >= this.maxLadders) step = NEW_STREAM_STEP;
      else this.opened.push(now);
    }
    if (!Number.isFinite(spot)) spot = 0;
    const plan = RECOVERY_STEPS[Math.min(step, NEW_STREAM_STEP)];
    const ladder = {
      track,
      step: Math.min(step, NEW_STREAM_STEP),
      action: plan.action,
      at: spot,
      cause,
      detail,
      failedAt,
      stepStartedAt: now,
      askedAt: null,
      firstOutputAt: null,
      output: false,
      token: this.nextToken++,
    };
    this.ladders[track] = ladder.step < NEW_STREAM_STEP ? ladder : null;
    return { step: ladder.step, action: ladder.action, deadlineMs: plan.deadlineMs, track, at: spot, token: ladder.token, ended };
  }

  /**
   * The decoder of `track` gave out media at `timestamp`. Returns the step
   * that recovered (outcome "recovered") once that is past the place the
   * ladder failed at, and closes it; otherwise null.
   */
  output(track, timestamp) {
    const ladder = this.ladders[track];
    if (!ladder) return null;
    if (!ladder.output) ladder.firstOutputAt = this.now();
    ladder.output = true;
    if (!(Number(timestamp) > ladder.at)) return null;
    this.ladders[track] = null;
    return this.end(ladder, "recovered", this.now());
  }

  /**
   * The restarted decoder of `track` was asked for its first output (the
   * picture's waits for room in the decoded queue first). Returns the open
   * step `{ token, deadlineMs }` whose deadline starts now, or null.
   */
  asked(track) {
    const ladder = this.ladders[track];
    if (!ladder || ladder.output || ladder.askedAt !== null) return null;
    ladder.askedAt = this.now();
    return { token: ladder.token, deadlineMs: RECOVERY_STEPS[ladder.step].deadlineMs };
  }

  /** The open step `token` of `track`, while its decoder gave nothing out yet. */
  waiting(track, token) {
    const ladder = this.ladders[track];
    return Boolean(ladder && ladder.token === token && !ladder.output);
  }

  /** A seek: what failed before it is behind or ahead of the new place. */
  reset() {
    this.ladders = { video: null, audio: null };
  }

  end(ladder, outcome, now) {
    return {
      step: ladder.step,
      action: ladder.action,
      track: ladder.track,
      at: ladder.at,
      cause: ladder.cause,
      outcome,
      elapsedMs: Math.round(now - ladder.stepStartedAt),
      // How long the restarted decoder took to give out media once asked.
      firstOutputMs: ladder.firstOutputAt === null ? null : Math.round(ladder.firstOutputAt - (ladder.askedAt ?? ladder.stepStartedAt)),
      sinceFailureMs: Math.round(now - ladder.failedAt),
      detail: ladder.detail,
    };
  }
}
