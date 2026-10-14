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

// The node's frames (Agent Note 2026-10-13-video-frames): ffmpeg reads one
// picture from the Input a source's prepare() gives, with real media, so
// ffmpeg is needed as in the rest of the end-to-end suite.

const secret = "e2e-frame-secret";
const exec = promisify(execFile);

const INPUTS = {
  file: (url) => ({ type: "file", url: `${url}/clip.webm` }),
  hls: (url) => ({ type: "hls", url: `${url}/hls/index.m3u8` }),
  split: (url) => ({
    type: "split",
    video: { url: `${url}/video.mp4`, codec: "avc1.42c00d", width: 320, height: 180, fps: 30 },
    audio: { url: `${url}/audio.mp4`, codec: "mp4a.40.2" },
  }),
};

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "yolo-e2e-frames-"));
  await makeMedia(dir, { seconds: 12 });
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
    }),
  }]);
  await plugins.start();
  const media = createMediaPipeline({ secret, runtimeDir: join(dir, "runtime"), stopGraceMs: 10 });
  media.init();
  t.after(() => media.close());
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const app = createNodeApp({ secret, plugins, media });
  const frame = async (body) => {
    const payload = JSON.stringify(body);
    const headers = await signNodeRequest(secret, { method: "POST", path: "/internal/v1/frame", body: payload });
    const response = await app.request("/internal/v1/frame", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: payload });
    return { status: response.status, body: await response.json() };
  };
  // The picture's real size, as ffprobe reads the JPEG.
  const probe = async (image) => {
    const path = join(dir, `probe-${Math.random().toString(36).slice(2)}.jpg`);
    await writeFile(path, Buffer.from(image, "base64"));
    const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", path]);
    return stdout.trim();
  };
  return { dir, origin, media, frame, probe, prepared, stopped };
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
