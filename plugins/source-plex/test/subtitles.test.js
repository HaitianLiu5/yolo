import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describePlexSubtitle,
  embeddedSubtitleFfmpegArgs,
  PlexSubtitleCache,
  plexSubtitleStreamsForPart,
  plexSubtitleVersionInfo,
  resolvePlexSubtitleDelivery,
  SubtitleExtractionQueue,
} from "../src/subtitles.js";

const bilingualAss = `\uFEFF[Script Info]
Title: Green Book

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.20,0:00:04.50,Default,,0,0,0,,{\\fs22\\fn宋体}纽约人民，大家好！\\N{\\r}Hello New York, everyone!
`;

test("remote embedded subtitle paths are mutable and fall back to burn-in", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "drive-in-remote-subtitle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [stream] = plexSubtitleStreamsForPart({
    file: join(dir, "not-mounted", "movie.mkv"),
    Stream: [{ id: 10, index: 2, codec: "ass", streamType: 3 }],
  });
  const first = await plexSubtitleVersionInfo(stream, { now: 0 });
  const later = await plexSubtitleVersionInfo(stream, { now: 3_600_000 });
  assert.equal(first.sourceAvailable, false);
  assert.notEqual(first.token, later.token, "the version expires hourly");
  const descriptor = describePlexSubtitle("remote", stream, {
    versionToken: first.token, externalAvailable: first.sourceAvailable,
  });
  assert.equal(descriptor.delivery, "burn");
});

test("converted subtitles survive process cache recreation and invalidate with the source file", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "drivein-subtitle-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = join(root, "movie.ass");
  const cacheDir = join(root, "cache");
  writeFileSync(sourcePath, bilingualAss);
  const stream = { id: 75307, streamType: 3, codec: "ass", file: sourcePath };
  let loadCount = 0;
  const load = () => {
    loadCount += 1;
    return readFileSync(sourcePath);
  };

  const firstCache = new PlexSubtitleCache(cacheDir);
  const first = await firstCache.get("9147", stream, load);
  const memoryHit = await firstCache.get("9147", stream, load);
  const restartedCache = new PlexSubtitleCache(cacheDir);
  const diskHit = await restartedCache.get("9147", stream, load);

  assert.equal(first.source, "converted");
  assert.equal(memoryHit.source, "memory");
  assert.equal(diskHit.source, "disk");
  assert.equal(loadCount, 1);
  assert.equal(diskHit.vtt, first.vtt);

  writeFileSync(sourcePath, `${bilingualAss}\n; source changed`);
  const invalidated = await restartedCache.get("9147", stream, load);
  assert.equal(invalidated.source, "converted");
  assert.equal(loadCount, 2);
});

test("cold concurrent requests share one conversion", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "drivein-subtitle-coalesce-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = join(root, "movie.ass");
  writeFileSync(sourcePath, bilingualAss);
  const stream = { id: 75307, codec: "ass", file: sourcePath };
  let loadCount = 0;
  const cache = new PlexSubtitleCache(join(root, "cache"));
  const load = async () => {
    loadCount += 1;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    return readFileSync(sourcePath);
  };
  const [first, second] = await Promise.all([
    cache.get("9147", stream, load),
    cache.get("9147", stream, load),
  ]);
  assert.equal(loadCount, 1);
  assert.deepEqual(new Set([first.source, second.source]), new Set(["converted", "coalesced"]));
});

test("embedded subtitle versions follow the parent media file instead of expiring hourly", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "drivein-embedded-subtitle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceFile = join(root, "movie.mkv");
  writeFileSync(sourceFile, "first media version");
  const [stream] = plexSubtitleStreamsForPart({
    file: sourceFile,
    Stream: [{ id: 39934, index: 2, streamType: 3, codec: "ass" }],
  });

  const first = await plexSubtitleVersionInfo(stream, { now: 0 });
  const later = await plexSubtitleVersionInfo(stream, { now: 7200_000 });
  writeFileSync(sourceFile, "second media version with a different size");
  const changed = await plexSubtitleVersionInfo(stream, { now: 7200_000 });

  assert.equal(later.token, first.token);
  assert.notEqual(changed.token, first.token);
  assert.deepEqual(embeddedSubtitleFfmpegArgs(stream).slice(-7), [
    "-map", "0:2", "-c:s", "ass", "-f", "ass", "pipe:1",
  ]);
});

test("background subtitle queue deduplicates work and stays single-flight", async () => {
  const queue = new SubtitleExtractionQueue({ maxConcurrent: 1 });
  let active = 0;
  let maxActive = 0;
  let firstRuns = 0;
  const task = (value) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (value === "first") firstRuns += 1;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    active -= 1;
    return value;
  };

  const first = queue.enqueue("same", task("first"));
  const duplicate = queue.enqueue("same", task("duplicate"));
  const second = queue.enqueue("second", task("second"));
  assert.equal(duplicate, first);
  assert.deepEqual(await Promise.all([first, duplicate, second]), ["first", "first", "second"]);
  assert.equal(firstRuns, 1);
  assert.equal(maxActive, 1);
});

test("failed external conversion falls back to Plex burn-in", async () => {
  const descriptor = {
    id: 75307,
    codec: "ass",
    delivery: "external",
  };
  const resolved = await resolvePlexSubtitleDelivery(descriptor, async () => {
    throw new Error("subtitle source unavailable");
  });
  assert.equal(resolved.fallback, true);
  assert.equal(resolved.burnSubtitleStreamID, 75307);
  assert.equal(resolved.subtitle.delivery, "burn");
  assert.match(resolved.subtitle.fallbackReason, /unavailable/);
});

test("disk cache evicts by total bytes instead of entry count alone", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "drivein-subtitle-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cacheDir = join(root, "cache");
  const convert = async () => ({
    vtt: `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${"x".repeat(160)}\n`,
    inferredLanguage: null,
  });
  const cache = new PlexSubtitleCache(cacheDir, { maxDiskBytes: 300, convert });

  for (const id of [1, 2]) {
    const file = join(root, `${id}.ass`);
    writeFileSync(file, bilingualAss);
    await cache.get("9147", { id, codec: "ass", file }, () => readFileSync(file));
  }

  assert.equal(readdirSync(cacheDir).filter((name) => name.endsWith(".vtt")).length, 1);
});
