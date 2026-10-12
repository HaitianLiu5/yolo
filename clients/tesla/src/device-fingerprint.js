// Is this the Tesla browser? Only a default guess: the owner names the device
// and picks its type on the approval page
// (Agent Note 2026-10-07-device-code-pairing), and that choice wins.
//
// Since Tesla software 2026.26 the browser's user agent is plain desktop
// Chrome on Linux (no "Tesla", "QtWebEngine" or "QtCarBrowser"), and its
// device pixel ratio went from about 1.0 to about 1.53: the CSS viewport
// shrank to about 773×601 and the screen reads about 1254×784 CSS px (a
// 1920×1200 panel). Drive-In recorded exactly that in our car. So the user
// agent decides for older software, and a weighted score of window and
// screen measurements decides for newer software.
//
// The signals, weights and threshold follow the community fingerprint in
// teodorstavrov/Tesla-Waze-4 (src/lib/browser.ts), reimplemented here.

export const TESLA_USER_AGENT = /Tesla|QtWebEngine|QtCarBrowser/i;

const within = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;

// One row per signal; extend here when another model reports different
// measurements (the `env` device event carries the breakdown).
export const TESLA_SIGNALS = Object.freeze([
  // 2026.26 sets 1.53; Windows scaling gives 1.25, 1.5 or 1.75 exactly.
  { id: "dpr", points: 2, value: (input) => input.devicePixelRatio, test: (dpr) => within(dpr, 1.45, 1.65) },
  { id: "innerWidth", points: 2, value: (input) => input.innerWidth, test: (width) => within(width, 700, 850) },
  { id: "innerHeight", points: 2, value: (input) => input.innerHeight, test: (height) => within(height, 520, 680) },
  { id: "screenWidth", points: 1, value: (input) => input.screenWidth, test: (width) => within(width, 1150, 1400) },
  { id: "screenHeight", points: 1, value: (input) => input.screenHeight, test: (height) => within(height, 700, 870) },
  // The DPR changed in the system, not by the user zooming.
  { id: "viewportScale", points: 1, value: (input) => input.viewportScale ?? 1, test: (scale) => within(scale, 0.95, 1.05) },
  // Tesla's own UI (media, climate) keeps about 38% of the screen's width.
  {
    id: "widthRatio",
    points: 2,
    value: (input) => (input.screenWidth > 0 ? input.innerWidth / input.screenWidth : 0),
    test: (ratio) => within(ratio, 0.55, 0.68),
  },
  // A 16:10 panel; most laptops are 16:9 (1.78).
  {
    id: "screenAspect",
    points: 2,
    value: (input) => (input.screenHeight > 0 ? input.screenWidth / input.screenHeight : 0),
    test: (aspect) => within(aspect, 1.5, 1.68),
  },
  {
    id: "desktopChrome",
    points: 1,
    value: (input) => input.userAgent,
    test: (userAgent) => /Chrome/i.test(userAgent || "") && !/Android|iPhone|iPad|iPod|CriOS/i.test(userAgent || ""),
  },
]);

export const TESLA_MAX_SCORE = TESLA_SIGNALS.reduce((sum, signal) => sum + signal.points, 0);
export const TESLA_SCORE_THRESHOLD = 9;

const round = (value) => (typeof value === "number" ? Math.round(value * 1000) / 1000 : value);

/**
 * @param {{ userAgent?: string, devicePixelRatio?: number, innerWidth?: number, innerHeight?: number,
 *   screenWidth?: number, screenHeight?: number, viewportScale?: number }} input
 * @returns {{ tesla: boolean, by: "user-agent" | "score" | null, score: number, maxScore: number,
 *   threshold: number, signals: Array<{ id: string, points: number, matched: boolean, value: unknown }> }}
 */
export function teslaFingerprint(input) {
  const signals = TESLA_SIGNALS.map((signal) => {
    const value = signal.value(input);
    return { id: signal.id, points: signal.points, matched: Boolean(signal.test(value)), value: signal.id === "desktopChrome" ? undefined : round(value) };
  });
  const score = signals.reduce((sum, signal) => sum + (signal.matched ? signal.points : 0), 0);
  const byUserAgent = TESLA_USER_AGENT.test(input.userAgent || "");
  const byScore = score >= TESLA_SCORE_THRESHOLD;
  return {
    tesla: byUserAgent || byScore,
    by: byUserAgent ? "user-agent" : byScore ? "score" : null,
    score,
    maxScore: TESLA_MAX_SCORE,
    threshold: TESLA_SCORE_THRESHOLD,
    signals,
  };
}

// The measurements, from the page. A display size the page chose
// (display-scale.js) changes the window's CSS size and perhaps its pixel
// ratio: the ones measured before that change describe the browser.
export function readFingerprintInput(win = globalThis) {
  const native = win.__yoloDisplayBoot;
  return {
    userAgent: win.navigator?.userAgent || "",
    devicePixelRatio: Number(native?.devicePixelRatio ?? win.devicePixelRatio) || 1,
    innerWidth: Number(native?.innerWidth ?? win.innerWidth) || 0,
    innerHeight: Number(native?.innerHeight ?? win.innerHeight) || 0,
    screenWidth: Number(win.screen?.width) || 0,
    screenHeight: Number(win.screen?.height) || 0,
    viewportScale: Number(win.visualViewport?.scale) || 1,
  };
}

const BROWSERS = [
  [/Edg\//, "Edge"], [/OPR\//, "Opera"], [/Firefox\/|FxiOS/, "Firefox"], [/CriOS|Chrome\//, "Chrome"], [/Safari\//, "Safari"],
];
const SYSTEMS = [
  [/iPhone/, "iPhone"], [/iPad/, "iPad"], [/Android/, "Android"], [/Mac OS X|Macintosh/, "Mac"], [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"], [/Linux/, "Linux"],
];
const pick = (table, text) => table.find(([pattern]) => pattern.test(text))?.[1] ?? null;

// The name and type this browser suggests for itself (pairing, hello), such
// as "Chrome on Mac" or "Safari on iPhone"; the owner can change both.
export function guessDevice(input) {
  if (teslaFingerprint(input).tesla) return { name: "Tesla", kind: "car" };
  const userAgent = input.userAgent || "";
  const browser = pick(BROWSERS, userAgent);
  const system = pick(SYSTEMS, userAgent);
  const phone = /iPhone|iPod|Android.*Mobile|Mobile.*Android/.test(userAgent);
  const name = browser && system ? `${browser} on ${system}` : browser || system || "Browser";
  return { name, kind: phone ? "phone" : "browser" };
}
