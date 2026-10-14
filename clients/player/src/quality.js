// Adaptive quality (ABR) for both engines. The canvas engine cannot switch
// variants inside a stream, and most of Yolo's streams have one variant, so
// a quality change is a new stream from Yolo: a rebuild with
// `reason: "quality"` and `maxVideoKbps`, at the current position
// (Agent Note 2026-10-11-adaptive-quality). That costs a short pause, so the
// policy is deliberately slow to change and quick only when playback is already
// stalling:
//
// - Down: the measured throughput is below what the stream needs (its
//   bitrate plus 15%) while the player is stalled for 8 seconds, or while a
//   short buffer drains for 20 seconds. The new cap leaves a quarter of the
//   measured throughput spare and is rounded down to a ladder rung.
// - Up: one rung at a time, only after throughput has stayed comfortably
//   above the next rung (its bitrate × 1.6) with a healthy buffer for 90
//   seconds, and not within 2 minutes of a step down. An upgrade followed by
//   a downgrade within 5 minutes doubles the wait for the next upgrade (up to
//   15 minutes), so a borderline connection does not flap.
// - The viewport/device ceiling (capabilities.maxHeight) and the node's own
//   bitrate ceiling still apply on top: a cap only ever lowers quality.
// - Where the <video> engine's hls.js switches between a playlist's variants
//   by itself (`adaptive` samples), a draining buffer is its to handle: Yolo
//   steps the cap down only after a stall.

// The rungs above 4000 serve the paths with a higher ceiling than the relay's
// (LAN and remote direct play): a stall there need not drop to 4 Mbps.
export const QUALITY_LADDER_KBPS = Object.freeze([400, 700, 1000, 1500, 2200, 3000, 4000, 6000, 9000, 13000]);

export const QUALITY_POLICY = Object.freeze({
  requiredHeadroom: 1.15,
  downSafety: 0.75,
  downAfterBufferingMs: 8_000,
  downAfterDrainingMs: 20_000,
  downCooldownMs: 20_000,
  lowBufferSeconds: 20,
  healthyBufferSeconds: 30,
  upHeadroom: 1.6,
  upSustainMs: 90_000,
  upMinAfterDownMs: 120_000,
  upMaxSustainMs: 15 * 60_000,
  oscillationWindowMs: 5 * 60_000,
  penaltyResetMs: 30 * 60_000,
  minSamples: 2,
  upMinSamples: 3,
  defaultAudioKbps: 128,
});

const PENDING_TIMEOUT_MS = 60_000;

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {typeof QUALITY_POLICY} [options.policy]
 * @param {readonly number[]} [options.ladder]
 */
