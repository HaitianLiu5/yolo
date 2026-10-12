import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

// Local stand-ins for everything outside Yolo: a media origin (a WebM file,
// an fMP4 HLS stream, separate DASH-style audio and video files), a fake
// yt-dlp that answers with fixture JSON, and a Plex Media Server that
// "transcodes" by serving the HLS fixture. Real media is made with ffmpeg,
// so decoding and canvas painting in the browser are real.

const exec = promisify(execFile);
const ffmpeg = (args) => exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

export async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => {
    server.closeAllConnections();
    server.close(done);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function sendFile(req, res, body, type) {
  res.setHeader("content-type", type);
  res.setHeader("accept-ranges", "bytes");
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  if (!range) {
    res.setHeader("content-length", body.length);
    res.end(body);
    return;
  }
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
  if (start >= body.length || end < start) {
    res.writeHead(416, { "content-range": `bytes */${body.length}` });
    res.end();
    return;
  }
  res.writeHead(206, { "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
  res.end(body.subarray(start, end + 1));
}

const TYPES = { webm: "video/webm", m3u8: "application/vnd.apple.mpegurl", mp4: "video/mp4", m4s: "video/iso.segment" };

export async function makeMedia(dir, { seconds = 12 } = {}) {
  await mkdir(join(dir, "hls"), { recursive: true });
  const video = ["-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:duration=${seconds}`];
  const audio = ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`];
  await Promise.all([
    ffmpeg([...video, ...audio, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "500k", "-c:a", "libopus", join(dir, "clip.webm")]),
    ffmpeg([...video, ...audio, "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-c:a", "aac", "-f", "hls", "-hls_time", "2",
      "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
      "-hls_segment_filename", join(dir, "hls", "seg%d.m4s"), join(dir, "hls", "index.m3u8")]),
    ffmpeg([...video, "-an", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-movflags", "+dash+global_sidx", join(dir, "video.mp4")]),
    ffmpeg([...audio, "-vn", "-c:a", "aac", "-movflags", "+dash+global_sidx", join(dir, "audio.mp4")]),
  ]);
}

// Serves the files in `dir` (and dir/hls) with byte ranges.
export async function mediaOrigin(t, dir) {
  const requests = [];
  const url = await listen(t, async (req, res) => {
    const path = new URL(req.url, "http://fixture").pathname;
    requests.push(path);
    const file = path.startsWith("/hls/") ? join(dir, "hls", path.slice(5)) : join(dir, path.slice(1));
    try {
      sendFile(req, res, await readFile(file), TYPES[path.split(".").at(-1)] || "application/octet-stream");
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return { url, requests };
}

// A yt-dlp stand-in: `--version`, and the fixture JSON for any other call.
export async function fakeYtdlp(dir, info) {
  const infoPath = join(dir, "ytdlp-info.json");
  await writeFile(infoPath, JSON.stringify(info));
  const tool = join(dir, "yt-dlp");
  await writeFile(tool, `#!${process.execPath}
if (process.argv.includes("--version")) { process.stdout.write("2026.09.01\\n"); process.exit(0); }
process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(infoPath)}));
`);
  await chmod(tool, 0o755);
  return tool;
}

// Plex Media Server, as much as Yolo's Plex plugin uses. The "transcode"
// serves the HLS fixture for any session it started.
export async function plexFixture(t, dir, { viewOffset = 0 } = {}) {
  const calls = [];
  const sessions = new Set();
  const movie = {
    ratingKey: "7",
    type: "movie",
    title: "Fixture Movie",
    duration: 12000,
    viewOffset,
    thumb: "/library/metadata/7/thumb/1",
    Media: [{ Part: [{ id: 5, Stream: [
      { id: 11, streamType: 2, codec: "aac", channels: 2, languageCode: "eng", displayTitle: "English", selected: true },
      { id: 21, streamType: 3, codec: "srt", key: "/library/streams/21", languageCode: "eng", displayTitle: "English" },
    ] }] }],
  };
  const url = await listen(t, async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, "http://plex");
    calls.push({ method: req.method, path: pathname, params: Object.fromEntries(searchParams), token: req.headers["x-plex-token"] });
    const json = (value) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (pathname === "/identity") return json({ MediaContainer: { machineIdentifier: "fixture" } });
    if (pathname === "/library/sections") return json({ MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } });
    if (pathname === "/library/sections/1/all") return json({ MediaContainer: { totalSize: 1, Metadata: [movie] } });
    if (pathname === "/library/metadata/7") return json({ MediaContainer: { Metadata: [movie] } });
    if (pathname === "/library/parts/5") return res.end();
    if (pathname === "/library/streams/21") return res.end("1\n00:00:00,000 --> 00:00:12,000\nFixture subtitle\n");
    if (pathname === "/transcode/sessions") return json({ MediaContainer: { size: sessions.size, TranscodeSession: [...sessions].map((key) => ({ key })) } });
    if (pathname === "/:/progress") return res.end();
    if (pathname === "/photo/:/transcode") {
      res.setHeader("content-type", "image/png");
      return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
    }
    if (pathname === "/video/:/transcode/universal/decision") return json({ MediaContainer: { generalDecisionText: "Direct play not available; transcoding" } });
    if (pathname === "/video/:/transcode/universal/start.m3u8") {
      const session = searchParams.get("session");
      sessions.add(session);
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      return res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=320x180\nsession/${session}/base/index.m3u8\n`);
    }
    if (pathname === "/video/:/transcode/universal/stop") {
      sessions.delete(searchParams.get("session"));
      return res.end();
    }
    const segment = /^\/video\/:\/transcode\/universal\/session\/([^/]+)\/base\/(.+)$/.exec(pathname);
    if (segment && sessions.has(segment[1])) {
      try {
        return sendFile(req, res, await readFile(join(dir, "hls", segment[2])), TYPES[segment[2].split(".").at(-1)] || "video/mp4");
      } catch {
        // Fall through to 404.
      }
    }
    res.writeHead(404);
    res.end();
  });
  return { url, calls, sessions };
}

