import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { fakeYtdlpVariants, makeDashVariants, makeMedia, mediaOrigin } from "./fixtures.js";
import { autoplayMessage, deviceEvents, eventually, launchBrowser, openPage, pair, playingPast, waitFor } from "./tesla-helpers.js";
import { startYolo } from "./yolo-stack.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The playback experience in the car (2026-10-12): resuming by itself
// after a wake like Spotify, quality that adapts to the connection, and a
// loading screen without technical text.

let mediaDir;

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "yolo-e2e-experience-"));
  await Promise.all([
    makeMedia(mediaDir),
    // A noisy 2 Mbps picture and a 150 kbps one of the same clip, and a 4:3
    // picture, each with a long audio track.
    makeDashVariants(mediaDir, {
      seconds: 60,
      variants: [
        { name: "hi", width: 320, height: 180, kbps: 2000, noise: true },
        { name: "lo", width: 160, height: 90, kbps: 150 },
        { name: "four-three", width: 320, height: 240, kbps: 400 },
      ],
    }),
  ]);
});

after(async () => {
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
});

const tapHintShown = () => !document.getElementById("btn-tap-sound").classList.contains("hidden");

test("the car wakes and plays on by itself, muted until a tap, however it went to sleep", { timeout: 240_000 }, async (t) => {
  const media = await mediaOrigin(t, mediaDir);
  const yolo = await startYolo(t);
  // Chromium's real autoplay policy for a site without media engagement:
  // no sound before a tap on the page.
  const context = await launchBrowser(t, { autoplay: "gesture" });
  let { page, errors } = await openPage(context, yolo.origin);
  const credential = await pair(yolo, page);

  // Pairing above had the page polled, which counts as a user activation
  // in Playwright: this first stream starts with sound.
  const autoplayed = autoplayMessage(page);
  const played = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST", body: { url: `${media.url}/hls/index.m3u8`, startTime: 0, deviceId: credential.deviceId },
  });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  assert.equal(await autoplayed, "sound");
  await playingPast(page, 2.5, "playing before sleeping");
  assert.equal(await page.evaluate(tapHintShown), false);
  assert.deepEqual(errors, []);

  // The car sleeps: the page and its connection go away. The Hub keeps the
  // place and marks that it was playing.
  await page.close();
  const saved = await eventually(async () => {
    const { body } = await yolo.api(credential.token, "/v1/playback");
    return body.status === "paused" && body.interruptedAt ? body : null;
  }, "the Hub to keep the place", 15_000);

  // It wakes (a fresh page with the same credential, no tap on it yet):
  // playing again by itself, from where it was. The browser blocks sound
  // without a tap, so it plays muted.
  let woke;
  ({ page, errors, before: woke } = await openPage(context, yolo.origin, { onPage: (fresh) => autoplayMessage(fresh) }));
  assert.equal(await woke, "muted");
  assert.equal(await page.evaluate(() => globalThis.__driveInMediabunny.player.audioContext.state), "suspended");
  await playingPast(page, saved.position + 0.5, "playing again after the wake", 45_000);
  assert.equal(await page.evaluate(tapHintShown), true);
  assert.equal(await page.evaluate(() => document.getElementById("overlay").classList.contains("hidden")), true, "no status screen");
  await eventually(async () => (await yolo.api(credential.token, "/v1/playback")).body.status === "playing", "the Hub to see it playing");

  // The first tap anywhere brings the sound; playback goes on.
  await page.mouse.click(640, 200);
  await waitFor(page, () => globalThis.__driveInMediabunny?.player?.audioOutputState === "running"
    && document.getElementById("btn-tap-sound").classList.contains("hidden")
    && globalThis.__driveInMediabunny.player.audioContext.state === "running", null, "sound after a tap");
  const unlockedAt = await page.evaluate(() => globalThis.__driveInMediabunny.player.getCurrentTime());
  await playingPast(page, unlockedAt + 0.5, "playing with sound");

  // Paused by the owner before the car sleeps: it stays paused.
  await yolo.api(credential.token, "/v1/playback/pause", { method: "POST" });
  await waitFor(page, () => globalThis.__driveInMediabunny?.player?.getStatus() === "paused", null, "paused by the owner");
  await page.close();
  await eventually(async () => {
    const { body } = await yolo.api(credential.token, "/v1/playback");
    return body.status === "paused" && !body.interruptedAt;
  }, "the Hub to keep the paused place");
  ({ page, errors } = await openPage(context, yolo.origin));
  await waitFor(page, () => globalThis.__driveInMediabunny?.player?.getStatus() === "paused"
    && globalThis.__driveInMediabunny.player.getStats().videoFrameRenderCount > 0, null, "paused after the wake");
  await new Promise((done) => setTimeout(done, 2_000));
  assert.equal(await page.evaluate(() => globalThis.__driveInMediabunny.player.getStatus()), "paused");
  assert.deepEqual(errors, []);

  // What happened reached Workers Logs.
  await eventually(() => deviceEvents(yolo, "audio_unlocked").length > 0, "audio_unlocked in the logs", 25_000);
  const autoplay = deviceEvents(yolo, "autoplay_result");
  assert.ok(autoplay.some((event) => event.includes("result: 'muted'")), autoplay.join("\n"));
  const decisions = deviceEvents(yolo, "resume_decision");
  assert.ok(decisions.some((event) => event.includes("why: 'interrupted'") && event.includes("autoplay: true")), decisions.join("\n"));
});

