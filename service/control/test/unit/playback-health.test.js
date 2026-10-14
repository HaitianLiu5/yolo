import assert from "node:assert/strict";
import { test } from "node:test";
import { assemblePlaybackHealth, sanitizeHealthReport } from "../../src/hub/playback-health.js";

const NOW = 1_800_000_000_000;
const ago = (seconds) => NOW - seconds * 1000;

test("playback health joins the stream, the device's report, its path, and the cap, and says why it stutters", () => {
  const report = sanitizeHealthReport({
    engine: "canvas",
    bufferSeconds: 1.24,
    throughputKbps: 1800.6,
    buffering: true,
    stalls: 4,
    stallSeconds: 31.27,
    recentStalls: [{ ago: 2, seconds: 0.3 }, { ago: 20, seconds: 9.5 }, { ago: 200, seconds: 6 }, { ago: 900, seconds: 4 }, { ago: "x" }],
    width: 1280,
    height: 720,
    videoCodec: "avc1.64001f",
    droppedFrames: 12,
    token: "secret",
  });
  assert.equal("token" in report, false);
  const health = assemblePlaybackHealth({
    now: NOW,
    device: { id: "dev_car", name: "Model Y", kind: "car", online: true, active: true },
    state: {
      status: "buffering", deviceId: "dev_car", sessionId: "ses_1", position: 754.2,
      item: { source: { plugin: "library", id: "7" }, title: "A Movie" },
    },
    stream: {
      sessionId: "ses_1", at: ago(600), reason: "quality", network: "relay", delivery: "hls",
      profile: { width: 1280, height: 720, fps: 30, videoKbps: 4000, audioKbps: 128, videoCodec: "avc1" },
      limits: { maxVideoKbps: 4000, ceilingKbps: 4800, capped: true },
    },
    report: { ...report, sessionId: "ses_1", at: ago(4) },
    network: { path: "relay", probes: { lan: "timeout", wan: "refused" }, at: ago(900) },
    media: { relayMode: "auto" },
    events: [{ at: ago(600), reason: "quality", maxVideoKbps: 4000, network: "relay" }, { at: ago(5000), reason: "recovery" }],
  });
  assert.deepEqual(health.device, { id: "dev_car", name: "Model Y", online: true, active: true });
  assert.equal(health.engine, "canvas");
  assert.deepEqual(health.item, { id: "library:7", title: "A Movie", status: "buffering", position: 754 });
  assert.deepEqual(health.stream, {
    delivery: "hls", resolution: "1280x720", fps: 30, videoKbps: 4000, audioKbps: 128, videoCodec: "avc1",
    decoded: "1280x720", decodedCodec: "avc1.64001f", droppedFrames: 12, since: 600,
  });
  assert.deepEqual(health.quality, { capKbps: 4000, ceilingKbps: 4800, capped: true });
  assert.deepEqual(health.path, { now: "relay", probes: { lan: "timeout", wan: "refused" }, relayMode: "auto" });
  assert.deepEqual(health.buffer, { aheadSeconds: 1.2, throughputKbps: 1801, buffering: true, reported: 4 });
  // The report is 4 seconds old: its stalls are 4 seconds older now. A wait
  // under half a second (a start or a seek) is not a stall here.
  assert.deepEqual(health.stalls, { count: 4, seconds: 31.3, recent: [{ ago: 24, seconds: 9.5 }, { ago: 204, seconds: 6 }, { ago: 904, seconds: 4 }] });
  // Only the last 30 minutes of stream rebuilds.
  assert.deepEqual(health.rebuilds, [{ ago: 600, reason: "quality", capKbps: 4000, path: "relay" }]);
  assert.deepEqual(health.hints, [
    "Buffering now, with 1.2 s of buffer.",
    "Measured throughput 1801 kbps is below the 4747 kbps this stream needs.",
    "2 stalls of a second or more in the last 5 minutes.",
    "Adaptive quality capped the video at 4000 kbps (the node allows 4800).",
    "Media goes through the Cloudflare relay; the LAN probe: timeout, the remote probe: refused.",
  ]);

  // A device that sent no report (an older player) still gets the stream and path.
  const quiet = assemblePlaybackHealth({
    now: NOW,
    device: { id: "dev_web", name: "Laptop", online: true, active: true },
    state: { status: "playing", deviceId: "dev_web", sessionId: "ses_2", position: 10, item: { source: { plugin: "web", id: "x" }, title: "Clip" } },
    stream: { sessionId: "ses_2", at: ago(30), network: "lan", delivery: "mp4", profile: { width: 640, height: 360 }, limits: { maxVideoKbps: 200000, ceilingKbps: 200000, capped: false } },
    report: null,
    network: { path: "lan", probes: {} },
    media: { relayMode: "off" },
    events: [],
  });
  assert.equal("buffer" in quiet, false);
  assert.deepEqual(quiet.path, { now: "lan", relayMode: "off" });
  assert.deepEqual(quiet.hints, ["The device sent no buffer report: it may run an older player."]);
});
