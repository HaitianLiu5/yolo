// What Yolo's Hub said to this screen that a reconnect lost
// (Agent Note 2026-10-07-hub-and-realtime-channel). The Hub sends each
// command once, over the connections the screen has then, and a connection
// that died without the Hub noticing takes it. The welcome after the
// reconnect names the last pause or resume and the last seek the Hub sent
// for the stream it names (`commands`, with their ids), and the subtitles
// it chose for it (`state.tracks`): what of that this page never heard, it
// does now, in place of what it shows. Reports the page sent the other way
// are player.js's.

const HEARD_IDS = 256;

/** The ids of the commands this page heard, the last `limit` of them. */
export function createHeardCommands(limit = HEARD_IDS) {
  const ids = new Set();
  return {
    note(id) {
      if (typeof id !== "string" || !id) return;
      ids.delete(id);
      ids.add(id);
      if (ids.size > limit) ids.delete(ids.values().next().value);
    },
    has: (id) => ids.has(id),
  };
}

const NONE = Object.freeze({ pause: false, resume: false, resumeHeld: false, seek: null });

/**
 * The commands for the stream this screen plays, or keeps behind its home
 * screen, that the welcome names and this page never heard.
 *
 * A resume is left out when the owner paused here, or went Back, after the
 * page last heard Yolo over its previous connection: that pause may be the
 * newer, and in doubt nothing starts playing. A pause never starts anything
 * and always goes.
 *
 * @param {object | null} welcome  the welcome: `state`, and `commands` from
 *   a Hub that names them (a 0.8.0 Hub does not)
 * @param {object} screen
 * @param {string | null} screen.deviceId  this device
 * @param {string | null} screen.sessionId  the stream on screen, or kept
 * @param {(id: string) => boolean} screen.heard  whether this page heard it
 * @param {number} [screen.heardAt]  when this page last heard Yolo over its
 *   previous connection (ms)
 * @param {number} [screen.pausedHereAt]  when the owner last paused here (ms)
 * @returns {{ pause: boolean, resume: boolean, resumeHeld: boolean, seek: number | null }}
 *   `resumeHeld`: a missed resume left out for the owner's pause
 */
export function missedCommands(welcome, { deviceId, sessionId, heard, heardAt = 0, pausedHereAt = 0 }) {
  const hub = welcome?.state;
  const commands = welcome?.commands;
  if (!hub || !commands || !deviceId || !sessionId) return NONE;
  if (hub.deviceId !== deviceId || hub.sessionId !== sessionId || commands.sessionId !== sessionId) return NONE;
  const missed = (command) => typeof command?.id === "string" && !heard(command.id);
  const playback = missed(commands.playback) ? commands.playback.action : null;
  const pausedSince = Number(pausedHereAt) > Number(heardAt);
  const position = Number(commands.seek?.position);
  return {
    pause: playback === "pause",
    resume: playback === "resume" && !pausedSince,
    resumeHeld: playback === "resume" && pausedSince,
    seek: missed(commands.seek) && Number.isFinite(position) && position >= 0 ? position : null,
  };
}

/**
 * The subtitles Yolo chose for the stream on screen (`state.tracks` of the
 * welcome), when they are not the ones the screen shows and a `tracks`
 * message would have switched them in place: text tracks, each with its
 * WebVTT URL in the stream the screen has. Null otherwise; a switch from or
 * to a burned-in track is a new stream.
 *
 * @param {object | null} hub  the Hub's PlaybackState
 * @param {{ deviceId: string | null, sessionId: string | null, tracks: object | null }} screen
 *   `tracks` as the stream on screen, or kept, has them
 * @returns {string[] | null}
 */
export function subtitlesToFollow(hub, { deviceId, sessionId, tracks }) {
  if (!hub || !deviceId || !sessionId || hub.deviceId !== deviceId || hub.sessionId !== sessionId) return null;
  if (!Array.isArray(hub.tracks?.subtitles)) return null;
  const wanted = hub.tracks.subtitles.map(String);
  const shown = (tracks?.selected?.subtitles || []).map(String);
  if (wanted.length === shown.length && wanted.every((id) => shown.includes(id))) return null;
  const available = new Map((tracks?.subtitles || []).map((track) => [String(track.id), track]));
  const inPlace = (id) => available.get(id)?.delivery === "vtt" && Boolean(available.get(id)?.url);
  return wanted.every(inPlace) && shown.every(inPlace) ? wanted : null;
}
