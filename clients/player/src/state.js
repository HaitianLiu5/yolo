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
  // The owner's playback speed for this page, and the speeds the engine
  // playing plays: { max, quietAbove } (playback-speed.js, set by player.js).
  playbackSpeed: 1,
  speedLimits: { max: 3, quietAbove: null },
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
  hub: null,             // this screen's own session: the Hub's latest PlaybackState for it
  // Every other screen's session, by device id (client protocol 2, Agent
  // Note 2026-10-31-screen-sessions), and the profiles: who watches here by
  // default (`profile`, { id, name }) and the owner's list.
  sessions: {},
  profile: null,
  profiles: [],
  canvas: [],            // this screen's agent canvas: its objects (canvas.js)
  // Yolo's Hub has welcomed this page once: until then the home screen and
  // the now-playing bar show what the page kept from last time
  // (home-cache.js), for looking only.
  welcomed: false,
  cachedHub: null,       // the Hub's state as the page kept it, shown until then
  welcomedAt: 0,         // performance.now() of the latest welcome
  devices: [],           // Yolo's devices (`devices` broadcasts)
  queue: [],
  playlists: [],
  progressInterval: null,
};
