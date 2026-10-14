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

// A `load` the realtime connection loses. The Hub sends each `load` once,
// over the connection it has then. The page's realtime socket runs through
// the test, which swallows the first `load` with `reason` after `send()`,
// as a connection that died while Yolo prepared the stream. `connection`
// "closed" then closes the socket on both sides, and the page reconnects at
// once; "silent" passes nothing more either way, as a socket that died
// without the page noticing, which the page replaces only once it finds
// out; "open" passes everything else, as a `load` Yolo sent to a connection
// the page had left while its new one, welcomed a moment before, goes on.
// `before()` runs once the socket goes through the test, before
// `send()`. Returns the session whose `load` was lost, the session the page
// played before, and the sessions each welcome through the test named (the
// first one before `send()`).
export async function loseLoad(page, { reason, send, before = null, connection = "closed" }) {
  const seen = await loseMessage(page, {
    label: `the ${reason} load`,
    lose: (message, from) => from === "hub" && message.type === "load" && message.reason === reason,
    send,
    before,
    connection,
  });
  return { ...seen, lost: seen.lost.stream?.sessionId ?? "unknown" };
}

// Any single message the realtime connection loses, either way, as
// loseLoad does with a `load`: `lose(message, from)` picks the first one
// after `send()` starts, `from` "hub" for what Yolo's Hub sends the page
// (a `pause`, a `tracks`, a `danmaku`) and "page" for what the page sends
// (an `ended`, a `report`). Returns that message, the session the page
// played before, and the sessions each welcome through the test named (the
// first one before `send()`); `welcomes` keeps growing after it returns.
export async function loseMessage(page, { lose, send, before = null, connection = "closed", label = "the message" }) {
  let armed = false;
  let lost = null;
  const welcomes = [];
  await page.routeWebSocket(/\/v1\/realtime/, (ws) => {
    const server = ws.connectToServer();
    let silent = false;
    // The message is swallowed, then the connection dies as `connection` says.
    const swallowed = (message) => {
      if (!armed || !message || !lose(message.parsed, message.from)) return false;
      armed = false;
      lost = message.parsed;
      if (connection === "silent") {
        silent = true;
      } else if (connection === "closed") {
        void ws.close({ code: 1001, reason: "e2e: connection lost" }).catch(() => {});
        void server.close({ code: 1001, reason: "e2e: connection lost" }).catch(() => {});
      }
      return true;
    };
    const parse = (data, from) => {
      try {
        const parsed = JSON.parse(String(data));
        return parsed && typeof parsed === "object" ? { parsed, from } : null;
      } catch {
        // The heartbeat and its answer.
        return null;
      }
    };
    ws.onMessage((data) => {
      if (silent || swallowed(parse(data, "page"))) return;
      server.send(data);
    });
    server.onMessage((data) => {
      if (silent) return;
      const message = parse(data, "hub");
      if (swallowed(message)) return;
      if (message?.parsed.type === "welcome") welcomes.push(message.parsed.state?.sessionId ?? null);
      ws.send(data);
    });
  });
  // The connection the page opened before the route: a new one runs through it.
  await page.evaluate(() => globalThis.__yolo.realtime.reconnect());
  await eventually(() => welcomes.length > 0, "the realtime connection through the test", 20_000);
  await before?.();
  const replaced = await page.evaluate(() => globalThis.__yolo.state.sessionId);
  armed = true;
  await send();
  await eventually(() => lost, `${label}, lost`, 60_000);
  return { replaced, lost, welcomes };
}

// A seek whose new stream's `load` the realtime connection loses
// (loseLoad). Yolo builds a new stream for a seek before where the playing
// one starts (a transcode that started part way); here the playing stream
// is made to say it starts at `streamStart`, and `seek(seekTo)` (an agent's
// seek) goes before it. Also returns whether the progress bar showed the
// seek once the `load` was lost.
export async function loseSeekLoad(page, { seek, seekTo, streamStart, connection = "closed" }) {
  const seen = await loseLoad(page, {
    reason: "seek",
    connection,
    before: () => page.evaluate((start) => {
      const player = globalThis.__yoloPlayer.player;
      player.getSeekableRange = () => ({ start, end: globalThis.__yolo.state.duration || null });
    }, streamStart),
    send: () => seek(seekTo),
  });
  const seeking = await page.evaluate(() => document.getElementById("progress-wrap").classList.contains("seeking"));
  return { ...seen, seeking };
}

