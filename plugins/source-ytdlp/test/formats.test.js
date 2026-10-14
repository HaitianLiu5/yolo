import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildFormatSelector, targetHeight } from "../src/formats.js";
import { createYtdlpSource } from "../src/node.js";
import { createYtdlp } from "../src/ytdlp.js";

// Format selection per device (Agent Note 2026-10-07-capability-negotiation).
// The fixtures are yt-dlp's JSON for two YouTube videos, recorded on
// 2026-10-13 and trimmed to what selection reads, with placeholder URLs:
// Big Buck Bunny at 60 fps up to 2160p, and Tears of Steel at 24 fps up to
// 4096×1714. YouTube offers H.264 up to 1080p only; taller pictures come as
// VP9 in WebM or HLS, and as AV1 in MP4.

const CAR = { renderer: "canvas-webcodecs", delivery: ["hls", "mp4"], containers: ["mp4"], video: ["avc1"], audio: ["mp4a"], maxHeight: 720 };
const chrome = (maxHeight) => ({
  renderer: "html5-video", delivery: ["hls", "mp4"], containers: ["mp4"], video: ["avc1", "hvc1", "vp09", "av01"], audio: ["mp4a", "opus", "flac"], maxHeight,
});
const safari = (maxHeight) => ({ ...chrome(maxHeight), video: ["avc1", "hvc1"], audio: ["mp4a", "flac"] });

const alternatives = (selector) => selector.split("/");

test("a device's target height is its own maxHeight, 720p when it names none", () => {
  assert.equal(targetHeight(CAR), 720);
  assert.equal(targetHeight(chrome(1440)), 1440);
  assert.equal(targetHeight(chrome(2160)), 2160);
  assert.equal(targetHeight({}), 720);
});

test("the car's selector is H.264 only, at 720p for fast motion and 1080p below 50 fps", () => {
  const selector = alternatives(buildFormatSelector({ targetHeight: 720, maxVideoKbps: 4800, videoCodecs: ["avc1"], audioCodec: "mp4a" }));
  assert.equal(selector[0], "bv[vcodec^=avc1][height<=720][tbr<=4800][fps>=50]+ba[acodec^=mp4a]");
  assert.ok(selector.includes("bv[vcodec^=avc1][height<=1080][tbr<=4800][fps<50]+ba[acodec^=mp4a]"), selector.join(" / "));
  // Any other codec only as a family the car did not announce is left out.
  const any = selector.filter((alternative) => /^bv\[height/.test(alternative));
  assert.ok(any.length > 0);
  for (const alternative of any) {
    for (const family of ["av01", "vp9", "vp09", "hvc1", "hev1"]) assert.match(alternative, new RegExp(`\\[vcodec!\\^=\\?${family}\\]`), alternative);
  }
  assert.doesNotMatch(selector.join("/"), /vcodec\^=(?:av01|vp09|hvc1)/);
});

test("a taller picture in another announced codec comes before H.264 at a lower height", () => {
  const selector = alternatives(buildFormatSelector({ targetHeight: 1440, maxVideoKbps: 20_000, videoCodecs: ["avc1", "vp09", "av01"], audioCodec: "mp4a" }));
  const tallAv1 = selector.indexOf("bv[vcodec^=av01][ext=mp4][protocol^=http][protocol!*=dash][dynamic_range=SDR][height<=1440][height>1080][tbr<=20000][fps>=50]+ba[acodec^=mp4a]");
  const tallAvc = selector.indexOf("bv[vcodec^=avc1][height<=1440][height>1080][tbr<=20000][fps>=50]+ba[acodec^=mp4a]");
  const avc1080 = selector.indexOf("bv[vcodec^=avc1][height<=1080][tbr<=20000][fps>=50]+ba[acodec^=mp4a]");
  assert.ok(tallAvc >= 0 && tallAvc < tallAv1 && tallAv1 < avc1080, selector.join(" / "));
});

// --- Against yt-dlp's own selection, on the recorded JSON ----------------------

const hasYtdlp = spawnSync("yt-dlp", ["--version"], { encoding: "utf8" }).status === 0;
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// yt-dlp itself, reading the fixture instead of the site.
function fromFixture(file) {
  return (binary, args, options, callback) => {
    const at = args.indexOf("--");
    return execFile("yt-dlp", [...args.slice(0, at), "--load-info-json", file], options, callback);
  };
}

async function picked(file, capabilities, maxVideoKbps) {
  const source = createYtdlpSource(createYtdlp({ exec: fromFixture(fixture(file)) }), { logger: {} });
  const url = "https://www.youtube.com/watch?v=fixture";
  const stream = await source.prepare({ plugin: "ytdlp", id: url, url }, {
    capabilities, startTime: 0, reason: "play", limits: { maxVideoKbps }, chooseTracks: () => ({ subtitles: [], audio: null }),
  });
  return { height: stream.profile.height, fps: stream.profile.fps, codec: stream.profile.videoCodec.split(".")[0], type: stream.input.type };
}

test("a browser with a 1440p-class screen gets more than 720p from YouTube", { skip: !hasYtdlp && "needs yt-dlp" }, async () => {
  assert.deepEqual(await picked("youtube-4k60.json", chrome(1440), 20_000), { height: 1440, fps: 60, codec: "av01", type: "split" });
  assert.deepEqual(await picked("youtube-4k24-scope.json", chrome(1440), 20_000), { height: 1142, fps: 24, codec: "av01", type: "split" });
  // Fast motion stops at 1440p on a 2160p screen; 24 fps goes to the top.
  assert.deepEqual(await picked("youtube-4k60.json", chrome(2160), 20_000), { height: 1440, fps: 60, codec: "av01", type: "split" });
  assert.deepEqual(await picked("youtube-4k24-scope.json", chrome(2160), 20_000), { height: 1714, fps: 24, codec: "av01", type: "split" });
  // H.264 wherever it reaches the screen's height, and for a browser without AV1.
  assert.deepEqual(await picked("youtube-4k60.json", chrome(1080), 20_000), { height: 1080, fps: 60, codec: "avc1", type: "split" });
  assert.deepEqual(await picked("youtube-4k60.json", safari(1440), 20_000), { height: 1080, fps: 60, codec: "avc1", type: "split" });
});

test("the car still gets 720p H.264 from the same video", { skip: !hasYtdlp && "needs yt-dlp" }, async () => {
  assert.deepEqual(await picked("youtube-4k60.json", CAR, 4800), { height: 720, fps: 60, codec: "avc1", type: "split" });
  // Below 50 fps the car's detail rule allows a 1080p-class picture, as before.
  assert.deepEqual(await picked("youtube-4k24-scope.json", CAR, 4800), { height: 858, fps: 24, codec: "avc1", type: "split" });
  // Under an adaptive-quality cap it stays on H.264, the only codec it announces.
  assert.deepEqual(await picked("youtube-4k60.json", CAR, 1500), { height: 480, fps: 30, codec: "avc1", type: "split" });
});
