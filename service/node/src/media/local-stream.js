import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { YoloError } from "@useyolo/core";
import { silentLogger } from "../log.js";

// A file on the node's disk as HLS (Agent Note 2026-10-26-folder-source),
// for a screen that cannot play the file as it is. The playlist names every
// segment of the whole file at once, as a VOD playlist, so a screen seeks
// anywhere in it; ffmpeg makes the segments on demand, from the one a screen
// asks for on, and starts again where a seek lands outside what it has made.
//
// The video is copied where the screen decodes its codec, and its segments
// are cut at the file's own keyframes (local-file.js), at least
// SEGMENT_SECONDS apart; otherwise it is transcoded to H.264 with a keyframe
// every SEGMENT_SECONDS. Either way a segment's bounds are fixed by the plan,
// so a job started at segment n writes the same segments as one that started
// earlier: ffmpeg seeks to segment n's first keyframe, keeps the file's
// timestamps (-copyts), and cuts at the plan's times, which its segment
// muxer counts from the job's first packet. Every timestamp is moved by
// TIMESTAMP_OFFSET, so no job writes a negative one, which MPEG-TS cannot
// carry and ffmpeg would otherwise shift by a different amount per job; a
// player reads it as noise below its half-second threshold.
//
// ffmpeg runs ahead of the screen by at most AHEAD_SEGMENTS, paused with
// SIGSTOP beyond that, and segments the screen has left behind are removed.

export const SEGMENT_SECONDS = 6;
const TIMESTAMP_OFFSET = 0.2;
// ffmpeg's input seek aims this far before the time it is given when the
// video has B-frames; a job aims past its first keyframe by more than that.
const SEEK_PAST = 0.2;
// How near a keyframe may be to a cut and still not take it: the segment
// muxer's tolerance, and the margins a cut keyframe needs on each side.
const CUT_TOLERANCE = 0.25;
const AHEAD_SEGMENTS = 40;
const KEEP_BEHIND = 8;
// A segment a job will reach soon is waited for; one further away, or behind
// the job's start, starts a new job.
const REACH_SEGMENTS = 6;
const SEGMENT_WAIT_MS = 10_000;
const POLL_MS = 100;

/**
 * Segment bounds for a file: `[start, end)` of each, in seconds of ffmpeg's
 * timeline. With keyframes, cuts fall on keyframes at least `seconds` apart
 * that no other keyframe crowds; without, every `seconds` from 0.
 */
export function planSegments({ duration, keyframes = null, seconds = SEGMENT_SECONDS }) {
  const end = Number(duration);
  if (!(end > 0)) throw new YoloError("resolve_failed", "This file has no duration to make a playlist from");
  const cuts = [];
  if (keyframes?.length) {
    cuts.push(Math.max(0, keyframes[0]));
    for (let at = 1; at < keyframes.length; at += 1) {
      const time = keyframes[at];
      if (time >= end - 0.5) break;
      const roomy = time - keyframes[at - 1] > CUT_TOLERANCE + 0.1 && (at + 1 >= keyframes.length || keyframes[at + 1] - time > SEEK_PAST + 0.1);
      if (time - cuts.at(-1) >= seconds && roomy) cuts.push(time);
    }
  } else {
    for (let time = 0; time < end - 0.5; time += seconds) cuts.push(time);
  }
  return cuts.map((start, index) => ({ start, end: cuts[index + 1] ?? end }));
}

