import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { makeMedia, mediaOrigin } from "./fixtures.js";
import { autoplayMessage, deviceEvents, eventually, launchBrowser, openPage, pair, playingPast, waitFor } from "./tesla-helpers.js";
import { startYolo } from "./yolo-stack.js";

// The playback experience in the car (2026-10-12): resuming by itself
// after a wake like Spotify, quality that adapts to the connection, and a
// loading screen without technical text.

let mediaDir;

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "yolo-e2e-experience-"));
  await makeMedia(mediaDir);
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
