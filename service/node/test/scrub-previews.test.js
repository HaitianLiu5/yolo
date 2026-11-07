import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signMediaToken, WEB_NATIVE_CAPABILITIES } from "@useyolo/core";
import { createFrames, jpegSize } from "../src/media/frames.js";
import { createMediaPipeline } from "../src/media/pipeline.js";

// A screen's scrub previews (Agent Note 2026-11-07-scrub-previews): small
// pictures of a stream's moments at /m/{token}/preview/{seconds}.jpg.

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const needsFfmpeg = { skip: !hasFfmpeg && "needs ffmpeg" };

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "yolo-previews-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Red for its first 10 seconds, then blue, with a keyframe every 2 seconds.
function makeVideo(path) {
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=red:size=960x540:rate=24:duration=10", "-f", "lavfi", "-i", "color=blue:size=960x540:rate=24:duration=20",
    "-lavfi", "[0][1]concat=n=2:v=1", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path,
  ]);
}

// The picture's average colour as [r, g, b].
function colour(jpeg, dir) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-f", "image2pipe", "-i", "pipe:0", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: jpeg, cwd: dir });
  return [...raw];
}

async function setup(t, { sources = {}, input, descriptor = {}, fetchImpl } = {}) {
  const dir = tempDir(t);
  const media = createMediaPipeline({ secret: "secret", runtimeDir: dir });
  media.init();
  t.after(() => media.close());
  const frames = createFrames({ sources, media, ...(fetchImpl ? { fetchImpl } : {}) });
  media.setPreviews(frames.preview);
  const token = await signMediaToken("secret", { sessionId: "ses", userId: "usr", exp: Math.floor(Date.now() / 1000) + 600 });
  const stream = await media.open({
    sessionId: "ses", mediaToken: token, source: { plugin: "test", id: "item" },
    descriptor: { input, duration: 30, ...descriptor }, request: { capabilities: WEB_NATIVE_CAPABILITIES, limits: { maxVideoKbps: 20_000 } },
  });
  return { stream, dir, get: (path) => media.handle(new Request(`http://node${path}`)) };
}

test("a moment's picture is small, of that moment, and read once", needsFfmpeg, async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "a.mp4");
  makeVideo(file);
  const { stream, get } = await setup(t, { input: { type: "local", path: file } });
  assert.match(stream.previews, /\/preview$/);

  const blue = await get(`${stream.previews}/20.jpg`);
  assert.equal(blue.status, 200);
  assert.equal(blue.headers.get("content-type"), "image/jpeg");
  const jpeg = Buffer.from(await blue.arrayBuffer());
  assert.equal(jpegSize(jpeg).width, 480);
  const [r, , b] = colour(jpeg, dir);
  assert.ok(b > r, "20 seconds in is blue");
  const [redR, , redB] = colour(Buffer.from(await (await get(`${stream.previews}/4.jpg`)).arrayBuffer()), dir);
  assert.ok(redR > redB, "4 seconds in is red");

  // The next scrub finds it in memory, with the file gone.
  unlinkSync(file);
  assert.equal((await get(`${stream.previews}/20.jpg`)).status, 200);
  assert.notEqual((await get(`${stream.previews}/22.jpg`)).status, 200);
});

test("a moment past the end, and a live stream, have no picture", needsFfmpeg, async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "a.mp4");
  makeVideo(file);
  const { stream, get } = await setup(t, { input: { type: "local", path: file } });
  assert.equal((await get(`${stream.previews}/31.jpg`)).status, 400);

  const live = await setup(t, { input: { type: "hls", url: "https://cdn.test/live.m3u8", manifest: "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://cdn.test/a.ts\n" }, descriptor: { isLive: true, duration: null } });
  assert.equal(live.stream.previews, null);
  const [liveBase] = /\/m\/[^/]+/.exec(live.stream.delivery.url);
  assert.equal((await live.get(`${liveBase}/preview/4.jpg`)).status, 404);
});

test("a source's own storyboard gives the picture, one download a sheet", needsFfmpeg, async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "a.mp4");
  makeVideo(file);
  // Two tiles of 160x90, 15 seconds each: green, then yellow.
  const sheetPath = join(dir, "sheet.jpg");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=green:size=160x90", "-f", "lavfi", "-i", "color=yellow:size=160x90", "-lavfi", "[0][1]hstack", "-frames:v", "1", sheetPath]);
  const sheetBytes = execFileSync("cat", [sheetPath]);
  let downloads = 0;
  const fetchImpl = async () => {
    downloads += 1;
    return new Response(sheetBytes);
  };
  const sources = {
    storyboard: async () => ({ duration: 30, sheets: [{ url: "https://cdn.test/sheet.jpg", start: 0, duration: 30, columns: 2, rows: 1, tileWidth: 160, tileHeight: 90, interval: 15 }] }),
  };
  const { stream, get } = await setup(t, { sources, fetchImpl, input: { type: "local", path: file } });
  const first = Buffer.from(await (await get(`${stream.previews}/4.jpg`)).arrayBuffer());
  const second = Buffer.from(await (await get(`${stream.previews}/20.jpg`)).arrayBuffer());
  assert.equal(jpegSize(first).width, 160, "never larger than the tile");
  const [r1, g1] = colour(first, dir);
  const [r2, g2] = colour(second, dir);
  assert.ok(g1 > r1 + 40, "the first tile is green");
  assert.ok(r2 > 150 && g2 > 150, "the second tile is yellow");
  assert.equal(downloads, 1);
});

test("a transcoding source's session reads the item a prepare gives, once", needsFfmpeg, async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "a.mp4");
  makeVideo(file);
  const reasons = [];
  const sources = {
    prepare: async (_source, context) => {
      reasons.push(context.reason);
      return { input: { type: "local", path: file }, duration: 30 };
    },
  };
  const { stream, get } = await setup(t, {
    sources,
    input: { type: "hls", transcoder: true, url: "https://transcoder.test/start.m3u8", manifest: "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://transcoder.test/a.ts\n#EXT-X-ENDLIST\n" },
  });
  assert.equal((await get(`${stream.previews}/20.jpg`)).status, 200);
  assert.equal((await get(`${stream.previews}/24.jpg`)).status, 200);
  assert.deepEqual(reasons, ["frame"]);
});
