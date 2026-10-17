import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { fakeYtdlp, makeMedia, mediaOrigin, plexFixture } from "./fixtures.js";
import {
  actHereWhileDead, askForQuality, CHROMIUM_EXECUTABLE, deviceEvents, eventually, launchBrowser, loseLoad, loseMessage, loseSeekLoad, openPage, pair, playingPast,
  playsHubStream, seekDuringSeek, seekPlayed, stallOnSeekStream, staysPaused, waitFor,
} from "./browser.js";
import { fileContext, OWNER, startYolo } from "./yolo-stack.js";

// The player's web profile, Yolo Web, end to end on one stack
// (Agent Notes 2026-10-11-yolo-web-client and 2026-10-12-two-playback-engines):
// in a computer's browser the four stream types play through the browser's
// own <video> element (hls.js for HLS in Chromium), with seeks, pause and
// resume, Yolo's subtitles drawn over the picture, a track switch, and
// recovery after a 410; Back leaves the item in the now-playing bar; a
// browser pairs with the owner's passkey and plays at desktop and phone
// sizes; and owner settings sit behind the passkey session. The owner's
// passkey ceremony is stood in for by the session it leaves behind
// (yolo.ownerSession). The car's canvas engine plays the same streams in
// car-playback.test.js.
//
// The tests share the stack and run in order: the first one to pair is the
// only screen online when an agent plays without naming a device, and owner
// settings come last, because signing out there ends the owner's session.
//
// YOLO_E2E_WEBKIT=1 also runs the stream types and Plex in Playwright's
// WebKit, Safari's engine, where HLS plays natively
// (PLAYWRIGHT_WEBKIT_EXECUTABLE names a WebKit build other than Playwright's
// own).

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SECONDS = 120;
const PHONE_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36";
const PASSKEY_SEED = `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
  VALUES ('e2e-passkey', '${OWNER}', 'x', 0, '["internal"]', 'multiDevice', 1, 'E2E passkey', 0);\n`;

const shared = fileContext();
let mediaDir;
let media;
let plex;
let yolo;

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "yolo-e2e-web-"));
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
  plex = await plexFixture(shared, mediaDir, { viewOffset: 3_000, duration: SECONDS * 1000, commentary: true });
  yolo = await startYolo(shared, {
    seed: PASSKEY_SEED,
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

const engineOf = (page) => page.evaluate(() => ({
  engine: globalThis.__yoloPlayer?.engine ?? null,
  mode: globalThis.__yoloPlayer?.player?.mode ?? null,
  video: Boolean(document.querySelector('#player-container video[data-engine="native"]')),
  canvas: Boolean(document.querySelector('#player-container canvas[data-engine="mediabunny"]')),
}));

const currentTime = (page) => page.evaluate(() => globalThis.__yoloPlayer?.player?.getCurrentTime() ?? null);

const statusIs = (page, status, label) => waitFor(page, (wanted) => globalThis.__yoloPlayer?.player?.getStatus() === wanted, status, label);

// An agent's commands a moment apart: every command costs the page an
// acknowledgement and a report or two, and the Hub closes a socket that
// sends more than 30 messages in 10 seconds.
async function agentSays(agent, tool, args) {
  const result = await yolo.mcp(agent, tool, args);
  await new Promise((done) => setTimeout(done, 1_200));
  return result;
}

const mediaPaths = (page, fragment) => page.evaluate((part) => performance.getEntriesByType("resource")
  .map((entry) => new URL(entry.name).pathname)
  .filter((path) => path.startsWith("/m/") && path.includes(part)), fragment);

// iPhone, stood in for in Playwright's WebKit, which is macOS's: no element
// fullscreen, and the <video> element's own fullscreen is the system's
// player, which announces itself with webkitbeginfullscreen. (On a Mac,
// WebKit takes the element fullscreen there and sends no such event.)
function iPhoneFullscreen() {
  for (const name of ["fullscreenEnabled", "webkitFullscreenEnabled"]) {
    Object.defineProperty(Document.prototype, name, { configurable: true, get: () => false });
  }
  globalThis.__systemPlayer = { entered: 0 };
  HTMLVideoElement.prototype.webkitEnterFullscreen = function enterSystemPlayer() {
    globalThis.__systemPlayer.entered += 1;
    this.dispatchEvent(new Event("webkitbeginfullscreen"));
  };
}

// A browser playing as Yolo Web (no type given: the web profile). `init`
// runs in the page before its own scripts.
async function webPage(t, options = {}) {
  const context = await launchBrowser(t, options);
  if (options.init) await context.addInitScript(options.init);
  const opened = await openPage(context, yolo.origin);
  const credential = await pair(yolo, opened.page);
  await waitFor(opened.page, () => globalThis.__yolo.profile.engine === "native", null, "the <video> engine");
  return { ...opened, context, credential };
}

// A browser with its own window, for sizes other than launchBrowser's.
async function browserWith(t, options) {
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_EXECUTABLE, args: ["--autoplay-policy=no-user-gesture-required"] });
  t.after(() => browser.close());
  const context = await browser.newContext(options);
  return context;
}

// The owner signed in with a passkey on this browser. (A host-only cookie:
// Chromium refuses a __Host- cookie added by URL on plain http.)
const signIn = (context) => context.addCookies([{
  name: yolo.ownerSession.name, value: yolo.ownerSession.value, domain: new URL(yolo.origin).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax",
}]);

const devicesOf = async (token) => (await yolo.api(token, "/v1/devices")).body.devices;

