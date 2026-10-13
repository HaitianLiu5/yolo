import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium, webkit } from "playwright";

// Browser helpers for the player's end-to-end tests.

const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Chromium for every end-to-end test: PLAYWRIGHT_CHROMIUM_EXECUTABLE, else
// Google Chrome on a Mac, else Playwright's own build.
export const CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(macChrome) ? macChrome : undefined);

// The car's browser as Tesla software 2026.26 reported it (2026-10-12): Chrome
// 148 on Linux, a 773x601 window at devicePixelRatio 1.53 on a 1254x784
// screen, with touch. It is desktop Chrome, so it ignores the viewport meta
// (isMobile: false).
export const CAR_BROWSER = Object.freeze({
  viewport: { width: 773, height: 601 }, screen: { width: 1254, height: 784 }, deviceScaleFactor: 1.53, isMobile: false, hasTouch: true,
});

// `autoplay` "allowed" lets pages play sound without a gesture (most tests);
// "gesture" is Chromium's real policy for a site without media engagement,
// as a car's browser may apply it. `context` overrides the browser context's
// options (CAR_BROWSER for the car's window); `args` adds Chromium switches. `engine: "webkit"` opens
// Playwright's WebKit instead, Safari's engine (PLAYWRIGHT_WEBKIT_EXECUTABLE
// names a WebKit build when the installed one is not Playwright's own); it
// keeps WebKit's own autoplay policy.
export async function launchBrowser(t, { autoplay = "allowed", context = {}, engine = "chromium", args = [] } = {}) {
  const browser = engine === "webkit"
    ? await webkit.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE || undefined })
    : await chromium.launch({
      headless: true,
      executablePath: CHROMIUM_EXECUTABLE,
      args: [`--autoplay-policy=${autoplay === "gesture" ? "document-user-activation-required" : "no-user-gesture-required"}`, ...args],
    });
  t.after(() => browser.close());
  return browser.newContext({ viewport: { width: 1280, height: 720 }, ...context });
}

// `onPage` runs before the page loads (to listen for its first messages).
// Mind that every Playwright call into the page (evaluate, waitForFunction,
// waitForSelector, locators) gives it a user activation, which unlocks
// sound: watch console messages instead until autoplay has happened.
export async function openPage(context, origin, { onPage = null } = {}) {
  const page = await context.newPage();
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const before = onPage?.(page);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  return { page, errors, before };
}

export const autoplayMessage = (page, timeout = 45_000) => page.waitForEvent("console", {
  predicate: (message) => message.text().startsWith("[player] Autoplay: "),
  timeout,
}).then((message) => message.text().slice("[player] Autoplay: ".length));

// Pair the page as the owner would: read the code it shows, press Allow.
// `fields` are the approval page's name and type (`{ kind: "car" }` for the
// car's profile).
export async function pair(yolo, page, fields = {}) {
  await page.waitForFunction(
    () => /^[B-Z]{4}-[B-Z]{4}$/.test(document.getElementById("pair-code")?.textContent || "")
      && !document.getElementById("pair-screen").classList.contains("hidden"),
    null,
    { timeout: 20_000 },
  );
  const approved = await yolo.approve(await page.locator("#pair-code").innerText(), "approve", fields);
  assert.equal(approved.status, 200, approved.text);
  await page.waitForFunction(() => Boolean(globalThis.__yolo?.state?.deviceId), null, { timeout: 20_000 });
  if (fields.kind) await page.waitForFunction((kind) => globalThis.__yolo.profile.kind === kind, fields.kind, { timeout: 20_000 });
  return page.evaluate(() => JSON.parse(localStorage.getItem("yolo.device")));
}

// The playing engine, either one (globalThis.__yoloPlayer: { player, engine }).
export async function playerDiagnostics(page) {
  return page.evaluate(() => ({
    status: document.getElementById("status-text")?.textContent,
    engine: globalThis.__yoloPlayer?.engine ?? null,
    player: globalThis.__yoloPlayer?.player?.getStatus?.() ?? null,
    time: globalThis.__yoloPlayer?.player?.getCurrentTime?.() ?? null,
    log: (globalThis.__yoloPlayerLog || []).slice(-12).map((entry) => `${entry.type} ${entry.error || entry.code || entry.state || entry.result || ""}`),
  }));
}

export async function waitFor(page, predicate, arg, label, timeout = 30_000) {
  try {
    await page.waitForFunction(predicate, arg, { timeout });
  } catch (error) {
    throw new Error(`${label}: ${error.message}\n${JSON.stringify(await playerDiagnostics(page), null, 2)}`);
  }
}

export const playingPast = (page, seconds, label, timeout) => waitFor(page, (min) => {
  const player = globalThis.__yoloPlayer?.player;
  return player?.getStatus() === "playing" && player.getStats()?.videoFrameRenderCount > 0 && player.getCurrentTime() > min;
}, seconds, label, timeout);

export async function eventually(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

// Device events of one type as wrangler dev printed them (Workers Logs in
// production): one top-level object each, over several lines.
export function deviceEvents(yolo, type) {
  return yolo.workerLog()
    .split(/\n(?=\{)/)
    .filter((chunk) => chunk.includes("kind: 'device_event'") && chunk.includes(`type: '${type}'`));
}
