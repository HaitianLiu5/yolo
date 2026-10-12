import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { fakeYtdlp, makeMedia, mediaOrigin, plexFixture } from "./fixtures.js";
import { startYolo } from "./yolo-stack.js";

// The Tesla client on the new stack, end to end: Chromium opens the control
// plane's origin (static assets with COOP/COEP), pairs with the device code
// flow, and plays all four stream types through the node's /m/* pipeline —
// direct (a WebM file), hls, dash_split (separate audio/video files) and
// plex (a Plex fixture's transcode) — started by an agent over MCP.
// Progress comes back to Yolo's history and drives resume.

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let mediaDir;

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "yolo-e2e-media-"));
  await makeMedia(mediaDir);
});

after(async () => {
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
});

async function browserPage(t, origin) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(macChrome) ? macChrome : undefined),
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  return { page, errors };
}

const shownCode = (page) => page.waitForFunction(
  () => /^[B-Z]{4}-[B-Z]{4}$/.test(document.getElementById("pair-code")?.textContent || "")
    && !document.getElementById("pair-screen").classList.contains("hidden"),
  null,
  { timeout: 20_000 },
);

// Pair the page as the owner would: read the code it shows, press Allow.
async function pair(yolo, page) {
  await shownCode(page);
  assert.equal(await page.locator("#pair-qr svg").count(), 1, "the QR code is drawn");
  const code = await page.locator("#pair-code").innerText();
  const approved = await yolo.approve(code);
  assert.equal(approved.status, 200, approved.text);
  // The device polls every 5 seconds, then connects to the Hub.
  await page.waitForFunction(() => Boolean(globalThis.__yolo?.state?.deviceId), null, { timeout: 20_000 });
  return page.evaluate(() => JSON.parse(localStorage.getItem("yolo.device")));
}

async function waitForFrames(page, label, minimumTime = 0.5) {
  try {
    await page.waitForFunction((min) => {
      const player = globalThis.__driveInMediabunny?.player;
      return player?.getStats()?.videoFrameRenderCount > 0 && player.getCurrentTime() > min;
    }, minimumTime, { timeout: 30_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      status: document.getElementById("status-text")?.textContent,
      crossOriginIsolated: globalThis.crossOriginIsolated,
      stats: globalThis.__driveInMediabunny?.player?.getStats?.() || null,
      log: (globalThis.__yoloPlayerLog || []).slice(-8),
    }));
    throw new Error(`${label}: ${error.message}\n${JSON.stringify(diagnostics, null, 2)}`);
  }
}

const mediaPaths = (page, fragment) => page.evaluate((part) => performance.getEntriesByType("resource")
  .map((entry) => new URL(entry.name).pathname)
  .filter((path) => path.startsWith("/m/") && path.includes(part)), fragment);

