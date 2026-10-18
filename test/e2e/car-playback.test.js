import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { NODE_PROTOCOL, signOperatorRequest } from "@useyolo/core";
import {
  autoplayMessage, CAR_BROWSER, eventually, launchBrowser, loseHubMessage, openPage, pair, pairCodeShown, playingPast, statusIs, waitFor,
} from "./browser.js";
import { startMediaStack } from "./fixtures.js";
import { fileContext } from "./yolo-stack.js";

// The car profile on one stack: Chromium pairs as the car with the device
// code flow and plays direct, hls, dash_split (yt-dlp) and plex through the
// node's /m/* with the canvas engine, started by an agent over MCP; a Tesla
// paired as a browser still plays with the canvas engine. The tests run in
// order: the first to pair is the only screen online when an agent names none.

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../ops/yolo.js", import.meta.url));
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const SECONDS = 120;

// The Plex fixture's English subtitle: what an agent reads and searches.
const SUBTITLE = [
  "1\n00:00:00,000 --> 00:00:20,000\nFixture subtitle",
  "2\n00:00:40,000 --> 00:00:44,000\nThe lighthouse keeper waves",
  "3\n00:01:30,000 --> 00:01:33,000\nBack to the harbour",
].join("\n\n");

const shared = fileContext();
let media;
let plex;
let yolo;

before(async () => {
  ({ media, plex, yolo } = await startMediaStack(shared, { seconds: SECONDS, plex: { subtitle: SUBTITLE } }));
}, { timeout: 120_000 });

after(() => shared.cleanup());

const waitForFrames = (page, label, minimumTime = 0.5) => waitFor(page, (min) => {
  const player = globalThis.__yoloPlayer?.player;
  return player?.getStats()?.videoFrameRenderCount > 0 && player.getCurrentTime() > min;
}, minimumTime, label);

const mediaPaths = (page, fragment) => page.evaluate((part) => performance.getEntriesByType("resource")
  .map((entry) => new URL(entry.name).pathname)
  .filter((path) => path.startsWith("/m/") && path.includes(part)), fragment);

// A tap on the picture shows the controls and another hides them.
const controlsShown = (page) => page.evaluate(() => document.getElementById("app").classList.contains("controls-visible"));
const tapPicture = (page) => page.touchscreen.tap(386, 150);
async function showControls(page) {
  if (await controlsShown(page)) {
    await tapPicture(page);
    await waitFor(page, () => !document.getElementById("app").classList.contains("controls-visible"), null, "the controls hidden");
  }
  await tapPicture(page);
  await waitFor(page, () => document.getElementById("app").classList.contains("controls-visible"), null, "the controls");
}

const freshPlayer = (page) => page.evaluate(() => { globalThis.__yoloPlayer.player.canvas.dataset.oldPlayer = "true"; });

test("the Worker reports its version and its path to the node, and yolo doctor checks the stack", { timeout: 60_000 }, async () => {
  assert.deepEqual(await (await fetch(`${yolo.origin}/healthz`)).json(), { ok: true, version });
  const open = await (await fetch(`${yolo.origin}/.well-known/yolo`)).json();
  assert.deepEqual([open.version, open.protocol, open.migrations.applied, open.operator], [version, NODE_PROTOCOL, "9999_e2e_owner", undefined]);
  const headers = await signOperatorRequest(yolo.secret, { path: "/.well-known/yolo" });
  const signed = await (await fetch(`${yolo.origin}/.well-known/yolo`, { headers })).json();
  assert.deepEqual(signed.operator.node, { reachable: true, version, protocol: NODE_PROTOCOL, error: null });

  const instance = join(yolo.dir, "yolo.instance.json");
  const envFile = join(yolo.dir, "doctor.env");
  writeFileSync(instance, JSON.stringify({ version: 1, domain: "yolo.example.com", node: { port: yolo.nodePort } }));
  writeFileSync(envFile, `NODE_SECRET=${yolo.secret}\nNODE_PORT=${yolo.nodePort}\nPUBLIC_ORIGIN=https://yolo.example.com\n`);
  const { stdout } = await exec(process.execPath, [cli, "doctor", "--offline", "--origin", yolo.origin, "--json"], {
    env: { ...process.env, YOLO_INSTANCE: instance, YOLO_ENV_FILE: envFile },
  }).catch((error) => error);
  const checks = Object.fromEntries(JSON.parse(stdout).checks.map((check) => [check.id, check.status]));
  for (const id of ["node.health", "worker.reachable", "worker.isolation", "worker.node", "versions.match", "versions.protocol"]) assert.equal(checks[id], "ok", id);
  assert.equal(checks["config.d1.id"], "fail", "no Cloudflare ids provisioned yet");
});

