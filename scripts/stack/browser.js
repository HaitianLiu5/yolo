import { existsSync } from "node:fs";
import { chromium, webkit } from "playwright";

// Browsers for walking the player's paths on the local stack
// (.agents/skills/yolo-acceptance/SKILL.md). An agent's own script imports
// these; nothing here asserts.

const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// PLAYWRIGHT_CHROMIUM_EXECUTABLE, else Google Chrome on a Mac, else
// Playwright's own build, which cannot decode H.264 and so cannot play the
// car's streams.
export const CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(macChrome) ? macChrome : undefined);

// The car's browser as Tesla software 2026.26 reported it: Chrome 148 on
// Linux, a 773x601 window at devicePixelRatio 1.53, with touch. It is desktop
// Chrome, so it ignores the viewport meta (isMobile: false). Pair it as a car
// (`npm run stack -- approve <code> car`) for car mode.
export const CAR_BROWSER = Object.freeze({
  viewport: { width: 773, height: 601 }, screen: { width: 1254, height: 784 }, deviceScaleFactor: 1.53, isMobile: false, hasTouch: true,
});

export const PHONE_BROWSER = Object.freeze({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36",
});

/**
 * A browser context. `engine: "webkit"` is Playwright's WebKit, Safari's
 * engine; `autoplay: "gesture"` is Chromium's real policy for a new site.
 * Close the returned browser when done.
 */
export async function launch({ engine = "chromium", headless = true, autoplay = "allowed", context = {} } = {}) {
  const browser = engine === "webkit"
    ? await webkit.launch({ headless, executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE || undefined })
    : await chromium.launch({
      headless,
      executablePath: CHROMIUM_EXECUTABLE,
      args: [`--autoplay-policy=${autoplay === "gesture" ? "document-user-activation-required" : "no-user-gesture-required"}`, "--no-proxy-server"],
    });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...context });
  return { browser, context: ctx };
}

/** The pairing code a fresh player page shows, once it shows one. */
export async function pairCode(page) {
  await page.waitForFunction(
    () => /^[B-Z]{4}-[B-Z]{4}$/.test(document.getElementById("pair-code")?.textContent || "")
      && !document.getElementById("pair-screen").classList.contains("hidden"),
    null,
    { timeout: 20_000 },
  );
  return page.locator("#pair-code").innerText();
}

/** What the player says about itself: its mode, device, and playback. */
export function playerState(page) {
  return page.evaluate(() => ({
    mode: globalThis.__yolo?.mode?.kind ?? null,
    deviceId: globalThis.__yolo?.state?.deviceId ?? null,
    status: globalThis.__yoloPlayer?.player?.getStatus?.() ?? null,
    engine: globalThis.__yoloPlayer?.engine ?? null,
    position: globalThis.__yoloPlayer?.player?.getCurrentTime?.() ?? null,
    framesDrawn: globalThis.__yoloPlayer?.player?.getStats?.()?.videoFrameRenderCount ?? null,
  }));
}
