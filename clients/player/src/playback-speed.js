// Playback speed (Agent Note 2026-10-12-two-playback-engines): the player's
// speed panel, a slider with a row of presets, and Shift+. and Shift+, (>
// and <). The owner's speed holds for every stream this page plays, through
// rebuilds and from item to item; a new page starts at 1×.
export const MIN_SPEED = 0.5;
// The fastest each engine plays. The canvas engine decodes the speed's
// multiple of frames, and the car was not measured past 3×.
export const MAX_SPEED = Object.freeze({ native: 5, canvas: 3 });
export const PRESETS = Object.freeze([0.5, 1, 1.5, 2, 3]);
// A press and hold on the picture, below this speed; at it or faster, the
// hold changes nothing.
export const HOLD_SPEED = 2;
const SLIDER_STEP = 0.1;
const KEY_STEP = 0.25;
// A slider let go this close to a preset lands on it.
const SNAP = 0.05;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const tidy = (value) => Math.round(value * 100) / 100;

// The slider lays speeds out on a logarithmic scale of the speed plus one,
// which gives 0.5× to 2× half of a track to 5×.
const scale = (speed) => Math.log(speed + 1);

/** Where `speed` sits on a slider from MIN_SPEED to `max`, from 0 to 1. */
export function speedFraction(speed, max) {
  return clamp((scale(speed) - scale(MIN_SPEED)) / (scale(max) - scale(MIN_SPEED)), 0, 1);
}

/** The speed at `fraction` of a slider to `max`: a preset within SNAP, else a step of 0.1. */
export function speedAt(fraction, max) {
  const raw = Math.exp(scale(MIN_SPEED) + clamp(fraction, 0, 1) * (scale(max) - scale(MIN_SPEED))) - 1;
  const preset = PRESETS.find((speed) => speed <= max && Math.abs(speed - raw) <= SNAP + 1e-9);
  return preset ?? clamp(tidy(Math.round(raw / SLIDER_STEP) * SLIDER_STEP), MIN_SPEED, max);
}

// The next multiple of `step` faster (direction 1) or slower (-1), or the
// end of the range it is at.
function stepOn(speed, direction, step, max) {
  const steps = speed / step;
  const next = direction > 0 ? Math.floor(steps + 1e-9) + 1 : Math.ceil(steps - 1e-9) - 1;
  return clamp(tidy(next * step), MIN_SPEED, max);
}

/** The slider's arrow keys: the next 0.1 faster (1) or slower (-1). */
export const nudgeSpeed = (speed, direction, max) => stepOn(speed, direction, SLIDER_STEP, max);

/** Shift+. and Shift+,: the next quarter faster (1) or slower (-1). */
export const stepSpeed = (speed, direction, max) => stepOn(speed, direction, KEY_STEP, max);

/**
 * The speeds an engine plays: to `max`, and with sound up to `quietAbove`
 * (null: at every speed). `native` is nativeVideoSupport().
 */
export function speedLimits(engine, native = null) {
  return engine === "native"
    ? { max: MAX_SPEED.native, quietAbove: native?.quietAbove ?? null }
    : { max: MAX_SPEED.canvas, quietAbove: null };
}

/** The speed a press and hold plays at, or null when it changes nothing. */
export const holdSpeed = (speed) => (speed < HOLD_SPEED ? HOLD_SPEED : null);

/** "1.5×". */
export const speedName = (speed) => `${Number(speed.toFixed(2))}×`;
