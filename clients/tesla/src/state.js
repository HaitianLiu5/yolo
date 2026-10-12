// Shared mutable state — all modules import and read/write this directly.

export const state = {
  player: null,
  audioUnlocked: false,
  // The browser would not start sound without a user gesture: the player
  // runs muted (engine/mediabunny-player.js) until a tap.
  audioBlocked: false,
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
  devices: [],           // Yolo's devices (`devices` broadcasts)
  queue: [],
  playlists: [],
  progressInterval: null,
};
