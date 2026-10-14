// Shared mutable state — all modules import and read/write this directly.

export const state = {
  player: null,
  audioUnlocked: false,
  // The browser would not start sound without a user gesture: the player
  // runs muted (engine/mediabunny-player.js) until a tap.
  audioBlocked: false,
  playbackIntent: "paused",
  // When the owner last paused on this screen, or went Back (ms): a resume
  // a reconnect lost does not overrule a pause that may be newer
  // (missed-commands.js).
  pausedHereAt: 0,
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
  // The stream's path: "lan" or "wan" from one of the node's listeners
  // (mediaOrigin), or "relay" from this page's origin
  // (Agent Note 2026-10-13-media-off-the-worker).
  streamNetwork: "relay",
  mediaOrigin: null,
  hub: null,             // the Hub's latest PlaybackState
  devices: [],           // Yolo's devices (`devices` broadcasts)
  queue: [],
  playlists: [],
  progressInterval: null,
};
