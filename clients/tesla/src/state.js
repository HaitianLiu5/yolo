// Shared mutable state — all modules import and read/write this directly.

export const state = {
  player: null,
  audioUnlocked: false,
  playbackIntent: "paused",
  isPlaying: false,
  isMuted: false,
  isBuffering: false,
  isLive: false,
  liveDvrAvailable: false,
  liveStartTime: 0,
  liveEdgeTime: 0,
  duration: 0,
  currentTime: 0,
  // Yolo: this device, and the stream it plays (the `load` message).
  deviceId: null,
  sessionId: null,
  source: null,          // the item's Source, for rebuilding the stream
  tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
  hub: null,             // the Hub's latest PlaybackState
  queue: [],
  playlists: [],
  progressInterval: null,
};
