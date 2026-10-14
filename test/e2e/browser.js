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

// A seek whose new stream's `load` the realtime connection loses. Yolo
// builds a new stream for a seek before where the playing one starts (a
// transcode that started part way); here the playing stream is made to say
// it starts at `streamStart`, and `seek(seekTo)` (an agent's seek) goes
// before it. The page's realtime socket runs through the test, which
// swallows that stream's `load`, as a connection that died while Yolo
// prepared the stream. `connection` "closed" then closes the socket on both
// sides, and the page reconnects at once; "silent" passes nothing more
// either way, as a socket that died without the page noticing, which the
// page replaces only once it finds out. Returns the session whose `load` was
// lost, the session the page played before, whether the progress bar showed
// the seek then, and the sessions each welcome through the test named (the
// first one before the seek).
export async function loseSeekLoad(page, { seek, seekTo, streamStart, connection = "closed" }) {
  let armed = false;
  let lost = null;
  const welcomes = [];
  await page.routeWebSocket(/\/v1\/realtime/, (ws) => {
    const server = ws.connectToServer();
    let silent = false;
    ws.onMessage((data) => {
      if (!silent) server.send(data);
    });
    server.onMessage((data) => {
      if (silent) return;
      let message = null;
      try {
        message = JSON.parse(String(data));
      } catch {
        // The heartbeat's answer.
      }
      if (armed && message?.type === "load" && message.reason === "seek") {
        armed = false;
        lost = message.stream?.sessionId ?? "unknown";
        if (connection === "silent") {
          silent = true;
        } else {
          void ws.close({ code: 1001, reason: "e2e: connection lost" }).catch(() => {});
          void server.close({ code: 1001, reason: "e2e: connection lost" }).catch(() => {});
        }
        return;
      }
      if (message?.type === "welcome") welcomes.push(message.state?.sessionId ?? null);
      ws.send(data);
    });
  });
  // The connection the page opened before the route: a new one runs through it.
  await page.evaluate(() => globalThis.__yolo.realtime.reconnect());
  await eventually(() => welcomes.length > 0, "the realtime connection through the test", 20_000);
  await page.evaluate((start) => {
    const player = globalThis.__yoloPlayer.player;
    player.getSeekableRange = () => ({ start, end: globalThis.__yolo.state.duration || null });
  }, streamStart);
  const replaced = await page.evaluate(() => globalThis.__yolo.state.sessionId);
  armed = true;
  await seek(seekTo);
  await eventually(() => lost, "the seek's new stream, its load lost", 60_000);
  const seeking = await page.evaluate(() => document.getElementById("progress-wrap").classList.contains("seeking"));
  return { replaced, lost, seeking, welcomes };
}

// The seek to `target` played: its stream is the one Yolo has for this
// screen, it plays past the target, and the progress bar no longer shows a
// seek. Throws with what the page shows after `timeout`.
export async function seekPlayed(page, target, label, timeout = 30_000) {
  try {
    await page.waitForFunction((at) => {
      const player = globalThis.__yoloPlayer?.player;
      const { state } = globalThis.__yolo;
      return player?.getStatus() === "playing" && player.getStats()?.videoFrameRenderCount > 0
        && player.getCurrentTime() > at + 0.5 && player.getCurrentTime() < at + 30
        && state.sessionId && state.sessionId === state.hub?.sessionId
        && !document.getElementById("progress-wrap").classList.contains("seeking");
    }, target, { timeout });
  } catch (error) {
    const screen = await page.evaluate(() => ({
      sessionId: globalThis.__yolo.state.sessionId,
      hubSessionId: globalThis.__yolo.state.hub?.sessionId ?? null,
      hubStatus: globalThis.__yolo.state.hub?.status ?? null,
      seeking: document.getElementById("progress-wrap").classList.contains("seeking"),
      controls: document.getElementById("app").classList.contains("controls-visible"),
    }));
    throw new Error(`${label}: ${error.message}\n${JSON.stringify({ ...screen, ...await playerDiagnostics(page) }, null, 2)}`);
  }
}

// A stall on the stream a seek built. Yolo builds a new stream for a seek the
// playing one cannot do itself (as for a transcode that started at an
// offset); this asks for one at `startTime` of a dash_split item, whose
// video fragments are a second each, and holds the fragments from
// `holdFrom` seconds on until the new player, its seek done, stalls.
// Returns what the progress bar and the spinner showed at the stall, and
// once playback went on past `holdFrom`.
export async function stallOnSeekStream(page, yolo, { token, deviceId, source, startTime = 4, holdFrom = 9 }) {
  let release;
  const released = new Promise((done) => { release = done; });
  await page.route(/\/m\/[^/]+\/dash\/video\/\d+\.m4s$/, async (route) => {
    if (Number(/(\d+)\.m4s$/.exec(route.request().url())[1]) >= holdFrom) await released;
    await route.continue().catch(() => {});
  });
  try {
    await page.evaluate(() => { globalThis.__yoloPlayer.player.e2eReplaced = true; });
    const sessionId = await page.evaluate(() => globalThis.__yolo.state.sessionId);
    const seek = await yolo.api(token, "/v1/playback/play", {
      method: "POST",
      body: { source, startTime, reason: "seek", sessionId, deviceId },
    });
    assert.equal(seek.status, 200, JSON.stringify(seek.body));
    await waitFor(page, () => {
      const player = globalThis.__yoloPlayer?.player;
      return player && !player.e2eReplaced && player.getStats()?.videoFrameRenderCount > 0
        && !document.querySelector(".playback-transition-frame")
        && !document.getElementById("progress-wrap").classList.contains("seeking");
    }, null, "the seek done: the new stream's first picture");
    // Each read is in one turn with the engine's state, since the player's
    // callbacks run inside the change: a short stall may be over by a
    // second read.
    const screenWhen = async (label, predicate, arg) => {
      try {
        return await (await page.waitForFunction(predicate, arg, { timeout: 30_000 })).jsonValue();
      } catch (error) {
        throw new Error(`${label}: ${error.message}\n${JSON.stringify(await playerDiagnostics(page), null, 2)}`);
      }
    };
    const stall = await screenWhen("the stall", () => globalThis.__yoloPlayer.player.getStatus() === "buffering" && {
      seeking: document.getElementById("progress-wrap").classList.contains("seeking"),
      spinner: document.getElementById("center-loading").classList.contains("buffering"),
    });
    release();
    const playing = await screenWhen("playing on after the stall", (past) => {
      const player = globalThis.__yoloPlayer.player;
      return player.getStatus() === "playing" && player.getCurrentTime() > past && {
        seeking: document.getElementById("progress-wrap").classList.contains("seeking"),
        spinner: document.getElementById("center-loading").classList.contains("buffering"),
      };
    }, holdFrom + 1);
    return { stall, playing };
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
}

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
// production): one top-level object each, over several lines. `deviceId`
// keeps one device's, where several screens share the stack.
export function deviceEvents(yolo, type, deviceId = null) {
  return yolo.workerLog()
    .split(/\n(?=\{)/)
    .filter((chunk) => chunk.includes("kind: 'device_event'") && chunk.includes(`type: '${type}'`)
      && (!deviceId || chunk.includes(`deviceId: '${deviceId}'`)));
}
