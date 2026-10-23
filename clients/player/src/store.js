import { state } from "./state.js";

// What the Hub keeps for every screen and broadcasts to each: its playback
// state, the queue, and the playlists (Agent Note
// 2026-10-07-hub-and-realtime-channel). A welcome, a broadcast, a home
// load, or the answer to this screen's own change writes it with share(); it
// lands in `state` as before, and each view that shows it redraws once,
// without every writer having to name every view.

const KEYS = new Set(["hub", "queue", "playlists"]);
const listeners = [];

/**
 * Writes `changes` (some of hub, queue, playlists) into `state`, then calls
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