const ytdlpPlugin = (binary) => ({ plugins: [{ source: join(root, "plugins/source-ytdlp"), options: { binary } }] });
const audioFormat = (url) => ({ format_id: "a", url, vcodec: "none", acodec: "mp4a.40.2", abr: 128, tbr: 128 });
const playRequests = (page) => {
  const plays = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/v1/playback/play")) plays.push(request.postDataJSON());
  });
  return plays;
};
const lastPlayback = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("yolo.playback.diagnostics") || "null"));

test("a slow connection steps quality down, with a spinner and no error or technical text", { timeout: 240_000 }, async (t) => {
  const media = await mediaOrigin(t, mediaDir);
  const binary = await fakeYtdlpVariants(mediaDir, {
    title: "Variants", duration: 60, audio: audioFormat(`${media.url}/audio-long.mp4`),
    videos: [
      { format_id: "hi", url: `${media.url}/hi.mp4`, vcodec: "avc1.42c00d", acodec: "none", width: 320, height: 180, fps: 30, tbr: 2000 },
      { format_id: "lo", url: `${media.url}/lo.mp4`, vcodec: "avc1.42c00d", acodec: "none", width: 160, height: 90, fps: 30, tbr: 150 },
    ],
  });
  const yolo = await startYolo(t, { pluginConfig: ytdlpPlugin(binary) });
  const context = await launchBrowser(t);
  const { page, errors } = await openPage(context, yolo.origin);
  const credential = await pair(yolo, page);
  const plays = playRequests(page);

  // About 700 kbps to the car: enough for the 150 kbps picture, a third of
  // what the 2 Mbps one needs.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: 700_000 / 8, uploadThroughput: 2_000_000 / 8 });

  const played = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST", body: { url: "https://videos.test/watch?v=variants", startTime: 0, deviceId: credential.deviceId },
  });
  assert.equal(played.status, 200, JSON.stringify(played.body));
  assert.equal(played.body.state.item.title, "Variants");

  // Waiting: a spinner, never words about the connection.
  await waitFor(page, () => document.getElementById("btn-center-play").classList.contains("buffering"), null, "the spinner");
  const quality = await eventually(() => plays.find((body) => body.reason === "quality"), "a quality change", 60_000);
  assert.ok(quality.maxVideoKbps > 0 && quality.maxVideoKbps <= 700, JSON.stringify(quality));
  assert.equal(quality.sessionId, played.body.state.sessionId);

  // The smaller picture plays on from where it was.
  await waitFor(page, () => globalThis.__driveInMediabunny?.player?.height === 90, null, "the 150 kbps stream", 30_000);
  const from = await page.evaluate(() => globalThis.__driveInMediabunny.player.getCurrentTime());
  await playingPast(page, from + 2, "playing after stepping down", 45_000);
  const screen = await page.evaluate(() => ({
    overlay: document.getElementById("overlay").classList.contains("hidden"),
    error: document.getElementById("playback-error").classList.contains("hidden"),
    text: document.body.innerText,
  }));
  assert.equal(screen.overlay, true, "no status screen");
  assert.equal(screen.error, true, "no error");
  assert.doesNotMatch(screen.text, /Mbps|kbps|throughput|bandwidth|connection/i);
  assert.deepEqual(errors, []);

  // The details are for the logs and /diag.
  const diagnostics = await lastPlayback(page);
  assert.equal(diagnostics.stream.reason, "quality");
  assert.deepEqual([diagnostics.stream.height, diagnostics.stream.capped], [90, true]);
  assert.ok(diagnostics.events.some((event) => event.type === "quality_change_requested"));
  await eventually(() => deviceEvents(yolo, "quality_change_requested").length > 0, "quality_change_requested in the logs", 25_000);
  assert.ok(deviceEvents(yolo, "stream_selected").some((event) => event.includes("reason: 'quality'") && event.includes("capped: true")));
});

