import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { fakeYtdlp, makeMedia, mediaOrigin, plexFixture } from "./fixtures.js";
import { autoplayMessage, deviceEvents, eventually, launchBrowser, openPage, pair, playingPast, waitFor } from "./browser.js";
import { startYolo } from "./yolo-stack.js";

// Yolo Web's <video> engine (Agent Note 2026-10-12-two-playback-engines): in
// a computer's browser the four stream types play through the browser's own
// <video> element (hls.js for HLS in Chromium), with seeks, pause and
// resume, Yolo's subtitles drawn over the picture, a track switch, recovery
// after a 410, progress and resume, and the autoplay rule. The car's canvas
// engine plays the same streams in car-playback.test.js.
//
// YOLO_E2E_WEBKIT=1 also runs the browser part in Playwright's WebKit,
// Safari's engine, where HLS plays natively (PLAYWRIGHT_WEBKIT_EXECUTABLE
// names a WebKit build other than Playwright's own).

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
let mediaDir;

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "yolo-e2e-native-"));
  await makeMedia(mediaDir, { seconds: 120 });
});

after(async () => {
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
async function agentSays(yolo, agent, tool, args) {
  const result = await yolo.mcp(agent, tool, args);
  await new Promise((done) => setTimeout(done, 1_200));
  return result;
}

const mediaPaths = (page, fragment) => page.evaluate((part) => performance.getEntriesByType("resource")
  .map((entry) => new URL(entry.name).pathname)
  .filter((path) => path.startsWith("/m/") && path.includes(part)), fragment);

// A browser playing as Yolo Web (no type given: the web profile).
async function webPage(t, yolo, options = {}) {
  const context = await launchBrowser(t, options);
  const opened = await openPage(context, yolo.origin, options.onPage ? { onPage: options.onPage } : {});
  const credential = await pair(yolo, opened.page);
  await waitFor(opened.page, () => globalThis.__yolo.profile.engine === "native", null, "the <video> engine");
  return { ...opened, context, credential };
}

async function playsStreamTypes(t, { engine = "chromium" } = {}) {
  const media = await mediaOrigin(t, mediaDir);
  const ytdlp = await fakeYtdlp(mediaDir, {
    title: "DASH fixture",
    duration: 120,
    requested_formats: [
      { format_id: "v", url: `${media.url}/video.mp4`, vcodec: "avc1.42c00d", acodec: "none", width: 320, height: 180, fps: 30, tbr: 400 },
      { format_id: "a", url: `${media.url}/audio.mp4`, vcodec: "none", acodec: "mp4a.40.2", abr: 128 },
    ],
  });
  const yolo = await startYolo(t, {
    pluginConfig: { plugins: [{ source: join(root, "plugins/source-ytdlp"), options: { binary: ytdlp } }] },
  });
  const { page, errors, credential } = await webPage(t, yolo, { engine });
  const agent = await yolo.agentToken();
  const hlsPath = engine === "webkit" ? "native-hls" : "hls.js";

  // The device said it plays through <video>, with its own codecs.
  const { devices } = await yolo.mcp(agent, "list_devices");
  const device = devices.find((candidate) => candidate.id === credential.deviceId);
  assert.equal(device.capabilities.renderer, "html5-video");
  assert.ok(device.capabilities.video.includes("avc1") && device.capabilities.audio.includes("mp4a"), JSON.stringify(device.capabilities));

  // direct: a progressive file, read by the element with byte ranges.
  // (WebKit plays no WebM: an MP4 there.)
  const directUrl = engine === "webkit" ? `${media.url}/video.mp4` : `${media.url}/clip.webm`;
  await yolo.mcp(agent, "play", { url: directUrl, start_at: 0 });
  await playingPast(page, 1, "direct");
  assert.deepEqual(await engineOf(page), { engine: "native", mode: "progressive", video: true, canvas: false });
  assert.match(await page.evaluate(() => document.querySelector('#player-container video[data-engine="native"]').currentSrc), /\/m\/[^/]+\/f\/\d+$/, "the element reads the file through /m/");

  // Pause and resume from an agent, then a seek.
  await agentSays(yolo, agent, "control", { action: "pause" });
  await statusIs(page, "paused", "direct paused");
  const pausedAt = await currentTime(page);
  await new Promise((done) => setTimeout(done, 1_000));
  assert.ok(Math.abs(await currentTime(page) - pausedAt) < 0.1, "paused means paused");
  await agentSays(yolo, agent, "control", { action: "resume" });
  await playingPast(page, pausedAt + 0.5, "direct resumed");
  await agentSays(yolo, agent, "seek", { position_seconds: 60 });
  await playingPast(page, 60.5, "direct after a seek");
  assert.ok(await currentTime(page) < 70);

  // Leaving saves the position; playing again resumes there.
  await page.evaluate(() => document.getElementById("btn-back").click());
  await waitFor(page, () => location.pathname === "/" && !globalThis.__yoloPlayer, null, "back home");
  const saved = await eventually(async () => {
    const history = await yolo.mcp(agent, "history");
    const position = history.find((entry) => entry.title.includes(directUrl.split("/").at(-1)))?.position ?? 0;
    return position > 60 ? position : null;
  }, "the saved position");
  const resumed = await yolo.mcp(agent, "play", { url: directUrl });
  assert.ok(Math.abs(resumed.state.position - saved) < 0.5, `resumed at ${resumed.state.position}, saved ${saved}`);
  await playingPast(page, saved + 0.5, "direct resumed where it was");

  // hls: hls.js (or the browser's own HLS), a seek inside the stream.
  await yolo.mcp(agent, "play", { url: `${media.url}/hls/index.m3u8`, start_at: 0 });
  await playingPast(page, 1, "hls");
  assert.equal((await engineOf(page)).mode, hlsPath);
  const hlsSession = await page.evaluate(() => globalThis.__yolo.state.sessionId);
  await agentSays(yolo, agent, "seek", { position_seconds: 90 });
  await playingPast(page, 90.5, "hls after a seek");
  assert.equal(await page.evaluate(() => globalThis.__yolo.state.sessionId), hlsSession, "a seek inside the stream keeps it");

  // dash_split: separate files joined into fMP4 HLS with an audio rendition.
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0 });
  await playingPast(page, 1, "dash_split");
  assert.equal((await engineOf(page)).mode, hlsPath);
  if (engine !== "webkit") {
    const dashPaths = await mediaPaths(page, "/dash/");
    assert.ok(dashPaths.some((path) => path.endsWith("/dash/master.m3u8")), JSON.stringify(dashPaths));
    assert.ok(dashPaths.some((path) => path.includes("/dash/audio/")), "the audio rendition is fetched");
  }
  await agentSays(yolo, agent, "control", { action: "pause" });
  await statusIs(page, "paused", "dash_split paused");
  await agentSays(yolo, agent, "seek", { position_seconds: 50 });
  await waitFor(page, () => Math.abs(globalThis.__yoloPlayer.player.getCurrentTime() - 50) < 0.5, null, "dash_split seeked while paused");
  await agentSays(yolo, agent, "control", { action: "resume" });
  await playingPast(page, 50.5, "dash_split resumed after a seek");
  const status = await yolo.mcp(agent, "get_status");
  assert.equal(status.playback.status, "playing");
  assert.deepEqual(errors, []);

  // The events say which engine played, and what the picture really was.
  await eventually(() => deviceEvents(yolo, "stream_first_frame").length >= 4, "first frames in the logs", 25_000);
  assert.ok(deviceEvents(yolo, "stream_selected").every((event) => event.includes("engine: 'native'")));
  assert.ok(deviceEvents(yolo, "stream_first_frame").every((event) => event.includes("engine: 'native'") && event.includes("width: 320")));
  return { page, yolo };
}

