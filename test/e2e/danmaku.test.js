import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { CAR_BROWSER, launchBrowser, openPage, pair, playingPast, waitFor } from "./browser.js";
import { fakeYtdlp, makeMedia, mediaOrigin } from "./fixtures.js";
import { fileContext, startYolo } from "./yolo-stack.js";

// Danmaku in the car (Agent Note 2026-10-13-danmaku): a Bilibili page that
// the yt-dlp plugin resolves with a fake yt-dlp, whose comment XML is a
// fixture, plays on the car's canvas engine; its comments are drawn over the
// picture at their times through a pause and seeks, an agent reads and
// switches them over MCP, and the page asks no host but Yolo's own.

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SECONDS = 30;
const PAGE = "https://www.bilibili.com/video/BV1e2eDanmaku";
const DANMAKU = `<?xml version="1.0" encoding="UTF-8"?><i><chatid>1</chatid><maxlimit>500</maxlimit>
<d p="2.0,1,25,16777215,0,0,a,1,10">first comment</d>
<d p="2.4,1,25,16776960,0,0,b,2,10">second comment</d>
<d p="6.0,5,25,16711680,0,0,c,3,10">a top comment</d>
<d p="20.0,1,25,16777215,0,0,d,4,10">much later</d>
</i>`;

const shared = fileContext();
let mediaDir;
let media;
let yolo;

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "yolo-e2e-danmaku-"));
  await makeMedia(mediaDir, { seconds: SECONDS });
  await writeFile(join(mediaDir, "danmaku.xml"), DANMAKU);
  media = await mediaOrigin(shared, mediaDir);
  const ytdlp = await fakeYtdlp(mediaDir, {
    title: "Danmaku fixture",
    duration: SECONDS,
    webpage_url: PAGE,
    manifest_url: `${media.url}/hls/index.m3u8`,
    http_headers: { Referer: PAGE },
    // What yt-dlp lists for a Bilibili video with --write-subs: its comment XML.
    subtitles: { danmaku: [{ ext: "xml", url: `${media.url}/danmaku.xml` }] },
  });
  yolo = await startYolo(shared, { pluginConfig: { plugins: [{ source: join(root, "plugins/source-ytdlp"), options: { binary: ytdlp } }] } });
}, { timeout: 120_000 });

after(async () => {
  await shared.cleanup();
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
});

const onScreen = (page) => page.evaluate(() => globalThis.__yolo.danmaku.onScreen());
const texts = (comments) => comments.map((comment) => comment.text).sort();

test("comments appear over the car's picture at their times, and the page asks no other host", { timeout: 180_000 }, async (t) => {
  const browser = await launchBrowser(t, { context: CAR_BROWSER });
  const { page, errors } = await openPage(browser, yolo.origin);
  const offOrigin = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/^(?:https?|wss?):$/.test(url.protocol) && url.origin !== yolo.origin) offOrigin.push(request.url());
  });
  await pair(yolo, page, { kind: "car" });
  assert.equal(await page.evaluate(() => globalThis.__yolo.profile.engine), "canvas");
  // Danmaku is on by default, in the car as on the web.
  assert.equal(await page.evaluate(() => globalThis.__yolo.danmakuSettings.get().enabled), true);

  const agent = await yolo.agentToken();
  await yolo.mcp(agent, "play", { url: PAGE, start_at: 0 });
  await playingPast(page, 0.2, "the Bilibili fixture");
  await waitFor(page, () => globalThis.__yolo.danmaku.available, null, "comments for the item", 30_000);
  await page.waitForSelector("#btn-danmaku:not(.hidden)", { state: "attached" });
  assert.equal(await page.getAttribute("#btn-danmaku", "aria-pressed"), "true");

  // Paused at 1 s: nothing yet. At 3 s: the two comments of 2 s and 2.4 s,
  // each as far in as its time says, in different lanes.
  await yolo.mcp(agent, "control", { action: "pause" });
  await page.waitForFunction(() => globalThis.__yoloPlayer.player.getStatus() === "paused", null, { timeout: 10_000 });
  await yolo.mcp(agent, "seek", { position_seconds: 1 });
  await page.waitForFunction(() => Math.abs(globalThis.__yoloPlayer.player.getCurrentTime() - 1) < 0.2, null, { timeout: 10_000 });
  await page.waitForTimeout(300);
  assert.deepEqual(await onScreen(page), []);
  await yolo.mcp(agent, "seek", { position_seconds: 3 });
  await waitFor(page, () => globalThis.__yolo.danmaku.onScreen().length === 2, null, "comments at 3 s");
  const at3 = await onScreen(page);
  assert.deepEqual(texts(at3), ["first comment", "second comment"]);
  const geometry = await page.evaluate(() => globalThis.__yolo.danmaku.geometry);
  const first = at3.find((comment) => comment.text === "first comment");
  const second = at3.find((comment) => comment.text === "second comment");
  assert.ok(first.x < second.x && second.x < geometry.width, JSON.stringify({ at3, geometry }));
  assert.notEqual(first.y, second.y, "two lanes");

  // The layer lies on the picture, inside the car's window, and has pixels
  // once the text worker has drawn the two comments.
  const painted = () => {
    const layer = document.getElementById("danmaku-layer");
    const pixels = layer.getContext("2d").getImageData(0, 0, layer.width, layer.height).data;
    let count = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) count += 1;
    return count;
  };
  await waitFor(page, `(${painted})() > 100`, null, "the comments' pixels");
  const boxes = await page.evaluate(() => {
    const box = (element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    const layer = document.getElementById("danmaku-layer");
    return { layer: box(layer), picture: box(document.querySelector("#player-container canvas[data-engine]")), hidden: layer.hidden };
  });
  assert.equal(boxes.hidden, false);
  assert.ok(boxes.layer.left >= boxes.picture.left - 1 && boxes.layer.right <= boxes.picture.right + 1, JSON.stringify(boxes));
  assert.ok(boxes.layer.bottom <= 601 && boxes.layer.right <= 773, JSON.stringify(boxes));

  // Paused, the picture holds still; playing on, the comments move left and
  // the top comment of 6 s appears.
  await page.waitForTimeout(400);
  assert.deepEqual(await onScreen(page), at3);
  await yolo.mcp(agent, "control", { action: "resume" });
  await playingPast(page, 6.2, "playing past 6 s");
  await waitFor(page, () => globalThis.__yolo.danmaku.onScreen().some((comment) => comment.mode === "top"), null, "the top comment");
  const later = await onScreen(page);
  assert.ok(later.find((comment) => comment.text === "first comment").x < first.x);

  // An agent reads what people say around the position, and turns danmaku off.
  const said = await yolo.mcp(agent, "get_comments", { at: 3, window: 4 });
  assert.equal(said.available, true);
  assert.deepEqual(said.comments.map((comment) => comment.text), ["first comment", "second comment"]);
  const set = await yolo.mcp(agent, "set_danmaku", { enabled: false });
  assert.equal(set.settings.enabled, false);
  await page.waitForFunction(() => document.getElementById("danmaku-layer").hidden && !globalThis.__yolo.danmaku.running, null, { timeout: 10_000 });
  assert.equal(await page.getAttribute("#btn-danmaku", "aria-pressed"), "false");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("yolo.danmaku")).enabled), false);

  assert.deepEqual(offOrigin, [], "every request stays on Yolo's origin");
  assert.deepEqual(errors, []);
});
