// What Yolo's Hub said to this screen that a reconnect lost, and what the
// owner did here meanwhile (Agent Note 2026-10-07-hub-and-realtime-channel).
// The Hub sends each command once, over the connections the screen has
// then, and a connection that died without the Hub noticing takes it. The
// welcome after the reconnect names the last pause or resume and the last
// seek the Hub sent for the stream it names (`commands`, with their ids),
// and the subtitles it chose for it (`state.tracks`); the Hub sends an
// unacknowledged danmaku change again after it (`again`). What of that this
// page never dealt with, it does now, unless the owner did the same kind of
// thing here and Yolo may not have heard it yet. Reports the page sent the
// other way are player.js's.

/**
 * The last pause or resume and the last seek this page dealt with for one
 * stream, the one on screen or kept: heard live, or settled from a welcome
 * whether done or left out. A welcome naming one of them again changes
 * nothing; a new stream starts with none.
 */
export function createSettledCommands() {
  let settled = { sessionId: null, playback: null, seek: null };
  const settle = (sessionId, slot, id) => {
    if (!sessionId || typeof id !== "string") return;
    if (settled.sessionId !== sessionId) settled = { sessionId, playback: null, seek: null };
    settled[slot] = id;
  };
  return {
    settle,
    has: (sessionId, slot, id) => Boolean(sessionId) && settled.sessionId === sessionId && settled[slot] === id,
    /** The welcome's commands for `sessionId`, done or left out now. */
    settleWelcome(welcome, sessionId) {
      const commands = welcome?.commands;
      if (!sessionId || commands?.sessionId !== sessionId) return;
      settle(sessionId, "playback", commands.playback?.id);
      settle(sessionId, "seek", commands.seek?.id);
    },
  };
}

/**
 * What the owner did on this screen that Yolo may not have heard: a pause
 * or Back (`playback`), a seek (`seek`), a danmaku setting (`danmaku:<name>`).
 * Each counts as unheard until Yolo answers a ping the page sent over its
 * welcomed connection after it (`confirm`, realtime.js): whatever Yolo
 * sends from then on, or sent and the page has not received, was sent
 * after it. No clock is read. One ping is in flight at a time: its answer
 * covers what came before it, and what came after it waits for the next.
 * Without a welcomed connection nothing is pinged, and what the owner did
 * stays unheard. A welcome takes what is unheard (`take()`); from it on,
 * everything Yolo sends over the new connection is newer, so nothing is.
 *
 * @param {{ confirm: (heard: () => void) => boolean }} options  `confirm`
 *   pings and calls back on the answer; false when it could not ping
 */
export function createOwnActions({ confirm }) {
  const unheard = new Map();
  let count = 0;
  let welcomes = 0;
  let asking = false;
  const ask = () => {
    if (asking || !unheard.size) return;
    const covers = count;
    const welcome = welcomes;
    asking = confirm(() => {
      if (welcome !== welcomes) return;
      asking = false;
      for (const [kind, mark] of unheard) if (mark <= covers) unheard.delete(kind);
      ask();
    }) === true;
  };
  return {
    note(kind) {
      unheard.set(kind, ++count);
      ask();
    },
    /** What is unheard now; nothing is unheard afterwards. */
    take() {
      const kinds = new Set(unheard.keys());
      unheard.clear();
      welcomes += 1;
      asking = false;
      return kinds;
    },
  };
}

const NONE = Object.freeze({ pause: false, resume: false, resumeHeld: false, seek: null, seekHeld: false });

/**
 * The commands for the stream this screen plays, or keeps behind its home
 * screen, that the welcome names and this page never dealt with. A missed
 * resume is left out (`resumeHeld`) when the owner paused here, or went
 * Back, unheard: that pause may be the newer, and nothing starts playing on
 * a doubt. A missed seek is left out (`seekHeld`) when the owner sought
 * here unheard. A missed pause always goes: it starts nothing.
 *
 * @param {object | null} welcome  the welcome: `state`, and `commands` from
 *   a Hub that names them (a 0.8.0 Hub does not)
 * @param {object} screen
 * @param {string | null} screen.deviceId  this device
 * @param {string | null} screen.sessionId  the stream on screen, or kept
 * @param {{ has: (sessionId: string, slot: string, id: string) => boolean }} screen.settled
 * @param {Set<string>} screen.own  what the owner did here unheard (createOwnActions().take())
 * @returns {{ pause: boolean, resume: boolean, resumeHeld: boolean, seek: number | null, seekHeld: boolean }}
 */
export function missedCommands(welcome, { deviceId, sessionId, settled, own = new Set() }) {
  const hub = welcome?.state;
  const commands = welcome?.commands;
  if (!hub || !commands || !deviceId || !sessionId) return NONE;
  if (hub.deviceId !== deviceId || hub.sessionId !== sessionId || commands.sessionId !== sessionId) return NONE;
  const missed = (slot) => typeof commands[slot]?.id === "string" && !settled.has(sessionId, slot, commands[slot].id);
  const playback = missed("playback") ? commands.playback.action : null;
  const position = Number(commands.seek?.position);
  const seek = missed("seek") && Number.isFinite(position) && position >= 0;
  return {
    pause: playback === "pause",
    resume: playback === "resume" && !own.has("playback"),
    resumeHeld: playback === "resume" && own.has("playback"),
    seek: seek && !own.has("seek") ? position : null,
    seekHeld: seek && own.has("seek"),
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

/**
 * The danmaku settings of a `danmaku` message to apply. A live change goes
 * whole. One the Hub sends again after a welcome (`again`), because the
 * screen never acknowledged it, keeps only the settings this page has not
 * applied from that change already (`heard`: the id of the last change from
 * Yolo applied to each setting) and the owner has not changed here unheard
 * before that welcome (`own`, as for missedCommands).
 *
 * @param {{ id?: string, settings?: object, again?: boolean }} message
 * @param {{ heard: Record<string, string>, own: Set<string> }} screen
 * @returns {object} the settings to apply
 */
export function danmakuToApply(message, { heard, own }) {
  const settings = message?.settings && typeof message.settings === "object" ? message.settings : {};
  if (message?.again !== true) return { ...settings };
  return Object.fromEntries(Object.entries(settings).filter(([name]) => heard[name] !== message.id && !own.has(`danmaku:${name}`)));
}