// Owner report: on a Bilibili dash_split stream the resolution looked wrong
// after seeking. A 4:3 picture whose yt-dlp format names no size (the
// node's master playlist then says 1280x720): a seek inside the stream, a
// seek that rebuilds it, and a recovery must all keep the same format and
// the decoder's own picture size.
test("seeking a dash_split stream keeps its format and picture size", { timeout: 240_000 }, async (t) => {
  const media = await mediaOrigin(t, mediaDir);
  const binary = await fakeYtdlpVariants(mediaDir, {
    title: "Four by three", duration: 60, audio: audioFormat(`${media.url}/audio-long.mp4`),
    videos: [{ format_id: "v43", url: `${media.url}/four-three.mp4`, vcodec: "avc1.42c00d", acodec: "none", fps: 30, tbr: 400 }],
  });
  const yolo = await startYolo(t, { pluginConfig: ytdlpPlugin(binary) });
  const context = await launchBrowser(t);
  const { page, errors } = await openPage(context, yolo.origin);
  const credential = await pair(yolo, page);
  const agent = await yolo.agentToken();
  const picture = () => page.evaluate(() => {
    const player = globalThis.__driveInMediabunny.player;
    return { width: player.width, height: player.height, canvas: [player.canvas.width, player.canvas.height], sessionId: globalThis.__yolo.state.sessionId };
  });

  const played = await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=four-three", start_at: 0 });
  await playingPast(page, 1, "dash_split");
  const first = await picture();
  assert.deepEqual([first.width, first.height, first.canvas], [320, 240, [320, 240]]);

  // A seek inside the stream: no new stream, the same picture.
  await yolo.mcp(agent, "seek", { position_seconds: 30 });
  await playingPast(page, 30.5, "after seeking inside the stream");
  assert.deepEqual(await picture(), first);

  // A seek that rebuilds the stream (as one past a transcode's start does).
  const rebuilt = await yolo.api(credential.token, "/v1/playback/play", {
    method: "POST", body: { source: played.state.item.source, startTime: 45, reason: "seek", sessionId: first.sessionId, deviceId: credential.deviceId },
  });
  assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.body));
  await waitFor(page, (id) => globalThis.__yolo.state.sessionId !== id, first.sessionId, "the rebuilt stream");
  await playingPast(page, 45.5, "after the rebuilding seek");
  const afterRebuild = await picture();
  assert.deepEqual([afterRebuild.width, afterRebuild.height, afterRebuild.canvas], [320, 240, [320, 240]]);

  // A recovery (the stream failed after the seek).
  await page.evaluate(() => {
    const { player } = globalThis.__driveInMediabunny;
    player.canvas.dataset.oldPlayer = "true";
    player.fail(new Error("network fixture failure"));
  });
  await waitFor(page, () => !globalThis.__driveInMediabunny?.player?.canvas.dataset.oldPlayer
    && globalThis.__driveInMediabunny.player.getStatus() === "playing", null, "the recovered stream", 45_000);
  const recovered = await picture();
  assert.deepEqual([recovered.width, recovered.height, recovered.canvas], [320, 240, [320, 240]]);
  assert.deepEqual(errors, []);

  // In the car's window (773x601), the controls stay above the band its
  // app dock covers (the bottom 15%).
  await page.setViewportSize({ width: 773, height: 601 });
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 320);
  await waitFor(page, () => document.getElementById("app").classList.contains("controls-visible"), null, "the controls");
  const bottoms = await page.evaluate(() => ["progress-wrap", "controls-row", "btn-volume"].map((id) => document.getElementById(id).getBoundingClientRect().bottom));
  for (const bottom of bottoms) assert.ok(bottom <= 601 * 0.85, `a control reaches ${bottom} px of 601`);

  // Every load chose the same format, without a cap, and the decoder's
  // picture matched it each time (after the seek inside the stream too).
  await eventually(() => deviceEvents(yolo, "stream_first_frame").some((event) => event.includes("reason: 'recovery'")), "the recovery's first frame in the logs", 25_000);
  assert.ok(deviceEvents(yolo, "stream_first_frame").some((event) => event.includes("reason: 'play'") && event.includes("seeks: 1")));
  const selected = deviceEvents(yolo, "stream_selected");
  assert.deepEqual(selected.map((event) => /reason: '(\w+)'/.exec(event)?.[1]), ["play", "seek", "recovery"]);
  for (const event of selected) {
    assert.match(event, /formatId: 'v43\+a'/);
    assert.match(event, /capped: false/);
    assert.match(event, /deliveryType: 'hls'/);
  }
  for (const event of deviceEvents(yolo, "stream_first_frame")) {
    assert.match(event, /width: 320,/);
    assert.match(event, /height: 240,/);
  }
});
