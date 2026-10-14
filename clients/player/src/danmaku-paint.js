// How one danmaku comment looks (Agent Note 2026-10-13-danmaku), shared by
// the text worker (danmaku-worker.js) and the main-thread fallback
// (danmaku-text.js). No DOM: it runs in a worker.

// The page's own caption fonts (/lib/fonts), then the system's.
export const FONT_FAMILY = "\"Noto Sans SC\", \"Noto Sans\", \"Noto Sans JP\", \"Noto Sans KR\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif";
// Widths are measured at this size and given in ems.
export const REFERENCE_PX = 100;
// Room around the text for its outline, in ems: half on each side.
export const OUTLINE_EM = 0.3;
// The outline's width, in ems (half of it lies outside the glyphs).
const STROKE_EM = 0.12;
// Space between two lanes' outlines, in ems.
const LANE_GAP_EM = 0.08;
// Text whose ink spans the font's tallest and deepest common glyphs: a CJK
// ideograph, Latin capitals, and descenders.
export const LINE_PROBE = "国Hgjy";
// Until the fonts have been measured: Noto Sans SC's ink, in ems.
export const DEFAULT_METRICS = Object.freeze({ ascent: 0.88, descent: 0.24 });

/** A lane's height in ems: the probe's ink, its outline, and the gap. */
export const lineEm = (metrics) => metrics.ascent + metrics.descent + STROKE_EM + LANE_GAP_EM;

export const fontAt = (px) => `${Math.round(px * 10) / 10}px ${FONT_FAMILY}`;

function isDark(color) {
  const value = Number.parseInt(String(color).slice(1), 16);
  if (!Number.isFinite(value)) return false;
  return 0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255) < 60;
}

/**
 * Paints `text` into a 2D context whose canvas is `width` x `height` device
 * pixels: the fill colour with an outline that contrasts with it, so it
 * reads over any picture, its ink centred in the height (`metrics`, ems).
 * `px` is the font size in device pixels. Nothing is drawn outside the
 * canvas, so a comment never reaches into the next lane.
 */
export function paintComment(context, { text, color = "#ffffff", px, height, metrics = DEFAULT_METRICS }) {
  context.font = fontAt(px);
  context.textBaseline = "alphabetic";
  context.lineJoin = "round";
  context.lineWidth = Math.max(1.5, px * STROKE_EM);
  context.strokeStyle = isDark(color) ? "rgba(255, 255, 255, 0.85)" : "rgba(0, 0, 0, 0.75)";
  context.fillStyle = color;
  const x = (px * OUTLINE_EM) / 2;
  const baseline = height / 2 + ((metrics.ascent - metrics.descent) * px) / 2;
  context.strokeText(text, x, baseline);
  context.fillText(text, x, baseline);
}

/** The probe's ink above and below the baseline, in ems, from a 2D context at `REFERENCE_PX`. */
export function measureLine(context) {
  context.font = fontAt(REFERENCE_PX);
  const measured = context.measureText(LINE_PROBE);
  const ascent = measured.actualBoundingBoxAscent / REFERENCE_PX;
  const descent = measured.actualBoundingBoxDescent / REFERENCE_PX;
  return ascent > 0 && descent >= 0 ? { ascent, descent } : DEFAULT_METRICS;
}
