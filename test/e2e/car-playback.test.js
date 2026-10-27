import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { CLIENT_PROTOCOLS, NODE_PROTOCOL, signOperatorRequest } from "@useyolo/core";
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
// The split files (dash_split): long enough that the canvas engine has not
// buffered their rest when adaptive quality may step up, 90 seconds in.
const DASH_SECONDS = 360;

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
  ({ media, plex, yolo } = await startMediaStack(shared, { seconds: SECONDS, dashSeconds: DASH_SECONDS, plex: { subtitle: SUBTITLE, embedded: (at) => `Embedded subtitle ${at}\\N内嵌字幕 ${at}` } }));
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
  assert.deepEqual([open.name, open.version, open.protocol, open.clientProtocols, open.migrations.applied, open.operator], ["Yolo", version, NODE_PROTOCOL, CLIENT_PROTOCOLS, "9999_e2e_owner", undefined]);
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

  // A seek that builds a new stream shows the seek indicator until its first
  // picture; a stall that outlasts that picture shows the spinner. Neither
  // raises the controls: waiting is not a pause. The video fragments are a
  // second each; those from 9 s on wait, read-ahead (?prefetch=1) included.
  let release;
  const released = new Promise((done) => { release = done; });
  await page.route(/\/m\/[^/]+\/dash\/video\/\d+\.m4s(\?|$)/, async (route) => {
    if (Number(/(\d+)\.m4s/.exec(route.request().url())[1]) >= 9) await released;
    await route.continue().catch(() => {});
  });
  await freshPlayer(page);
  const seek = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST",
    body: { source: dash.state.item.source, startTime: 4, reason: "seek", sessionId: await page.evaluate(() => globalThis.__yolo.state.sessionId), deviceId: credential.deviceId },
  });
  assert.equal(seek.status, 200, JSON.stringify(seek.body));
  const stalled = await page.waitForFunction(() => {
    const player = globalThis.__yoloPlayer?.player;
    return player && !player.canvas.dataset.oldPlayer && player.getStats()?.videoFrameRenderCount > 0
      && player.getStatus() === "buffering" && {
      controls: document.getElementById("app").classList.contains("controls-visible"),
      seeking: document.getElementById("progress-wrap").classList.contains("seeking"),
      spinner: document.getElementById("center-loading").classList.contains("buffering"),
    };
  }, null, { timeout: 30_000 });
  assert.deepEqual(await stalled.jsonValue(), { controls: false, seeking: false, spinner: true }, "the stall after the seek's first picture");
  release();
  await playingPast(page, 9.5, "playing on after the stall");
  assert.deepEqual(await page.evaluate(() => [
    document.getElementById("progress-wrap").classList.contains("seeking"),
    document.getElementById("center-loading").classList.contains("buffering"),
  ]), [false, false], "no seek indicator or spinner once it plays on");
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // A quality change the owner did not ask for keeps the last picture under
  // the spinner and leaves the controls hidden, and Yolo hears where the
  // screen was while the new stream loads. On 2026-10-21 the car raised the
  // controls for one, and a tap meant for pause landed on the progress bar
  // just above it: a seek 5 minutes back. Its fragments wait until released.
  await waitFor(page, () => !document.getElementById("app").classList.contains("controls-visible"), null, "the controls hidden");
  const screenPlays = [];
  const notePlay = (request) => {
    if (request.method() === "POST" && request.url().endsWith("/v1/playback/play")) screenPlays.push(request.postDataJSON());
  };
  page.on("request", notePlay);
  let releaseQuality;
  const qualityReleased = new Promise((done) => { releaseQuality = done; });
  await page.route(/\/m\/[^/]+\/dash\/video\/\d+\.m4s(\?|$)/, async (route) => {
    await qualityReleased;
    await route.continue().catch(() => {});
  });
  await freshPlayer(page);
  const before = await page.evaluate(() => ({ sessionId: globalThis.__yolo.state.sessionId, at: globalThis.__yoloPlayer.player.getCurrentTime() }));
  const quality = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST",
    body: { source: dash.state.item.source, startTime: before.at, reason: "quality", maxVideoKbps: 400, sessionId: before.sessionId, deviceId: credential.deviceId },
  });
  assert.equal(quality.status, 200, JSON.stringify(quality.body));
  await waitFor(page, () => {
    const player = globalThis.__yoloPlayer?.player;
    return player && !player.canvas.dataset.oldPlayer && player.getStatus() === "loading";
  }, null, "the quality change's stream loading");
  const heard = await eventually(async () => {
    const hub = (await yolo.api(credential.token, "/v1/playback")).body;
    return hub.sessionId === quality.body.state.sessionId && hub.status !== "loading" && hub;
  }, "the screen's report while the stream loads", 15_000);
  assert.ok(Math.abs(heard.position - before.at) < 2, `Yolo heard ${heard.position}, the screen was at ${before.at}`);
  assert.deepEqual(await page.evaluate(() => ({
    controls: document.getElementById("app").classList.contains("controls-visible"),
    seeking: document.getElementById("progress-wrap").classList.contains("seeking"),
    spinner: document.getElementById("center-loading").classList.contains("buffering"),
  })), { controls: false, seeking: false, spinner: true }, "waiting for the quality change's stream");
  // The car's tap: on the progress bar's row, just above play/pause.
  const spot = await page.evaluate(() => {
    const bar = document.getElementById("progress-wrap").getBoundingClientRect();
    const play = document.getElementById("btn-play").getBoundingClientRect();
    return { x: play.left + play.width * 0.8, y: bar.bottom - 4 };
  });
  await page.touchscreen.tap(spot.x, spot.y);
  await waitFor(page, () => document.getElementById("app").classList.contains("controls-visible"), null, "the controls the tap showed");
  releaseQuality();
  await playingPast(page, before.at + 0.5, "playing on from where the quality change began");
  page.off("request", notePlay);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  assert.deepEqual(screenPlays, [], "no seek from the tap");

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

  // Agent controls reach the car, and an agent's pause brings the controls
  // up as the owner's does; the car's own controls answer taps.
  await waitFor(page, () => !document.getElementById("app").classList.contains("controls-visible"), null, "the controls hidden");
  await yolo.mcp(agent, "control", { action: "pause" });
  await statusIs(page, "paused", "paused by the agent");
  await waitFor(page, () => document.getElementById("app").classList.contains("controls-visible"), null, "the controls the agent's pause raised");
  await yolo.mcp(agent, "seek", { position_seconds: 1 });
  await waitFor(page, () => Math.abs(globalThis.__yoloPlayer.player.getCurrentTime() - 1) < 0.5, null, "the agent's seek");
  const status = await yolo.mcp(agent, "get_status");
  assert.deepEqual([status.playback.deviceId, status.playback.status], [credential.deviceId, "paused"]);
  await showControls(page);
  await page.locator("#btn-center-play").tap();
  await playingPast(page, 1.5, "played by the centre button");

  // 2× from the speed panel, whose slider ends at the canvas engine's 3×:
  // the engine's clock counts the media its audio output played, which
  // stretches the sound, so it runs at twice the wall clock's pace.
  const speedTo = async (name) => {
    await showControls(page);
    await page.locator("#btn-speed").tap();
    await page.locator("#speed-presets").getByRole("button", { name, exact: true }).tap();
    await page.locator("#btn-speed").tap();
  };
  await speedTo("2×");
  assert.equal(await page.locator("#speed-slider").getAttribute("aria-valuemax"), "3");
  const pace = await page.evaluate(async () => {
    const { player } = globalThis.__yoloPlayer;
    const [from, at] = [player.getCurrentTime(), performance.now()];
    await new Promise((done) => setTimeout(done, 3_000));
    return { pace: (player.getCurrentTime() - from) / ((performance.now() - at) / 1000), status: player.getStatus() };
  });
  assert.ok(pace.status === "playing" && pace.pace > 1.7 && pace.pace < 2.3, JSON.stringify(pace));

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
  assert.equal(await page.evaluate(() => globalThis.__yoloPlayer.player.playbackRate), 2, "the new stream at the owner's speed");
  await speedTo("1×");

  // An item played to its end goes on to the queue's next item.
  await yolo.mcp(agent, "queue_add", { url: `${media.url}/hls/index.m3u8` });
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: DASH_SECONDS - 6 });
  await waitForFrames(page, "near the end", DASH_SECONDS - 5.5);
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

  // Loaded again, it starts on what it kept; a tap on a card in Continue
  // Watching plays it in the car.
  await page.reload();
  await waitFor(page, () => globalThis.__yolo.realtime.ready && (location.pathname === "/play"
    ? ["playing", "paused"].includes(globalThis.__yoloPlayer?.player?.getStatus())
    : !document.getElementById("overlay").classList.contains("hidden")), null, "taken over");
  if (await page.evaluate(() => location.pathname === "/play")) await page.evaluate(() => document.getElementById("btn-back").click());
  const card = page.locator("#history-list .browse-card-primary").first();
  await card.waitFor();
  await card.tap();
  await waitFor(page, () => globalThis.__yoloPlayer?.player?.getStatus() === "playing" && location.pathname === "/play", null, "the tapped item");

  // Revocation: the device credential stops working, the screen forgets
  // what it kept and pairs again, and, paired, shows its home screen: the
  // tap before is not one the new device's welcome waits on, and the
  // launch mark, which a start that kept something never showed, does not
  // show either.
  await yolo.mcp(agent, "remove_device", { device: credential.deviceId });
  assert.equal((await yolo.api(credential.token, "/v1/queue")).status, 401);
  await pairCodeShown(page);
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem("yolo.device"), Object.keys(localStorage).filter((key) => key.startsWith("yolo.home."))]), [null, []]);
  const again = await pair(yolo, page, { kind: "car" });
  await waitFor(page, () => globalThis.__yolo.realtime.ready && !document.getElementById("overlay").classList.contains("hidden")
    && !document.getElementById("browse-screen").classList.contains("hidden") && document.getElementById("status-screen").style.display === "none", null, "the home screen after pairing again");
  assert.notEqual(again.deviceId, credential.deviceId);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.boot), "warm");
  assert.deepEqual(errors, []);
});

