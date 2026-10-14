// How much encoded media the canvas engine holds before the picture moves
// (Agent Note 2026-04-04-canvas-playback-engine). A start or a seek plays
// once START_BUFFER_SECONDS are buffered, and the HLS prefetcher keeps
// filling toward its target while it plays. A stall that found the network
// buffer shorter than that (the link fell behind) waits for
// REBUFFER_SECONDS, so a link slower than the stream does not stall again at
// once; a stall with media still buffered (a decoder hiccup) resumes as soon
// as frames are decoded again.
export const START_BUFFER_SECONDS = 3;
export const REBUFFER_SECONDS = 5;

/** The runway a stall from playing waits for. */
export function stallRunwaySeconds({ startSeconds = START_BUFFER_SECONDS, network = null } = {}) {
  const ahead = Number(network?.bufferedAheadSeconds);
  if (!network || !Number.isFinite(ahead) || ahead >= startSeconds) return startSeconds;
  return Math.max(startSeconds, REBUFFER_SECONDS);
}

export function hasHlsStartupBuffer({
  decodedReady,
  network = null,
  mediaTime = 0,
  duration = 0,
  requiredStartSeconds = START_BUFFER_SECONDS,
}) {
  if (!decodedReady) return false;
  if (!network) return true;
  if (network.allRemainingSegmentsCached === true) return true;
  if (!network.activePlaylistCount) {
    return ![
      network.pendingSegments,
      network.activeDownloads,
      network.queuedSegments,
      network.retryWaitingSegments,
    ].some((value) => Number(value) > 0);
  }
  const remainingSeconds = Number.isFinite(duration) && duration > 0
    ? Math.max(0, duration - mediaTime)
    : requiredStartSeconds;
  const requiredSeconds = Math.min(requiredStartSeconds, remainingSeconds);
  return network.bufferedAheadSeconds >= requiredSeconds
    || (network.pendingSegments === 0 && network.bufferedAheadSeconds > 0);
}
