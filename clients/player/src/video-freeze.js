// A picture that stopped while its sound plays on: no new frame for
// 8 seconds while the sound runs 5 seconds ahead of the last one shown.
// The player recovers with a new stream (player.js). Checked with each
// progress report, from the engine's summary (telemetry/engine-stats.js),
// and said once per freeze: a frame shown again ends it.

const FROZEN_MS = 8_000;
const DRIFT_MS = 5_000;

export function createFreezeWatch() {
  let lastFrameMs = 0;
  let movedAt = 0;
  let said = false;

  const moved = (frameMs, now) => {
    lastFrameMs = frameMs;
    movedAt = now;
    said = false;
  };

  return {
    /** A new stream: nothing seen yet. */
    reset() {
      lastFrameMs = 0;
      movedAt = 0;
      said = false;
    },

    /**
     * `watching` while playing on a visible page; `now` in milliseconds.
     * Returns the freeze, the first time it is one, else null.
     */
    check(stats, { watching, now }) {
      const frameMs = stats?.videoCurrentTimeMs;
      if (!watching || !stats?.videoCodec || !Number.isFinite(frameMs)) {
        moved(frameMs || 0, now);
        return null;
      }
      if (stats.videoFrameRenderCount > 0 && frameMs > lastFrameMs + 50) {
        moved(frameMs, now);
        return null;
      }
      if (!movedAt) {
        movedAt = now;
        return null;
      }
      const driftMs = Number.isFinite(stats.audioCurrentTimeMs) ? stats.audioCurrentTimeMs - frameMs : 0;
      const frozenForMs = now - movedAt;
      if (said || driftMs < DRIFT_MS || frozenForMs < FROZEN_MS) return null;
      said = true;
      return { videoCurrentTimeMs: frameMs, audioCurrentTimeMs: stats.audioCurrentTimeMs, frozenForMs: Math.round(frozenForMs), driftMs: Math.round(driftMs) };
    },
  };
}