test("an agent plays direct, hls and dash_split on the paired car with the canvas engine; controls, recovery, the queue, and revocation work", { timeout: 300_000 }, async (t) => {
  const { page, errors } = await openPage(await launchBrowser(t, { context: CAR_BROWSER }), yolo.origin);

  // The site root is the player, cross-origin isolated (SharedArrayBuffer).
  for (const path of ["/", "/play"]) {
    const response = await fetch(`${yolo.origin}${path}`);
    assert.deepEqual([response.headers.get("cross-origin-opener-policy"), response.headers.get("cross-origin-embedder-policy")], ["same-origin", "credentialless"], path);
  }
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);

  await page.waitForSelector("#pair-qr svg", { timeout: 20_000 });
  const credential = await pair(yolo, page, { kind: "car" });
  assert.equal(await page.evaluate(() => globalThis.__yolo.profile.engine), "canvas");
  assert.match(credential.token, /^ydt_/);
  // The default display size lays out 946 CSS px wide (Agent Note 2026-10-11-display-size).
  await waitFor(page, () => Math.abs(document.body.clientWidth - 946) <= 1, null, "the default display size");
  const agent = await yolo.agentToken();
  const { devices } = await yolo.mcp(agent, "list_devices");
  assert.deepEqual(devices.filter((device) => device.online).map((device) => device.id), [credential.deviceId]);
  // A device credential is for playing, not for agents.
  assert.equal((await fetch(`${yolo.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${credential.token}` } })).status, 403);

  // direct: a file read with byte ranges, on the only online device.
  await yolo.mcp(agent, "play", { url: `${media.url}/clip.webm` });
  await waitForFrames(page, "direct");
  assert.ok(media.requests.includes("/clip.webm") && (await mediaPaths(page, "/f/")).length > 0);
  // hls: a playlist rewritten onto the session.
  await yolo.mcp(agent, "play", { url: `${media.url}/hls/index.m3u8`, start_at: 0 });
  await waitForFrames(page, "hls");
  assert.ok((await mediaPaths(page, "/p/")).some((path) => path.endsWith(".m3u8")));
  // dash_split: separate audio and video files joined into fMP4 HLS.
  const dash = await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0 });
  assert.equal(dash.state.item.title, "DASH fixture");
  await waitForFrames(page, "dash_split");
  const dashPaths = await mediaPaths(page, "/dash/");
  assert.ok(dashPaths.some((path) => path.endsWith("/dash/master.m3u8")) && dashPaths.some((path) => path.endsWith("/dash/video/init.mp4")), JSON.stringify(dashPaths));

  // An agent sees the playing item (ffmpeg on the node) and the screen's health.
  const frame = await yolo.mcp(agent, "get_frame", {});
  assert.equal(frame.content[0].mimeType, "image/jpeg");
  const health = await eventually(async () => {
    const value = await yolo.mcp(agent, "get_playback_health");
    return value.engine ? value : null;
  }, "the player's health report", 30_000);
  assert.deepEqual([health.engine, health.device.id, health.path.now], ["canvas", credential.deviceId, "relay"]);

  // An error nothing will fix by itself: one sentence, and Try again plays on.
  await freshPlayer(page);
  await page.evaluate(() => globalThis.__yoloPlayer.player.fail(Object.assign(new Error("Upstream answered 403"), { code: "UPSTREAM_ACCESS_DENIED" })));
  await waitFor(page, () => !document.getElementById("playback-error").classList.contains("hidden"), null, "the error panel");
  assert.equal(await page.locator("#playback-error-text").innerText(), "This video can't play right now.");
  await page.locator("#btn-playback-retry").tap();
  await waitFor(page, () => !globalThis.__yoloPlayer?.player?.canvas.dataset.oldPlayer && globalThis.__yoloPlayer.player.getStatus() === "playing"
    && document.getElementById("playback-error").classList.contains("hidden"), null, "playing after Try again", 45_000);

  // Agent controls reach the car; the car's own controls answer taps.
  await yolo.mcp(agent, "control", { action: "pause" });
  await statusIs(page, "paused", "paused by the agent");
  await yolo.mcp(agent, "seek", { position_seconds: 1 });
  await waitFor(page, () => Math.abs(globalThis.__yoloPlayer.player.getCurrentTime() - 1) < 0.5, null, "the agent's seek");
  const status = await yolo.mcp(agent, "get_status");
  assert.deepEqual([status.playback.deviceId, status.playback.status], [credential.deviceId, "paused"]);
  await showControls(page);
  await page.locator("#btn-center-play").tap();
  await playingPast(page, 1.5, "played by the centre button");

  // A pause the realtime connection lost: the welcome after the reconnect says what the screen missed.
  const welcomes = await loseHubMessage(page, {
    lose: (message) => message.type === "pause",
    send: () => yolo.mcp(agent, "control", { action: "pause" }),
  });
  await eventually(() => welcomes.length > 1, "the welcome after the reconnect", 30_000);
  await statusIs(page, "paused", "paused after the reconnect");

  // A paused stream that fails recovers once, still paused.
  const plays = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/v1/playback/play")) plays.push(request.postDataJSON());
  });
  await freshPlayer(page);
  await page.evaluate(() => globalThis.__yoloPlayer.player.fail(new Error("network fixture failure")));
  await waitFor(page, () => globalThis.__yoloPlayer?.player?.getStatus() === "paused" && !globalThis.__yoloPlayer.player.canvas.dataset.oldPlayer, null, "the paused recovery");
  assert.deepEqual(plays.map((body) => [body.reason, body.autoplay]), [["recovery", false]]);

  // An item played to its end goes on to the queue's next item.
  await yolo.mcp(agent, "queue_add", { url: `${media.url}/hls/index.m3u8` });
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: SECONDS - 6 });
  await waitForFrames(page, "near the end", SECONDS - 5.5);
  const ending = await page.evaluate(() => globalThis.__yolo.state.sessionId);
  await waitFor(page, (old) => {
    const { state } = globalThis.__yolo;
    const player = globalThis.__yoloPlayer?.player;
    return state.sessionId !== old && JSON.stringify(state.source).includes("hls") && player?.getStatus() === "playing" && player.getCurrentTime() > 0.5;
  }, ending, "the queue's next item", 60_000);
  const queue = await yolo.mcp(agent, "queue_list");
  assert.deepEqual(queue.queue ?? queue.items ?? queue, []);
  assert.deepEqual(errors, []);

  // A second window of the same screen takes over; the first can take it back.
  const second = await page.context().newPage();
  await second.goto(yolo.origin);
  await page.waitForSelector("#status-actions:not(.hidden)", { timeout: 15_000 });
  assert.equal(await page.locator("#status-text").innerText(), "Yolo is open in another window");
  await page.locator("#btn-take-over").tap();
  await second.waitForSelector("#status-actions:not(.hidden)", { timeout: 15_000 });
  await second.close();

  // Revocation: the device credential stops working and the screen pairs again.
  await yolo.mcp(agent, "remove_device", { device: credential.deviceId });
  assert.equal((await yolo.api(credential.token, "/v1/queue")).status, 401);
  await pairCodeShown(page);
  assert.equal(await page.evaluate(() => localStorage.getItem("yolo.device")), null);
});

