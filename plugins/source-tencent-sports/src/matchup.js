import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A game's picture: its two logos side by side, made with ffmpeg and kept in
// `cacheDir`. The site's own pictures are a channel's card or a frame of the
// game, which can show an advertisement or the score
// (Agent Note 2026-11-06-event-libraries).

const FETCH_TIMEOUT_MS = 8_000;
const FFMPEG_TIMEOUT_MS = 10_000;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const BACKGROUND = "0x16181d";

// Where the logos go: side by side in a wide picture, one above the other in a poster.
const LAYOUTS = {
  landscape: { size: "640x360", logo: 190, first: "x=165-overlay_w/2:y=(main_h-overlay_h)/2", second: "x=475-overlay_w/2:y=(main_h-overlay_h)/2" },
  poster: { size: "400x600", logo: 220, first: "x=(main_w-overlay_w)/2:y=165-overlay_h/2", second: "x=(main_w-overlay_w)/2:y=435-overlay_h/2" },
};

function runFfmpeg(ffmpeg, args) {
  return new Promise((done, fail) => {
    execFile(ffmpeg, args, { timeout: FFMPEG_TIMEOUT_MS, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? fail(error) : done(stdout)));
  });
}

export function matchupArgs(first, second, variant) {
  const layout = LAYOUTS[variant] ?? LAYOUTS.landscape;
  const scale = `scale=${layout.logo}:${layout.logo}:force_original_aspect_ratio=decrease`;
  return [
    "-v", "error", "-i", first, "-i", second,
    "-filter_complex", `color=c=${BACKGROUND}:s=${layout.size}:d=1[bg];[0:v]${scale}[a];[1:v]${scale}[b];[bg][a]overlay=${layout.first}:format=auto[c];[c][b]overlay=${layout.second}:format=auto`,
    "-frames:v", "1", "-q:v", "3", "-c:v", "mjpeg", "-f", "image2", "pipe:1",
  ];
}

export function createMatchups({ fetchImpl = globalThis.fetch, cacheDir = null, ffmpeg = "ffmpeg", run = runFfmpeg } = {}) {
  const making = new Map();

  async function logo(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`The logo answered ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_LOGO_BYTES) throw new Error("The logo has no usable size");
    return bytes;
  }

  async function make(first, second, variant) {
    const dir = mkdtempSync(join(tmpdir(), "yolo-matchup-"));
    try {
      const paths = [join(dir, "first"), join(dir, "second")];
      const logos = await Promise.all([logo(first), logo(second)]);
      logos.forEach((bytes, index) => writeFileSync(paths[index], bytes));
      const picture = await run(ffmpeg, matchupArgs(paths[0], paths[1], variant));
      if (!picture.length) throw new Error("ffmpeg gave no picture");
      return picture;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    /** A JPEG of the two logos at `first` and `second`. */
    picture(first, second, variant = "landscape") {
      const shape = LAYOUTS[variant] ? variant : "landscape";
      const key = createHash("sha256").update(`${first}\n${second}\n${shape}`).digest("hex").slice(0, 24);
      const kept = cacheDir ? join(cacheDir, "matchups", `${key}.jpg`) : null;
      if (kept && existsSync(kept)) return Promise.resolve(readFileSync(kept));
      if (making.has(key)) return making.get(key);
      const work = make(first, second, shape).then((picture) => {
        if (kept) {
          mkdirSync(join(cacheDir, "matchups"), { recursive: true });
          const partial = `${kept}.${process.pid}.tmp`;
          writeFileSync(partial, picture);
          renameSync(partial, kept);
        }
        return picture;
      }).finally(() => making.delete(key));
      making.set(key, work);
      return work;
    },
  };
}
