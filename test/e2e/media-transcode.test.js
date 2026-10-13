import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signMediaToken } from "@useyolo/core";
import { createMediaPipeline } from "../../service/node/src/media/pipeline.js";
import { makeMedia, makePlainSplit, mediaOrigin } from "./fixtures.js";

// The node's ffmpeg paths for split files, with real media (ffmpeg is
// needed, as in the rest of the end-to-end suite): the transcode fallback,
// and files without a segment index for a <video> element
// (Agent Note 2026-10-12-two-playback-engines). Split files with a segment
// index become fMP4 HLS over byte ranges without ffmpeg: the node's unit
// tests and both engines' dash_split journeys cover them.

const secret = "e2e-media-secret";

// node:test runs after-hooks in the order they were added, and a failing
// hook skips the rest. So: stop the pipeline first, then the origin, and
// remove the directory last, retrying while a cache write that was still
// in flight lands.
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "yolo-e2e-split-"));
  const media = createMediaPipeline({ secret, runtimeDir: join(dir, "runtime"), stopGraceMs: 10 });
  media.init();
  t.after(() => media.close());
  await Promise.all([makeMedia(dir, { seconds: 6 }), makePlainSplit(dir)]);
  const origin = await mediaOrigin(t, dir);
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const open = async (sessionId, input, request) => media.open({
    sessionId,
    mediaToken: await signMediaToken(secret, { sessionId, userId: "usr_e2e", exp: Math.floor(Date.now() / 1000) + 600 }),
    source: { plugin: "fixture", id: sessionId },
    descriptor: { input },
    ...(request ? { request } : {}),
  });
  const get = (path) => media.handle(new Request(`http://node.test${path}`));
  return { origin, open, get };
}

const split = (url, extra = {}) => ({
  type: "split",
  video: { url: `${url}/video.mp4`, codec: "avc1.42c00d", width: 320, height: 180, fps: 30 },
  audio: { url: `${url}/audio.mp4`, codec: "mp4a.40.2" },
  ...extra,
});

test("the ffmpeg fallback transcodes split files into HLS", { timeout: 90_000 }, async (t) => {
  const { origin, open, get } = await setup(t);
  const stream = await open("ses_ffmpeg", split(origin.url, { transcode: true }));
  assert.match(stream.delivery.url, /\/x\/playlist\.m3u8$/);
  const playlist = await (await get(stream.delivery.url)).text();
  assert.match(playlist, /#EXT-X-MAP:URI="\/m\/[^/]+\/x\/init\.mp4"/);
  const segment = playlist.split("\n").find((line) => line.endsWith(".m4s"));
  const response = await get(segment);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
});

test("split files without a segment index become one ffmpeg stream for a <video> element", { timeout: 90_000 }, async (t) => {
  const { origin, open, get } = await setup(t);
  const plain = { type: "split", video: { url: `${origin.url}/video-plain.mp4` }, audio: { url: `${origin.url}/audio-plain.mp4` } };
  // The canvas engine reads both files by byte range.
  assert.equal((await open("ses_plain_canvas", plain, { capabilities: { renderer: "canvas-webcodecs" } })).delivery.type, "split-mp4");
  // A <video> element plays one stream.
  const stream = await open("ses_plain_video", plain, { capabilities: { renderer: "html5-video" } });
  assert.equal(stream.delivery.type, "hls");
  assert.match(stream.delivery.url, /\/x\/playlist\.m3u8$/);
  const playlist = await (await get(stream.delivery.url)).text();
  const segment = await get(playlist.split("\n").find((line) => line.endsWith(".m4s")));
  assert.equal(segment.status, 200);
});
