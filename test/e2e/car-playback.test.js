import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { NODE_PROTOCOL, signOperatorRequest } from "@useyolo/core";
import { autoplayMessage, CAR_BROWSER, deviceEvents, eventually, launchBrowser, openPage, pair, playingPast, waitFor } from "./browser.js";
import { fakeYtdlp, makeMedia, mediaOrigin, plexFixture } from "./fixtures.js";
import { fileContext, startYolo } from "./yolo-stack.js";

// The player's car profile, end to end on one stack: Chromium opens the
// control plane's origin (static assets with COOP/COEP), pairs with the device
// code flow as the car (so the canvas engine plays), and plays the four
// stream types through the node's /m/* pipeline — direct (a WebM file), hls,
// dash_split (separate audio and video files) and plex (a Plex fixture's
// transcode) — started by an agent over MCP. The car's window and its layout,
// a wake that plays on muted until a tap, and what an operator's tools read
// from the stack run on the same stack. test/e2e/web-playback.test.js plays
// the same streams in the web profile's <video> engine.
//
// The tests share the stack and run in order: the first one to pair is the
// only screen online when an agent plays without naming a device.

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
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
let mediaDir;
let media;
let plex;
let yolo;

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "yolo-e2e-car-"));
  await makeMedia(mediaDir, { seconds: SECONDS });
  media = await mediaOrigin(shared, mediaDir);
  const ytdlp = await fakeYtdlp(mediaDir, {
    title: "DASH fixture",
    duration: SECONDS,
    requested_formats: [
      { format_id: "v", url: `${media.url}/video.mp4`, vcodec: "avc1.42c00d", acodec: "none", width: 320, height: 180, fps: 30, tbr: 400 },
      { format_id: "a", url: `${media.url}/audio.mp4`, vcodec: "none", acodec: "mp4a.40.2", abr: 128 },
    ],
  });
  plex = await plexFixture(shared, mediaDir, { viewOffset: 3_000, duration: SECONDS * 1000, subtitle: SUBTITLE });
  yolo = await startYolo(shared, {
    pluginConfig: {
      plugins: [
        { source: join(root, "plugins/source-ytdlp"), options: { binary: ytdlp } },
        { source: join(root, "plugins/source-plex"), options: { url: plex.url, token: "fixture-token" } },
      ],
    },
  });
}, { timeout: 120_000 });

after(async () => {
  await shared.cleanup();
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
});

async function carPage(t, { context = {}, autoplay } = {}) {
  const browser = await launchBrowser(t, { context, autoplay });
  return { browser, ...await openPage(browser, yolo.origin) };
}

async function waitForFrames(page, label, minimumTime = 0.5) {
  await waitFor(page, (min) => {
    const player = globalThis.__yoloPlayer?.player;
    return player?.getStats()?.videoFrameRenderCount > 0 && player.getCurrentTime() > min;
  }, minimumTime, label);
}

const mediaPaths = (page, fragment) => page.evaluate((part) => performance.getEntriesByType("resource")
  .map((entry) => new URL(entry.name).pathname)
  .filter((path) => path.startsWith("/m/") && path.includes(part)), fragment);

// --- What an operator's tools read (Agent Note 2026-10-13-agent-deployment) --

test("the Worker reports its version, protocol, migrations, and its path to the node", { timeout: 60_000 }, async () => {
  const healthz = await fetch(`${yolo.origin}/healthz`);
  assert.equal(healthz.status, 200);
  assert.match(healthz.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await healthz.json(), { ok: true, version });

  const open = await (await fetch(`${yolo.origin}/.well-known/yolo`)).json();
  assert.equal(open.version, version);
  assert.equal(open.protocol, NODE_PROTOCOL);
  assert.match(open.migrations.required, /^\d{4}_/);
  // The e2e database also has the stack's owner seed, numbered after every real migration.
  assert.equal(open.migrations.applied, "9999_e2e_owner");
  assert.equal(open.operator, undefined);

  const headers = await signOperatorRequest(yolo.secret, { path: "/.well-known/yolo" });
  const signed = await (await fetch(`${yolo.origin}/.well-known/yolo`, { headers })).json();
  assert.deepEqual(signed.operator.node, { reachable: true, version, protocol: NODE_PROTOCOL, error: null });
  assert.equal(signed.operator.owner.passkey, false);
});

