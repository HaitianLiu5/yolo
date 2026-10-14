// Danmaku, timed comments over the picture (Agent Note 2026-10-13-danmaku):
// the shape a source's comments() answer is normalized to, and how a screen
// shows them. Each screen keeps its own settings; an agent changes them
// through the Hub's `danmaku` message, and the player and the control plane
// check them with the same definitions.

// One comment as devices and agents get it: `t` in seconds, plain text of at
// most MAX_COMMENT_TEXT characters, a mode, a "#rrggbb" colour, a size
// relative to the normal one (0.5 to 2), and, when the provider ranks its
// comments, `weight`, 0 to 10, higher for the ones its viewers want to see;
// screens hide those below 3 at normal density. Comments without a usable
// time or text are dropped, and one answer keeps at most
// MAX_COMMENTS_PER_ANSWER.
const COMMENT_MODES = new Set(["scroll", "top", "bottom"]);
const MAX_COMMENT_TEXT = 100;
export const MAX_COMMENTS_PER_ANSWER = 20_000;

/** Comments in time order, each in the shape above. */
export function normalizeComments(list) {
  const comments = [];
  for (const comment of Array.isArray(list) ? list : []) {
    if (comments.length >= MAX_COMMENTS_PER_ANSWER) break;
    const t = Number(comment?.t);
    const text = typeof comment?.text === "string" ? comment.text.replace(/\s+/g, " ").trim() : "";
    if (!Number.isFinite(t) || t < 0 || !text) continue;
    const characters = [...text];
    const color = typeof comment.color === "string" && /^#[0-9a-f]{6}$/i.test(comment.color) ? comment.color.toLowerCase()
      : Number.isInteger(comment.color) ? `#${(comment.color & 0xffffff).toString(16).padStart(6, "0")}` : "#ffffff";
    const size = Number(comment.size);
    const normalized = {
      t: Math.round(t * 1000) / 1000,
      text: characters.length > MAX_COMMENT_TEXT ? `${characters.slice(0, MAX_COMMENT_TEXT).join("")}…` : text,
      mode: COMMENT_MODES.has(comment.mode) ? comment.mode : "scroll",
      color,
      size: Number.isFinite(size) && size > 0 ? Math.min(2, Math.max(0.5, Math.round(size * 100) / 100)) : 1,
    };
    const weight = comment.weight == null ? NaN : Number(comment.weight);
    if (Number.isFinite(weight)) normalized.weight = Math.min(10, Math.max(0, Math.round(weight)));
    comments.push(normalized);
  }
  return comments.sort((left, right) => left.t - right.t);
}

export const DANMAKU_DENSITIES = Object.freeze(["low", "normal", "high"]);
// The part of the picture comments use, from its top.
export const DANMAKU_AREAS = Object.freeze(["full", "half", "quarter"]);
export const DANMAKU_FONT_SIZES = Object.freeze(["small", "normal", "large"]);
export const DANMAKU_OPACITY_STEPS = Object.freeze([0.4, 0.6, 0.8, 1]);
const MIN_OPACITY = 0.2;

// Bilibili's player's own defaults, read from its code on 2026-10-14: on,
// 80% opacity, its normal density, its normal text size; the area is the
// top quarter (Agent Note 2026-10-13-danmaku says why).
export const DANMAKU_DEFAULTS = Object.freeze({ enabled: true, density: "normal", opacity: 0.8, area: "quarter", fontSize: "normal" });

/**
 * The valid settings in `value`, and nothing else: a partial change. An
 * opacity is clamped to 0.2–1 and rounded to 0.05.
 */
export function danmakuSettingsPatch(value) {
  const patch = {};
  if (!value || typeof value !== "object") return patch;
  if (typeof value.enabled === "boolean") patch.enabled = value.enabled;
  if (DANMAKU_DENSITIES.includes(value.density)) patch.density = value.density;
  if (DANMAKU_AREAS.includes(value.area)) patch.area = value.area;
  if (DANMAKU_FONT_SIZES.includes(value.fontSize)) patch.fontSize = value.fontSize;
  const opacity = Number(value.opacity);
  if (value.opacity != null && Number.isFinite(opacity)) patch.opacity = Math.round(Math.min(1, Math.max(MIN_OPACITY, opacity)) * 20) / 20;
  return patch;
}

/** Complete settings: `value`'s valid fields over the defaults. */
export function normalizeDanmakuSettings(value, defaults = DANMAKU_DEFAULTS) {
  return { ...defaults, ...danmakuSettingsPatch(value) };
}