async function playsStreamTypes(t, { engine = "chromium" } = {}) {
  const { page, errors, credential } = await webPage(t, { engine });
  const agent = await yolo.agentToken();
  const hlsPath = engine === "webkit" ? "native-hls" : "hls.js";
  const events = (type) => deviceEvents(yolo, type, credential.deviceId);

  // The device said it plays through <video>, with its own codecs.
  const { devices } = await yolo.mcp(agent, "list_devices");
  const device = devices.find((candidate) => candidate.id === credential.deviceId);
  assert.equal(device.capabilities.renderer, "html5-video");
  assert.ok(device.capabilities.video.includes("avc1") && device.capabilities.audio.includes("mp4a"), JSON.stringify(device.capabilities));

  // direct: a progressive file, read by the element with byte ranges.
  // (WebKit plays no WebM: an MP4 there.)
  const directUrl = engine === "webkit" ? `${media.url}/video.mp4` : `${media.url}/clip.webm`;
  await yolo.mcp(agent, "play", { url: directUrl, start_at: 0, device: credential.deviceId });
  await playingPast(page, 1, "direct");
  assert.deepEqual(await engineOf(page), { engine: "native", mode: "progressive", video: true, canvas: false });
  assert.match(await page.evaluate(() => document.querySelector('#player-container video[data-engine="native"]').currentSrc), /\/m\/[^/]+\/f\/\d+$/, "the element reads the file through /m/");

  // Pause and resume from an agent, then a seek.
  await agentSays(agent, "control", { action: "pause" });
  await statusIs(page, "paused", "direct paused");
  const pausedAt = await currentTime(page);
  await new Promise((done) => setTimeout(done, 1_000));
  assert.ok(Math.abs(await currentTime(page) - pausedAt) < 0.1, "paused means paused");
  await agentSays(agent, "control", { action: "resume" });
  await playingPast(page, pausedAt + 0.5, "direct resumed");
  await agentSays(agent, "seek", { position_seconds: 60 });
  await playingPast(page, 60.5, "direct after a seek");
  assert.ok(await currentTime(page) < 70);

  // hls: hls.js (or the browser's own HLS), a seek inside the stream.
  await yolo.mcp(agent, "play", { url: `${media.url}/hls/index.m3u8`, start_at: 0, device: credential.deviceId });
  await playingPast(page, 1, "hls");
  assert.equal((await engineOf(page)).mode, hlsPath);
  const hlsSession = await page.evaluate(() => globalThis.__yolo.state.sessionId);
  await agentSays(agent, "seek", { position_seconds: 90 });
  await playingPast(page, 90.5, "hls after a seek");
  assert.equal(await page.evaluate(() => globalThis.__yolo.state.sessionId), hlsSession, "a seek inside the stream keeps it");

  // dash_split: separate files joined into fMP4 HLS with an audio rendition.
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0, device: credential.deviceId });
  await playingPast(page, 1, "dash_split");
  assert.equal((await engineOf(page)).mode, hlsPath);
  if (engine !== "webkit") {
    const dashPaths = await mediaPaths(page, "/dash/");
    assert.ok(dashPaths.some((path) => path.endsWith("/dash/master.m3u8")), JSON.stringify(dashPaths));
    assert.ok(dashPaths.some((path) => path.includes("/dash/audio/")), "the audio rendition is fetched");
  }
  await agentSays(agent, "control", { action: "pause" });
  await statusIs(page, "paused", "dash_split paused");
  await agentSays(agent, "seek", { position_seconds: 50 });
  await waitFor(page, () => Math.abs(globalThis.__yoloPlayer.player.getCurrentTime() - 50) < 0.5, null, "dash_split seeked while paused");
  await agentSays(agent, "control", { action: "resume" });
  await playingPast(page, 50.5, "dash_split resumed after a seek");
  const status = await yolo.mcp(agent, "get_status");
  assert.equal(status.playback.status, "playing");
  assert.deepEqual(errors, []);

  // The events say which engine played, and what the picture really was.
  await eventually(() => events("stream_first_frame").length >= 3, "first frames in the logs", 25_000);
  assert.ok(events("stream_selected").every((event) => event.includes("engine: 'native'")));
  assert.ok(events("stream_first_frame").every((event) => event.includes("engine: 'native'") && event.includes("width: 320")));
  return { page };
}

test("direct, hls and dash_split play in the browser's <video> element, with seeks and pauses", { timeout: 300_000 }, async (t) => {
  const { page } = await playsStreamTypes(t);

  // What <video> gives for free: Picture-in-Picture and fullscreen buttons,
  // and the system's media controls.
  const offered = await page.evaluate(() => ({
    pip: !document.getElementById("btn-pip").classList.contains("hidden"),
    pipSupported: document.pictureInPictureEnabled === true,
    fullscreen: !document.getElementById("btn-fullscreen").classList.contains("hidden"),
    title: navigator.mediaSession?.metadata?.title ?? null,
    playing: navigator.mediaSession?.playbackState ?? null,
  }));
  assert.equal(offered.pip, offered.pipSupported);
  assert.equal(offered.fullscreen, true);
  assert.equal(offered.title, "DASH fixture");
  assert.equal(offered.playing, "playing");
  await page.locator("#btn-fullscreen").click({ force: true });
  await waitFor(page, () => document.fullscreenElement?.id === "app", null, "the player in fullscreen");
  assert.equal(await page.evaluate(() => document.getElementById("controls").closest("#app") === document.fullscreenElement), true, "Yolo's controls stay");
  await page.locator("#btn-fullscreen").click({ force: true });
  await waitFor(page, () => !document.fullscreenElement, null, "fullscreen left");
});

