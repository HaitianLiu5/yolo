import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signMediaToken, signNodeRequest, WEB_NATIVE_CAPABILITIES } from "@useyolo/core";
import localMetadata from "../../../plugins/metadata-local/src/node.js";
import folderSource from "../../../plugins/source-folder/src/node.js";
import { createNodeApp } from "../src/app.js";
import { normalizeInput } from "../src/media/input.js";
import { probeFile, readKeyframes } from "../src/media/local-file.js";
import { jobArgs, localPlaylist, planSegments } from "../src/media/local-stream.js";
import { createMediaPipeline } from "../src/media/pipeline.js";
import { loadPlugins } from "../src/plugins.js";
import { createSourceRegistry, insideRoots } from "../src/sources.js";

// A file on the node's disk (Agent Note 2026-10-26-folder-source): the
// `local` Input, the roots it must lie in, the segment plan, and, with
// ffmpeg on the machine, real files played as they are and as HLS.

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "yolo-local-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A 30-second H.264 video with a keyframe every 2 seconds and B-frames, and
// the audio given.
function makeVideo(path, { audio = "aac", seconds = 30 } = {}) {
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-bf", "2", "-c:a", audio, "-b:a", "96k", path,
  ]);
}

test("a local Input is an absolute, normalized path", () => {
  assert.deepEqual(normalizeInput({ type: "local", path: "/media/a.mkv", audio: 2 }), { type: "local", path: "/media/a.mkv", audio: 2 });
  assert.equal(normalizeInput({ type: "local", path: "/media/a.mkv", audio: "x" }).audio, null);
  for (const path of ["media/a.mkv", "/media/../etc/passwd", "/media/a\0.mkv", 3]) {
    assert.throws(() => normalizeInput({ type: "local", path }), /path must be an absolute, normalized path/);
  }
});

test("a source plays a local file only from inside its roots, links resolved", async (t) => {
  const dir = tempDir(t);
  const root = join(dir, "library");
  const outside = join(dir, "secret.mkv");
  execFileSync("mkdir", ["-p", root]);
  writeFileSync(join(root, "a.mkv"), "x");
  writeFileSync(outside, "x");
  symlinkSync(outside, join(root, "link.mkv"));
  assert.equal(await insideRoots(join(root, "a.mkv"), [root]), true);
  assert.equal(await insideRoots(outside, [root]), false);
  assert.equal(await insideRoots(join(root, "link.mkv"), [root]), false);
  assert.equal(await insideRoots(join(root, "missing.mkv"), [root]), false);
  assert.equal(await insideRoots(join(`${root}2`, "a.mkv"), [root]), false);

  const registry = createSourceRegistry();
  registry.add("folder", { roots: () => [root], prepare: async (source) => ({ input: { type: "local", path: source.id } }) }, "folder");
  registry.add("bare", { prepare: async () => ({ input: { type: "local", path: join(root, "a.mkv") } }) }, "bare");
  assert.equal((await registry.prepare({ plugin: "folder", id: join(root, "a.mkv") }, {})).input.path, join(root, "a.mkv"));
  await assert.rejects(registry.prepare({ plugin: "folder", id: outside }, {}), { code: "forbidden" });
  await assert.rejects(registry.prepare({ plugin: "folder", id: join(root, "link.mkv") }, {}), { code: "forbidden" });
  await assert.rejects(registry.prepare({ plugin: "bare", id: "x" }, {}), { code: "forbidden" });
});

