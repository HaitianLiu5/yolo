// What an engine says about itself: getStats(), one shape from both engines
// (engine/mediabunny-player.js, engine/native-video-player.js), read for the
// runtime log (Agent Note 2026-10-11-device-telemetry) and for the checks
// that tell whether playback moves (player.js). Times the engines give in
// milliseconds keep an `Ms` suffix here.

/** The engine's stats, or null when it has none or fails to give them. */
export function readStats(player) {
  try {
    const stats = player?.getStats?.();
    return stats && typeof stats === "object" ? stats : null;
  } catch {
    return null;
  }
}

const number = (value) => {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};
const rounded = (value) => (value == null ? null : Number(value.toFixed(3)));
const object = (value) => (value && typeof value === "object" ? value : null);

// The canvas engine's HLS read-ahead (engine/hls-segment-prefetcher.js),
// which both the summary and the buffer carry.
const HLS_BUFFER_FIELDS = [
  "hlsBufferedAheadSeconds", "hlsBufferedBytes", "hlsCachedSegments", "hlsPendingSegments", "hlsActiveDownloads",
  "hlsQueuedSegments", "hlsRetryWaitingSegments", "hlsOldestActiveDownloadMs", "hlsNetworkRetryCount", "hlsTimeoutCount",
  "hlsFailureCount", "hlsBufferMaxBytes", "hlsBufferTargetSeconds", "hlsPeakBufferedBytes", "hlsPeakBufferedAheadSeconds",
  "hlsManagedBytesEstimate", "hlsPeakManagedBytesEstimate", "hlsBufferByteCapHitCount",
];

function hlsBuffer(stats) {
  return {
    ...Object.fromEntries(HLS_BUFFER_FIELDS.map((key) => [key, number(stats[key])])),
    hlsLastFailure: object(stats.hlsLastFailure),
    hlsBufferCacheUtilization: rounded(number(stats.hlsBufferCacheUtilization)),
  };
}

// The summary's numbers, by their name in it and, where it differs, in the stats.
const SUMMARY_NUMBERS = [
  "audioPacketQueueLength", "audioDropPacketCount", "audioFrameDecodeCount", "audioFrameRenderCount", "audioFrameRenderIntervalMax",
  "videoPacketQueueLength", "videoDropPacketCount", "videoDecodeErrorPacketCount", "videoFrameDecodeCount", "videoFrameRenderCount",
  "videoFrameDropCount", "videoFrameDecodeIntervalMax", "videoFrameRenderIntervalMax", "bandwidth", "bufferReceiveBytes",
  "bufferOutputBytes", "bufferDropBytes", "audioStutter", "audioDiscontinuities", "videoStutter", "seekRequestCount",
  "seekSupersededCount", "iteratorCloseTimeoutCount", "lastSeekTarget", ["audioCurrentTimeMs", "audioCurrentTime"],
  ["audibleAudioCurrentTimeMs", "audibleAudioCurrentTime"], "audioOutputLatencyMs", ["videoCurrentTimeMs", "videoCurrentTime"],
  ["audioNextTimeMs", "audioNextTime"], ["videoNextTimeMs", "videoNextTime"], "durationDistanceMs", "width", "height",
  "hlsThroughputSampleCount", "liveDvrStartTime", "liveEdgeTime", "livePlayStartTime", "liveLatencyMs",
].map((field) => (Array.isArray(field) ? field : [field, field]));

/** Everything the engine says about decoding, presenting, and fetching, for the log and the checks. */
export function summarizeStats(stats) {
  if (!stats) return null;
  const jitterBuffer = object(stats.jitterBuffer);
  return {
    ...Object.fromEntries(SUMMARY_NUMBERS.map(([name, key]) => [name, number(stats[key])])),
    jitter: rounded(number(stats.jitter)),
    audioSourceEnded: typeof stats.audioSourceEnded === "boolean" ? stats.audioSourceEnded : null,
    videoSourceEnded: typeof stats.videoSourceEnded === "boolean" ? stats.videoSourceEnded : null,
    audioCodec: typeof stats.audiocodec === "string" ? stats.audiocodec : null,
    videoCodec: typeof stats.videocodec === "string" ? stats.videocodec : null,
    ...hlsBuffer(stats),
    jitterBuffer: jitterBuffer ? { minMs: number(jitterBuffer.min), maxMs: number(jitterBuffer.max) } : null,
    ...(stats.engine === "native" ? {
      engine: "native",
      mode: typeof stats.mode === "string" ? stats.mode : null,
      adaptsWithinStream: stats.adaptsWithinStream === true,
      hlsLevels: number(stats.hlsLevels),
      hlsLevelKbps: number(stats.hlsLevelKbps),
      timelineOffset: number(stats.timelineOffset),
    } : {}),
  };
}

// At most 8 playlists of 9 small fields: about 150 bytes each.
function hlsPlaylists(playlists) {
  if (!Array.isArray(playlists)) return null;
  return playlists.slice(0, 8).map((playlist) => ({
    name: typeof playlist?.name === "string" ? playlist.name.slice(0, 40) : null,
    ...Object.fromEntries(["current", "segments", "scheduledThrough", "ahead", "queued", "pending", "retry", "failed"]
      .map((key) => [key, number(playlist?.[key])])),
  }));
}

/**
 * What is buffered ahead: seconds of picture (the HLS read-ahead when the
 * stream has one), milliseconds of sound, the sound's underruns, and the
 * HLS read-ahead itself, each playlist's included, so a stalled read-ahead
 * shows which playlist stopped and why.
 */
export function bufferState(stats) {
  const ahead = number(stats?.hlsBufferedAheadSeconds) ?? (number(stats?.videoBufferedMs) ?? NaN) / 1000;
  const evictions = object(stats?.hlsEvictions);
  return {
    bufferHealthSeconds: Number.isFinite(ahead) ? Math.max(0, ahead) : null,
    bufferedAudioMs: number(stats?.audioBufferedMs),
    audioUnderrunCount: number(stats?.audioStutter),
    ...hlsBuffer(stats ?? {}),
    hlsPlaylists: hlsPlaylists(stats?.hlsPlaylists),
    hlsEvictions: evictions ? { behind: number(evictions.behind), ahead: number(evictions.ahead), bytes: number(evictions.bytes) } : null,
    hlsOrphanJobs: number(stats?.hlsOrphanJobs),
  };
}

/** Frames the engine decoded and never showed. */
export const droppedFrames = (stats) => number(stats?.videoFrameDropCount);