// A folder on the node's disk (Agent Note 2026-10-26-folder-source) in the
// car: the MP4 as it is, by byte range, and the Matroska episode as the HLS
// the node remuxes, both decoded by the canvas engine, and a seek past what
// ffmpeg has made.
test("a folder's MP4 and Matroska episode play through the node with the canvas engine", { timeout: 240_000 }, async (t) => {
  const { page, errors } = await openPage(await launchBrowser(t), yolo.origin);
  const credential = await pair(yolo, page, { kind: "car" });
  const agent = await yolo.agentToken({ name: "Folder agent" });
  const [movie] = (await yolo.mcp(agent, "search", { query: "Clip", type: "movie" })).results;
  await yolo.api(credential.token, "/v1/playback/play", { method: "POST", body: { itemId: movie.id, deviceId: credential.deviceId, startAt: 0 } });
  await waitForFrames(page, "the folder's MP4");
  assert.ok((await mediaPaths(page, "/f/")).length > 0);

  const [episode] = (await yolo.mcp(agent, "search", { query: "Folder Show", type: "episode" })).results;
  await yolo.api(credential.token, "/v1/playback/play", { method: "POST", body: { itemId: episode.id, deviceId: credential.deviceId, startAt: 0 } });
  await waitForFrames(page, "the folder's MKV");
  assert.ok((await mediaPaths(page, "/r/")).some((path) => path.endsWith("/r/index.m3u8")));
  await yolo.mcp(agent, "seek", { position_seconds: SECONDS - 20 });
  await waitForFrames(page, "the MKV after a seek", SECONDS - 19.5);
  assert.deepEqual(errors, []);
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

  // A text subtitle inside the file is drawn by the player too, and an
  // agent's transcript gets the whole track once it is extracted.
  await yolo.api(credential.token, "/v1/playback/tracks", { method: "PUT", body: { subtitles: ["plex:22"] } });
  await page.waitForFunction(() => document.getElementById("subtitle-overlay").textContent.includes("Embedded subtitle"), null, { timeout: 15_000 });
  assert.equal(starts().length, 1, "still no second transcode");
  const embedded = await eventually(() => yolo.mcp(agent, "get_transcript", { track: "plex:22", from_seconds: 112, to_seconds: 120 }).catch(() => null), "the embedded subtitle's transcript");
  assert.equal(embedded.text, "1:52 Embedded subtitle 112 内嵌字幕 112\n1:56 Embedded subtitle 116 内嵌字幕 116");

  // The file moves, so Yolo has not read its subtitle yet when the next play
  // starts with the saved choice: Plex still burns nothing in, and the
  // screen reads the subtitle from the file as it plays.
  const part = plex.movie.Media[0].Part[0];
  const moved = part.file.replace(/\.mkv$/, "-moved.mkv");
  await copyFile(part.file, moved);
  part.file = moved;
  await freshPlayer(page);
  await yolo.api(credential.token, "/v1/playback/play", { method: "POST", body: { itemId: "plex:7", deviceId: credential.deviceId } });
  assert.deepEqual([starts().length, starts().at(-1).params.subtitles], [2, "none"]);
  await waitFor(page, () => !globalThis.__yoloPlayer?.player?.canvas.dataset.oldPlayer
    && document.getElementById("subtitle-overlay").textContent.includes("Embedded subtitle"), null, "the subtitle of the moved file");
  await yolo.api(credential.token, "/v1/playback/tracks", { method: "PUT", body: { subtitles: ["plex:21"] } });

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

  // It wakes (a fresh page, no tap yet). Its first screen, before Yolo's
  // welcome, is the loading screen of the item it kept, never "Connecting…"
  // or the home screen (Agent Note 2026-10-11-yolo-web-client); then it
  // plays by itself, muted. The page says what it shows itself: a call
  // into it, or a routed socket, would count as a tap and unlock sound.
  await context.addInitScript(() => {
    const look = () => {
      const shown = (id) => document.getElementById(id) && !document.getElementById(id).classList.contains("hidden");
      const overlay = shown("overlay");
      const screen = shown("loading-poster") && !overlay ? "loading"
        : overlay && shown("browse-screen") ? "home"
          : overlay && document.getElementById("status-screen")?.style.display !== "none" ? `status "${document.getElementById("status-text").textContent}"` : null;
      if (!screen) {
        requestAnimationFrame(look);
        return;
      }
      console.log(`[e2e] first screen: ${screen}, ${globalThis.__yolo?.realtime?.ready ? "after" : "before"} the welcome`);
    };
    requestAnimationFrame(look);
  });
  const firstScreen = (fresh) => fresh.waitForEvent("console", { predicate: (message) => message.text().startsWith("[e2e] first screen: "), timeout: 20_000 });
  const { page, errors, before } = await openPage(context, yolo.origin, { onPage: (fresh) => ({ woke: autoplayMessage(fresh), first: firstScreen(fresh) }) });
  assert.equal((await before.first).text(), "[e2e] first screen: loading, before the welcome");
  assert.equal(await before.woke, "muted");
  await playingPast(page, saved.position + 0.5, "playing again after the wake", 45_000);
  assert.equal(await page.evaluate(() => !document.getElementById("btn-tap-sound").classList.contains("hidden")), true, "Tap for sound");
  // The first tap anywhere brings the sound; playback goes on.
  await page.mouse.click(400, 200);
  await waitFor(page, () => globalThis.__yoloPlayer?.player?.audioContext.state === "running"
    && document.getElementById("btn-tap-sound").classList.contains("hidden"), null, "sound after a tap");
  await playingPast(page, await page.evaluate(() => globalThis.__yoloPlayer.player.getCurrentTime()) + 0.5, "playing with sound");

  // Another item plays, then Back: Continue Watching is Yolo's history now,
  // not what the page asked for when it woke.
  await yolo.api(credential.token, "/v1/playback/play", { method: "POST", body: { url: `${media.url}/clip.webm`, startTime: 0, deviceId: credential.deviceId } });
  await waitFor(page, () => JSON.stringify(globalThis.__yolo.state.source || {}).includes("clip.webm") && globalThis.__yoloPlayer?.player?.getStatus() === "playing", null, "the next item");
  await page.evaluate(() => document.getElementById("btn-back").click());
  const latest = (await yolo.api(credential.token, "/v1/history")).body[0].title;
  await waitFor(page, (title) => !document.getElementById("browse-screen").classList.contains("hidden")
    && document.querySelector("#history-list .browse-card-title")?.textContent === title, latest, "Continue Watching after Back");
  assert.deepEqual(errors, []);
});

