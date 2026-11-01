// Where a tap on an item plays (Agent Note 2026-10-31-screen-sessions).
//
// - A browser that plays, with either engine, plays on itself, in both
//   modes: every screen has its own session, and controlling another
//   screen is an explicit act in the now-playing bar. Safari on iPhone and
//   iPad plays with its own <video> element (Agent Note
//   2026-10-12-two-playback-engines), so it is no remote.
// - A browser that cannot (a remote) plays on the only other screen online,
//   or the owner picks one.

const playable = (device) => device?.capabilities?.renderer !== "remote";

/**
 * @param {object} input
 * @param {boolean} input.canPlay  this browser plays, with either engine (mode.js)
 * @param {Array<object>} input.devices  Yolo's device list
 * @param {string | null} input.self  this device's id
 * @returns {{ here: true } | { deviceId: string } | { choose: Array<object> }}
 *   `choose` lists the devices to pick from (none: nothing can play)
 */
export function playTarget({ canPlay, devices = [], self }) {
  if (canPlay) return { here: true };
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