test("yolo doctor checks a running stack end to end", { timeout: 60_000 }, async () => {
  // The stack's instance: its node port and NODE_SECRET; the Worker is local.
  const instance = join(yolo.dir, "yolo.instance.json");
  const envFile = join(yolo.dir, "doctor.env");
  writeFileSync(instance, JSON.stringify({ version: 1, domain: "yolo.example.com", node: { port: yolo.nodePort } }));
  writeFileSync(envFile, `NODE_SECRET=${yolo.secret}\nNODE_PORT=${yolo.nodePort}\nPUBLIC_ORIGIN=https://yolo.example.com\n`);
  const { stdout } = await exec(process.execPath, [cli, "doctor", "--offline", "--origin", yolo.origin, "--json"], {
    env: { ...process.env, YOLO_INSTANCE: instance, YOLO_ENV_FILE: envFile },
  }).catch((error) => error);
  const result = JSON.parse(stdout);
  const check = (id) => result.checks.find((entry) => entry.id === id);
  assert.equal(check("node.health").status, "ok", JSON.stringify(check("node.health")));
  assert.equal(check("worker.reachable").status, "ok");
  assert.equal(check("worker.isolation").status, "ok", JSON.stringify(check("worker.isolation")));
  assert.equal(check("worker.node").status, "ok", JSON.stringify(check("worker.node")));
  assert.equal(check("worker.owner").status, "warn");
  assert.match(check("worker.owner").fix, /owner-code/);
  assert.equal(check("versions.match").status, "ok");
  assert.equal(check("versions.protocol").status, "ok");
  assert.deepEqual(result.versions, { checkout: version, worker: version, node: version });
  // The instance has no Cloudflare ids yet, so doctor says what to provision.
  assert.equal(check("config.d1.id").status, "fail");
  assert.match(check("config.d1.id").fix, /provision d1/);
  assert.equal(check("cloudflare").status, "skip");
});

// --- The car profile --------------------------------------------------------