test("segments are cut at roomy keyframes at least six seconds apart, else every six seconds", () => {
  const keyframes = [0, 2, 4, 6, 8, 10, 12.1, 12.3, 15, 22, 24, 26, 28];
  const plan = planSegments({ duration: 30, keyframes });
  // 12.1 has a keyframe 0.2 s after it, too close to seek to; 12.3 one 0.2 s before it.
  assert.deepEqual(plan.map((segment) => segment.start), [0, 6, 15, 22, 28]);
  assert.equal(plan.at(-1).end, 30);
  assert.deepEqual(planSegments({ duration: 13 }).map((segment) => [segment.start, segment.end]), [[0, 6], [6, 12], [12, 13]]);
  assert.throws(() => planSegments({ duration: 0 }), /no duration/);

  const playlist = localPlaylist(plan, (index) => `/r/${index}.ts`);
  assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(playlist, /#EXT-X-TARGETDURATION:9\n/);
  assert.match(playlist, /#EXTINF:9\.000000,\n\/r\/1\.ts/);
  assert.match(playlist, /#EXT-X-ENDLIST\n$/);
});

test("a job copies from its first keyframe and cuts at the plan's times, counted from there", () => {
  const segments = planSegments({ duration: 30, keyframes: [0, 6, 12, 18, 24] });
  const copy = jobArgs({ path: "/m/a.mkv", segments, from: 2, plan: { video: "copy", audio: "copy", videoIndex: 0, audioIndex: 1 }, dir: "/tmp/j" });
  assert.deepEqual(copy.slice(copy.indexOf("-ss"), copy.indexOf("-ss") + 2), ["-ss", "12.200"]);
  assert.deepEqual(copy.slice(copy.indexOf("-segment_times"), copy.indexOf("-segment_times") + 2), ["-segment_times", "6.000,12.000"]);
  assert.equal(copy[copy.indexOf("-segment_start_number") + 1], "2");
  assert.ok(copy.includes("-copyts"));
  assert.ok(!copy.includes("libx264"));
  // The first job starts at the file's start, with no seek.
  assert.ok(!jobArgs({ path: "/m/a.mkv", segments, from: 0, plan: { video: "copy", audio: "copy", videoIndex: 0, audioIndex: 1 }, dir: "/tmp/j" }).includes("-ss"));

  const transcode = jobArgs({ path: "/m/a.mkv", segments, from: 1, plan: { video: "transcode", audio: "transcode", videoIndex: 0, audioIndex: 3, maxHeight: 720, maxVideoKbps: 3000 }, dir: "/tmp/j" });
  assert.deepEqual(transcode.slice(transcode.indexOf("-ss"), transcode.indexOf("-ss") + 2), ["-ss", "6.000"]);
  assert.equal(transcode[transcode.indexOf("-force_key_frames") + 1], "12.000,18.000,24.000");
  assert.equal(transcode[transcode.indexOf("-maxrate") + 1], "3000k");
  assert.ok(transcode.includes("0:3"));
  assert.ok(transcode.includes("aac"));
});

test("an MP4's and a Matroska file's keyframes come from their own index", { skip: !hasFfmpeg && "needs ffmpeg" }, async (t) => {
  const dir = tempDir(t);
  makeVideo(join(dir, "a.mkv"));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(dir, "a.mkv"), "-c", "copy", join(dir, "a.mp4")]);
  for (const name of ["a.mkv", "a.mp4"]) {
    const path = join(dir, name);
    const probe = await probeFile(path);
    assert.equal(probe.video.codec, "avc1");
    assert.deepEqual(probe.audio.map((track) => track.codec), ["mp4a"]);
    const indexed = await readKeyframes(path, { container: probe.container, scan: false });
    const scanned = await readKeyframes(path, { container: "other" });
    assert.equal(indexed.length, 15, name);
    assert.deepEqual(indexed.map((time) => time.toFixed(2)), scanned.map((time) => time.toFixed(2)), name);
  }
});

async function pipeline(t, dir) {
  const media = createMediaPipeline({ secret: "secret", runtimeDir: dir });
  media.init();
  t.after(() => media.close());
  const exp = Math.floor(Date.now() / 1000) + 600;
  const open = async (sessionId, input) => media.open({
    sessionId, mediaToken: await signMediaToken("secret", { sessionId, userId: "usr", exp }), source: { plugin: "folder", id: sessionId },
    descriptor: { input, duration: 30 }, request: { capabilities: WEB_NATIVE_CAPABILITIES, limits: { maxVideoKbps: 20_000 } },
  });
  const get = (path, headers = {}) => media.handle(new Request(`http://node${path}`, { headers }));
  return { media, open, get };
}

// The first video timestamp and the frame count of an MPEG-TS segment.
function videoOf(bytes, dir) {
  const path = join(dir, `probe-${Math.random()}.ts`);
  writeFileSync(path, bytes);
  const out = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=start_time,nb_read_packets", "-of", "json", path], { encoding: "utf8" }));
  return { start: Number(out.streams[0].start_time), frames: Number(out.streams[0].nb_read_packets) };
}

test("a file the screen plays as it is is served by byte range from the disk", { skip: !hasFfmpeg && "needs ffmpeg" }, async (t) => {
  const dir = tempDir(t);
  makeVideo(join(dir, "a.mkv"));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(dir, "a.mkv"), "-c", "copy", "-movflags", "+faststart", join(dir, "a.mp4")]);
  const { open, get } = await pipeline(t, dir);
  const stream = await open("ses_mp4", { type: "local", path: join(dir, "a.mp4") });
  assert.equal(stream.delivery.type, "mp4");
  const ranged = await get(stream.delivery.url, { range: "bytes=10-19" });
  assert.equal(ranged.status, 206);
  assert.match(ranged.headers.get("content-range"), /^bytes 10-19\/\d+$/);
  assert.equal(ranged.headers.get("content-type"), "video/mp4");
  assert.equal((await ranged.arrayBuffer()).byteLength, 10);
  assert.equal((await get(stream.delivery.url, { range: "bytes=999999999-" })).status, 416);
});

