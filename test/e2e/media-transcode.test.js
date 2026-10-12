import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signMediaToken } from "@useyolo/core";
import { createMediaPipeline } from "../../service/node/src/media/pipeline.js";
import { makeMedia, mediaOrigin } from "./fixtures.js";

// The node's split-file paths with real media (ffmpeg is needed, as in the
// rest of the end-to-end suite): fMP4 HLS over byte ranges, and the ffmpeg
// transcode fallback.

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
  await makeMedia(dir, { seconds: 6 });
  const origin = await mediaOrigin(t, dir);
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const open = async (sessionId, input) => media.open({
    sessionId,
    mediaToken: await signMediaToken(secret, { sessionId, userId: "usr_e2e", exp: Math.floor(Date.now() / 1000) + 600 }),
    source: { plugin: "fixture", id: sessionId },
    descriptor: { input },
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

test("split files become fMP4 HLS whose segments are byte ranges of the originals", { timeout: 60_000 }, async (t) => {
  const { origin, open, get } = await setup(t);
  const stream = await open("ses_dash", split(origin.url));
  assert.equal(stream.delivery.type, "hls");
  const master = await (await get(stream.delivery.url)).text();
  assert.match(master, /CODECS="avc1\.42c00d,mp4a\.40\.2"/);
  const video = await (await get(stream.delivery.url.replace("master", "video"))).text();
  const init = await get(/#EXT-X-MAP:URI="([^"]+)"/.exec(video)[1]);
  const first = await get(video.split("\n").find((line) => line.endsWith(".m4s")));
  assert.equal(init.status, 200);
  assert.equal(first.status, 200);
  assert.ok((await first.arrayBuffer()).byteLength > 0);
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