// The built Tesla client on its own, with the headers Workers Static Assets
// add from its _headers file (COOP/COEP), for tests of the page alone.
export async function serveClient(t, dist) {
  const { readFile: read } = await import("node:fs/promises");
  const { extname } = await import("node:path");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml" };
  return listen(t, async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://client").pathname);
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    if (/^\/(v1|m|oauth|device|login)\b/.test(path)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "No control plane in this test" } }));
      return;
    }
    const file = path.endsWith("/") || !extname(path) ? join(dist, "index.html") : join(dist, path);
    try {
      const body = await read(file);
      res.setHeader("content-type", types[extname(file)] || "application/octet-stream");
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
}

// DASH-style video variants of one clip (each a video-only fMP4 with a
// sidx, 1-second fragments) and one audio file, for adaptive quality and
// seeks. `noise` makes x264 spend the bitrate it is given.
export async function makeDashVariants(dir, { seconds = 60, variants, audioName = "audio-long.mp4" }) {
  await mkdir(dir, { recursive: true });
  await Promise.all([
    ...variants.map(({ name, width, height, kbps, noise = false }) => ffmpeg([
      "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30:duration=${seconds}${noise ? ",noise=alls=80:allf=t+u" : ""}`,
      "-an", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
      "-b:v", `${kbps}k`, "-minrate", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps}k`, "-x264-params", "nal-hrd=cbr",
      "-movflags", "+dash+global_sidx", join(dir, `${name}.mp4`),
    ])),
    ffmpeg(["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`, "-vn", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+dash+global_sidx", join(dir, audioName)]),
  ]);
}

// A yt-dlp stand-in that picks among video formats as the real one would
// for Yolo's selector: the best whose tbr fits the `[tbr<=N]` cap in -f,
// else the smallest. `videos` and `audio` are yt-dlp format objects.
export async function fakeYtdlpVariants(dir, { title, duration, videos, audio }) {
  const infoPath = join(dir, "ytdlp-variants.json");
  await writeFile(infoPath, JSON.stringify({ title, duration, videos, audio }));
  const tool = join(dir, "yt-dlp-variants");
  await writeFile(tool, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("2026.09.01\\n"); process.exit(0); }
const { title, duration, videos, audio } = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(infoPath)}, "utf8"));
const selector = args.includes("-f") ? args[args.indexOf("-f") + 1] : "";
const cap = Number(/\\[tbr<=(\\d+)\\]/.exec(selector)?.[1]) || Infinity;
const sorted = [...videos].sort((a, b) => a.tbr - b.tbr);
const video = sorted.filter((format) => format.tbr <= cap).at(-1) || sorted[0];
process.stdout.write(JSON.stringify({ title, duration, requested_formats: [video, audio] }));
`);
  await chmod(tool, 0o755);
  return tool;
}
