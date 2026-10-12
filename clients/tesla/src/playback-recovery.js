export const PLAYER_RECOVERY_BACKOFF_MS = [1_000, 3_000, 10_000, 30_000, 60_000];

export function playbackRecoveryDelayMs(attempt) {
  const index = Math.max(0, Math.floor(Number(attempt) || 1) - 1);
  return PLAYER_RECOVERY_BACKOFF_MS[Math.min(index, PLAYER_RECOVERY_BACKOFF_MS.length - 1)];
}

export function hasSeekPlaybackProgress(_before, after, targetTimeSeconds, minimumClockProgressMs = 250) {
  const targetMs = Math.max(0, Number(targetTimeSeconds) || 0) * 1000;
  const afterClockMs = Math.max(
    Number(after?.videoCurrentTimeMs) || 0,
    Number(after?.audioCurrentTimeMs) || 0,
  );
  return afterClockMs >= targetMs + minimumClockProgressMs;
}

export function hasRecoveryPlaybackProgress({
  status,
  baselineTime,
  currentTime,
  hasVideo = false,
  videoFrameRenderCount = 0,
  minimumProgressSeconds = 0.25,
}) {
  if (status !== "playing") return false;
  if (hasVideo && !(Number(videoFrameRenderCount) > 0)) return false;
  const baseline = Number(baselineTime);
  const current = Number(currentTime);
  if (!Number.isFinite(baseline) || !Number.isFinite(current)) return false;
  return current >= baseline + minimumProgressSeconds;
}

export function resolvePlaybackPosition({ engineTime, fallbackTime, duration }) {
  const maximum = Number(duration) > 0 ? Number(duration) : Infinity;
  const engine = Number(engineTime);
  const fallback = Number(fallbackTime);
  const selected = Number.isFinite(engine)
    ? engine
    : Number.isFinite(fallback) ? fallback : 0;
  return Math.max(0, Math.min(maximum, selected));
}

// A stream that starts at an offset (a transcode resumed part way, as Plex
// does) cannot seek before its first segment: ask Yolo for a new stream.
export function shouldRestartSessionForSeek({
  sessionId,
  targetTime,
  seekableStartTime,
  sessionRestartPending = false,
}) {
  if (!sessionId) return false;
  if (sessionRestartPending) return true;
  const target = Number(targetTime);
  const seekableStart = Number(seekableStartTime);
  return Number.isFinite(target)
    && Number.isFinite(seekableStart)
    && target < seekableStart;
}

export function shouldHoldOptimisticSeekTarget({ transitionPending, playerIsCurrent }) {
  return transitionPending === true && playerIsCurrent === true;
}

// A new stream of what this device plays now, from Yolo (yolo-v1.md §7):
// recovery after a failure, or a seek outside the current stream. Yolo's
// source plugin resolves the item again, so expired CDN URLs and dropped
// transcodes are replaced. `sessionId` is the session it replaces; Yolo
// refuses the request if something else started meanwhile.
// `maxVideoKbps` is the device's adaptive-quality cap (quality.js): a number,
// null for none, or undefined to leave it to what Yolo remembers.
export function buildFreshPlaybackSessionRequest(request, startTime, {
  autoplay = true,
  recovery = true,
  reason,
  deviceId = null,
  maxVideoKbps = undefined,
} = {}) {
  const source = request?.meta?.source;
  if (!source) return null;
  return {
    endpoint: "/v1/playback/play",
    body: {
      source,
      startTime: Math.max(0, Number(startTime) || 0),
      reason: reason || (recovery ? "recovery" : "seek"),
      autoplay,
      ...(request.meta.sessionId ? { sessionId: request.meta.sessionId } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(maxVideoKbps !== undefined ? { maxVideoKbps } : {}),
    },
  };
}
