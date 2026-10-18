// How one danmaku comment looks (Agent Note 2026-10-13-danmaku), shared by
// the text worker (danmaku-worker.js) and the main-thread fallback
// (danmaku-text.js). No DOM: it runs in a worker.
//
// The look is Bilibili's web player's default, read from its code on
// 2026-10-14 and its screen on 2026-10-18: bold white or coloured text with
// its default outline style (fontborder 0, "重墨"), four solid black
// text-shadows, each 1 CSS pixel to one side with a 1 pixel blur, white for
// black text. Together they make a dark edge about two pixels wide that
// fades out, which reads on a light picture where a thin stroke turns grey.

// The page's own caption fonts (/lib/fonts), then the system's.
export const FONT_FAMILY = "\"Noto Sans SC\", \"Noto Sans\", \"Noto Sans JP\", \"Noto Sans KR\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif";
// Widths are measured at this size and given in ems.
export const REFERENCE_PX = 100;
// The shadows' offset and blur, in CSS pixels: the outline a lane makes room
// for on each side.
export const OUTLINE_PX = 1;
// Space between two lanes' outlines, in CSS pixels (Bilibili stacks a
// comment 1 px under the one above).
export const LANE_GAP_PX = 1;
// Text whose ink spans the font's tallest and deepest common glyphs: a CJK
// ideograph, Latin capitals, and descenders.
export const LINE_PROBE = "国Hgjy";
// Until the fonts have been measured: Noto Sans SC's ink, in ems, as
// Chrome measures it (0.795 and 0.25).
export const DEFAULT_METRICS = Object.freeze({ ascent: 0.8, descent: 0.25 });

/** The probe's ink in ems: the part of a lane the text itself takes. */
export const inkEm = (metrics) => metrics.ascent + metrics.descent;

/** A lane's height in CSS pixels at `fontPx`: the ink, its outline, and the gap. */
export const lanePx = (metrics, fontPx) => inkEm(metrics) * fontPx + 2 * OUTLINE_PX + LANE_GAP_PX;

export const fontAt = (px) => `700 ${Math.round(px * 10) / 10}px ${FONT_FAMILY}`;

// The four shadows' directions, in outlines.
const EDGE_OFFSETS = [[1, 0], [0, 1], [0, -1], [-1, 0]];

function isDark(color) {
  const value = Number.parseInt(String(color).slice(1), 16);
  if (!Number.isFinite(value)) return false;
  return 0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255) < 60;
}

/**
 * Paints `text` into a 2D context whose canvas is `width` x `height` device
 * pixels: the fill colour with an edge that contrasts with it, so it reads
 * over any picture, its ink centred in the height (`metrics`, ems).
 * `px` is the font size and `outline` the shadows' offset and blur, both
 * in device pixels. Nothing is drawn outside the canvas, so a comment never
 * reaches into the next lane.
 */
export function paintComment(context, { text, color = "#ffffff", px, height, outline = OUTLINE_PX, metrics = DEFAULT_METRICS }) {
  context.font = fontAt(px);
  context.textBaseline = "alphabetic";
  context.fillStyle = color;
  const x = outline;
  const baseline = height / 2 + ((metrics.ascent - metrics.descent) * px) / 2;
  // A canvas shadow's blur, like a CSS one's, is twice the Gaussian's sigma,
  // and both are in device pixels here.
  context.shadowColor = isDark(color) ? "#ffffff" : "#000000";
  context.shadowBlur = outline;
  for (const [dx, dy] of EDGE_OFFSETS) {
    context.shadowOffsetX = dx * outline;
    context.shadowOffsetY = dy * outline;
    context.fillText(text, x, baseline);
  }
  context.shadowColor = "transparent";
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
