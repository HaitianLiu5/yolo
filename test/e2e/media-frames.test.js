import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { signMediaToken, signNodeRequest } from "@useyolo/core";
import { createNodeApp } from "../../service/node/src/app.js";
import { createMediaPipeline } from "../../service/node/src/media/pipeline.js";
import { loadPlugins } from "../../service/node/src/plugins.js";
import { makeMedia, mediaOrigin } from "./fixtures.js";

// The node's frames and storyboards (Agent Note 2026-10-13-video-frames):
// ffmpeg reads pictures from the Input a source's prepare() gives, or cuts
// them from the source's own storyboard images, with real media, so ffmpeg
// is needed as in the rest of the end-to-end suite.

const secret = "e2e-frame-secret";
const exec = promisify(execFile);

const INPUTS = {
  board: (url) => ({ type: "file", url: `${url}/clip.webm` }),
  file: (url) => ({ type: "file", url: `${url}/clip.webm` }),
  hls: (url) => ({ type: "hls", url: `${url}/hls/index.m3u8` }),
  split: (url) => ({
    type: "split",
    video: { url: `${url}/video.mp4`, codec: "avc1.42c00d", width: 320, height: 180, fps: 30 },
    audio: { url: `${url}/audio.mp4`, codec: "mp4a.40.2" },
  }),
};

// The fixture's own storyboard: one picture a second, in two 3×2 sheets.
const SHEETS = (url) => [0, 1].map((index) => ({
  url: `${url}/sb${index + 1}.jpg`, start: index * 6, duration: 6, columns: 3, rows: 2, tileWidth: 160, tileHeight: 90, interval: 1,
}));

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "yolo-e2e-frames-"));
  await makeMedia(dir, { seconds: 12 });
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=12",
    "-vf", "fps=1,scale=160:90,tile=3x2", "-frames:v", "2", join(dir, "sb%d.jpg")]);
  const origin = await mediaOrigin(t, dir);
  const prepared = [];
  const stopped = [];
  const plugins = await loadPlugins([{
    name: "fixture",
    enabled: true,
    options: {},
    factory: (yolo) => yolo.registerSource("fixture", {
      async prepare(source, context) {
        prepared.push({ id: source.id, reason: context.reason, startTime: context.startTime });
        return { title: `Fixture ${source.id}`, duration: 12, input: INPUTS[source.id](origin.url), stop: () => stopped.push(source.id) };
      },
      // Only "board" has storyboard images of its own.
      storyboard: async (source) => (source.id === "board" ? { title: "Fixture board", duration: 12, sheets: SHEETS(origin.url) } : null),
    }),
  }]);
  await plugins.start();
  const media = createMediaPipeline({ secret, runtimeDir: join(dir, "runtime"), stopGraceMs: 10 });
  media.init();
  t.after(() => media.close());
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const app = createNodeApp({ secret, plugins, media });
  const post = async (path, body) => {
    const payload = JSON.stringify(body);
    const headers = await signNodeRequest(secret, { method: "POST", path, body: payload });
    const response = await app.request(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: payload });
    return { status: response.status, body: await response.json() };
  };
  const frame = (body) => post("/internal/v1/frame", body);
  const storyboard = (body) => post("/internal/v1/storyboard", body);
  // The picture's real size, as ffprobe reads the JPEG.
  const probe = async (image) => {
    const path = join(dir, `probe-${Math.random().toString(36).slice(2)}.jpg`);
    await writeFile(path, Buffer.from(image, "base64"));
    const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", path]);
    return stdout.trim();
  };
  // RGB pixels of a JPEG, to look inside a storyboard.
  const pixels = async (image) => {
    const path = join(dir, `pixels-${Math.random().toString(36).slice(2)}.jpg`);
    await writeFile(path, Buffer.from(image, "base64"));
    const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  };
  return { dir, origin, media, frame, storyboard, probe, pixels, prepared, stopped };
}

test("a frame comes from each kind of Input at the time asked, scaled down only", { timeout: 90_000 }, async (t) => {
  const { frame, probe, prepared, stopped } = await setup(t);
  for (const id of ["file", "hls", "split"]) {
    const { status, body } = await frame({ source: { plugin: "fixture", id }, time: 7.5 });
    assert.equal(status, 200, `${id}: ${JSON.stringify(body)}`);
    assert.equal(body.mimeType, "image/jpeg");
    assert.equal(body.input, id);
    assert.equal(body.time, 7.5);
    assert.equal(body.title, `Fixture ${id}`);
    assert.deepEqual([body.width, body.height], [320, 180], id);
    assert.equal(await probe(body.image), "mjpeg,320,180", id);
  }
  // The source was asked for a frame at that time, and released after it.
  assert.deepEqual(prepared.map(({ reason, startTime }) => [reason, startTime]), [["frame", 7.5], ["frame", 7.5], ["frame", 7.5]]);
  assert.deepEqual(stopped, ["file", "hls", "split"]);

  const small = await frame({ source: { plugin: "fixture", id: "split" }, time: 3, width: 160 });
  assert.equal(await probe(small.body.image), "mjpeg,160,90");
  const early = await frame({ source: { plugin: "fixture", id: "hls" }, time: 2 });
  const late = await frame({ source: { plugin: "fixture", id: "hls" }, time: 9 });
  assert.notEqual(early.body.image, late.body.image, "two times give two pictures");

  const past = await frame({ source: { plugin: "fixture", id: "file" }, time: 30 });
  assert.equal(past.status, 400);
  assert.match(past.body.error.message, /past the end/);
});

