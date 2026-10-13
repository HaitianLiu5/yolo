import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { makeMedia, mediaOrigin } from "./fixtures.js";
import { CAR_BROWSER, deviceEvents, eventually, launchBrowser, openPage, pair, playingPast, waitFor } from "./browser.js";
import { startYolo } from "./yolo-stack.js";

// The player in the car's window as the car reported it on 2026-10-12: a
// 773x601 window at devicePixelRatio 1.53 that ends above the car's app
// dock, in a Chrome that ignores the viewport meta. The display size zooms
// the page (Agent Note 2026-10-11-display-size); the controls sit on the
// window's bottom edge and the picture is centred
// (Agent Note 2026-07-13-in-car-design-principles).

let mediaDir;

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "yolo-e2e-car-layout-"));
  await makeMedia(mediaDir, { seconds: 120 });
});

after(async () => {
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
});

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
  const media = await mediaOrigin(t, mediaDir);
  const yolo = await startYolo(t);
  const context = await launchBrowser(t, { context: CAR_BROWSER });
  const { page, errors } = await openPage(context, yolo.origin);
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
  await waitFor(page, () => globalThis.__driveInMediabunny.player.getStatus() === "paused", null, "paused");
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
  await waitFor(page, () => Math.abs(globalThis.__driveInMediabunny.player.getCurrentTime() - 91.2) < 2.5, null, "the seek to 1:31");

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
  await eventually(() => deviceEvents(yolo, "display_scale").some((event) => event.includes("honoured: true")), "display_scale in the logs", 25_000);
  const scaled = deviceEvents(yolo, "display_scale").find((event) => event.includes("honoured: true"));
  for (const field of ["method: 'zoom'", "scale: 1.25", "zoom: 0.817", "width: 946", "layoutWidth: 946", "physicalWidth: 1183", "innerWidth: 773"]) assert.ok(scaled.includes(field), `${field} in ${scaled}`);
  await eventually(() => deviceEvents(yolo, "stream_selected").length > 0, "stream_selected in the logs", 25_000);
  assert.match(deviceEvents(yolo, "stream_selected")[0], /physicalWidth: 1183/);

  // Largest is the browser's own scale: no zoom, and the controls still
  // sit on the bottom edge.
  await page.evaluate(() => globalThis.__yolo.displayScale.choose("native"));
  await waitFor(page, () => document.body.clientWidth === 773 && getComputedStyle(document.documentElement).zoom === "1", null, "the largest size");
  await showControls(page);
  const largest = await geometry(page);
  assert.ok(largest.innerHeight - largest.row.bottom <= 8.5, JSON.stringify(largest.row));
});