// Two seeks, the second while the stream the first asked for is on its way.
// As in loseSeekLoad, the playing stream is made to say it starts at
// `streamStart`, so `seek(first)` asks Yolo for a new stream. The test holds
// that stream's `load` until Yolo has built it and the page has done
// everything it does for `seek(second)`: a request sent for the second seek
// then reaches the Hub after the first one's stream won, the race the second
// seek lost on main. Returns the session the first seek's stream has, and
// the first new stream to play: its session, and where it was then.
export async function seekDuringSeek(page, { seek, first, second, streamStart }) {
  const before = await page.evaluate(() => globalThis.__yolo.state.sessionId);
  let held = null;
  let release;
  const released = new Promise((done) => { release = done; });
  await page.routeWebSocket(/\/v1\/realtime/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((data) => server.send(data));
    server.onMessage(async (data) => {
      let message = null;
      try {
        message = JSON.parse(String(data));
      } catch {
        // The heartbeat's answer.
      }
      if (message?.type === "load" && message.reason === "seek" && !held) {
        held = message.stream?.sessionId ?? "unknown";
        await released;
      }
      ws.send(data);
    });
  });
  const plays = new Set();
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/playback/play")) plays.add(request);
  });
  const settled = (request) => plays.delete(request);
  page.on("requestfinished", settled);
  page.on("requestfailed", settled);
  try {
    await page.evaluate(() => globalThis.__yolo.realtime.reconnect());
    await page.waitForFunction(() => globalThis.__yolo.realtime.ready, null, { timeout: 20_000 });
    await page.evaluate((start) => {
      const player = globalThis.__yoloPlayer.player;
      player.getSeekableRange = () => ({ start, end: globalThis.__yolo.state.duration || null });
    }, streamStart);
    await seek(first);
    await eventually(() => held, "the first seek's stream, its load held", 60_000);
    await eventually(() => plays.size === 0, "the first seek's request answered", 60_000);
    await seek(second);
    await page.waitForFunction((at) => Math.abs(globalThis.__yolo.state.currentTime - at) < 0.01, second, { timeout: 10_000 });
    // A request the page sent for it is answered (on main, superseded).
    await new Promise((done) => setTimeout(done, 500));
    await eventually(() => plays.size === 0, "the second seek's request answered", 60_000);
  } finally {
    release();
  }
  const played = await (await page.waitForFunction((old) => {
    const player = globalThis.__yoloPlayer?.player;
    const { sessionId } = globalThis.__yolo.state;
    return sessionId !== old && player?.getStatus() === "playing" && player.getStats()?.videoFrameRenderCount > 0
      && { sessionId, at: player.getCurrentTime() };
  }, before, { timeout: 30_000 })).jsonValue();
  return { held, played };
}