async function eventually(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

test("an agent plays direct, hls and dash_split streams on the paired car, which resumes and can be revoked", { timeout: 300_000 }, async (t) => {
  const media = await mediaOrigin(t, mediaDir);
  const ytdlp = await fakeYtdlp(mediaDir, {
    title: "DASH fixture",
    duration: 12,
    requested_formats: [
      { format_id: "v", url: `${media.url}/video.mp4`, vcodec: "avc1.42c00d", acodec: "none", width: 320, height: 180, fps: 30, tbr: 400 },
      { format_id: "a", url: `${media.url}/audio.mp4`, vcodec: "none", acodec: "mp4a.40.2", abr: 128 },
    ],
  });
  const yolo = await startYolo(t, {
    pluginConfig: { plugins: [{ source: join(root, "plugins/source-ytdlp"), options: { binary: ytdlp } }] },
  });
  const { page, errors } = await browserPage(t, yolo.origin);

  // The site root is the player, cross-origin isolated (SharedArrayBuffer).
  const home = await fetch(yolo.origin);
  assert.equal(home.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(home.headers.get("cross-origin-embedder-policy"), "credentialless");
  assert.equal((await fetch(`${yolo.origin}/play`)).headers.get("cross-origin-embedder-policy"), "credentialless", "client routes too");
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);

  const credential = await pair(yolo, page);
  assert.match(credential.token, /^ydt_/);
  const agent = await yolo.agentToken();
  const { devices } = await yolo.mcp(agent, "list_devices");
  assert.deepEqual(devices.filter((device) => device.online).map((device) => device.id), [credential.deviceId]);
  // A device credential is for playing, not for agents.
  assert.equal((await fetch(`${yolo.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${credential.token}` } })).status, 403);

  // direct: a progressive file, read with byte ranges. The agent names no
  // device: the only online one plays.
  await yolo.mcp(agent, "play", { url: `${media.url}/clip.webm` });
  await waitForFrames(page, "direct");
  assert.ok(media.requests.includes("/clip.webm"), "the node fetched the file");
  assert.ok((await mediaPaths(page, "/f/")).length > 0);

  // Leaving the video saves the position; playing it again resumes there
  // (positions under 5 seconds are not worth resuming).
  await page.waitForFunction(() => globalThis.__driveInMediabunny.player.getCurrentTime() > 6, null, { timeout: 20_000 });
  await page.evaluate(() => document.getElementById("btn-back").click());
  await page.waitForFunction(() => location.pathname === "/" && !globalThis.__driveInMediabunny, null, { timeout: 10_000 });
  const saved = await eventually(async () => {
    const history = await yolo.mcp(agent, "history");
    const position = history.find((entry) => entry.title.includes("clip.webm"))?.position ?? 0;
    return position > 5 ? position : null;
  }, "the saved position");
  assert.ok(saved < 11, `saved position ${saved}`);
  const resumed = await yolo.mcp(agent, "play", { url: `${media.url}/clip.webm` });
  assert.ok(Math.abs(resumed.state.position - saved) < 0.5, `resumed at ${resumed.state.position}, saved ${saved}`);
  await waitForFrames(page, "resumed direct", saved);

  // hls: a playlist rewritten onto the session.
  await yolo.mcp(agent, "play", { url: `${media.url}/hls/index.m3u8`, start_at: 0 });
  await waitForFrames(page, "hls");
  assert.ok(media.requests.some((path) => path.startsWith("/hls/seg")), "segments came from the origin through the node");
  assert.ok((await mediaPaths(page, "/p/")).some((path) => path.endsWith(".m3u8")));

  // dash_split: separate audio and video files joined into fMP4 HLS.
  const dash = await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0 });
  assert.equal(dash.state.item.title, "DASH fixture");
  await waitForFrames(page, "dash_split");
  const dashPaths = await mediaPaths(page, "/dash/");
  assert.ok(dashPaths.some((path) => path.endsWith("/dash/master.m3u8")), JSON.stringify(dashPaths));
  assert.ok(dashPaths.some((path) => path.endsWith("/dash/video/init.mp4")), JSON.stringify(dashPaths));

  // A seek the stream cannot do itself (as for a transcode that started at
  // an offset): the player asks Yolo for a new stream and keeps its last
  // frame on screen meanwhile.
  await page.route("**/m/**", async (route) => {
    await new Promise((done) => setTimeout(done, 300));
    await route.continue();
  });
  const current = await page.evaluate(() => globalThis.__yolo.state.sessionId);
  const seek = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST",
    body: { source: dash.state.item.source, startTime: 4, reason: "seek", sessionId: current, deviceId: credential.deviceId },
  });
  assert.equal(seek.status, 200, JSON.stringify(seek.body));
  await page.waitForFunction(() => document.querySelector(".playback-transition-frame")
    && document.getElementById("progress-wrap").classList.contains("seeking"), null, { timeout: 10_000 });
  assert.equal(await page.evaluate(() => document.getElementById("overlay").classList.contains("hidden")), true, "no loading screen");
  await page.waitForFunction(() => globalThis.__driveInMediabunny?.player?.getCurrentTime() > 4.25
    && !document.querySelector(".playback-transition-frame"), null, { timeout: 20_000 });
  await page.unroute("**/m/**");
  // A stale rebuild (the session it names was replaced) is refused.
  const stale = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST", body: { source: dash.state.item.source, startTime: 1, reason: "recovery", sessionId: current, deviceId: credential.deviceId },
  });
  assert.equal(stale.body.error?.code, "superseded");

  // Agent controls reach the car.
  await yolo.mcp(agent, "control", { action: "pause" });
  await page.waitForFunction(() => globalThis.__driveInMediabunny?.player?.getStatus() === "paused", null, { timeout: 10_000 });
  await yolo.mcp(agent, "seek", { position_seconds: 1 });
  await page.waitForFunction(() => Math.abs(globalThis.__driveInMediabunny.player.getCurrentTime() - 1) < 0.5, null, { timeout: 10_000 });
  const status = await yolo.mcp(agent, "get_status");
  assert.equal(status.playback.deviceId, credential.deviceId);
  assert.equal(status.playback.status, "paused");
  assert.deepEqual(errors, []);

  // A second window of the same screen takes over; the first can take it back.
  const second = await page.context().newPage();
  await second.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await second.goto(yolo.origin);
  await page.waitForSelector("#status-actions:not(.hidden)", { timeout: 15_000 });
  assert.equal(await page.locator("#status-text").innerText(), "Yolo is open in another window");
  await page.locator("#btn-take-over").click();
  await second.waitForSelector("#status-actions:not(.hidden)", { timeout: 15_000 });
  await page.waitForFunction(() => document.getElementById("connection-status").classList.contains("hidden"), null, { timeout: 15_000 });
  await second.close();

  // Revocation: the device credential stops working and the screen pairs again.
  await yolo.mcp(agent, "remove_device", { device: credential.deviceId });
  assert.equal((await yolo.api(credential.token, "/v1/queue")).status, 401);
  await shownCode(page);
  assert.equal(await page.evaluate(() => localStorage.getItem("yolo.device")), null);
});