async function playsPlex(t, { engine = "chromium", iPhone = false } = {}) {
  const { page, errors, credential } = await webPage(t, { engine, init: iPhone ? iPhoneFullscreen : null });
  const plays = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/v1/playback/play")) plays.push(request.postDataJSON());
  });
  const starts = () => plex.calls.filter((call) => call.path.endsWith("/start.m3u8"));
  const startsAtFirst = starts().length;

  // No Yolo history for it: Plex's own position (3 s).
  await yolo.api(credential.token, "/v1/history", { method: "DELETE", body: { sourceKey: "plex:7" } });
  const played = await yolo.api(credential.token, "/v1/playback/play", { method: "POST", body: { itemId: "plex:7", deviceId: credential.deviceId } });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  assert.equal(played.body.state.position, 3);
  await playingPast(page, 3, "plex");
  assert.equal((await engineOf(page)).mode, engine === "webkit" ? "native-hls" : "hls.js");

  // A text subtitle, drawn by Yolo over the <video> picture.
  const tracks = await yolo.api(credential.token, "/v1/playback/tracks", { method: "PUT", body: { subtitles: ["plex:21"] } });
  assert.equal(tracks.status, 200, JSON.stringify(tracks.body));
  await waitFor(page, () => document.getElementById("subtitle-overlay").textContent.includes("Fixture subtitle"), null, "the subtitle");
  const layout = await page.evaluate(() => {
    const video = document.querySelector('#player-container video[data-engine="native"]');
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const picture = { left: box.left + (box.width - video.videoWidth * scale) / 2, width: video.videoWidth * scale, top: box.top + (box.height - video.videoHeight * scale) / 2, height: video.videoHeight * scale };
    const line = document.querySelector("#subtitle-overlay .subtitle-line").getBoundingClientRect();
    const overlay = document.getElementById("subtitle-overlay");
    return {
      picture, line: line.toJSON(), above: Number(getComputedStyle(overlay).zIndex) > Number(getComputedStyle(video).zIndex) || overlay.compareDocumentPosition(video) === Node.DOCUMENT_POSITION_PRECEDING,
      captionsShown: Array.from(video.textTracks).filter((track) => track.mode === "showing").length,
    };
  });
  assert.ok(layout.line.left >= layout.picture.left - 1 && layout.line.right <= layout.picture.left + layout.picture.width + 1, JSON.stringify(layout));
  assert.ok(layout.line.bottom <= layout.picture.top + layout.picture.height + 1 && layout.line.top >= layout.picture.top, JSON.stringify(layout));
  assert.equal(layout.above, true, "the subtitle is above the picture");
  assert.equal(layout.captionsShown, 0, "not the browser's own captions");
  assert.equal(starts().length, startsAtFirst + 1, "no second transcode");

  if (iPhone) {
    // The fullscreen button opens the system's player, where the subtitle
    // is the element's own text track, on the stream's timeline; back from
    // it, Yolo draws the subtitle again and the element shows none.
    assert.equal(await page.evaluate(() => document.getElementById("btn-fullscreen").classList.contains("hidden")), false, "a fullscreen button");
    await page.locator("#btn-fullscreen").click({ force: true });
    await waitFor(page, () => globalThis.__systemPlayer.entered === 1, null, "the system's player");
    const captions = () => page.evaluate(() => {
      const { player } = globalThis.__yoloPlayer;
      return Array.from(player.video.textTracks).filter((track) => track.mode === "showing")
        .map((track) => ({ kind: track.kind, cues: Array.from(track.cues, (cue) => [Math.round(cue.endTime + player.offset), cue.text]) }));
    });
    assert.deepEqual(await captions(), [{ kind: "subtitles", cues: [[12, "Fixture subtitle"]] }]);
    await page.evaluate(() => globalThis.__yoloPlayer.player.video.dispatchEvent(new Event("webkitendfullscreen")));
    assert.deepEqual(await captions(), []);
  }

  // An audio track switch rebuilds the stream through Yolo, at the place
  // reached. It goes to the track not playing: Yolo starts the item with
  // the audio chosen for it last, which the journey before on this stack
  // may have chosen. From here segments arrive slowly (still faster than
  // they play), so the browser is still fetching ahead when Plex drops the
  // transcode below.
  const audio = played.body.state.tracks?.audio === "plex:12" ? "plex:11" : "plex:12";
  await page.route(/\/m\/[^/]+\/f\//, async (route) => {
    await new Promise((done) => setTimeout(done, 300));
    await route.continue();
  });
  const before = await currentTime(page);
  const switched = await yolo.api(credential.token, "/v1/playback/tracks", { method: "PUT", body: { audio } });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  await eventually(() => starts().length === startsAtFirst + 2, "the new transcode");
  assert.equal(starts().at(-1).params.audioStreamID, audio.slice("plex:".length));
  await playingPast(page, before, "playing on with the chosen audio");

  // Plex drops the transcode (as after a long pause). The browser is still
  // fetching ahead (slowly, as routed above), so its next segment is a 410,
  // and the player asks Yolo for a new stream where playback is.
  const clearedAt = await currentTime(page);
  const startsBefore = starts().length;
  plex.sessions.clear();
  await eventually(() => starts().length === startsBefore + 1, "a new transcode after the 410", 45_000);
  const recovery = plays.find((body) => body.reason === "recovery");
  assert.ok(recovery && recovery.startTime >= clearedAt - 1 && recovery.startTime < SECONDS, JSON.stringify({ clearedAt, plays }));
  await playingPast(page, recovery.startTime + 0.5, "playing again after the 410", 45_000);
  await eventually(() => deviceEvents(yolo, "session_expired", credential.deviceId).length > 0, "session_expired in the logs", 25_000);
  assert.equal(await page.evaluate(() => document.getElementById("playback-error").classList.contains("hidden")), true, "no error shown");

  // Back keeps the player and its transcode for the now-playing bar, with
  // the position saved; a stop ends the transcode.
  const stops = () => plex.calls.filter((call) => call.path === "/video/:/transcode/universal/stop").length;
  const stopsBefore = stops();
  await page.evaluate(() => document.getElementById("btn-back").click());
  await waitFor(page, () => location.pathname === "/" && !globalThis.__yoloPlayer, null, "home, with the player kept");
  await eventually(async () => (await yolo.api(credential.token, "/v1/history")).body[0].position > recovery.startTime, "the position saved");
  assert.equal(stops(), stopsBefore, "the kept player's transcode goes on");
  await yolo.api(credential.token, "/v1/playback/stop", { method: "POST" });
  await eventually(() => stops() > stopsBefore, "the transcode stop", 20_000);
  assert.deepEqual(errors, []);
}

