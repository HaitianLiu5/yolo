// How one danmaku comment looks (Agent Note 2026-10-13-danmaku), shared by
// the text worker (danmaku-worker.js) and the main-thread fallback
// (danmaku-text.js). No DOM: it runs in a worker.

// The page's own caption fonts (/lib/fonts), then the system's.
export const FONT_FAMILY = "\"Noto Sans SC\", \"Noto Sans\", \"Noto Sans JP\", \"Noto Sans KR\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif";
// Widths are measured at this size and given in ems.
export const REFERENCE_PX = 100;
// Room around the text for its outline, in ems: half on each side.
export const OUTLINE_EM = 0.3;
// A comment's line height, in ems.
export const LINE_EM = 1.25;

export const fontAt = (px) => `${Math.round(px * 10) / 10}px ${FONT_FAMILY}`;

function isDark(color) {
  const value = Number.parseInt(String(color).slice(1), 16);
  if (!Number.isFinite(value)) return false;
  return 0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255) < 60;
}

/**
 * Paints `text` into a 2D context whose canvas is `width` x `height` device
 * pixels: the fill colour with an outline that contrasts with it, so it
 * reads over any picture. `px` is the font size in device pixels.
 */
export function paintComment(context, { text, color = "#ffffff", px, height }) {
  context.font = fontAt(px);
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.lineWidth = Math.max(1.5, px * 0.12);
  context.strokeStyle = isDark(color) ? "rgba(255, 255, 255, 0.85)" : "rgba(0, 0, 0, 0.75)";
  context.fillStyle = color;
  const x = (px * OUTLINE_EM) / 2;
  context.strokeText(text, x, height / 2);
  context.fillText(text, x, height / 2);
}