// A seek while the stream an earlier seek asked for loads. As in
// seekDuringSeek, the playing stream is made to say it starts at
// `streamStart`: `first` asks Yolo for a stream there. `second`, if given,
// sent while that stream's `load` is held and before where it starts, moves
// the target, so the stream starts at `first` and was to seek back to
// `second` once loaded. While the stream loads (its media held), `third`
// asks for a stream of its own, whose `load` is held until the first one's
// stream has loaded (and shown its first picture, if it does). `after`, if
// given, is a seek sent then, before the third one's `load` comes. Returns
// the sessions of the two streams, and the lowest position the screen
// showed from the last seek on (lowestShown(): the progress bar's, and any
// later stream's).
export async function seekWhileSeekStreamLoads(page, { seek, first, second = null, third, after = null, streamStart }) {
  const before = await page.evaluate(() => globalThis.__yolo.state.sessionId);
  const held = [];
  await page.routeWebSocket(/\/v1\/realtime/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((data) => server.send(data));
    server.onMessage(async (data) => {
      let message = null;
      try {
        message = JSON.parse(String(data));
      } catch {
        // The heartbeat's answer.
      }
      if (message?.type === "load" && message.reason === "seek") {
        let release;
        const released = new Promise((done) => { release = done; });
        held.push({ sessionId: message.stream?.sessionId ?? "unknown", release });
        await released;
      }
      ws.send(data);
    });
  });
  let media = null;
  await page.route(/\/m\//, async (route) => {
    if (media) await media.held;
    await route.continue().catch(() => {});
  });
  try {
    await page.evaluate(() => globalThis.__yolo.realtime.reconnect());
    await page.waitForFunction(() => globalThis.__yolo.realtime.ready, null, { timeout: 20_000 });
    await page.evaluate((start) => {
      const player = globalThis.__yoloPlayer.player;
      player.getSeekableRange = () => ({ start, end: globalThis.__yolo.state.duration || null });
      player.e2eBefore = true;
    }, streamStart);
    const shown = (at) => page.waitForFunction((target) => Math.abs(globalThis.__yolo.state.currentTime - target) < 0.01, at, { timeout: 10_000 });
    // From the last seek on, the lowest position on the progress bar and
    // in any stream after the first seek's.
    const sampleFrom = (old) => page.evaluate((sessions) => {
      globalThis.__e2eLowest = Infinity;
      globalThis.__e2eSampler ??= setInterval(() => {
        const { state } = globalThis.__yolo;
        globalThis.__e2eLowest = Math.min(globalThis.__e2eLowest, state.currentTime);
        const player = globalThis.__yoloPlayer?.player;
        if (!player || globalThis.__e2eOld.includes(state.sessionId) || player.getStatus() !== "playing") return;
        if (player.getStats()?.videoFrameRenderCount > 0) globalThis.__e2eLowest = Math.min(globalThis.__e2eLowest, player.getCurrentTime());
      }, 20);
      globalThis.__e2eOld = sessions;
    }, old);
    await seek(first);
    await eventually(() => held.length === 1, "the first seek's stream, its load held", 60_000);
    if (second != null) {
      await seek(second);
      await shown(second);
    }
    let release;
    media = { held: new Promise((done) => { release = done; }), release };
    held[0].release();
    await waitFor(page, () => {
      const player = globalThis.__yoloPlayer?.player;
      return player && !player.e2eBefore && globalThis.__yolo.state.player === player;
    }, null, "the first seek's stream loading");
    await seek(third);
    await shown(third);
    await sampleFrom([before, held[0].sessionId]);
    await eventually(() => held.length === 2, "the third seek's stream, its load held", 60_000);
    media.release();
    media = null;
    // Loaded: its first picture, when it shows one, or a moment.
    await page.waitForFunction(() => {
      const player = globalThis.__yoloPlayer?.player;
      return player && !player.e2eBefore && player.getStats()?.videoFrameRenderCount > 0;
    }, null, { timeout: 3_000 }).catch(() => {});
    await new Promise((done) => setTimeout(done, 1_000));
    if (after != null) {
      await seek(after);
      await shown(after);
      await sampleFrom([before, held[0].sessionId]);
    }
    held[1].release();
    return { first: held[0].sessionId, third: held[1].sessionId, lowestShown: () => page.evaluate(() => globalThis.__e2eLowest) };
  } finally {
    media?.release();
    for (const entry of held) entry.release();
  }
}

// What the player asks for on its own for a quality change
// (player.js requestQualityChange): a stream of the same item capped at
// `maxVideoKbps`, from where it plays now, in place of the one it plays.
// Returns the position it was asked at.
export async function askForQuality(yolo, page, credential, maxVideoKbps) {
  const { sessionId, source, at } = await page.evaluate(() => ({
    sessionId: globalThis.__yolo.state.sessionId, source: globalThis.__yolo.state.source, at: globalThis.__yoloPlayer.player.getCurrentTime(),
  }));
  const asked = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST",
    body: { source, startTime: at, reason: "quality", autoplay: true, sessionId, deviceId: credential.deviceId, maxVideoKbps },
  });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  return at;
}

// The screen plays the stream Yolo has for it, not `replaced` (the one it
// played before), between `from` and `to` seconds, and the progress bar
// shows no seek. Throws with what the page shows after `timeout`.
export async function playsHubStream(page, { replaced = null, from = 0, to = Infinity, label, timeout = 30_000 }) {
  try {
    await page.waitForFunction(([after, before, old]) => {
      const player = globalThis.__yoloPlayer?.player;
      const { state } = globalThis.__yolo;
      return player?.getStatus() === "playing" && player.getStats()?.videoFrameRenderCount > 0
        && player.getCurrentTime() > after && player.getCurrentTime() < (before ?? Infinity)
        && state.sessionId && state.sessionId === state.hub?.sessionId && state.sessionId !== old
        && !document.getElementById("progress-wrap").classList.contains("seeking");
    }, [from, Number.isFinite(to) ? to : null, replaced], { timeout });
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
  return page.evaluate(() => ({
    sessionId: globalThis.__yolo.state.sessionId,
    source: globalThis.__yolo.state.source,
    time: globalThis.__yoloPlayer.player.getCurrentTime(),
  }));
}

// The seek to `target` played: its stream is the one Yolo has for this
// screen, it plays past the target, and the progress bar no longer shows a
// seek.
export const seekPlayed = (page, target, label, timeout = 30_000) => playsHubStream(page, { from: target + 0.5, to: target + 30, label, timeout });

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