test("Plex plays in the <video> element: Plex's position, subtitles over the picture, an audio switch, and recovery after a 410", { timeout: 300_000 }, async (t) => {
  await playsPlex(t);
});

test("Back leaves the item paused in this browser's now-playing bar, which plays it again or stops it", { timeout: 180_000 }, async (t) => {
  const { page, errors } = await openPage(await launchBrowser(t), yolo.origin);
  const credential = await pair(yolo, page);
  const played = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST", body: { url: `${media.url}/hls/index.m3u8`, startTime: 0, deviceId: credential.deviceId },
  });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  await playingPast(page, 4, "playing in the browser");

  // Back: home, with the item paused here at the position reached, also
  // after a reload.
  await page.evaluate(() => document.getElementById("btn-back").click());
  const parked = () => waitFor(page, () => location.pathname === "/" && !globalThis.__yoloPlayer
    && !document.getElementById("browse-screen").classList.contains("hidden")
    && !document.getElementById("now-playing").classList.contains("hidden")
    && document.querySelector("#now-playing .np-device").textContent === "Paused on This browser", null, "the bar with this browser's item");
  await parked();
  const left = (await yolo.api(credential.token, "/v1/playback")).body;
  assert.deepEqual([left.status, left.deviceId], ["paused", credential.deviceId]);
  assert.ok(left.position > 4, `left at ${left.position}`);
  await page.reload();
  await parked();

  // Its play button opens the player at that position.
  await page.locator("#np-toggle").click();
  await playingPast(page, left.position + 0.5, "playing again from the bar", 45_000);
  assert.equal(await page.evaluate(() => location.pathname), "/play");
  assert.ok(await page.evaluate(() => globalThis.__yoloPlayer.player.getCurrentTime()) < left.position + 10, "not from the start or further on");

  // "Stop playing" clears it.
  await page.evaluate(() => document.getElementById("btn-back").click());
  await parked();
  await page.locator("#np-devices").click();
  await page.locator("#device-picker").getByRole("button", { name: "Stop playing" }).click();
  await waitFor(page, () => document.getElementById("now-playing").classList.contains("hidden"), null, "the bar gone");
  assert.equal((await yolo.api(credential.token, "/v1/playback")).body.status, "idle");
  assert.deepEqual(errors, []);
});

// The bar's picture: the kept player's own paused frame, drawn on this page.
const barFrame = (page) => page.evaluate(() => {
  const frame = document.querySelector("#now-playing .np-art .np-frame");
  if (!(frame instanceof HTMLCanvasElement)) return { tag: frame?.tagName ?? null };
  const pixels = frame.getContext("2d").getImageData(0, 0, frame.width, frame.height).data;
  let sum = 0;
  for (let index = 0; index < pixels.length; index += 4) sum += pixels[index] + pixels[index + 1] + pixels[index + 2];
  return { tag: frame.tagName, source: frame.dataset.source, width: frame.width, brightness: sum / (pixels.length / 4) / 3 };
});

// A tap on the bar, and how long until the picture moves on from `from`, in
// the page's own clock.
async function tapBarUntilMoving(page, from, label) {
  await page.evaluate(() => {
    delete globalThis.__movingAt;
    document.getElementById("np-open").addEventListener("click", () => {
      globalThis.__tappedAt = performance.now();
    }, { once: true });
  });
  await page.locator("#np-open").click();
  await waitFor(page, (min) => {
    const player = globalThis.__yoloPlayer?.player;
    if (!(player?.getStatus() === "playing" && player.getStats()?.videoFrameRenderCount > 0 && player.getCurrentTime() > min)) return false;
    globalThis.__movingAt ??= performance.now();
    return true;
  }, from + 0.1, label, 45_000);
  return page.evaluate(() => Math.round(globalThis.__movingAt - globalThis.__tappedAt));
}