test("an agent plays direct, hls and dash_split streams on the paired car, which recovers, controls, and can be revoked", { timeout: 300_000 }, async (t) => {
  const { page, errors } = await carPage(t);

  // The site root is the player, cross-origin isolated (SharedArrayBuffer).
  const home = await fetch(yolo.origin);
  assert.equal(home.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(home.headers.get("cross-origin-embedder-policy"), "credentialless");
  assert.equal((await fetch(`${yolo.origin}/play`)).headers.get("cross-origin-embedder-policy"), "credentialless", "client routes too");
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);

  // Pair as the owner would, with "car" as its type: the car's profile and
  // its canvas engine.
  await page.waitForSelector("#pair-qr svg", { timeout: 20_000 });
  const credential = await pair(yolo, page, { kind: "car" });
  assert.equal(await page.evaluate(() => globalThis.__yolo.profile.engine), "canvas");
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
  await page.waitForFunction(() => globalThis.__yoloPlayer?.player?.getCurrentTime() > 4.25
    && !document.querySelector(".playback-transition-frame"), null, { timeout: 20_000 });
  // Let the delayed requests in flight finish before the routes go.
  await page.unrouteAll({ behavior: "wait" });

  // An error nothing will fix by itself: one sentence, and Try again plays
  // on from there.
  await page.evaluate(() => {
    const { player } = globalThis.__yoloPlayer;
    player.canvas.dataset.oldPlayer = "true";
    player.fail(Object.assign(new Error("Upstream answered 403"), { code: "UPSTREAM_ACCESS_DENIED" }));
  });
  await waitFor(page, () => !document.getElementById("playback-error").classList.contains("hidden"), null, "the error panel");
  assert.equal(await page.locator("#playback-error-text").innerText(), "This video can't play right now.");
  assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /403|Upstream/);
  await page.locator("#btn-playback-retry").click();
  await waitFor(page, () => !globalThis.__yoloPlayer?.player?.canvas.dataset.oldPlayer
    && globalThis.__yoloPlayer.player.getStatus() === "playing"
    && document.getElementById("playback-error").classList.contains("hidden"), null, "playing after Try again", 45_000);

  // Agent controls reach the car.
  await yolo.mcp(agent, "control", { action: "pause" });
  await page.waitForFunction(() => globalThis.__yoloPlayer?.player?.getStatus() === "paused", null, { timeout: 10_000 });
  await yolo.mcp(agent, "seek", { position_seconds: 1 });
  await page.waitForFunction(() => Math.abs(globalThis.__yoloPlayer.player.getCurrentTime() - 1) < 0.5, null, { timeout: 10_000 });
  const status = await yolo.mcp(agent, "get_status");
  assert.equal(status.playback.deviceId, credential.deviceId);
  assert.equal(status.playback.status, "paused");

  // A paused stream that fails recovers once, still paused: the new stream's
  // recovery is confirmed at once, so no retry follows.
  const plays = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/v1/playback/play")) plays.push(request.postDataJSON());
  });
  const logged = await page.evaluate(() => globalThis.__yoloPlayerLog.length);
  await page.evaluate(() => {
    const { player } = globalThis.__yoloPlayer;
    player.canvas.dataset.oldPlayer = "true";
    player.fail(new Error("network fixture failure"));
  });
  await waitFor(page, (from) => {
    const player = globalThis.__yoloPlayer?.player;
    return player?.getStatus() === "paused" && !player.canvas.dataset.oldPlayer
      && globalThis.__yoloPlayerLog.slice(from).some((entry) => entry.type === "playback_recovery_confirmed");
  }, logged, "the paused recovery");
  assert.deepEqual(plays.map((body) => [body.reason, body.autoplay]), [["recovery", false]]);
  assert.deepEqual(errors, []);

  // A second window of the same screen takes over; the first can take it back.
  const second = await page.context().newPage();
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
  await page.waitForFunction(() => /^[B-Z]{4}-[B-Z]{4}$/.test(document.getElementById("pair-code")?.textContent || "")
    && !document.getElementById("pair-screen").classList.contains("hidden"), null, { timeout: 20_000 });
  assert.equal(await page.evaluate(() => localStorage.getItem("yolo.device")), null);
});

test("Plex plays through the node, resumes at Plex's own position, and switches text subtitles in place", { timeout: 240_000 }, async (t) => {
  const { page, errors } = await carPage(t);
  const credential = await pair(yolo, page, { kind: "car" });

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
    const player = globalThis.__yoloPlayer.player;
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
    const player = globalThis.__yoloPlayer?.player;
    return player && !player.canvas.dataset.oldPlayer && player.getStatus() === "playing";
  }, null, { timeout: 30_000 });
  const restarts = plex.calls.filter((call) => call.path.endsWith("/start.m3u8"));
  assert.equal(restarts.length, startsBefore + 1, "one new transcode");
  assert.ok(Number(restarts.at(-1).params.offset) >= 3, "at the position reached");

  // Leaving stops the transcode and keeps the position for next time.
  await page.waitForFunction(() => globalThis.__yoloPlayer.player.getCurrentTime() > 4, null, { timeout: 15_000 });
  await page.evaluate(() => document.getElementById("btn-back").click());
  await page.waitForFunction(() => location.pathname === "/", null, { timeout: 10_000 });
  await eventually(() => plex.calls.some((call) => call.path === "/video/:/transcode/universal/stop"), "the transcode stop", 20_000);
  const history = await yolo.api(credential.token, "/v1/history");
  assert.ok(history.body[0].position > 3, JSON.stringify(history.body[0]));
  assert.deepEqual(errors, []);
});

