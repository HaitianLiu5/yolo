import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { parseMp4Structure } from "../../service/node/src/media/dash.js";
import { CAR_BROWSER, deviceEvents, eventually, launchBrowser, openPage, pair, playsHubStream, waitFor } from "./browser.js";
import { fakeYtdlp, makeMedia, mediaOrigin } from "./fixtures.js";
import { fileContext, startYolo } from "./yolo-stack.js";

// A yt-dlp item end to end, in the car's canvas engine and the web
// profile's <video> engine: separate audio and video files (dash_split, as
// YouTube serves them) played to their end, with and without a queue item
// to go on to, also when the source's signed links failed on the way
// there. Each video has links of its own (fakeYtdlp's perVideo), since the
// node caches segments by their link.

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SECONDS = 40;
const shared = fileContext();
let mediaDir;
let media;
let yolo;
let videos = 0;

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "yolo-e2e-ytdlp-"));
  await makeMedia(mediaDir, { seconds: SECONDS });
  media = await mediaOrigin(shared, mediaDir);
  const ytdlp = await fakeYtdlp(mediaDir, {
    title: "Split fixture",
    duration: SECONDS,
    requested_formats: [
      { format_id: "v", url: `${media.url}/video.mp4`, vcodec: "avc1.42c00d", acodec: "none", width: 320, height: 180, fps: 30, tbr: 400 },
      { format_id: "a", url: `${media.url}/audio.mp4`, vcodec: "none", acodec: "mp4a.40.2", abr: 128 },
    ],
  }, { perVideo: true });
  yolo = await startYolo(shared, { pluginConfig: { plugins: [{ source: join(root, "plugins/source-ytdlp"), options: { binary: ytdlp } }] } });
}, { timeout: 120_000 });

after(async () => {
  await shared.cleanup();
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
});

const queued = (queue) => (Array.isArray(queue) ? queue : queue?.queue ?? queue?.items ?? []);

async function screen(t, kind) {
  const browser = await launchBrowser(t, kind === "car" ? { context: CAR_BROWSER } : {});
  const { page, errors } = await openPage(browser, yolo.origin);
  const credential = await pair(yolo, page, { kind });
  return { page, errors, credential };
}

// What the screen did at the end: the player ended, or the error panel.
async function atTheEnd(page) {
  await waitFor(page, () => globalThis.__yoloPlayer?.player?.getStatus() === "ended"
    || !document.getElementById("playback-error").classList.contains("hidden"), null, "the end of the item", 60_000);
  return page.evaluate(() => ({
    status: globalThis.__yoloPlayer?.player?.getStatus() ?? null,
    error: document.getElementById("playback-error").classList.contains("hidden") ? null : document.getElementById("playback-error-text").textContent,
  }));
}

// The CDN refuses the signed links the session started with once, which
// refreshes them, and then, during the node's refresh cooldown, refuses
// the last audio segment for a few seconds: while the car reads it ahead,
// not when it plays.
function refuseLinksOnTheWay() {
  const last = parseMp4Structure(readFileSync(join(mediaDir, "audio.mp4"))).segments.at(-1);
  const seen = { refreshed: false, lastRefused: 0 };
  let lastUntil = null;
  media.refuse = (path, range) => {
    const start = Number(/^bytes=(\d+)-/.exec(range || "")?.[1] ?? 0);
    if (path === "/video.mp4" && start > 0 && !seen.refreshed) {
      seen.refreshed = true;
      return 403;
    }
    if (path === "/audio.mp4" && start === last.start) {
      lastUntil ??= Date.now() + 4_000;
      if (Date.now() < lastUntil) {
        seen.lastRefused += 1;
        return 403;
      }
    }
    return null;
  };
  return seen;
}

async function playToTheEnd(t, { kind, queue, refused = false }) {
  const { page, errors, credential } = await screen(t, kind);
  const agent = await yolo.agentToken();
  await yolo.mcp(agent, "queue_clear");
  t.after(() => {
    media.refuse = null;
    return yolo.mcp(agent, "queue_clear").catch(() => {});
  });
  if (queue) await yolo.mcp(agent, "queue_add", { url: `${media.url}/hls/index.m3u8` });
  const item = `e2e-${videos += 1}`;
  const seen = refused ? refuseLinksOnTheWay() : null;
  await yolo.mcp(agent, "play", { url: `https://videos.test/watch?v=${item}`, start_at: SECONDS - 12, device: credential.deviceId });
  const { sessionId } = await playsHubStream(page, { from: SECONDS - 11.5, label: "the item near its end", timeout: 60_000 });
  const end = queue ? null : await atTheEnd(page);
  if (seen) {
    assert.ok(seen.refreshed, "the links were refreshed");
    assert.ok(seen.lastRefused > 0, "the last audio segment was refused on the way");
  }
  if (queue) {
    const playing = await playsHubStream(page, { replaced: sessionId, from: 0.5, to: 20, label: "the queue's next item", timeout: 60_000 });
    assert.match(JSON.stringify(playing.source), /hls/);
    assert.deepEqual(queued(await yolo.mcp(agent, "queue_list")), []);
  } else {
    assert.deepEqual(end, { status: "ended", error: null });
    await eventually(async () => (await yolo.api(credential.token, "/v1/playback")).body.status === "idle", "Yolo stopping after the end", 15_000);
  }
  assert.deepEqual(deviceEvents(yolo, "playback_error_shown", credential.deviceId), [], "no error panel");
  assert.equal(await page.evaluate(() => document.getElementById("playback-error").classList.contains("hidden")), true);
  assert.deepEqual(errors, []);
}

for (const kind of ["car", "browser"]) {
  const profile = kind === "car" ? "the car" : "the web profile";
  test(`in ${profile}, an item played to its end with nothing queued ends there, and Yolo stops`, { timeout: 180_000 }, (t) => playToTheEnd(t, { kind, queue: false }));
  test(`in ${profile}, an item played to its end goes on to the queue's next item`, { timeout: 180_000 }, (t) => playToTheEnd(t, { kind, queue: true }));
}

// The Tesla on 2026-10-16: a seek's new session reused links the CDN
// refused, the node refreshed them, and a refusal during the refresh's
// cooldown reached the car's read-ahead of the last audio segment, which
// showed the error panel 8 seconds before the end instead of ending.
test("in the car, a segment the node refused while the car read it ahead plays when the car gets there, and the item ends", { timeout: 180_000 }, (t) => playToTheEnd(t, { kind: "car", queue: false, refused: true }));
test("in the car, after a refused read-ahead the item still goes on to the queue's next item", { timeout: 180_000 }, (t) => playToTheEnd(t, { kind: "car", queue: true, refused: true }));