test("direct, hls and dash_split play in the browser's <video> element, with seeks, pauses, and resume", { timeout: 300_000 }, async (t) => {
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

async function playsPlex(t, { engine = "chromium" } = {}) {
  const plex = await plexFixture(t, mediaDir, { viewOffset: 3_000, duration: 120_000 });
  const yolo = await startYolo(t, {
    pluginConfig: { plugins: [{ source: join(root, "plugins/source-plex"), options: { url: plex.url, token: "fixture-token" } }] },
  });
  const { page, errors, credential } = await webPage(t, yolo, { engine });
  const plays = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/v1/playback/play")) plays.push(request.postDataJSON());
  });
  const starts = () => plex.calls.filter((call) => call.path.endsWith("/start.m3u8"));

  // No Yolo history yet: Plex's own position (3 s).
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
  assert.equal(starts().length, 1, "no second transcode");

  // An audio track switch rebuilds the stream through Yolo, at the place
  // reached. From here segments arrive slowly (still faster than they
  // play), so the browser is still fetching ahead when Plex drops the
  // transcode below.
  await page.route(/\/m\/[^/]+\/f\//, async (route) => {
    await new Promise((done) => setTimeout(done, 300));
    await route.continue();
  });
  const before = await currentTime(page);
  const switched = await yolo.api(credential.token, "/v1/playback/tracks", { method: "PUT", body: { audio: "plex:11" } });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  await eventually(() => starts().length === 2, "the new transcode");
  assert.equal(starts().at(-1).params.audioStreamID, "11");
  await playingPast(page, before, "playing on with the chosen audio");

  // Plex drops the transcode (as after a long pause). The browser is still
  // fetching ahead (slowly, as routed above), so its next segment is a 410,
  // and the player asks Yolo for a new stream where playback is.
  const clearedAt = await currentTime(page);
  const startsBefore = starts().length;
  plex.sessions.clear();
  await eventually(() => starts().length === startsBefore + 1, "a new transcode after the 410", 45_000);
  const recovery = plays.find((body) => body.reason === "recovery");
  assert.ok(recovery && recovery.startTime >= clearedAt - 1 && recovery.startTime < 120, JSON.stringify({ clearedAt, plays }));
  await playingPast(page, recovery.startTime + 0.5, "playing again after the 410", 45_000);
  await eventually(() => deviceEvents(yolo, "session_expired").length > 0, "session_expired in the logs", 25_000);
  assert.equal(await page.evaluate(() => document.getElementById("playback-error").classList.contains("hidden")), true, "no error shown");

  // Leaving stops the transcode and keeps the position for next time.
  await page.evaluate(() => document.getElementById("btn-back").click());
  await eventually(() => plex.calls.some((call) => call.path === "/video/:/transcode/universal/stop"), "the transcode stop", 20_000);
  const history = await yolo.api(credential.token, "/v1/history");
  assert.ok(history.body[0].position > recovery.startTime, JSON.stringify(history.body[0]));
  assert.deepEqual(errors, []);
}

