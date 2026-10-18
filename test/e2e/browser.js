import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium, webkit } from "playwright";

// Browser helpers for the player's end-to-end tests.

const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// PLAYWRIGHT_CHROMIUM_EXECUTABLE, else Google Chrome on a Mac, else Playwright's own build.
export const CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(macChrome) ? macChrome : undefined);

// The car's browser as Tesla software 2026.26 reported it: Chrome 148 on
// Linux, a 773x601 window at devicePixelRatio 1.53, with touch. It is desktop
// Chrome, so it ignores the viewport meta (isMobile: false).
export const CAR_BROWSER = Object.freeze({
  viewport: { width: 773, height: 601 }, screen: { width: 1254, height: 784 }, deviceScaleFactor: 1.53, isMobile: false, hasTouch: true,
});

// `autoplay` "gesture" is Chromium's real policy for a site without media
// engagement; `engine: "webkit"` opens Playwright's WebKit (Safari's engine).
// Everything is local: Chromium on Linux would otherwise take a proxy from the environment.
export async function launchBrowser(t, { autoplay = "allowed", context = {}, engine = "chromium", args = [] } = {}) {
  const browser = engine === "webkit"
    ? await webkit.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE || undefined })
    : await chromium.launch({
      headless: true,
      executablePath: CHROMIUM_EXECUTABLE,
      args: [`--autoplay-policy=${autoplay === "gesture" ? "document-user-activation-required" : "no-user-gesture-required"}`, "--no-proxy-server", ...args],
    });
  t.after(() => browser.close());
  return browser.newContext({ viewport: { width: 1280, height: 720 }, ...context });
}

// `onPage` runs before the page loads. Every Playwright call into the page
// gives it a user activation, which unlocks sound: watch console messages
// instead until autoplay has happened.
export async function openPage(context, origin, { onPage = null } = {}) {
  const page = await context.newPage();
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

export const pairCodeShown = (page) => page.waitForFunction(
  () => /^[B-Z]{4}-[B-Z]{4}$/.test(document.getElementById("pair-code")?.textContent || "")
    && !document.getElementById("pair-screen").classList.contains("hidden"),
  null,
  { timeout: 20_000 },
);

// Pair the page as the owner would: read the code it shows, press Allow.
// `fields` are the approval page's name and type (`{ kind: "car" }`).
export async function pair(yolo, page, fields = {}) {
  await pairCodeShown(page);
  const approved = await yolo.approve(await page.locator("#pair-code").innerText(), "approve", fields);
  assert.equal(approved.status, 200, approved.text);
  await page.waitForFunction(() => Boolean(globalThis.__yolo?.state?.deviceId), null, { timeout: 20_000 });
  if (fields.kind) await page.waitForFunction((kind) => globalThis.__yolo.profile.kind === kind, fields.kind, { timeout: 20_000 });
  return page.evaluate(() => JSON.parse(localStorage.getItem("yolo.device")));
}

export async function waitFor(page, predicate, arg, label, timeout = 30_000) {
  try {
    await page.waitForFunction(predicate, arg, { timeout });
  } catch (error) {
    const seen = await page.evaluate(() => ({
      status: document.getElementById("status-text")?.textContent,
      engine: globalThis.__yoloPlayer?.engine ?? null,
      player: globalThis.__yoloPlayer?.player?.getStatus?.() ?? null,
      time: globalThis.__yoloPlayer?.player?.getCurrentTime?.() ?? null,
      log: (globalThis.__yoloPlayerLog || []).slice(-12).map((entry) => `${entry.type} ${entry.error || entry.code || entry.state || entry.result || ""}`),
    })).catch(() => null);
    throw new Error(`${label}: ${error.message}\n${JSON.stringify(seen, null, 2)}`);
  }
}

// Playing, with a picture, past `seconds`.
export const playingPast = (page, seconds, label, timeout) => waitFor(page, (min) => {
  const player = globalThis.__yoloPlayer?.player;
  return player?.getStatus() === "playing" && player.getStats()?.videoFrameRenderCount > 0 && player.getCurrentTime() > min;
}, seconds, label, timeout);

export const statusIs = (page, status, label) => waitFor(page, (wanted) => globalThis.__yoloPlayer?.player?.getStatus() === wanted, status, label);

export async function eventually(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

// The first message from the Hub that `lose(message)` picks after `send()`
// starts is swallowed, and the realtime connection closes with it, as one
// that died while Yolo sent it. Returns the sessions each welcome named
// (the first one before `send()`); it keeps growing after the reconnect.
export async function loseHubMessage(page, { lose, send }) {
  let armed = false;
  const welcomes = [];
  await page.routeWebSocket(/\/v1\/realtime/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((data) => server.send(data));
    server.onMessage((data) => {
      let message = null;
      try {
        message = JSON.parse(String(data));
      } catch {
        // The heartbeat's answer.
      }
      if (armed && message && lose(message)) {
        armed = false;
        void ws.close({ code: 1001, reason: "e2e: connection lost" }).catch(() => {});
        void server.close({ code: 1001, reason: "e2e: connection lost" }).catch(() => {});
        return;
      }
      if (message?.type === "welcome") welcomes.push(message.state?.sessionId ?? null);
      ws.send(data);
    });
  });
  // The connection the page opened before the route: a new one runs through it.
  await page.evaluate(() => globalThis.__yolo.realtime.reconnect());
  await eventually(() => welcomes.length > 0, "the realtime connection through the test", 20_000);
  armed = true;
  await send();
  await eventually(() => !armed, "the message, lost", 60_000);
  return welcomes;
}

// Device events of one type as wrangler dev printed them (Workers Logs in
// production), for one device.
export const deviceEvents = (yolo, type, deviceId) => yolo.workerLog()
  .split(/\n(?=\{)/)
  .filter((chunk) => chunk.includes("kind: 'device_event'") && chunk.includes(`type: '${type}'`) && chunk.includes(`deviceId: '${deviceId}'`));