test("Plex plays through the node, resumes at Plex's own position, and switches text subtitles in place", { timeout: 240_000 }, async (t) => {
  const plex = await plexFixture(t, mediaDir, { viewOffset: 3_000 });
  const yolo = await startYolo(t, {
    pluginConfig: { plugins: [{ source: join(root, "plugins/source-plex"), options: { url: plex.url, token: "fixture-token" } }] },
  });
  const { page, errors } = await browserPage(t, yolo.origin);
  const credential = await pair(yolo, page);

  // The home screen lists the library from the plugin.
  await page.goto(yolo.origin);
  await page.waitForSelector("#movies-section:not(.hidden) .browse-card", { timeout: 15_000 });

  // No Yolo history yet: Yolo lets Plex resume at its viewOffset (3 s).
  const played = await yolo.api(credential.token, "/v1/playback/play", { method: "POST", body: { itemId: "plex:7", deviceId: credential.deviceId } });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  assert.equal(played.body.state.position, 3);
  const start = plex.calls.find((call) => call.path.endsWith("/start.m3u8"));
  assert.equal(start.params.offset, "3");
  assert.equal(start.params.videoResolution, "1280x720");
  assert.ok(plex.calls.every((call) => call.token === "fixture-token"), "the token goes as a header");
  await waitForFrames(page, "plex", 3);

  // A text subtitle switches without a new stream: WebVTT from the node.
  const tracks = await yolo.api(credential.token, "/v1/playback/tracks", { method: "PUT", body: { subtitles: ["plex:21"] } });
  assert.equal(tracks.status, 200, JSON.stringify(tracks.body));
  await page.waitForFunction(() => document.getElementById("subtitle-overlay").textContent.includes("Fixture subtitle"), null, { timeout: 15_000 });
  assert.equal(plex.calls.filter((call) => call.path.endsWith("/start.m3u8")).length, 1, "no second transcode");

  // Plex drops the transcode (as after a long pause): the node answers
  // SESSION_EXPIRED, and the player asks Yolo for a new stream where it was.
  const startsBefore = plex.calls.filter((call) => call.path.endsWith("/start.m3u8")).length;
  plex.sessions.clear();
  await page.evaluate(async () => {
    const player = globalThis.__driveInMediabunny.player;
    player.canvas.dataset.oldPlayer = "true";
    const prefetcher = player.hlsSegmentPrefetcher;
    const url = [...prefetcher.playlists.values()][0].segments[0].url;
    prefetcher.segmentCache.delete(url);
    try {
      await prefetcher.fetch(url);
    } catch (error) {
      if (error.code !== "SESSION_EXPIRED") throw error;
    }
  });
  await page.waitForFunction(() => {
    const player = globalThis.__driveInMediabunny?.player;
    return player && !player.canvas.dataset.oldPlayer && player.getStatus() === "playing";
  }, null, { timeout: 30_000 });
  const restarts = plex.calls.filter((call) => call.path.endsWith("/start.m3u8"));
  assert.equal(restarts.length, startsBefore + 1, "one new transcode");
  assert.ok(Number(restarts.at(-1).params.offset) >= 3, "at the position reached");

  // Leaving stops the transcode and keeps the position for next time.
  await page.waitForFunction(() => globalThis.__driveInMediabunny.player.getCurrentTime() > 4, null, { timeout: 15_000 });
  await page.evaluate(() => document.getElementById("btn-back").click());
  await page.waitForFunction(() => location.pathname === "/", null, { timeout: 10_000 });
  await eventually(() => plex.calls.some((call) => call.path === "/video/:/transcode/universal/stop"), "the transcode stop", 20_000);
  const history = await yolo.api(credential.token, "/v1/history");
  assert.ok(history.body[0].position > 3, JSON.stringify(history.body[0]));
  assert.deepEqual(errors, []);
});

