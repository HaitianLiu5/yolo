// Where a tap on an item plays (Agent Note 2026-10-11-yolo-web-client).
//
// - The car plays on itself: it is the screen in front of the people in it.
// - Yolo Web plays where playback is now, as Spotify Connect does: on the
//   device that is playing or paused, when that is another one and it is
//   online, so a phone or a computer acts as a remote. With nothing playing
//   elsewhere, it plays in this browser.
// - A browser that cannot play with either engine (a remote) plays on the
//   last device that played, or on the only other one online; with several,
//   the owner picks. Safari on iPhone and iPad plays with its own <video>
//   element (Agent Note 2026-10-12-two-playback-engines), so it is no remote.

const BUSY = new Set(["playing", "paused", "loading", "buffering"]);

const playable = (device) => device?.capabilities?.renderer !== "remote";

/**
 * @param {object} input
 * @param {"car" | "web"} input.mode
 * @param {boolean} input.canPlay  this browser plays, with either engine (mode.js)
 * @param {object | null} input.hub  the Hub's PlaybackState
 * @param {Array<object>} input.devices  Yolo's device list
 * @param {string | null} input.self  this device's id
 * @returns {{ here: true } | { deviceId: string } | { choose: Array<object> }}
 *   `choose` lists the devices to pick from (none: nothing can play)
 */
export function playTarget({ mode, canPlay, hub, devices = [], self }) {
  const onlinePlayer = (id) => devices.find((device) => device.id === id && device.id !== self && device.online && playable(device)) ?? null;
  if (mode === "car" && canPlay) return { here: true };
  const active = hub?.deviceId ? onlinePlayer(hub.deviceId) : null;
  if (active && hub.item && BUSY.has(hub.status)) return { deviceId: active.id };
  if (canPlay) return { here: true };
  if (active) return { deviceId: active.id };
  const others = devices.filter((device) => device.id !== self && device.online && playable(device));
  if (others.length === 1) return { deviceId: others[0].id };
  return { choose: others };
}

/** Devices playback can move to, this one first when it can play. */
export function transferTargets({ devices = [], self, canPlay }) {
  const others = devices.filter((device) => device.id !== self && device.online && playable(device));
  const mine = devices.find((device) => device.id === self);
  return canPlay && mine ? [mine, ...others] : others;
}

/** The position now, extrapolated from the Hub's last report while playing. */
export function livePosition(hub, now = Date.now()) {
  if (!hub) return 0;
  const position = Number(hub.position) || 0;
  if (hub.status !== "playing" || !hub.positionAt) return position;
  const duration = Number(hub.item?.duration) || Infinity;
  return Math.min(duration, position + Math.max(0, now - hub.positionAt) / 1000);
}