test("Back keeps the player: the bar shows its paused frame, and a tap plays on in place with no new stream", { timeout: 180_000 }, async (t) => {
  const { page, errors } = await openPage(await launchBrowser(t), yolo.origin);
  const credential = await pair(yolo, page);
  const plays = [];
  const fetches = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/v1/playback/play") plays.push(request.postDataJSON());
    if (path.startsWith("/m/")) fetches.push(path);
  });
  // Each node prepare is one `stream` line in the Hub's logs.
  const streams = () => yolo.workerLog().split(/\n(?=\{)/).filter((line) => line.includes("event: 'stream'") && line.includes(credential.deviceId)).length;
  const played = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST", body: { url: `${media.url}/hls/index.m3u8`, startTime: 0, deviceId: credential.deviceId },
  });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  await playingPast(page, 4, "playing in the browser");
  await page.evaluate(() => {
    globalThis.__yoloPlayer.player.keptMark = "the same engine";
  });
  const before = { plays: plays.length, streams: streams() };

  // Back: home, with the player kept. The Hub has the item paused here and
  // left, and keeps the node's session for it.
  await page.evaluate(() => document.getElementById("btn-back").click());
  await waitFor(page, () => location.pathname === "/" && !globalThis.__yoloPlayer
    && !document.getElementById("now-playing").classList.contains("hidden")
    && document.querySelector("#now-playing .np-device").textContent === "Paused on This browser"
    && Boolean(document.querySelector("#now-playing .np-art .np-frame")), null, "the bar with the paused frame");
  const left = (await yolo.api(credential.token, "/v1/playback")).body;
  assert.deepEqual([left.status, left.deviceId, left.kept, Boolean(left.leftAt)], ["paused", credential.deviceId, true, true]);
  const frame = await barFrame(page);
  assert.deepEqual([frame.tag, frame.source], ["CANVAS", "local"], "drawn here from the engine, with no request");
  assert.ok(frame.width > 0 && frame.width <= 320 && frame.brightness > 10, JSON.stringify(frame));
  // Hidden, it shows nothing and fetches nothing.
  assert.deepEqual(await page.evaluate(() => {
    const engine = document.querySelector("#player-container [data-engine]");
    return [engine.hasAttribute("data-kept"), getComputedStyle(engine).visibility, engine.paused];
  }), [true, "hidden", true]);
  await new Promise((done) => setTimeout(done, 1_000));
  const fetched = fetches.length;
  await new Promise((done) => setTimeout(done, 3_000));
  assert.equal(fetches.length, fetched, "no media fetched while hidden");

  // A tap on the bar shows the same player, which plays on where it was left,
  // with its controls up for a moment.
  const inPlaceMs = await tapBarUntilMoving(page, left.position, "playing on in place");
  const resumed = await page.evaluate(() => ({
    mark: globalThis.__yoloPlayer.player.keptMark,
    time: globalThis.__yoloPlayer.player.getCurrentTime(),
    path: location.pathname,
    controls: document.getElementById("app").classList.contains("controls-visible"),
  }));
  assert.deepEqual([resumed.mark, resumed.path, resumed.controls], ["the same engine", "/play", true]);
  assert.ok(resumed.time >= left.position - 0.5 && resumed.time < left.position + 5, `${resumed.time} for ${left.position}`);
  assert.deepEqual([plays.length, streams()], [before.plays, before.streams], "no new play request and no new prepare");
  await waitFor(page, () => !document.getElementById("app").classList.contains("controls-visible"), null, "the controls fade", 8_000);
  const shown = (await yolo.api(credential.token, "/v1/playback")).body;
  assert.deepEqual([shown.status, shown.sessionId, shown.kept, shown.leftAt], ["playing", left.sessionId, undefined, undefined]);

  // For comparison, the way back without a kept player: after a reload, the
  // bar asks for a new stream at the saved position.
  await page.evaluate(() => document.getElementById("btn-back").click());
  await waitFor(page, () => Boolean(document.querySelector("#now-playing .np-art .np-frame")), null, "kept again");
  await page.reload();
  await waitFor(page, () => !document.getElementById("now-playing").classList.contains("hidden"), null, "the bar after a reload");
  const reloaded = (await yolo.api(credential.token, "/v1/playback")).body;
  assert.deepEqual([reloaded.status, reloaded.kept, Boolean(reloaded.leftAt)], ["paused", undefined, true], "the page that went away let its player go");
  const newStreamMs = await tapBarUntilMoving(page, reloaded.position, "playing from a new stream");
  assert.equal(streams(), before.streams + 1, "one new prepare");
  t.diagnostic(`from a tap on the bar to the picture moving: in place ${inPlaceMs} ms, with a new stream ${newStreamMs} ms`);
  assert.deepEqual(errors, []);
});