export function createQualityController({ now = () => Date.now(), policy = QUALITY_POLICY, ladder = QUALITY_LADDER_KBPS } = {}) {
  // The device's cap (maxVideoKbps), or null for the source's best within
  // the node's ceiling. `known` turns true once a stream said which applied.
  let cap = null;
  let known = false;
  let ceilingKbps = null;
  let stream = null;
  let itemKey = null;
  let floorKbps = null;
  let pending = null;
  let pendingAt = 0;
  let bufferingSince = 0;
  let insufficientSince = 0;
  let headroomSince = 0;
  let lastDownAt = -Infinity;
  let lastUpAt = -Infinity;
  let upSustainMs = policy.upSustainMs;
  const history = [];

  const rungBelow = (kbps) => [...ladder].reverse().find((rung) => rung < kbps) ?? null;
  const rungAtOrBelow = (kbps) => [...ladder].reverse().find((rung) => rung <= kbps) ?? null;

  function decide(decision) {
    pending = decision;
    pendingAt = now();
    history.push({ ...decision, at: now() });
    if (history.length > 10) history.shift();
    return decision;
  }

  function downTarget(throughputKbps) {
    const videoKbps = stream.videoKbps;
    if (floorKbps != null && videoKbps <= floorKbps * 1.05) return null;
    const wanted = Math.floor(throughputKbps * policy.downSafety - stream.audioKbps);
    let rung = rungAtOrBelow(wanted) ?? ladder[0];
    // A step must be worth a rebuild: at least 15% below what plays now.
    if (rung >= videoKbps * 0.85) rung = rungBelow(Math.min(videoKbps * 0.85, rung));
    if (rung == null || (cap != null && rung >= cap)) return null;
    return rung;
  }

  function upTarget() {
    if (cap == null) return undefined;
    const next = ladder.find((rung) => rung > cap);
    const top = positive(ceilingKbps);
    // Past the ladder, or at the node's ceiling: no device cap at all.
    if (next == null || (top && next >= top)) return { maxVideoKbps: null, kbps: top || Math.max(cap * 1.5, ladder.at(-1)) };
    return { maxVideoKbps: next, kbps: next };
  }

  return {
    /** The cap this device plays with, or null (the source's best). */
    get cap() {
      return cap;
    },

    /**
     * What a request for a new stream of this item should say: a number,
     * null for no cap, or undefined when this page has not learned it yet
     * (Yolo then uses what it remembers for this device).
     */
    requestCap() {
      return known ? cap : undefined;
    },

    /**
     * A new stream started. `limits` is what the node applied
     * ({ maxVideoKbps, ceilingKbps, capped }); `profile` is the source's
     * description of the stream (videoKbps, audioKbps).
     */
    load({ profile = null, limits = null, isLive = false, key = null } = {}) {
      if (limits && typeof limits === "object") {
        known = true;
        ceilingKbps = positive(limits.ceilingKbps) || ceilingKbps;
        cap = limits.capped ? positive(limits.maxVideoKbps) || null : null;
      }
      if (key !== itemKey) floorKbps = null;
      itemKey = key;
      stream = {
        videoKbps: positive(profile?.videoKbps),
        audioKbps: positive(profile?.audioKbps) || policy.defaultAudioKbps,
        isLive: Boolean(isLive),
        startedAt: now(),
      };
      // The source had nothing lower: do not ask again for this item.
      if (pending?.direction === "down" && stream.videoKbps && stream.videoKbps >= pending.fromVideoKbps * 0.95) {
        floorKbps = stream.videoKbps;
      }
      pending = null;
      bufferingSince = 0;
      insufficientSince = 0;
      headroomSince = 0;
    },

    /** The request for the last decision failed; try again later. */
    abandon() {
      const failed = pending;
      pending = null;
      // A failed step down may be asked for again in 10 seconds.
      if (failed?.direction === "down") lastDownAt = now() - policy.downCooldownMs + 10_000;
    },

    /**
     * One look at the network, about every two seconds.
     * @param {{ throughputKbps: number, sampleCount: number, bufferedAheadSeconds: number,
     *   buffering: boolean, adaptive?: boolean }} sample
     * @returns {null | { direction: "down" | "up", maxVideoKbps: number | null, fromVideoKbps: number,
     *   throughputKbps: number, mediaKbps: number, why: string }}
     */
    observe({ throughputKbps = 0, sampleCount = 0, bufferedAheadSeconds = 0, buffering = false, adaptive = false } = {}) {
      const t = now();
      if (buffering) bufferingSince ||= t;
      else bufferingSince = 0;
      // A requested stream that never came is given up after a minute.
      if (pending && t - pendingAt > PENDING_TIMEOUT_MS) pending = null;
      if (!stream || stream.isLive || pending || !stream.videoKbps) return null;
      const throughput = positive(throughputKbps);
      const samples = positive(sampleCount);
      const buffered = positive(bufferedAheadSeconds);
      const mediaKbps = stream.videoKbps + stream.audioKbps;
      if (t - lastDownAt > policy.penaltyResetMs) upSustainMs = policy.upSustainMs;

      // --- Down -------------------------------------------------------------
      const insufficient = samples >= policy.minSamples && throughput > 0
        && throughput < mediaKbps * policy.requiredHeadroom
        && (buffering || buffered < policy.lowBufferSeconds);
      if (insufficient) insufficientSince ||= t;
      else insufficientSince = 0;
      const stalledLongEnough = buffering && bufferingSince && t - bufferingSince >= policy.downAfterBufferingMs;
      const drainedLongEnough = !adaptive && insufficientSince && t - insufficientSince >= policy.downAfterDrainingMs;
      if (insufficient && (stalledLongEnough || drainedLongEnough) && t - lastDownAt >= policy.downCooldownMs) {
        const target = downTarget(throughput);
        if (target != null) {
          if (t - lastUpAt < policy.oscillationWindowMs) upSustainMs = Math.min(upSustainMs * 2, policy.upMaxSustainMs);
          lastDownAt = t;
          headroomSince = 0;
          return decide({
            direction: "down", maxVideoKbps: target, fromVideoKbps: stream.videoKbps, throughputKbps: Math.round(throughput),
            mediaKbps, why: stalledLongEnough ? "stalled" : "draining",
          });
        }
      }

      // --- Up ---------------------------------------------------------------
      const up = upTarget();
      if (!up) {
        headroomSince = 0;
        return null;
      }
      const comfortable = samples >= policy.upMinSamples && !buffering
        && buffered >= policy.healthyBufferSeconds
        && throughput >= (up.kbps + stream.audioKbps) * policy.upHeadroom;
      if (!comfortable) {
        headroomSince = 0;
        return null;
      }
      headroomSince ||= t;
      if (t - headroomSince < upSustainMs || t - lastDownAt < policy.upMinAfterDownMs || t - stream.startedAt < upSustainMs) return null;
      lastUpAt = t;
      headroomSince = 0;
      return decide({
        direction: "up", maxVideoKbps: up.maxVideoKbps, fromVideoKbps: stream.videoKbps, throughputKbps: Math.round(throughput),
        mediaKbps, why: "headroom",
      });
    },

    /** For telemetry and /diag. */
    snapshot() {
      return {
        cap,
        known,
        ceilingKbps,
        floorKbps,
        videoKbps: stream?.videoKbps ?? null,
        audioKbps: stream?.audioKbps ?? null,
        pending: pending ? { direction: pending.direction, maxVideoKbps: pending.maxVideoKbps } : null,
        upSustainMs,
        history: history.map((entry) => ({ ...entry })),
      };
    },
  };
}