test("Plex plays in the <video> element: Plex's position, subtitles over the picture, an audio switch, and recovery after a 410", { timeout: 300_000 }, async (t) => {
  await playsPlex(t);
});

test("without a gesture the <video> element plays muted with Tap for sound, and the first tap brings sound", { timeout: 240_000 }, async (t) => {
  const media = await mediaOrigin(t, mediaDir);
  const yolo = await startYolo(t);
  // Chromium's real autoplay policy for a site without media engagement.
  const { page: first, context, credential } = await webPage(t, yolo, { autoplay: "gesture" });
  const played = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST", body: { url: `${media.url}/hls/index.m3u8`, startTime: 0, deviceId: credential.deviceId },
  });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  await playingPast(first, 2, "playing before the page goes away");
  await first.close();
  await eventually(async () => {
    const { body } = await yolo.api(credential.token, "/v1/playback");
    return body.status === "paused" && body.interruptedAt;
  }, "the Hub to keep the place", 15_000);

  // A fresh page, no tap yet: it plays on by itself, muted.
  const { page, errors, before: woke } = await openPage(context, yolo.origin, { onPage: (fresh) => autoplayMessage(fresh) });
  assert.equal(await woke, "muted");
  await playingPast(page, 2.5, "playing muted", 45_000);
  const muted = await page.evaluate(() => ({
    engine: globalThis.__yoloPlayer.engine,
    muted: document.querySelector('#player-container video[data-engine="native"]').muted,
    hint: !document.getElementById("btn-tap-sound").classList.contains("hidden"),
  }));
  assert.deepEqual(muted, { engine: "native", muted: true, hint: true });

  // The first tap anywhere brings the sound; playback goes on.
  await page.mouse.click(640, 200);
  await waitFor(page, () => !document.querySelector('#player-container video[data-engine="native"]').muted
    && globalThis.__yoloPlayer.player.audioOutputState === "running"
    && document.getElementById("btn-tap-sound").classList.contains("hidden"), null, "sound after a tap");
  const unmutedAt = await currentTime(page);
  await playingPast(page, unmutedAt + 0.5, "playing with sound");
  assert.deepEqual(errors, []);
  await eventually(() => deviceEvents(yolo, "audio_unlocked").length > 0, "audio_unlocked in the logs", 25_000);
  assert.ok(deviceEvents(yolo, "autoplay_result").some((event) => event.includes("result: 'muted'")));
});

const webkitOnly = { timeout: 300_000, skip: process.env.YOLO_E2E_WEBKIT !== "1" && "set YOLO_E2E_WEBKIT=1" };

test("in WebKit (Safari's engine) HLS plays natively and the page is a player, not a remote", webkitOnly, async (t) => {
  const { page } = await playsStreamTypes(t, { engine: "webkit" });
  const profile = await page.evaluate(() => ({ isolated: globalThis.crossOriginIsolated, engine: globalThis.__yolo.profile.engine, hls: globalThis.__yolo.profile.native?.hls }));
  assert.deepEqual(profile, { isolated: false, engine: "native", hls: "native" });
});

test("in WebKit Plex plays through native HLS, with subtitles, an audio switch, and recovery after a 410", webkitOnly, async (t) => {
  await playsPlex(t, { engine: "webkit" });
});