/** The VOD playlist of a plan; segment n is at `uri(n)`. */
export function localPlaylist(segments, uri) {
  const target = Math.max(1, ...segments.map((segment) => Math.ceil(segment.end - segment.start)));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-MEDIA-SEQUENCE:0"];
  segments.forEach((segment, index) => lines.push(`#EXTINF:${(segment.end - segment.start).toFixed(6)},`, uri(index)));
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

/**
 * ffmpeg's arguments for a job from segment `from`. `plan.video` and
 * `plan.audio` are "copy" or "transcode"; `plan.audioIndex` is the file's
 * stream index of the chosen audio, or null for none.
 */
export function jobArgs({ path, segments, from, plan, dir }) {
  const first = segments[from];
  const later = segments.slice(from + 1).map((segment) => segment.start);
  const copy = plan.video === "copy";
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  // A copy starts at the keyframe the seek lands on, at or before the time
  // given; a transcode decodes from there and starts at the time exactly.
  if (copy ? from > 0 : first.start > 0) args.push("-ss", (copy ? first.start + SEEK_PAST : first.start).toFixed(3));
  args.push("-i", path, "-copyts", "-map", `0:${plan.videoIndex}`);
  if (plan.audioIndex != null) args.push("-map", `0:${plan.audioIndex}`);
  if (copy) {
    args.push("-c:v", "copy");
  } else {
    const height = Math.max(144, Math.floor(Number(plan.maxHeight) || 1080));
    const kbps = Math.max(300, Math.floor(Number(plan.maxVideoKbps) || 4800));
    args.push(
      "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-vf", `scale=-2:'min(${height},ih)'`,
      "-crf", "21", "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`,
      ...(later.length ? ["-force_key_frames", later.map((time) => time.toFixed(3)).join(",")] : []),
    );
  }
  if (plan.audioIndex != null) args.push(...(plan.audio === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-ac", "2", "-b:a", "160k"]));
  args.push(
    "-sn", "-dn", "-max_muxing_queue_size", "4096",
    "-output_ts_offset", String(TIMESTAMP_OFFSET), "-muxdelay", "0", "-muxpreload", "0",
    "-f", "segment", "-segment_format", "mpegts",
    ...(later.length ? ["-segment_times", later.map((time) => (time - first.start).toFixed(3)).join(",")] : []),
    "-segment_time_delta", String(CUT_TOLERANCE),
    "-segment_start_number", String(from),
    "-segment_list", resolve(dir, "list.csv"), "-segment_list_type", "csv",
    resolve(dir, "%d.ts"),
  );
  return args;
}

/**
 * One file's HLS for one session. `plan` is { video, audio, videoIndex,
 * audioIndex, maxHeight, maxVideoKbps }; `segments` come from planSegments().
 */
export function createLocalStream({ path, segments, plan, dir, ffmpeg = "ffmpeg", logger = silentLogger, spawnImpl = spawn }) {
  mkdirSync(dir, { recursive: true });
  const done = new Map(); // segment → file, finished
  let job = null;
  let jobs = 0;
  let lastAsked = 0;
  let stopped = false;

  function startJob(from) {
    stopJob();
    const jobDir = resolve(dir, `job${jobs++}`);
    mkdirSync(jobDir, { recursive: true });
    const args = jobArgs({ path, segments, from, plan, dir: jobDir });
    const proc = spawnImpl(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    const current = { proc, dir: jobDir, from, reached: from - 1, exited: false, paused: false, errors: [] };
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (text) => {
      for (const line of text.split(/\r?\n/)) if (line.trim()) current.errors.push(line.trim());
      current.errors.splice(0, Math.max(0, current.errors.length - 5));
    });
    proc.once("error", (error) => {
      current.exited = true;
      current.errors.push(error.message);
    });
    proc.once("close", (code) => {
      current.exited = true;
      collect(current);
      if (code && !stopped && current === job) logger.warn({ path: "local", from, code, errors: current.errors }, "ffmpeg stopped making a local stream");
    });
    job = current;
    logger.info({ from, video: plan.video, audio: plan.audio }, "Making a local stream");
    return current;
  }

  function stopJob() {
    if (!job) return;
    const old = job;
    job = null;
    if (!old.exited) {
      try {
        if (old.paused) old.proc.kill("SIGCONT");
        old.proc.kill("SIGKILL");
      } catch {}
    }
  }

  // Segments the job has finished: those its list names. The segment muxer
  // adds a segment once it is closed, and the last one when ffmpeg ends
  // normally, so a killed job's unfinished segment is never served.
  function collect(current) {
    let names = [];
    try {
      names = readFileSync(resolve(current.dir, "list.csv"), "utf8").split("\n").map((line) => line.split(",")[0]).filter(Boolean);
    } catch {}
    for (const name of names) {
      const index = Number.parseInt(name, 10);
      if (!Number.isInteger(index)) continue;
      if (!done.has(index)) done.set(index, resolve(current.dir, name));
      if (index > current.reached) current.reached = index;
    }
  }

  // Run ahead of the screen by at most AHEAD_SEGMENTS; forget what it left.
  function pace() {
    if (job && !job.exited && process.platform !== "win32") {
      const ahead = job.reached - lastAsked;
      if (!job.paused && ahead > AHEAD_SEGMENTS) {
        job.paused = job.proc.kill("SIGSTOP");
      } else if (job.paused && ahead < AHEAD_SEGMENTS / 2) {
        job.proc.kill("SIGCONT");
        job.paused = false;
      }
    }
    for (const [index, file] of done) {
      if (index < lastAsked - KEEP_BEHIND || index > lastAsked + AHEAD_SEGMENTS * 2) {
        done.delete(index);
        rmSync(file, { force: true });
      }
    }
  }

  async function segment(index) {
    if (stopped) throw new YoloError("not_found", "This stream has stopped");
    if (!Number.isInteger(index) || index < 0 || index >= segments.length) throw new YoloError("not_found", "No such segment");
    lastAsked = index;
    const deadline = Date.now() + SEGMENT_WAIT_MS;
    for (;;) {
      if (job) collect(job);
      const file = done.get(index);
      if (file && existsSync(file)) {
        pace();
        return file;
      }
      const reaching = job && !job.exited && job.from <= index && index <= job.reached + REACH_SEGMENTS;
      if (!reaching) {
        // A job that ended where this segment should have been failed on it.
        if (job?.exited && job.from <= index && job.reached === index - 1) {
          throw new YoloError("resolve_failed", `ffmpeg could not make this stream${job.errors.length ? `: ${job.errors.at(-1)}` : ""}`);
        }
        startJob(index);
      } else if (job.paused) {
        job.proc.kill("SIGCONT");
        job.paused = false;
      }
      if (Date.now() > deadline) throw new YoloError("resolve_failed", "The segment was not ready in time", { retryable: true });
      await delay(POLL_MS);
    }
  }

  return {
    segments,
    plan,
    playlist: (uri) => localPlaylist(segments, uri),
    async respond(index, method = "GET") {
      const file = await segment(index);
      const size = statSync(file).size;
      const headers = { "content-type": "video/mp2t", "content-length": String(size), "cache-control": "private, max-age=3600", "access-control-allow-origin": "*" };
      if (method === "HEAD") return new Response(null, { headers });
      return new Response(Readable.toWeb(createReadStream(file)), { headers });
    },
    status: () => ({ jobs, running: Boolean(job && !job.exited), from: job?.from ?? null, reached: job?.reached ?? null, paused: Boolean(job?.paused) }),
    async stop() {
      stopped = true;
      stopJob();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