test("a paused stream that fails recovers once, still paused", { timeout: 120_000 }, async (t) => {
  const media = await mediaOrigin(t, mediaDir);
  const yolo = await startYolo(t);
  const { page } = await browserPage(t, yolo.origin);
  const credential = await pair(yolo, page);
  const plays = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/v1/playback/play")) plays.push(request.postDataJSON());
  });
  const played = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST", body: { url: `${media.url}/clip.webm`, autoplay: false, startTime: 0, deviceId: credential.deviceId },
  });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  await page.waitForFunction(() => globalThis.__driveInMediabunny?.player?.getStatus() === "paused", null, { timeout: 20_000 });
  await page.evaluate(() => {
    const { player } = globalThis.__driveInMediabunny;
    player.canvas.dataset.oldPlayer = "true";
    player.fail(new Error("network fixture failure"));
  });
  await page.waitForFunction(() => {
    const player = globalThis.__driveInMediabunny?.player;
    return player?.getStatus() === "paused" && !player.canvas.dataset.oldPlayer;
  }, null, { timeout: 20_000 });
  assert.equal(plays.length, 1);
  assert.deepEqual([plays[0].reason, plays[0].autoplay], ["recovery", false]);
  // Past the 20-second confirmation window plus a retry delay: no loop.
  await new Promise((done) => setTimeout(done, 24_000));
  assert.equal(plays.length, 1);
  assert.equal(await page.evaluate(() => globalThis.__driveInMediabunny.player.getStatus()), "paused");
});