test("an agent finds a line in the transcript, seeks there, and reads the screen's playback health", { timeout: 180_000 }, async (t) => {
  const { page, errors } = await carPage(t);
  const credential = await pair(yolo, page, { kind: "car" });
  const agent = await yolo.agentToken();
  await yolo.mcp(agent, "play", { item_id: "plex:7", device: credential.deviceId, start_at: 0 });
  await waitForFrames(page, "plex", 1);

  // The transcript comes from the playing session's text subtitle.
  const found = await yolo.mcp(agent, "search_transcript", { query: "Lighthouse keeper" });
  assert.deepEqual(found.track, { id: "plex:21", language: "eng", name: "English" });
  assert.deepEqual(found.matches, [{ at: 40, time: "0:40", text: "The lighthouse keeper waves" }]);
  const transcript = await yolo.mcp(agent, "get_transcript", { from_seconds: 30, to_seconds: 100 });
  assert.equal(transcript.text, "0:40 The lighthouse keeper waves\n1:30 Back to the harbour");

  await yolo.mcp(agent, "seek", { position_seconds: found.matches[0].at });
  await playingPast(page, 40.5, "after the seek to the match");

  // The player's reports carry its buffer and engine to the Hub.
  const health = await eventually(async () => {
    const value = await yolo.mcp(agent, "get_playback_health");
    return value.engine ? value : null;
  }, "the player's health report", 30_000);
  assert.equal(health.engine, "canvas");
  assert.equal(health.device.id, credential.deviceId);
  assert.equal(health.path.now, "relay");
  assert.equal(health.stream.delivery, "hls");
  assert.ok(health.buffer && health.hints.length, JSON.stringify(health));
  assert.deepEqual(errors, []);
});

// The player in the car's window as the car reported it on 2026-10-12: a
// 773x601 window at devicePixelRatio 1.53 that ends above the car's app
// dock, in a Chrome that ignores the viewport meta. The display size zooms
// the page (Agent Note 2026-10-11-display-size); the controls sit on the
// window's bottom edge and the picture is centred
// (Agent Note 2026-07-13-in-car-design-principles).

// Where things are on screen, in the window's CSS px (what a tap uses).
const geometry = (page) => page.evaluate(() => {
  const box = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
  const canvas = document.querySelector('#player-container canvas[data-engine="mediabunny"]');
  const frame = canvas.getBoundingClientRect();
  // The picture object-fit: contain draws inside the canvas box.
  const fit = Math.min(frame.width / canvas.width, frame.height / canvas.height);
  const picture = { top: frame.top + (frame.height - canvas.height * fit) / 2, height: canvas.height * fit };
  picture.bottom = picture.top + picture.height;
  return {
    innerWidth, innerHeight, devicePixelRatio,
    layoutWidth: document.body.clientWidth,
    appWidth: document.getElementById("app").clientWidth,
    zoom: getComputedStyle(document.documentElement).zoom,
    meta: document.querySelector('meta[name="viewport"]').content,
    picture,
    back: box("btn-back"),
    progress: box("progress-wrap"),
    row: box("controls-row"),
    controls: box("controls-bottom"),
    volume: { ...box("btn-volume"), cssHeight: document.getElementById("btn-volume").offsetHeight },
  };
});

const showControls = async (page) => {
  await page.mouse.move(380, 260);
  await page.mouse.move(400, 280);
  await waitFor(page, () => document.getElementById("app").classList.contains("controls-visible"), null, "the controls");
};