test("a Matroska file plays as HLS that ffmpeg copies, the same segments wherever a job starts", { skip: !hasFfmpeg && "needs ffmpeg" }, async (t) => {
  const dir = tempDir(t);
  makeVideo(join(dir, "a.mkv"));
  const { open, get } = await pipeline(t, dir);
  const first = await open("ses_one", { type: "local", path: join(dir, "a.mkv") });
  assert.equal(first.delivery.type, "hls");
  const playlist = await (await get(first.delivery.url)).text();
  const uris = playlist.split("\n").filter((line) => line.endsWith(".ts"));
  assert.equal(uris.length, 5);
  const continuous = [];
  for (const uri of uris) continuous.push(videoOf(Buffer.from(await (await get(uri)).arrayBuffer()), dir));
  // Each segment starts where the plan says, 0.2 s later, and they share every frame once.
  assert.deepEqual(continuous.map((segment) => segment.start.toFixed(2)), ["0.20", "6.20", "12.20", "18.20", "24.20"]);
  assert.equal(continuous.reduce((sum, segment) => sum + segment.frames, 0), 30 * 24);

  // A second stream asked first for segment 3: its job starts there.
  const second = await open("ses_two", { type: "local", path: join(dir, "a.mkv") });
  const later = (await (await get(second.delivery.url)).text()).split("\n").filter((line) => line.endsWith(".ts"));
  const jumped = videoOf(Buffer.from(await (await get(later[3])).arrayBuffer()), dir);
  assert.deepEqual(jumped, continuous[3]);
});

test("audio a screen does not decode is transcoded while the video is copied", { skip: !hasFfmpeg && "needs ffmpeg" }, async (t) => {
  const dir = tempDir(t);
  makeVideo(join(dir, "a.mkv"), { audio: "ac3", seconds: 12 });
  const { media, open, get } = await pipeline(t, dir);
  const stream = await open("ses_ac3", { type: "local", path: join(dir, "a.mkv") });
  const uri = (await (await get(stream.delivery.url)).text()).split("\n").find((line) => line.endsWith(".ts"));
  const path = join(dir, "seg.ts");
  writeFileSync(path, Buffer.from(await (await get(uri)).arrayBuffer()));
  const codecs = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", path], { encoding: "utf8" })).streams.map((stream) => stream.codec_name).sort();
  assert.deepEqual(codecs, ["aac", "h264"]);
  assert.equal(media.status().local[0].sessionId, "ses_ac3");
});

// The folder source and the metadata plugins together
// (Agent Note 2026-10-25-metadata-plugins): file() lets metadata-local read
// the NFO and poster beside a file, and the listing then shows the file as
// the work they name, with the poster as its picture.
test("a folder's file is listed as the work its NFO names, with the poster beside it", async (t) => {
  const dir = tempDir(t);
  const root = join(dir, "Movies");
  const movie = join(root, "Some Movie (2001)");
  execFileSync("mkdir", ["-p", movie]);
  writeFileSync(join(movie, "Some.Movie.2001.1080p.mkv"), "x");
  writeFileSync(join(movie, "Some.Movie.2001.1080p.nfo"), "<movie><title>The Real Title</title><year>2001</year><plot>What it is about.</plot><uniqueid type=\"imdb\">tt0000001</uniqueid></movie>");
  writeFileSync(join(movie, "poster.jpg"), "jpeg");
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const plugins = await loadPlugins([
    { name: "@useyolo/source-folder", enabled: true, options: { roots: [root] }, factory: folderSource },
    { name: "@useyolo/metadata-local", enabled: true, options: { ffprobe: "/nonexistent/ffprobe" }, factory: localMetadata },
  ], { logger: quiet });
  await plugins.start();
  t.after(() => plugins.shutdown?.());
  const app = createNodeApp({ secret: "s", plugins, metadataCacheDir: join(dir, "metadata"), logger: quiet });
  const get = async (path) => {
    const headers = await signNodeRequest("s", { method: "GET", path, body: "" });
    return (await app.request(path, { headers })).json();
  };
  const list = async () => (await get("/internal/v1/library/folder%3Amovies/items")).items;
  const [listed] = await list();
  assert.equal(listed.title, "Some Movie (2001)", "listed as the source gives it at first, never waited for");
  let item = listed;
  for (let tries = 0; tries < 100 && item.title === listed.title; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    [item] = await list();
  }
  assert.match(item.title, /The Real Title/);
  assert.equal(item.kind, "movie");
  assert.match(item.thumbnail, /artwork\?variant=m-local-poster$/);
  const details = await get(`/internal/v1/details?source=${encodeURIComponent(JSON.stringify({ plugin: "folder", id: item.id.slice("folder:".length) }))}`);
  assert.equal(details.description, "What it is about.");
  assert.equal(details.ids.imdb, "tt0000001");
});
