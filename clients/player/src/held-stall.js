// A stall nothing will end: the engine holds the picture with no download
// running or waiting, and the position has not moved for 20 seconds. The
// player recovers with a new stream (player.js), as it does for a picture
// that froze while its sound played on (video-freeze.js), which never sees
// this, since a held stream is not playing. A slow or retrying download is
// not this: the read-ahead bounds its own tries. Canvas engine HLS only, the
// one that reports what its read-ahead has on the way. Checked with each
// progress report and said once per stall.

const HELD_MS = 20_000;

const nothingOnItsWay = (stats) => (
  [stats?.hlsActiveDownloads, stats?.hlsPendingSegments, stats?.hlsQueuedSegments, stats?.hlsRetryWaitingSegments]
    .every((count) => count === 0)
);

export function createHeldStallWatch() {
  let heldSince = 0;
  let position = null;
  let said = false;

  return {
    /** A new stream: nothing seen yet. */
    reset() {
      heldSince = 0;
      position = null;
      said = false;
    },

    /**
     * `watching` while the engine holds a visible page's stream; `now` in milliseconds.
     * Returns the stall, the first time it is one, else null.
     */
    check(stats, { watching, now }) {
      const at = stats?.audioCurrentTimeMs ?? null;
      if (!watching || !nothingOnItsWay(stats) || at !== position) {
        heldSince = 0;
        position = at;
        said = false;
        return null;
      }
      heldSince ||= now;
      if (said || now - heldSince < HELD_MS) return null;
      said = true;
      return { positionMs: at, heldForMs: Math.round(now - heldSince) };
    },
  };
}