test("in the car's window the picture is centred, the controls sit on the bottom edge, and Default lays out 946 CSS px wide", { timeout: 240_000 }, async (t) => {
  const { page, errors } = await carPage(t, { context: CAR_BROWSER });
  const credential = await pair(yolo, page, { kind: "car" });

  // Default: a zoom of 1.25 / 1.53 on the root, so the page lays out
  // 773 / 0.817 = 946 CSS px wide; the window and its pixel ratio stay.
  await waitFor(page, () => Math.abs(document.body.clientWidth - 946) <= 1, null, "the default display size");
  const played = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST", body: { url: `${media.url}/hls/index.m3u8`, startTime: 20, deviceId: credential.deviceId },
  });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  await playingPast(page, 20.5, "playing in the car's window");
  const agent = await yolo.agentToken();
  await yolo.mcp(agent, "control", { action: "pause" });
  await waitFor(page, () => globalThis.__yoloPlayer.player.getStatus() === "paused", null, "paused");
  await showControls(page);

  const at = await geometry(page);
  assert.deepEqual([at.innerWidth, at.innerHeight, Math.round(at.devicePixelRatio * 100) / 100], [773, 601, 1.53]);
  assert.deepEqual([at.zoom, at.layoutWidth, at.appWidth, at.meta], ["0.817", 946, 946, "width=device-width, initial-scale=1.0"]);
  // Every control keeps its 48 CSS px target: about 60 physical pixels.
  assert.equal(at.volume.cssHeight, 48);
  assert.ok(Math.abs(at.volume.height * at.devicePixelRatio - 60) < 1, JSON.stringify(at.volume));

  // (a) The 16:9 picture is centred in the window: equal bands above and
  // below. The controls end on the window's bottom edge (only the 8 CSS px
  // margin under the row), the progress bar meets the picture's lower edge
  // instead of floating over it, and the back arrow sits in the band above.
  const bandAbove = at.picture.top;
  const bandBelow = at.innerHeight - at.picture.bottom;
  assert.ok(Math.abs(bandAbove - bandBelow) <= 1 && bandAbove > 60, JSON.stringify(at.picture));
  assert.equal(at.controls.bottom, at.innerHeight);
  assert.ok(at.innerHeight - at.row.bottom <= 8 * 0.817 + 0.5, `the row ends ${at.innerHeight - at.row.bottom} px above the window's bottom`);
  assert.ok(at.progress.top >= at.picture.bottom - at.progress.height, `the progress bar starts at ${at.progress.top}, the picture ends at ${at.picture.bottom}`);
  assert.ok(at.back.bottom <= at.picture.top, JSON.stringify(at.back));

  // (b) Taps land where they are drawn: the hit test at each control's
  // centre finds it, and a tap on the volume button presses it.
  await showControls(page);
  for (const id of ["btn-volume", "btn-back", "progress-wrap", "btn-center-play"]) {
    const hit = await page.evaluate((target) => {
      const box = document.getElementById(target).getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(`#${target}`)?.id ?? null;
    }, id);
    assert.equal(hit, id);
  }
  const muted = () => page.evaluate(() => document.getElementById("btn-volume").classList.contains("muted"));
  const wasMuted = await muted();
  await showControls(page);
  await page.locator("#btn-volume").tap();
  assert.equal(await muted(), !wasMuted);

  // Dragging the seek bar seeks to the point under the finger: 76% of the
  // bar is 91.2 seconds into the 120-second item.
  await showControls(page);
  const bar = (await geometry(page)).progress;
  const y = bar.top + bar.height / 2;
  await page.mouse.move(bar.left + bar.width * 0.1, y);
  await page.mouse.down();
  for (const fraction of [0.3, 0.5, 0.76]) await page.mouse.move(bar.left + bar.width * fraction, y, { steps: 4 });
  const preview = await page.locator("#time-current").innerText();
  await page.mouse.up();
  assert.equal(preview, "1:31");
  await waitFor(page, () => Math.abs(globalThis.__yoloPlayer.player.getCurrentTime() - 91.2) < 2.5, null, "the seek to 1:31");

  // A tap on the centre button resumes from there.
  await showControls(page);
  await page.locator("#btn-center-play").tap();
  await playingPast(page, 91.5, "playing after the tap");

  // The subtitle menu opens between the top bar and the controls.
  await page.evaluate(() => globalThis.__yolo.applyTracks({
    audio: [], subtitles: [{ id: "en", name: "English", language: "en", delivery: "vtt" }, { id: "zh", name: "中文", language: "zh-Hans", delivery: "vtt" }],
  }, { audio: null, subtitles: [] }));
  await showControls(page);
  await page.locator("#btn-subs").tap();
  const menu = await page.evaluate(() => document.getElementById("subs-panel").getBoundingClientRect().toJSON());
  const now = await geometry(page);
  assert.ok(menu.height > 0 && menu.top >= now.back.bottom && menu.bottom <= now.progress.top, JSON.stringify({ menu, back: now.back, progress: now.progress }));
  assert.deepEqual(errors, []);

  // Yolo hears of the screen in physical pixels (1183 across), and the
  // display_scale event says how the size applied.
  const events = (type) => deviceEvents(yolo, type, credential.deviceId);
  await eventually(() => events("display_scale").some((event) => event.includes("honoured: true")), "display_scale in the logs", 25_000);
  const scaled = events("display_scale").find((event) => event.includes("honoured: true"));
  for (const field of ["method: 'zoom'", "scale: 1.25", "zoom: 0.817", "width: 946", "layoutWidth: 946", "physicalWidth: 1183", "innerWidth: 773"]) assert.ok(scaled.includes(field), `${field} in ${scaled}`);
  await eventually(() => events("stream_selected").length > 0, "stream_selected in the logs", 25_000);
  assert.match(events("stream_selected")[0], /physicalWidth: 1183/);

  // Largest is the browser's own scale: no zoom, and the controls still
  // sit on the bottom edge.
  await page.evaluate(() => globalThis.__yolo.displayScale.choose("native"));
  await waitFor(page, () => document.body.clientWidth === 773 && getComputedStyle(document.documentElement).zoom === "1", null, "the largest size");
  await showControls(page);
  const largest = await geometry(page);
  assert.ok(largest.innerHeight - largest.row.bottom <= 8.5, JSON.stringify(largest.row));
});