test("Yolo Web pairs with the owner's passkey and plays at desktop and phone sizes", { timeout: 240_000 }, async (t) => {
  const link = `${media.url}/hls/index.m3u8`;
  const screens = {};

  for (const [label, options] of [
    ["desktop", { viewport: { width: 1440, height: 900 } }],
    ["phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: PHONE_UA }],
  ]) {
    const context = await browserWith(t, options);
    // Signed in with a passkey here: one press pairs this browser, no scan.
    await signIn(context);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(yolo.origin);
    await waitFor(page, () => document.getElementById("pair-passkey")?.textContent === "Pair this browser", null, `${label}: pair with the passkey`);
    await page.locator("#pair-passkey").click();
    await waitFor(page, () => Boolean(globalThis.__yolo?.state?.deviceId), null, `${label}: paired`);
    const deviceId = await page.evaluate(() => globalThis.__yolo.state.deviceId);
    screens[label] = { page, errors, deviceId };
    assert.equal(await page.evaluate(() => document.documentElement.dataset.profile), "web");
    // The layout fits the window: no sideways scrolling.
    await page.waitForSelector("#home-header");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} fits its width`);
  }
  const token = (await screens.desktop.page.evaluate(() => JSON.parse(localStorage.getItem("yolo.device")))).token;
  const kinds = Object.fromEntries((await devicesOf(token)).map((device) => [device.id, device.kind]));
  assert.deepEqual([kinds[screens.desktop.deviceId], kinds[screens.phone.deviceId]], ["browser", "phone"]);

  // On the computer: paste a link and play it here.
  const { page: desktop } = screens.desktop;
  await desktop.locator("#search-input").fill(link);
  await desktop.getByRole("button", { name: "Play link" }).click();
  await playingPast(desktop, 1, "playing on the computer", 45_000);
  assert.equal(await desktop.evaluate(() => globalThis.__yoloPlayer.engine), "native");
  const controls = await desktop.evaluate(() => document.getElementById("controls-row").getBoundingClientRect().bottom);
  assert.ok(controls <= 900, `controls end at ${controls}`);
  // With a mouse, a click on the picture pauses and Space plays on.
  await desktop.mouse.click(720, 300);
  await waitFor(desktop, () => globalThis.__yoloPlayer.player.getStatus() === "paused", null, "paused by a click");
  await desktop.keyboard.press(" ");
  await playingPast(desktop, await desktop.evaluate(() => globalThis.__yoloPlayer.player.getCurrentTime()) + 0.3, "playing after Space");

  // On the phone, a tap plays where playback is: on the computer.
  const { page: phone } = screens.phone;
  await waitFor(phone, () => !document.getElementById("now-playing").classList.contains("hidden"), null, "the phone's now-playing bar");
  const before = await yolo.api(token, "/v1/playback");
  await phone.locator("#search-input").fill(link);
  await phone.getByRole("button", { name: "Play link" }).tap();
  await eventually(async () => (await yolo.api(token, "/v1/playback")).body.sessionId !== before.body.sessionId, "a new play on the computer");
  assert.equal((await yolo.api(token, "/v1/playback")).body.deviceId, screens.desktop.deviceId);

  // Then the phone takes it and plays in its own window.
  await phone.locator("#search-clear").tap();
  await phone.locator("#np-devices").tap();
  await phone.locator("#device-picker").getByRole("button", { name: /This browser/ }).tap();
  await playingPast(phone, 1, "playing on the phone", 45_000);
  const phoneLayout = await phone.evaluate(() => ({
    picture: document.querySelector('#player-container video[data-engine="native"]').getBoundingClientRect().toJSON(),
    width: innerWidth,
  }));
  assert.ok(phoneLayout.picture.width <= phoneLayout.width + 1, JSON.stringify(phoneLayout));
  // Upright, as in the YouTube app, the top bar and the bottom row lie on the picture.
  await waitFor(phone, () => {
    const video = document.querySelector('#player-container video[data-engine="native"]');
    const box = video.getBoundingClientRect();
    const height = box.width * video.videoHeight / video.videoWidth;
    const top = box.top + (box.height - height) / 2;
    const back = document.getElementById("btn-back").getBoundingClientRect();
    const row = document.getElementById("controls-row").getBoundingClientRect();
    return top > 100 && back.top >= top && row.bottom <= top + height + 1;
  }, null, "the phone's controls on the picture");
  assert.deepEqual([...screens.desktop.errors, ...screens.phone.errors], []);
});

const webkitOnly = { timeout: 300_000, skip: process.env.YOLO_E2E_WEBKIT !== "1" && "set YOLO_E2E_WEBKIT=1" };

test("in WebKit (Safari's engine) HLS plays natively and the page is a player, not a remote", webkitOnly, async (t) => {
  const { page } = await playsStreamTypes(t, { engine: "webkit" });
  const profile = await page.evaluate(() => ({ isolated: globalThis.crossOriginIsolated, engine: globalThis.__yolo.profile.engine, hls: globalThis.__yolo.profile.native?.hls }));
  assert.deepEqual(profile, { isolated: false, engine: "native", hls: "native" });
});

test("in WebKit as on iPhone, Plex plays through native HLS, with subtitles also in the system's fullscreen player, an audio switch, and recovery after a 410", webkitOnly, async (t) => {
  await playsPlex(t, { engine: "webkit", iPhone: true });
});

// A stream that replaces what plays (a seek, a track or a quality change)
// shows the progress bar's seek indicator until its first picture; after
// that, a stall on it is a stall, with the spinner, and once it plays on no
// seek indicator stays.
test("a stall on the stream a seek built shows the spinner in the <video> engine, not the seek indicator", { timeout: 180_000 }, async (t) => {
  const { page, errors, credential } = await webPage(t);
  const agent = await yolo.agentToken();
  const dash = await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0, device: credential.deviceId });
  await playingPast(page, 1, "dash_split");
  const seen = await stallOnSeekStream(page, yolo, { token: credential.token, deviceId: credential.deviceId, source: dash.state.item.source });
  assert.deepEqual(seen, { stall: { seeking: false, spinner: true }, playing: { seeking: false, spinner: false } });
  assert.deepEqual(errors, []);
});

// A browser may pause the element itself when its data runs out (WebKit's
// native HLS can): that is a stall, with the spinner and the owner's intent
// kept, and it plays on, with its sound, once the data is back.
test("a pause the browser makes when the data runs out shows the spinner in the <video> engine and plays on with sound", { timeout: 180_000 }, async (t) => {
  const { page, errors, credential } = await webPage(t);
  const agent = await yolo.agentToken();
  let release;
  const released = new Promise((done) => { release = done; });
  await page.route(/\/m\/[^/]+\/dash\/video\/\d+\.m4s$/, async (route) => {
    if (Number(/(\d+)\.m4s$/.exec(route.request().url())[1]) >= 4) await released;
    await route.continue().catch(() => {});
  });
  t.after(() => release());
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0, device: credential.deviceId });
  await playingPast(page, 1, "dash_split");
  await statusIs(page, "buffering", "the stall");
  const paused = await page.evaluate(async () => {
    const video = document.querySelector('#player-container video[data-engine="native"]');
    video.pause();
    await new Promise((done) => setTimeout(done, 100));
    return {
      readyState: video.readyState,
      status: globalThis.__yoloPlayer.player.getStatus(),
      intent: globalThis.__yolo.state.playbackIntent,
      spinner: document.getElementById("center-loading").classList.contains("buffering"),
    };
  });
  assert.ok(paused.readyState < 3, JSON.stringify(paused));
  assert.deepEqual({ ...paused, readyState: null }, { readyState: null, status: "buffering", intent: "playing", spinner: true });
  const at = await currentTime(page);
  release();
  await playingPast(page, at + 1, "playing on after the stall");
  assert.deepEqual(await page.evaluate(() => ({
    muted: document.querySelector('#player-container video[data-engine="native"]').muted,
    spinner: document.getElementById("center-loading").classList.contains("buffering"),
  })), { muted: false, spinner: false });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  assert.deepEqual(errors, []);
});

// A seek before where the playing stream starts asks Yolo for a new stream
// there, and Yolo sends that stream's `load` once. When the realtime
// connection drops with it, the welcome after the reconnect names the new
// stream, and the screen asks for it again instead of waiting, paused under
// the seek indicator, for a `load` that will not come. (The car's test also
// loses it into a connection that died without the page noticing.)
async function seekAcrossLostLoad(t, { engine = "chromium" } = {}) {
  const { page, errors, credential } = await webPage(t, { engine });
  const agent = await yolo.agentToken();
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 30, device: credential.deviceId });
  await playingPast(page, 30.5, "dash_split");
  const seen = await loseSeekLoad(page, { seek: (position) => yolo.mcp(agent, "seek", { position_seconds: position }), seekTo: 5, streamStart: 30 });
  assert.notEqual(seen.lost, seen.replaced);
  assert.equal(seen.seeking, true, "the seek was pending");
  await seekPlayed(page, 5, "the seek played after the reconnect");
  assert.equal(seen.welcomes[1], seen.lost, "the welcome after the reconnect named the stream whose load was lost");
  assert.deepEqual(errors, []);
}

test("a seek's new stream plays in the <video> engine after the realtime connection closed with its load", { timeout: 180_000 }, async (t) => {
  await seekAcrossLostLoad(t);
});

test("in WebKit a seek's new stream plays after the realtime connection closed with its load", webkitOnly, async (t) => {
  await seekAcrossLostLoad(t, { engine: "webkit" });
});

// Two seeks before where the playing stream starts, the second while the
// stream the first asked for is on its way and to before where that stream
// starts: the second one wins, also when Yolo built the first one's stream
// before it heard of the second.
test("a second seek while the first seek's stream is on its way wins in the <video> engine", { timeout: 180_000 }, async (t) => {
  const { page, errors, credential } = await webPage(t);
  const agent = await yolo.agentToken();
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 30, device: credential.deviceId });
  await playingPast(page, 30.5, "dash_split");
  const seen = await seekDuringSeek(page, { seek: (position) => yolo.mcp(agent, "seek", { position_seconds: position }), first: 25, second: 5, streamStart: 30 });
  // Short of where the first seek asked: the second one won, in the first
  // one's stream, which can seek there.
  const playing = await playsHubStream(page, { from: 5.5, to: 20, label: "the second seek played" });
  assert.equal(playing.sessionId, seen.held);
  assert.deepEqual(errors, []);
});

// Any `load` the realtime connection loses, not only a seek's: a quality
// change the player asked for, or an agent's play of another item on this
// screen. Yolo stopped the stream the screen plays when it built the new
// one, and the welcome after the reconnect names the new one; the screen
// asks for it again instead of playing on into a stream the node ended.
async function lostLoadPlaysOn(t, { reason, engine = "chromium" }) {
  const { page, errors, credential } = await webPage(t, { engine });
  const agent = await yolo.agentToken();
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0, device: credential.deviceId });
  await playingPast(page, 1, "dash_split");
  let at = 0;
  let played = null;
  const seen = await loseLoad(page, {
    reason,
    send: async () => {
      if (reason === "quality") at = await askForQuality(yolo, page, credential, 400);
      else played = await yolo.mcp(agent, "play", { url: `${media.url}/hls/index.m3u8`, start_at: 0, device: credential.deviceId });
    },
  });
  assert.notEqual(seen.lost, seen.replaced);
  const playing = await playsHubStream(page, {
    replaced: seen.replaced, from: reason === "quality" ? at - 1 : 0.5, to: (reason === "quality" ? at : 0) + 30, label: `the ${reason} stream played after the reconnect`,
  });
  if (played) assert.deepEqual(playing.source, played.state.item.source, "the agent's item plays");
  assert.equal(seen.welcomes[1], seen.lost, "the welcome after the reconnect named the stream whose load was lost");
  assert.deepEqual(errors, []);
}

test("a quality change's stream plays in the <video> engine after the realtime connection closed with its load", { timeout: 180_000 }, async (t) => {
  await lostLoadPlaysOn(t, { reason: "quality" });
});

test("an agent's play plays in the <video> engine after the realtime connection closed with its load", { timeout: 180_000 }, async (t) => {
  await lostLoadPlaysOn(t, { reason: "play" });
});

test("in WebKit an agent's play plays after the realtime connection closed with its load", webkitOnly, async (t) => {
  await lostLoadPlaysOn(t, { reason: "play", engine: "webkit" });
});

// Commands, not only `load`s (car-playback.test.js has each kind): an
// agent's pause and the seek after it went into a connection that died
// without the page noticing, which the page finds out when it next probes
// the connection (as after a wake). After the reconnect the <video> engine
// is paused where the seek went, as Yolo said.
async function lostCommandsFollowed(t, { engine = "chromium" } = {}) {
  const { page, errors, credential } = await webPage(t, { engine });
  const agent = await yolo.agentToken();
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0, device: credential.deviceId });
  await playingPast(page, 1, "dash_split");
  const seen = await loseMessage(page, {
    label: "the pause",
    connection: "silent",
    lose: (message, from) => from === "hub" && message.type === "pause",
    send: async () => {
      await yolo.mcp(agent, "control", { action: "pause" });
      await yolo.mcp(agent, "seek", { position_seconds: 40 });
    },
  });
  await page.evaluate(() => globalThis.__yolo.realtime.probe());
  await eventually(() => seen.welcomes.length > 1, "the welcome after the reconnect", 30_000);
  const where = () => page.evaluate(() => ({ status: globalThis.__yoloPlayer?.player?.getStatus(), time: globalThis.__yoloPlayer?.player?.getCurrentTime() }));
  await waitFor(page, () => {
    const player = globalThis.__yoloPlayer?.player;
    return globalThis.__yolo.realtime.ready && player?.getStatus() === "paused" && Math.abs(player.getCurrentTime() - 40) < 0.5;
  }, null, "paused where the seek went, after the reconnect");
  await new Promise((done) => setTimeout(done, 1_500));
  const still = await where();
  assert.ok(still.status === "paused" && Math.abs(still.time - 40) < 0.5, JSON.stringify(still));
  assert.equal((await yolo.mcp(agent, "get_status")).playback.status, "paused");
  assert.deepEqual(errors, []);
}

test("an agent's pause and seek that a dead realtime connection lost reach the <video> engine after the reconnect", { timeout: 180_000 }, async (t) => {
  await lostCommandsFollowed(t);
});

test("in WebKit an agent's pause and seek that a dead realtime connection lost reach the screen after the reconnect", webkitOnly, async (t) => {
  await lostCommandsFollowed(t, { engine: "webkit" });
});

// A pause outside Yolo's controls (Picture-in-Picture, the system's player,
// a call) is the owner's as much as one in Yolo's controls: made after the
// connection died, it wins over a resume that went into the dead
// connection, at every reconnect.
test("a pause outside Yolo's controls after the connection died wins over a resume the connection lost in the <video> engine", { timeout: 180_000 }, async (t) => {
  const { page, errors, credential } = await webPage(t);
  const agent = await yolo.agentToken();
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0, device: credential.deviceId });
  await playingPast(page, 1, "dash_split");
  const seen = await actHereWhileDead(page, {
    act: async () => {
      await page.evaluate(() => globalThis.__yoloPlayer.player.video.pause());
      await page.waitForFunction(() => globalThis.__yoloPlayer?.player?.getStatus() === "paused", null, { timeout: 10_000 });
    },
    command: () => yolo.mcp(agent, "control", { action: "resume" }),
  });
  await staysPaused(page, "still paused after the reconnect");
  await seen.again();
  await staysPaused(page, "still paused after another reconnect");
  assert.deepEqual(errors, []);
});

// Last: signing out ends the owner's session, which pairing above needs.
test("owner settings need the owner's passkey session; a device credential never reaches them", { timeout: 180_000 }, async (t) => {
  const context = await launchBrowser(t);
  const { page, errors } = await openPage(context, yolo.origin);
  const credential = await pair(yolo, page);

  // A paired device's credential is a bearer token, never an owner session.
  for (const [method, path] of [["GET", "/v1/owner/devices"], ["GET", "/v1/owner/agents"], ["DELETE", `/v1/owner/devices/${credential.deviceId}`]]) {
    const response = await fetch(`${yolo.origin}${path}`, { method, headers: { authorization: `Bearer ${credential.token}`, "x-yolo-owner": "1", origin: yolo.origin } });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  // The owner's session, sent by another site: refused.
  const crossSite = await fetch(`${yolo.origin}/v1/owner/devices/${credential.deviceId}`, {
    method: "PATCH",
    headers: { cookie: yolo.ownerSession.cookie, "x-yolo-owner": "1", origin: "https://evil.test", "content-type": "application/json" },
    body: JSON.stringify({ name: "Hacked" }),
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await fetch(`${yolo.origin}/v1/owner/devices`, { headers: { cookie: yolo.ownerSession.cookie } })).status, 403, "no X-Yolo-Owner");

  // In this browser, settings are locked until the owner signs in.
  await page.locator("#btn-settings").click();
  await page.waitForSelector("#settings[open] .locked");
  assert.equal(await page.locator("#settings-sign-in").innerText(), "Sign in with passkey");
  assert.match(await page.locator("#settings-device-name").innerText(), /\S/);
  await page.locator("#settings-close").click();
  await page.waitForFunction(() => !document.getElementById("settings").open && location.pathname === "/");

  // Signed in with a passkey; an agent connected meanwhile.
  await signIn(context);
  const agent = await yolo.agentToken({ name: "Settings agent" });
  assert.equal((await yolo.api(agent, "/v1/me")).status, 200);
  await page.locator("#btn-settings").click();
  const self = page.locator(`#settings [data-device="${credential.deviceId}"]`);
  await self.waitFor();
  assert.match(await self.innerText(), /This screen/);

  // Rename this browser in place.
  await self.getByRole("button", { name: /^Rename/ }).click();
  await page.locator('#settings .row-edit input[name="name"]').fill("Desk");
  await page.locator('#settings .row-edit button[type="submit"]').click();
  await eventually(async () => (await devicesOf(credential.token)).find((device) => device.id === credential.deviceId)?.name === "Desk", "the rename");
  // Settings reload after a rename and redraw every row, which would drop a
  // Revoke armed meanwhile: wait until the list shows the new name.
  await self.filter({ hasText: "Desk" }).waitFor();

  // Revoke the agent: it asks once more, then the agent's token stops working.
  const agentRow = page.locator("#settings [data-agent]").filter({ hasText: "Settings agent" });
  await agentRow.getByRole("button", { name: "Revoke Settings agent" }).click();
  await agentRow.getByRole("button", { name: "Revoke?" }).click();
  await agentRow.waitFor({ state: "detached" });
  await eventually(async () => (await yolo.api(agent, "/v1/me")).status === 401, "the agent's token to be revoked");

  // Reset the image links of the covers agents show: it asks once more too.
  const imageLinks = page.locator("#settings-image-links");
  await imageLinks.getByRole("button", { name: "Reset image links" }).click();
  await imageLinks.getByRole("button", { name: "Reset?" }).click();
  await page.locator("#settings-owner .settings-status").filter({ hasText: "Image links reset" }).waitFor();
  assert.match(await imageLinks.innerText(), /Last reset today/);

  // Passkeys are listed; the only one cannot be removed.
  const passkeys = page.locator('#settings ul[aria-label="Passkeys"]');
  assert.match(await passkeys.innerText(), /E2E passkey[\s\S]*Your only passkey/);
  assert.equal(await passkeys.getByRole("button", { name: /^Remove/ }).count(), 0);

  // Signing out locks owner settings again.
  await page.locator("#settings").getByRole("button", { name: "Sign out" }).click();
  await page.waitForSelector("#settings[open] .locked");
  assert.equal((await fetch(`${yolo.origin}/v1/owner/devices`, { headers: { cookie: yolo.ownerSession.cookie, "x-yolo-owner": "1" } })).status, 401);
  assert.deepEqual(errors, []);
});