// Adaptive quality never rebuilds a stream to go up (Agent Note
// 2026-10-21-smooth-playback-first): the step up becomes where the car's
// next stream on the path starts, which Yolo keeps for it.
test("a step up keeps the stream and its buffer; the car's next stream, an agent's, starts at the rate it kept for the relay", { timeout: 240_000 }, async (t) => {
  const { page, errors } = await openPage(await launchBrowser(t, { context: CAR_BROWSER }), yolo.origin);
  const credential = await pair(yolo, page, { kind: "car" });
  const agent = await yolo.agentToken({ name: "Quality agent" });
  const quality = async () => (await yolo.mcp(agent, "get_playback_health", { device: credential.deviceId })).quality;
  const plays = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/v1/playback/play")) plays.push(request.postDataJSON());
  });

  // Nothing kept yet: the relay starts at 1500 kbps.
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0, device: credential.deviceId });
  await waitForFrames(page, "the split files");
  assert.deepEqual(await quality(), { capKbps: 1500, ceilingKbps: 4800, capped: true });
  const playing = await page.evaluate(() => globalThis.__yolo.state.sessionId);

  // 90 seconds of headroom keep 2200 for the next stream; this one plays on.
  await waitFor(page, () => (globalThis.__yoloPlayerLog || []).some((entry) => entry.type === "quality_rate_kept"), null, "a step up kept", 150_000);
  const kept = await page.evaluate(() => globalThis.__yoloPlayerLog.find((entry) => entry.type === "quality_rate_kept"));
  assert.deepEqual([kept.direction, kept.rebuild, kept.maxVideoKbps, kept.path], ["up", false, 2200, "relay"]);
  const after = await page.evaluate(() => ({
    sessionId: globalThis.__yolo.state.sessionId, status: globalThis.__yoloPlayer.player.getStatus(),
    ahead: globalThis.__yoloPlayer.player.getStats().hlsBufferedAheadSeconds,
  }));
  assert.ok(after.sessionId === playing && after.status === "playing" && after.ahead > 60, JSON.stringify(after));
  assert.deepEqual(plays, [], "no new stream asked for");
  // The next report's health.rate reaches the Hub, which keeps it.
  await eventually(() => yolo.workerLog().split(/\n(?=\{)/).some((chunk) => chunk.includes("event: 'rate_kept'")
    && chunk.includes(`deviceId: '${credential.deviceId}'`) && chunk.includes("kbps: 2200")), "the kept rate at the Hub", 30_000);

  // An agent's play is the next stream: at 2200 kbps on the relay, which
  // Plex serves at its checked 1500 kbps rung, 480p.
  const starts = () => plex.calls.filter((call) => call.path.endsWith("/start.m3u8"));
  const before = starts().length;
  await yolo.mcp(agent, "play", { item_id: "plex:7", device: credential.deviceId });
  await waitFor(page, (old) => globalThis.__yolo.state.sessionId !== old && globalThis.__yoloPlayer?.player?.getStatus() === "playing", playing, "the next stream");
  assert.deepEqual(await quality(), { capKbps: 2200, ceilingKbps: 4800, capped: true });
  assert.deepEqual(starts().slice(before).map((call) => [call.params.videoBitrate, call.params.videoResolution]), [["1500", "854x480"]]);
  assert.deepEqual(errors, []);
});