// The car wakes like Spotify (2026-10-12): it plays on by itself where it
// was, with sound when the browser allows it and muted with "Tap for sound"
// otherwise. The owner gave this car the type of a browser: the Tesla
// fingerprint still makes it play with the canvas engine, never <video>
// (Agent Note 2026-10-12-two-playback-engines).
test("a Tesla paired as a browser plays with the canvas engine, wakes, and plays on by itself, muted until a tap", { timeout: 240_000 }, async (t) => {
  // Chromium's real autoplay policy for a site without media engagement:
  // no sound before a tap on the page.
  const { browser: context, page: first, errors: firstErrors } = await carPage(t, { context: CAR_BROWSER, autoplay: "gesture" });
  const credential = await pair(yolo, first, { kind: "browser" });
  assert.deepEqual(await first.evaluate(() => [globalThis.__yolo.profile.name, globalThis.__yolo.profile.engine]), ["web", "canvas"]);
  const { body: { devices } } = await yolo.api(credential.token, "/v1/devices");
  assert.equal(devices.find((device) => device.id === credential.deviceId).capabilities.renderer, "canvas-webcodecs");

  // Pairing above had the page polled, which counts as a user activation
  // in Playwright: this first stream starts with sound.
  const autoplayed = autoplayMessage(first);
  const played = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST", body: { url: `${media.url}/hls/index.m3u8`, startTime: 0, deviceId: credential.deviceId },
  });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  assert.equal(await autoplayed, "sound");
  await playingPast(first, 2.5, "playing before sleeping");
  assert.deepEqual(firstErrors, []);

  // The car sleeps: the page and its connection go away. The Hub keeps the
  // place and marks that it was playing.
  await first.close();
  const saved = await eventually(async () => {
    const { body } = await yolo.api(credential.token, "/v1/playback");
    return body.status === "paused" && body.interruptedAt ? body : null;
  }, "the Hub to keep the place", 15_000);

  // It wakes (a fresh page with the same credential, no tap on it yet):
  // playing again by itself, from where it was. The browser blocks sound
  // without a tap, so it plays muted.
  const { page, errors, before: woke } = await openPage(context, yolo.origin, { onPage: (fresh) => autoplayMessage(fresh) });
  assert.equal(await woke, "muted");
  assert.equal(await page.evaluate(() => globalThis.__yoloPlayer.player.audioContext.state), "suspended");
  await playingPast(page, saved.position + 0.5, "playing again after the wake", 45_000);
  assert.equal(await page.evaluate(() => !document.getElementById("btn-tap-sound").classList.contains("hidden")), true, "Tap for sound");
  assert.equal(await page.evaluate(() => document.getElementById("overlay").classList.contains("hidden")), true, "no status screen");

  // The first tap anywhere brings the sound; playback goes on.
  await page.mouse.click(400, 200);
  await waitFor(page, () => globalThis.__yoloPlayer?.player?.audioOutputState === "running"
    && document.getElementById("btn-tap-sound").classList.contains("hidden")
    && globalThis.__yoloPlayer.player.audioContext.state === "running", null, "sound after a tap");
  const unlockedAt = await page.evaluate(() => globalThis.__yoloPlayer.player.getCurrentTime());
  await playingPast(page, unlockedAt + 0.5, "playing with sound");
  assert.deepEqual(errors, []);
});