// Production, 2026-10-12: the car slept while playing; the page froze, the
// Hub lost the socket. On waking, the next segment was 410 SESSION_EXPIRED
// and the player's request for a fresh stream reached the Hub before the
// reconnected socket's hello: "Recovery error … Browser is offline".
test("the car wakes after its media session expired and plays on where it was", { timeout: 180_000 }, async (t) => {
  const media = await mediaOrigin(t, mediaDir);
  // Through a proxy that can break the realtime connection like the car's
  // network: the Hub's side first, the browser's side when it wakes.
  const yolo = await startYolo(t, { proxy: true });
  const { page, errors } = await browserPage(t, yolo.origin);
  const credential = await pair(yolo, page);
  const plays = [];
  page.on("response", (response) => {
    if (response.request().method() !== "POST" || !response.url().endsWith("/v1/playback/play")) return;
    plays.push({ body: response.request().postDataJSON(), status: response.status() });
  });

  const played = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST", body: { url: `${media.url}/hls/index.m3u8`, startTime: 0, deviceId: credential.deviceId },
  });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  await waitForFrames(page, "hls before sleeping", 2.5);
  const [oldToken] = (await mediaPaths(page, "/p/")).map((path) => path.split("/")[2]);

  // The car sleeps: the page's JavaScript stops, and the Hub loses the
  // socket and keeps the place, paused.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Debugger.enable");
  const paused = new Promise((resolve) => cdp.once("Debugger.paused", resolve));
  await cdp.send("Debugger.pause");
  await paused;
  const sleptAt = Date.now();
  yolo.proxy.cutHubSide();
  const saved = await eventually(async () => {
    const { body } = await yolo.api(credential.token, "/v1/playback");
    return body.status === "paused" && body.interruptedAt ? body : null;
  }, "the Hub to keep the place", 15_000);
  // Meanwhile the node ends the stream (410 SESSION_EXPIRED from now on),
  // and the network that wakes up with the car is slow to reconnect.
  assert.equal((await yolo.node(`/internal/v1/sessions/${saved.sessionId}/stop`)).status, 200);
  yolo.proxy.holdRealtimeMs = 2_000;
  // Long enough for the page to notice it slept (its timers run late).
  await new Promise((done) => setTimeout(done, Math.max(0, 28_000 - (Date.now() - sleptAt))));

  // It wakes: the dead connection closes, and the next segment is 410.
  const connectionsBefore = yolo.proxy.realtime.length;
  yolo.proxy.dropPageSide();
  await cdp.send("Debugger.resume");
  await cdp.send("Debugger.disable");
  await page.evaluate(async () => {
    const player = globalThis.__driveInMediabunny.player;
    player.canvas.dataset.oldPlayer = "true";
    const prefetcher = player.hlsSegmentPrefetcher;
    const playlist = [...prefetcher.playlists.values()].find((entry) => entry.segments?.length);
    const url = playlist.segments.at(-1).url;
    prefetcher.segmentCache.delete(url);
    try {
      await prefetcher.fetch(url);
    } catch (error) {
      if (error.code !== "SESSION_EXPIRED") throw error;
    }
  });

  try {
    await page.waitForFunction(() => {
      const player = globalThis.__driveInMediabunny?.player;
      return player && !player.canvas.dataset.oldPlayer && player.getStatus() === "playing" && player.getStats()?.videoFrameRenderCount > 0;
    }, null, { timeout: 45_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      status: document.getElementById("status-text")?.textContent,
      realtime: { ready: globalThis.__yolo.realtime.ready, connected: globalThis.__yolo.realtime.connected },
      player: globalThis.__driveInMediabunny?.player?.getStatus?.(),
      log: (globalThis.__yoloPlayerLog || []).slice(-12).map((entry) => `${entry.type} ${entry.error || entry.code || entry.state || ""}`),
    }));
    throw new Error(`no playback after waking: ${error.message}\n${JSON.stringify({ diagnostics, plays, connections: yolo.proxy.realtime.length }, null, 2)}`);
  }
  assert.ok(yolo.proxy.realtime.length > connectionsBefore, "the page reconnected");
  const recoveries = plays.filter((play) => play.body.reason === "recovery");
  assert.equal(recoveries.length, 1, JSON.stringify(plays));
  assert.equal(recoveries[0].status, 200);
  // Near the Hub's saved place. The player's own position can be a little
  // ahead: Debugger.pause stops the main thread, not the audio worklet,
  // which plays out its buffer.
  assert.ok(Math.abs(recoveries[0].body.startTime - saved.position) < 5, `recovered at ${recoveries[0].body.startTime}, saved ${saved.position}`);
  await page.waitForFunction((from) => globalThis.__driveInMediabunny.player.getCurrentTime() > from + 0.5, recoveries[0].body.startTime, { timeout: 15_000 });
  assert.equal(await page.evaluate(() => document.getElementById("overlay").classList.contains("hidden")), true, "no error screen");
  assert.doesNotMatch(await page.locator("#status-text").innerText(), /error/i);
  assert.deepEqual(errors, []);

  // The wake reached Workers Logs: the device's events and the Hub's lines.
  await eventually(() => /wake_to_playback/.test(yolo.workerLog()), "wake_to_playback in the logs", 25_000);
  // wrangler dev's own request lines (`GET /m/<token>/… 200`) aside: in
  // production those are invocation logs, not Yolo's lines.
  const log = yolo.workerLog().split("\n").filter((line) => !/\b(GET|HEAD|POST) \/m\//.test(line)).join("\n");
  for (const type of ["session_expired", "realtime_close", "realtime_welcome", "page_wake", "socket_hello", "socket_close"]) {
    assert.ok(log.includes(type), `${type} logged`);
  }
  assert.ok(!log.includes(oldToken), "no media token in the logs");
  assert.ok(!log.includes(credential.token), "no device credential in the logs");
});
