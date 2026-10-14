// Danmaku, timed comments over the picture (Agent Note 2026-10-13-danmaku):
// the shape a source's comments() answer is normalized to.

// One comment as devices and agents get it: `t` in seconds, plain text of at
// most MAX_COMMENT_TEXT characters, a mode, a "#rrggbb" colour, and a size
// relative to the normal one (0.5 to 2). Comments without a usable time or
// text are dropped, and one answer keeps at most MAX_COMMENTS_PER_ANSWER.
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
    comments.push({
      t: Math.round(t * 1000) / 1000,
      text: characters.length > MAX_COMMENT_TEXT ? `${characters.slice(0, MAX_COMMENT_TEXT).join("")}…` : text,
      mode: COMMENT_MODES.has(comment.mode) ? comment.mode : "scroll",
      color,
      size: Number.isFinite(size) && size > 0 ? Math.min(2, Math.max(0.5, Math.round(size * 100) / 100)) : 1,
    });
  }
  return comments.sort((left, right) => left.t - right.t);
}