test("Plex plays through the node at Plex's position, with subtitles, a transcript, recovery after a lost transcode, and a kept player", { timeout: 300_000 }, async (t) => {
  const { page, errors } = await openPage(await launchBrowser(t), yolo.origin);
  const credential = await pair(yolo, page, { kind: "car" });
  await page.goto(yolo.origin);
  await page.waitForSelector("#movies-section:not(.hidden) .browse-card", { timeout: 15_000 });

  // An agent's search gives image links that load without a credential until the owner resets them.
  const agent = await yolo.agentToken({ name: "Cover agent" });
  const cover = async () => (await yolo.mcp(agent, "search", { query: "fixture" })).results.find((item) => item.id === "plex:7").thumbnail;
  const thumbnail = await cover();
  assert.match(thumbnail, new RegExp(`^${yolo.origin}/i/[A-Za-z0-9_-]+$`));
  const image = await fetch(thumbnail);
  assert.deepEqual([image.status, image.headers.get("content-type")], [200, "image/png"]);
  const reset = await fetch(`${yolo.origin}/v1/owner/image-links/reset`, {
    method: "POST", headers: { cookie: yolo.ownerSession.cookie, "x-yolo-owner": "1", origin: yolo.origin },
  });
  assert.equal(reset.status, 200);
  assert.equal((await fetch(thumbnail)).status, 410);
  assert.notEqual(await cover(), thumbnail);

  // No Yolo history yet: Plex's own position (3 s), with the token as a header.
  const starts = () => plex.calls.filter((call) => call.path.endsWith("/start.m3u8"));
  const played = await yolo.api(credential.token, "/v1/playback/play", { method: "POST", body: { itemId: "plex:7", deviceId: credential.deviceId } });
  assert.equal(played.body.state.position, 3, JSON.stringify(played.body));
  assert.equal(starts()[0].params.offset, "3");
  assert.ok(plex.calls.every((call) => call.token === "fixture-token"), "the token goes as a header");
  await waitForFrames(page, "plex", 3);

  // A text subtitle switches without a new stream: WebVTT from the node.
  const tracks = await yolo.api(credential.token, "/v1/playback/tracks", { method: "PUT", body: { subtitles: ["plex:21"] } });
  assert.equal(tracks.status, 200, JSON.stringify(tracks.body));
  await page.waitForFunction(() => document.getElementById("subtitle-overlay").textContent.includes("Fixture subtitle"), null, { timeout: 15_000 });
  assert.equal(starts().length, 1, "no second transcode");

  // The transcript comes from the session's text subtitle; the agent seeks to a line.
  const found = await yolo.mcp(agent, "search_transcript", { query: "Lighthouse keeper" });
  assert.deepEqual(found.matches, [{ at: 40, time: "0:40", text: "The lighthouse keeper waves" }]);
  assert.equal((await yolo.mcp(agent, "get_transcript", { from_seconds: 30, to_seconds: 100 })).text, "0:40 The lighthouse keeper waves\n1:30 Back to the harbour");
  await yolo.mcp(agent, "seek", { position_seconds: 40 });
  await playingPast(page, 40.5, "after the seek to the line");

  // Plex drops the transcode: the node answers SESSION_EXPIRED, and the
  // player asks Yolo for a new stream where it was.
  const startsBefore = starts().length;
  plex.sessions.clear();
  await freshPlayer(page);
  await page.evaluate(async () => {
    const prefetcher = globalThis.__yoloPlayer.player.hlsSegmentPrefetcher;
    const url = [...prefetcher.playlists.values()][0].segments[0].url;
    prefetcher.segmentCache.delete(url);
    await prefetcher.fetch(url).catch((error) => {
      if (error.code !== "SESSION_EXPIRED") throw error;
    });
  });
  await waitFor(page, () => !globalThis.__yoloPlayer?.player?.canvas.dataset.oldPlayer && globalThis.__yoloPlayer.player.getStatus() === "playing", null, "the new transcode plays");
  assert.equal(starts().length, startsBefore + 1, "one new transcode");
  assert.ok(Number(starts().at(-1).params.offset) >= 40, "at the position reached");

  // Back keeps the player and its transcode; the bar plays it on in place, and a stop ends the transcode.
  await page.evaluate(() => { globalThis.__yoloPlayer.player.keptMark = "the same engine"; });
  const stops = () => plex.calls.filter((call) => call.path === "/video/:/transcode/universal/stop").length;
  await new Promise((done) => setTimeout(done, 1_000));
  const stopsBefore = stops();
  await page.evaluate(() => document.getElementById("btn-back").click());
  await waitFor(page, () => location.pathname === "/" && !globalThis.__yoloPlayer
    && Boolean(document.querySelector("#now-playing .np-art canvas.np-frame")), null, "the bar with the paused frame");
  const left = (await yolo.api(credential.token, "/v1/playback")).body;
  assert.deepEqual([left.status, left.kept], ["paused", true]);
  assert.ok((await yolo.api(credential.token, "/v1/history")).body[0].position > 40, "the position saved");
  await page.locator("#np-open").click();
  await waitForFrames(page, "playing on in place", left.position + 0.3);
  assert.equal(await page.evaluate(() => globalThis.__yoloPlayer.player.keptMark), "the same engine");
  assert.equal(stops(), stopsBefore, "the kept player's transcode went on");
  await yolo.api(credential.token, "/v1/playback/stop", { method: "POST" });
  await eventually(() => stops() > stopsBefore, "the transcode stop", 20_000);
  assert.deepEqual(errors, []);
});

