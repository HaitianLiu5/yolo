// Playback speed, as on YouTube (Agent Note 2026-10-12-two-playback-engines):
// its steps, in the player's speed menu and with Shift+. and Shift+, (> and
// <). The owner's speed holds for every stream this page plays, through
// rebuilds and from item to item; a new page starts at Normal.
export const SPEEDS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
// A press and hold on the picture, whatever the owner's speed.
export const HOLD_SPEED = 2;

// The menu's words for a step: "Normal", else the number alone.
export const speedName = (speed) => (speed === 1 ? "Normal" : String(speed));

// The next step faster (direction 1) or slower (-1), or the end it is at.
export function stepSpeed(speed, direction) {
  return direction > 0
    ? SPEEDS.find((step) => step > speed) ?? SPEEDS.at(-1)
    : SPEEDS.findLast((step) => step < speed) ?? SPEEDS[0];
}