test("a frame of the playing session comes from its cached segment, without a new prepare", { timeout: 90_000 }, async (t) => {
  const { origin, media, frame, probe, prepared } = await setup(t);
  const sessionId = "ses_playing";
  const opened = await media.open({
    sessionId,
    mediaToken: await signMediaToken(secret, { sessionId, userId: "usr_e2e", exp: Math.floor(Date.now() / 1000) + 600 }),
    source: { plugin: "fixture", id: "split" },
    descriptor: { title: "Playing split", duration: 12, input: INPUTS.split(origin.url) },
  });
  // The device played second 7: its init and segment are in the disk cache.
  const base = opened.delivery.url.replace(/master\.m3u8$/, "");
  for (const path of ["video/init.mp4", "video/7.m4s"]) {
    const response = await media.handle(new Request(`http://node.test${base}${path}`));
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  // The cache entry is written once the segment's last byte arrived.
  await new Promise((done) => setTimeout(done, 200));
  const { status, body } = await frame({ source: { plugin: "fixture", id: "split" }, time: 7.5, sessionId });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.input, "cache");
  assert.equal(body.title, "Playing split");
  assert.equal(await probe(body.image), "mjpeg,320,180");
  assert.equal(prepared.length, 0, "no new prepare for the playing session");
});

test("a storyboard tiles evenly spaced frames in one picture, each labelled with its time", { timeout: 90_000 }, async (t) => {
  const { storyboard, probe, pixels, prepared, stopped } = await setup(t);
  const { status, body } = await storyboard({ source: { plugin: "fixture", id: "hls" }, count: 6, width: 160 });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.origin, "frames");
  assert.equal(body.input, "hls");
  // The middles of six equal parts of 0–12 s.
  assert.deepEqual(body.times, [1, 3, 5, 7, 9, 11]);
  assert.deepEqual(body.missing, []);
  assert.deepEqual([body.columns, body.rows, body.tileWidth, body.tileHeight], [3, 2, 160, 90]);
  // Three 160×90 tiles and two rows, with a 2-pixel gap around each.
  assert.equal(await probe(body.image), "mjpeg,488,186");
  assert.deepEqual([body.width, body.height], [488, 186]);
  // The first tile's label is white ink on a darkened box at its bottom left.
  const rgb = await pixels(body.image);
  let ink = 0;
  for (let y = 2 + 90 - 11; y < 2 + 90; y += 1) {
    for (let x = 2; x < 2 + 30; x += 1) {
      const at = (y * 488 + x) * 3;
      if (rgb[at] > 200 && rgb[at + 1] > 200 && rgb[at + 2] > 200) ink += 1;
    }
  }
  assert.ok(ink > 15, `the label has ink (${ink} white pixels)`);
  assert.deepEqual(prepared.map(({ id, reason }) => [id, reason]), [["hls", "frame"]]);
  assert.deepEqual(stopped, ["hls"]);

  const part = await storyboard({ source: { plugin: "fixture", id: "split" }, from: "0:02", to: 6, count: 4, width: 160 });
  assert.equal(part.status, 200, JSON.stringify(part.body));
  assert.deepEqual(part.body.times, [2.5, 3.5, 4.5, 5.5]);
  const past = await storyboard({ source: { plugin: "fixture", id: "file" }, from: 20 });
  assert.equal(past.status, 400);
});

test("a source's own storyboard images make the storyboard without reading the video", { timeout: 90_000 }, async (t) => {
  const { storyboard, probe, prepared } = await setup(t);
  const { status, body } = await storyboard({ source: { plugin: "fixture", id: "board" }, count: 4, width: 160 });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.origin, "storyboard");
  assert.equal(body.title, "Fixture board");
  // 1.5, 4.5, 7.5 and 10.5 s fall on the tiles of seconds 1, 4, 7 and 10.
  assert.deepEqual(body.times, [1, 4, 7, 10]);
  assert.deepEqual(body.missing, []);
  assert.equal(await probe(body.image), "mjpeg,326,186");
  assert.equal(prepared.length, 0, "no prepare, no video read");
});