// The Tesla fingerprint plays with the canvas engine whatever the device's
// type (Agent Note 2026-10-12-two-playback-engines); a wake plays on muted
// with "Tap for sound" when the browser blocks sound without a tap.
test("a Tesla paired as a browser plays with the canvas engine, wakes, and plays on by itself, muted until a tap", { timeout: 240_000 }, async (t) => {
  const context = await launchBrowser(t, { context: CAR_BROWSER, autoplay: "gesture" });
  const { page: first } = await openPage(context, yolo.origin);
  const credential = await pair(yolo, first, { kind: "browser" });
  assert.deepEqual(await first.evaluate(() => [globalThis.__yolo.profile.name, globalThis.__yolo.profile.engine]), ["web", "canvas"]);
  const { body: { devices } } = await yolo.api(credential.token, "/v1/devices");
  assert.equal(devices.find((device) => device.id === credential.deviceId).capabilities.renderer, "canvas-webcodecs");
  await yolo.api(credential.token, "/v1/playback/play", { method: "POST", body: { url: `${media.url}/hls/index.m3u8`, startTime: 0, deviceId: credential.deviceId } });
  await playingPast(first, 2.5, "playing before sleeping");

  // The car sleeps: the Hub keeps the place and marks that it was playing.
  await first.close();
  const saved = await eventually(async () => {
    const { body } = await yolo.api(credential.token, "/v1/playback");
    return body.status === "paused" && body.interruptedAt ? body : null;
  }, "the Hub to keep the place", 15_000);

  // It wakes (a fresh page, no tap yet): playing by itself, muted.
  const { page, errors, before: woke } = await openPage(context, yolo.origin, { onPage: (fresh) => autoplayMessage(fresh) });
  assert.equal(await woke, "muted");
  await playingPast(page, saved.position + 0.5, "playing again after the wake", 45_000);
  assert.equal(await page.evaluate(() => !document.getElementById("btn-tap-sound").classList.contains("hidden")), true, "Tap for sound");
  // The first tap anywhere brings the sound; playback goes on.
  await page.mouse.click(400, 200);
  await waitFor(page, () => globalThis.__yoloPlayer?.player?.audioContext.state === "running"
    && document.getElementById("btn-tap-sound").classList.contains("hidden"), null, "sound after a tap");
  await playingPast(page, await page.evaluate(() => globalThis.__yoloPlayer.player.getCurrentTime()) + 0.5, "playing with sound");
  assert.deepEqual(errors, []);
});
