import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startYolo } from "./yolo-stack.js";

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

// `dashSeconds` is the length of the separate audio and video files, which
// may be longer than the rest: a step up of adaptive quality needs an item
// whose rest the canvas engine has not buffered after 90 seconds.
export async function makeMedia(dir, { seconds = 12, dashSeconds = seconds } = {}) {
  await mkdir(join(dir, "hls"), { recursive: true });
  const lavfi = (length) => [
    ["-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:duration=${length}`],
    ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${length}`],
  ];
  const [video, audio] = lavfi(seconds);
  const [dashVideo, dashAudio] = lavfi(dashSeconds);
  await Promise.all([
    ffmpeg([...video, ...audio, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "500k", "-c:a", "libopus", join(dir, "clip.webm")]),
    ffmpeg([...video, ...audio, "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-c:a", "aac", "-f", "hls", "-hls_time", "2",
      "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
      "-hls_segment_filename", join(dir, "hls", "seg%d.m4s"), join(dir, "hls", "index.m3u8")]),
    ffmpeg([...dashVideo, "-an", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-movflags", "+dash+global_sidx", join(dir, "video.mp4")]),
    // Audio in 2-second fragments, as real DASH audio is: one fragment for
    // a long item is more than the canvas engine buffers ahead.
    ffmpeg([...dashAudio, "-vn", "-c:a", "aac", "-frag_duration", "2000000", "-movflags", "+dash+global_sidx", join(dir, "audio.mp4")]),
  ]);
}

// Serves the files in `dir` (and dir/hls) with byte ranges.
export async function mediaOrigin(t, dir) {
  const requests = [];
  const origin = { url: null, requests };
  origin.url = await listen(t, async (req, res) => {
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
  return origin;
}

// A yt-dlp stand-in: `--version`, and the fixture JSON for any other call.
export async function fakeYtdlp(dir, info) {
  const tool = join(dir, "yt-dlp");
  await writeFile(tool, `#!${process.execPath}
process.stdout.write(process.argv.includes("--version") ? "2026.09.01\\n" : ${JSON.stringify(JSON.stringify(info))});
`);
  await chmod(tool, 0o755);
  return tool;
}

// Plex Media Server, as much as Yolo's Plex plugin uses. The "transcode"
// serves the HLS fixture for any session it started; `duration` (ms) is the
// movie's, which should match the fixture's length. `original` names an
// H.264/AAC MP4 file in `dir` that the movie's part is, for direct play.
// `subtitle` is the SRT text of its English subtitle. `commentary` adds a
// second English audio track (id 12), so an audio switch always has a track
// to go to. `embedded(at)` adds a text subtitle inside the movie's file
// (id 22): an ASS track with its text for every 4 seconds, in an MKV that
// ffmpeg makes, which Plex's part names by its path.
export async function plexFixture(t, dir, { viewOffset = 0, duration = 12000, original = null, subtitle = "1\n00:00:00,000 --> 00:00:12,000\nFixture subtitle\n", commentary = false, embedded = null } = {}) {
  const calls = [];
  const sessions = new Set();
  const movie = {
    ratingKey: "7",
    type: "movie",
    title: "Fixture Movie",
    duration,
    viewOffset,
    thumb: "/library/metadata/7/thumb/1",
    Media: [{ Part: [{ id: 5, Stream: [
      { id: 11, streamType: 2, codec: "aac", channels: 2, languageCode: "eng", displayTitle: "English", selected: true },
      { id: 21, streamType: 3, codec: "srt", key: "/library/streams/21", languageCode: "eng", displayTitle: "English" },
    ] }] }],
  };
  if (commentary) {
    movie.Media[0].Part[0].Stream.splice(1, 0, { id: 12, streamType: 2, codec: "aac", channels: 2, languageCode: "eng", displayTitle: "English Commentary" });
  }
  if (embedded) {
    const seconds = Math.round(duration / 1000);
    const time = (at) => new Date(at * 1000).toISOString().slice(12, 22);
    const dialogue = Array.from({ length: Math.ceil(seconds / 4) }, (_, index) => `Dialogue: 0,${time(index * 4)},${time(index * 4 + 4)},Default,,0,0,0,,${embedded(index * 4)}`);
    await writeFile(join(dir, "embedded.ass"), `[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,16\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${dialogue.join("\n")}\n`);
    await ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=64x36:r=1:d=${seconds}`, "-i", join(dir, "embedded.ass"), "-map", "0", "-map", "1",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:s", "ass", join(dir, "embedded.mkv")]);
    movie.Media[0].Part[0].file = join(dir, "embedded.mkv");
    movie.Media[0].Part[0].Stream.push({ id: 22, streamType: 3, codec: "ass", index: 1, languageCode: "zho", displayTitle: "中英双语" });
  }
  if (original) {
    const part = movie.Media[0].Part[0];
    Object.assign(movie.Media[0], { container: "mp4", bitrate: 900, width: 320, height: 180 });
    Object.assign(part, { key: `/library/parts/5/1/${original}`, container: "mp4" });
    part.Stream.unshift({ id: 10, streamType: 1, codec: "h264", bitDepth: 8, width: 320, height: 180 });
  }
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
    if (pathname === "/hubs/search") {
      const found = movie.title.toLowerCase().includes(String(searchParams.get("query")).toLowerCase());
      return json({ MediaContainer: { Hub: [{ type: "movie", Metadata: found ? [movie] : [] }] } });
    }
    if (pathname === "/library/parts/5") return res.end();
    if (original && pathname === `/library/parts/5/1/${original}`) return sendFile(req, res, await readFile(join(dir, original)), "video/mp4");
    if (pathname === "/library/streams/21") return res.end(subtitle);
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
  // `movie` is what the fixture serves, for a test to change as a rescan would.
  return { url, calls, sessions, movie };
}

// One stack with the yt-dlp plugin (whose fake answers any page with
// separate audio and video files: dash_split) and the Plex plugin over a
// Plex fixture with `plex` options, on media `seconds` long (the split
// files `dashSeconds`).
export async function startMediaStack(t, { seconds, dashSeconds = seconds, plex: plexOptions = {}, seed = "" }) {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const dir = await mkdtemp(join(tmpdir(), "yolo-e2e-media-"));
  await makeMedia(dir, { seconds, dashSeconds });
  const media = await mediaOrigin(t, dir);
  const ytdlp = await fakeYtdlp(dir, {
    title: "DASH fixture",
    duration: dashSeconds,
    requested_formats: [
      { format_id: "v", url: `${media.url}/video.mp4`, vcodec: "avc1.42c00d", acodec: "none", width: 320, height: 180, fps: 30, tbr: 400 },
      { format_id: "a", url: `${media.url}/audio.mp4`, vcodec: "none", acodec: "mp4a.40.2", abr: 128 },
    ],
  });
  const plex = await plexFixture(t, dir, { viewOffset: 3_000, duration: seconds * 1000, ...plexOptions });
  const yolo = await startYolo(t, {
    seed,
    pluginConfig: {
      plugins: [
        { source: join(root, "plugins/source-ytdlp"), options: { binary: ytdlp } },
        { source: join(root, "plugins/source-plex"), options: { url: plex.url, token: "fixture-token" } },
      ],
    },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { media, plex, yolo };
}