// A decoder that fails mid-item recovers in place, from the buffer (Agent
// Note 2026-04-04-canvas-playback-engine): on 2026-10-21 the car's decoder
// failed with 216 seconds buffered, and the new transcode that replaced
// them stalled. One that keeps failing at the same place climbs the ladder
// to a new stream. The page's decodeErrorAt fault fails the picture's
// decoder once at 16 s.
test("a decoder error recovers in place from the buffer; one that persists climbs to a new stream", { timeout: 180_000 }, async (t) => {
  const { page, errors } = await openPage(await launchBrowser(t, { context: CAR_BROWSER }), `${yolo.origin}/?decodeErrorAt=16`);
  const credential = await pair(yolo, page, { kind: "car" });
  const agent = await yolo.agentToken({ name: "Decoder agent" });
  const plays = [];
  const mediaRequests = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/v1/playback/play")) plays.push(request.postDataJSON());
    if (new URL(request.url()).pathname.startsWith("/m/")) mediaRequests.push(request.url());
  });
  const starts = () => plex.calls.filter((call) => call.path.endsWith("/start.m3u8")).length;
  const recoveries = () => page.evaluate(() => (globalThis.__yoloPlayerLog || []).filter((entry) => entry.type === "decoder_recovery"));
  const engine = () => page.evaluate(() => {
    const { player } = globalThis.__yoloPlayer;
    return { sessionId: globalThis.__yolo.state.sessionId, same: player.canvas.dataset.sameEngine === "true", ahead: player.getStats().hlsBufferedAheadSeconds };
  });

  await yolo.mcp(agent, "play", { item_id: "plex:7", start_at: 10, device: credential.deviceId });
  await playingPast(page, 12, "playing before the fault");
  await page.evaluate(() => { globalThis.__yoloPlayer.player.canvas.dataset.sameEngine = "true"; });
  const before = await engine();
  const startsBefore = starts();

  // Step 1: a new decoder from the buffer, the sound playing on meanwhile.
  await waitFor(page, () => (globalThis.__yoloPlayerLog || []).some((entry) => entry.type === "decoder_recovery"), null, "the decoder's recovery");
  const [restart] = await recoveries();
  assert.deepEqual([restart.step, restart.action, restart.track, restart.cause, restart.outcome], [1, "restart", "video", "error", "recovered"], JSON.stringify(restart));
  assert.ok(restart.at >= 16 && restart.at < 16.5 && restart.elapsedMs < 2_000, JSON.stringify(restart));
  t.diagnostic(`step 1 recovered in ${restart.elapsedMs} ms`);
  assert.deepEqual([restart.failure.name, restart.failure.decoder.reportedError, restart.segments.length], ["EncodingError", true, 1]);
  await playingPast(page, 18, "playing on past the fault", 10_000);
  const after = await engine();
  assert.ok(after.same && after.sessionId === before.sessionId && after.ahead >= before.ahead - 10, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  assert.deepEqual([plays, starts()], [[], startsBefore], "no new stream, no new transcode");

  // A fault that stays at one place: the decoder restarted, the segment
  // fetched again and decoded in software, a skip to the next key frame,
  // and only then a new stream.
  const fault = await page.evaluate(() => {
    const { player } = globalThis.__yoloPlayer;
    const at = Math.ceil(player.getCurrentTime()) + 4;
    const prefetcher = player.hlsSegmentPrefetcher;
    const playlist = [...prefetcher.playlists.values()][0];
    const segment = new URL(playlist.segments[prefetcher.segmentIndexAtTime(playlist, at)].url).pathname;
    player.injectDecodeError(at, { count: 4 });
    return { at, segment };
  });
  await waitFor(page, (old) => globalThis.__yolo.state.sessionId !== old && globalThis.__yoloPlayer?.player?.canvas.dataset.sameEngine !== "true"
    && globalThis.__yoloPlayer.player.getStatus() === "playing", before.sessionId, "the new stream", 60_000);
  const ladder = (await recoveries()).slice(1);
  assert.deepEqual(ladder.map((entry) => [entry.step, entry.action, entry.outcome]), [
    [1, "restart", "failed"], [2, "refetch_software", "failed"], [3, "skip_to_key", "failed"], [4, "new_stream", "requested"],
  ], JSON.stringify(ladder));
  // Each step failed at the place; the skip failed at the next key frame.
  assert.ok(ladder.every((entry) => entry.track === "video") && ladder.slice(0, 3).every((entry) => Math.abs(entry.at - fault.at) < 0.5)
    && ladder[3].at > fault.at, JSON.stringify(ladder));
  const refetched = mediaRequests.filter((url) => new URL(url).pathname === fault.segment);
  assert.deepEqual([refetched.length, new URL(refetched.at(-1)).searchParams.has("prefetch")], [2, false], "fetched ahead, then again from the session");
  assert.deepEqual(plays.map((body) => body.reason), ["recovery"]);
  assert.equal(starts(), startsBefore + 1, "one new transcode");
  const scheduled = await page.evaluate(() => globalThis.__yoloPlayerLog.find((entry) => entry.type === "playback_recovery_scheduled"));
  assert.equal(scheduled.code, "DECODER_FAILED");
  await playingPast(page, fault.at + 1, "the new stream past the place");
  assert.deepEqual(errors, []);
});
