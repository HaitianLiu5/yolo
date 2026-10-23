import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CAR_BROWSER, eventually, launchBrowser, openPage, pair, waitFor } from "./browser.js";
import { startMediaStack } from "./fixtures.js";
import { fileContext } from "./yolo-stack.js";

// Adaptive quality's step up on the car, on a stack of its own: it waits out
// the real 90-second hold (Agent Note 2026-10-11-adaptive-quality), so it
// runs beside car-playback.test.js on a runner of its own rather than after it.

// The split files (dash_split): long enough that the canvas engine has not
// buffered their rest when adaptive quality may step up, 90 seconds in.
const DASH_SECONDS = 360;

const shared = fileContext();
let plex;
let yolo;

before(async () => {
  ({ plex, yolo } = await startMediaStack(shared, { seconds: 120, dashSeconds: DASH_SECONDS }));
}, { timeout: 120_000 });

after(() => shared.cleanup());

const waitForFrames = (page, label, minimumTime = 0.5) => waitFor(page, (min) => {
  const player = globalThis.__yoloPlayer?.player;
  return player?.getStats()?.videoFrameRenderCount > 0 && player.getCurrentTime() > min;
}, minimumTime, label);

// Adaptive quality never rebuilds a stream to go up (Agent Note
// 2026-10-21-smooth-playback-first): the step up becomes where the car's
// next stream on the path starts, which Yolo keeps for it.
test("a step up keeps the stream and its buffer; the car's next stream, an agent's, starts at the rate it kept for the relay", { timeout: 240_000 }, async (t) => {
  const { page, errors } = await openPage(await launchBrowser(t, { context: CAR_BROWSER }), yolo.origin);
  const credential = await pair(yolo, page, { kind: "car" });
  const agent = await yolo.agentToken({ name: "Quality agent" });
  const quality = async () => (await yolo.mcp(agent, "get_playback_health", { device: credential.deviceId })).quality;
  const plays = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/v1/playback/play")) plays.push(request.postDataJSON());
  });

  // Nothing kept yet: the relay starts at 1500 kbps.
  await yolo.mcp(agent, "play", { url: "https://videos.test/watch?v=dash", start_at: 0, device: credential.deviceId });
  await waitForFrames(page, "the split files");
  assert.deepEqual(await quality(), { capKbps: 1500, ceilingKbps: 4800, capped: true });
  const playing = await page.evaluate(() => globalThis.__yolo.state.sessionId);

  // 90 seconds of headroom keep 2200 for the next stream; this one plays on.
  await waitFor(page, () => (globalThis.__yoloPlayerLog || []).some((entry) => entry.type === "quality_rate_kept"), null, "a step up kept", 150_000);
  const kept = await page.evaluate(() => globalThis.__yoloPlayerLog.find((entry) => entry.type === "quality_rate_kept"));
  assert.deepEqual([kept.direction, kept.rebuild, kept.maxVideoKbps, kept.path], ["up", false, 2200, "relay"]);
  const after = await page.evaluate(() => ({
    sessionId: globalThis.__yolo.state.sessionId, status: globalThis.__yoloPlayer.player.getStatus(),
    ahead: globalThis.__yoloPlayer.player.getStats().hlsBufferedAheadSeconds,
  }));
  assert.ok(after.sessionId === playing && after.status === "playing" && after.ahead > 60, JSON.stringify(after));
  assert.deepEqual(plays, [], "no new stream asked for");
  // The next report's health.rate reaches the Hub, which keeps it.
  await eventually(() => yolo.workerLog().split(/\n(?=\{)/).some((chunk) => chunk.includes("event: 'rate_kept'")
    && chunk.includes(`deviceId: '${credential.deviceId}'`) && chunk.includes("kbps: 2200")), "the kept rate at the Hub", 30_000);

  // An agent's play is the next stream: at 2200 kbps on the relay, which
  // Plex serves at its checked 1500 kbps rung, 480p.
  const starts = () => plex.calls.filter((call) => call.path.endsWith("/start.m3u8"));
  const before = starts().length;
  await yolo.mcp(agent, "play", { item_id: "plex:7", device: credential.deviceId });
  await waitFor(page, (old) => globalThis.__yolo.state.sessionId !== old && globalThis.__yoloPlayer?.player?.getStatus() === "playing", playing, "the next stream");
  assert.deepEqual(await quality(), { capKbps: 2200, ceilingKbps: 4800, capped: true });
  assert.deepEqual(starts().slice(before).map((call) => [call.params.videoBitrate, call.params.videoResolution]), [["1500", "854x480"]]);
  assert.deepEqual(errors, []);
});
