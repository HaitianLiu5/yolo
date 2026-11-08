import { OWNER_PROFILE, sessionInUse } from "@useyolo/core";
import { state } from "./state.js";

// What the Hub keeps for every screen and broadcasts to each: this screen's
// own session (`hub`), every other screen's (`sessions`, by device id;
// Agent Note 2026-10-31-screen-sessions), this screen's queue, and the
// playlists (Agent Note 2026-10-07-hub-and-realtime-channel), and this screen's agent canvas
// (Agent Note 2026-10-21-agent-canvas). A welcome, a broadcast, a home
// load, or the answer to this screen's own change writes it with share(); it
// lands in `state` as before, and each view that shows it redraws once,
// without every writer having to name every view.

const KEYS = new Set(["hub", "sessions", "queue", "playlists", "canvas"]);
const listeners = [];

/**
 * Writes `changes` (some of hub, sessions, queue, playlists) into `state`, then calls
 * each listener subscribed to one of them, once. `options` reaches the
 * listeners: `remember: false` for what the page's own cache drew.
 */
export function share(changes, options = {}) {
  const keys = Object.keys(changes);
  for (const key of keys) {
    if (!KEYS.has(key)) throw new Error(`share: ${key} is not shared state`);
    state[key] = changes[key];
  }
  for (const { on, listener } of listeners) {
    if (!on.some((key) => keys.includes(key))) continue;
    // One view's failure leaves the others drawn.
    try {
      listener(options);
    } catch (error) {
      console.error("[store] A view failed to redraw:", error);
    }
  }
}

/** Calls `listener(options)` after each share() that writes one of `keys`. */
export function subscribe(keys, listener) {
  for (const key of keys) {
    if (!KEYS.has(key)) throw new Error(`subscribe: ${key} is not shared state`);
  }
  listeners.push({ on: keys, listener });
}

export const sourceKeyOf = (source) => (source?.plugin && source.id != null ? `${source.plugin}:${source.id}` : null);

/**
 * What the Hub's state names as up next after the stream `sessionId` (by
 * default the one on this screen; Agent Note 2026-10-23-up-next), or null
 * while the Hub plays another stream, or none.
 */
export function upNextFor(sessionId = state.sessionId, hub = state.hub) {
  return hub?.sessionId && hub.sessionId === sessionId ? hub.upNext ?? null : null;
}

// The Hub's walk through history counts for the item it was taken from: a
// screen that plays another item (a share link, a stream the Hub moved on
// from) has none.
function walkFor(hub, current) {
  return hub?.walk && sourceKeyOf(hub.item?.source) === current ? hub.walk : null;
}

/**
 * Whether `next` has somewhere to go from `current` (a source key; by default
 * the item the Hub plays): what the Hub's state names as up next (Agent Note
 * 2026-10-23-up-next), which a Hub before it does not, so also forward
 * again through the Hub's walk, then the queue's head (Agent Note
 * 2026-10-07-hub-and-realtime-channel).
 */
export function nextAvailable({ hub = state.hub, queue = state.queue, current = sourceKeyOf(hub?.item?.source) } = {}) {
  if (hub?.upNext && sourceKeyOf(hub.item?.source) === current) return true;
  return walkFor(hub, current)?.forward > 0 || (queue || []).length > 0;
}

/**
 * Whether `previous` has somewhere to go from `current`: back through the
 * Hub's walk while one is under way, otherwise to the latest other item in
 * `recentHistory` (source keys, newest first).
 */
export function previousAvailable({ hub = state.hub, current = sourceKeyOf(hub?.item?.source), recentHistory = [] } = {}) {
  const walk = walkFor(hub, current);
  return walk ? walk.back > 0 : (recentHistory || []).some((key) => key !== current);
}

/** Whether a session is in use, as the Hub decides it, with its screen's online flag from `devices`. */
export function inUse(session, { devices = state.devices, now = Date.now() } = {}) {
  const online = (devices || []).some((device) => device.id === session?.deviceId && device.online);
  return sessionInUse(session, { online, now });
}

const finished = (session) => {
  const duration = Number(session.item?.duration) || 0;
  const position = Number(session.position) || 0;
  return duration > 0 && !session.item.isLive && position >= duration - Math.min(60, duration * 0.05);
};

const sessionProfile = (session) => session.profile?.id ?? OWNER_PROFILE;

/**
 * The sessions "Continue from another screen" offers (Agent Note
 * 2026-10-31-screen-sessions): other screens' sessions of the owner's
 * profile or this screen's own default one, with an item not finished and
 * not continued elsewhere since, newest first, offline screens' too (a
 * parked car's), one for each profile's item, at most `max`.
 */
export function continueCandidates({ sessions = state.sessions, self = state.deviceId, profile = state.profile, max = 3 } = {}) {
  const mine = profile?.id ?? OWNER_PROFILE;
  const seen = new Set();
  return Object.values(sessions || {})
    .filter((session) => session?.item && session.deviceId !== self && session.status !== "idle" && !session.handedTo && !finished(session))
    .filter((session) => [OWNER_PROFILE, mine].includes(sessionProfile(session)))
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .filter((session) => {
      const key = `${sessionProfile(session)}|${sourceKeyOf(session.item.source)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
}

/**
 * The items Continue Watching leaves to the row above it: the source keys
 * of the candidates this screen's own profile watches. Another profile's
 * session is not this profile's progress, so its entry stays.
 */
export function offeredSources(candidates, { profile = state.profile } = {}) {
  const mine = profile?.id ?? OWNER_PROFILE;
  return new Set(candidates.filter((session) => sessionProfile(session) === mine).map((session) => sourceKeyOf(session.item.source)));
}
