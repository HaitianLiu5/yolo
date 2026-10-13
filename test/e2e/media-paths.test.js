import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { makeMedia, plexFixture } from "./fixtures.js";
import { eventually, launchBrowser, openPage, pair, waitFor } from "./browser.js";
import { freePort, startYolo } from "./yolo-stack.js";

// The media paths (Agent Note 2026-10-13-media-off-the-worker) in Chromium:
// the node's LAN listener and its remote listener (manual mode: no router
// is asked for anything) on 127.0.0.1 under names the browser maps there,
// with certificates for the node's own requests (signed here by openssl, as
// the ACME server signs them), and the Worker's relay. The welcome lists
// both listeners; a computer's browser plays a Plex original from the LAN
// origin without ever seeing the Plex token, and when one path after
// another goes away its recoveries play on by the remote path, then the
// relay, at the same position.

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const LAN_NAME = "yolo-lan-e2e.example.com";
const WAN_NAME = "yolo-wan-e2e.example.com";
const PLEX_TOKEN = "plex-e2e-token-0123456789";
// Long enough that each seek can land past what the <video> element read
// ahead from the origin it leaves (a few megabytes, about 30 seconds here).
const SECONDS = 180;

// A seek inside what the element already holds would play on without asking
// for a byte, so it goes 20 seconds past it: it needs bytes the old origin
// can no longer give.
async function seekPastBuffer(page) {
  const buffered = await page.evaluate(() => {
    const { video } = globalThis.__yoloPlayer.player;
    return Array.from({ length: video.buffered.length }, (_, index) => [video.buffered.start(index), video.buffered.end(index)]);
  });
  const target = Math.ceil(Math.max(0, ...buffered.map(([, end]) => end))) + 20;
  assert.ok(target <= SECONDS - 15, `room to seek past what the element holds: ${JSON.stringify(buffered)} of ${SECONDS} s`);
  return target;
}

test("a browser plays from the LAN, then by remote direct play, then through the relay, each at the same position", { timeout: 300_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "yolo-e2e-paths-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await makeMedia(dir, { seconds: SECONDS });
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:duration=${SECONDS}`, "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-c:a", "aac", "-movflags", "+faststart", join(dir, "movie.mp4")]);
  const plex = await plexFixture(t, dir, { duration: SECONDS * 1000, original: "movie.mp4" });
  const [lanPort, wanPort] = [await freePort(), await freePort()];
  const lanOrigin = `https://${LAN_NAME}:${lanPort}`;
  const wanOrigin = `https://${WAN_NAME}:${wanPort}`;
  const notAfter = Date.now() + 86_400_000;
  const yolo = await startYolo(t, {
    pluginConfig: { plugins: [{ source: join(root, "plugins/source-plex"), options: { url: plex.url, token: PLEX_TOKEN } }] },
    nodeEnv: {
      LAN_ADDRESS: "127.0.0.1", LAN_PORT: String(lanPort),
      WAN_ADDRESS: "127.0.0.1", WAN_PORT: String(wanPort), WAN_MAPPING: "manual", WAN_EXTERNAL_PORT: String(wanPort),
    },
    // What the control plane's checks leave when both listeners serve and
    // the Worker reached the remote one from outside; remote access is on.
    kv: {
      "yolo:lan": JSON.stringify({ ready: true, origin: lanOrigin, notAfter }),
      "yolo:wan": JSON.stringify({ status: "ok", origin: wanOrigin, notAfter }),
    },
    seed: "UPDATE media_settings SET remote = 1;",
  });

  // What the control plane does with each request: a certificate for its name.
  async function certify(path, name, keyFile) {
    const configured = (await yolo.node(`/internal/v1/${path}`, { name, allowOrigin: yolo.origin }, "PUT")).body;
    await writeFile(join(dir, `${path}.csr`), configured.csr);
    await writeFile(join(dir, `${path}.cnf`), `subjectAltName=DNS:${name}\n`);
    await exec("openssl", ["x509", "-req", "-in", join(dir, `${path}.csr`), "-signkey", join(yolo.dir, "node", keyFile), "-days", "2", "-extfile", join(dir, `${path}.cnf`), "-out", join(dir, `${path}.pem`)]);
    return (await yolo.node(`/internal/v1/${path}/certificate`, { name, chain: await readFile(join(dir, `${path}.pem`), "utf8") }, "PUT")).body;
  }
  assert.equal((await certify("lan", LAN_NAME, ".lan/key.pem")).origin, lanOrigin);
  assert.equal((await certify("wan", WAN_NAME, ".lan/wan/key.pem")).origin, wanOrigin);

  const context = await launchBrowser(t, { args: [`--host-resolver-rules=MAP ${LAN_NAME} 127.0.0.1, MAP ${WAN_NAME} 127.0.0.1`], context: { ignoreHTTPSErrors: true } });
  const { page, errors } = await openPage(context, yolo.origin);
  const pageLog = [];
  page.on("console", (message) => pageLog.push(message.text()));
  await pair(yolo, page);
  await waitFor(page, () => globalThis.__yolo.profile.engine === "native", null, "the <video> engine");
  // The welcome lists both listeners; the remote one answers its probe.
  await waitFor(page, () => globalThis.__yolo.paths.status().probes.wan?.outcome === "ok", null, "the remote path's probe");
  const probe = await page.evaluate(() => globalThis.__yolo.paths.setEnabled(true));
  assert.equal(probe.outcome, "ok");
  assert.equal(await page.evaluate(() => globalThis.__yolo.paths.network()), "lan");

  const agent = await yolo.agentToken();
  await yolo.mcp(agent, "play", { item_id: "plex:7" });
  await waitFor(page, () => globalThis.__yoloPlayer?.player?.getStatus() === "playing" && globalThis.__yoloPlayer.player.getCurrentTime() > 2, null, "the original plays", 40_000);
  const playing = await page.evaluate(() => ({ src: globalThis.__yoloPlayer.player.video.currentSrc, mode: globalThis.__yoloPlayer.player.mode }));
  assert.ok(playing.src.startsWith(`${lanOrigin}/m/`), playing.src);
  assert.equal(playing.mode, "progressive");
  assert.ok(!plex.calls.some((call) => call.path.endsWith("/start.m3u8")), "Plex transcodes nothing");
  const seen = await page.evaluate(() => JSON.stringify([globalThis.__yolo.state, performance.getEntriesByType("resource").map((entry) => entry.name)]));
  assert.ok(!seen.includes(PLEX_TOKEN) && !pageLog.join("\n").includes(PLEX_TOKEN), "the page never sees the Plex token");

  // The LAN goes away (the node takes another name, and its listener closes
  // every connection); a seek needs bytes it cannot get.
  await yolo.node("/internal/v1/lan", { name: "yolo-lan-gone.example.com", allowOrigin: yolo.origin }, "PUT");
  const first = await seekPastBuffer(page);
  await yolo.mcp(agent, "seek", { position_seconds: first });
  await waitFor(page, () => globalThis.__yolo.state.streamNetwork === "wan" && globalThis.__yoloPlayer?.player?.getStatus() === "playing", null, "the remote path plays on", 60_000);
  const remote = await page.evaluate(() => ({ time: globalThis.__yoloPlayer.player.getCurrentTime(), src: globalThis.__yoloPlayer.player.url }));
  assert.ok(remote.src.startsWith(`${wanOrigin}/m/`), remote.src);
  assert.ok(remote.time >= first - 2, `the position is kept: ${remote.time} for ${first}`);

  // The owner turns remote access off: the listener closes; the relay plays on.
  await yolo.node("/internal/v1/wan", { name: WAN_NAME, allowOrigin: yolo.origin, enabled: false }, "PUT");
  const second = await seekPastBuffer(page);
  await yolo.mcp(agent, "seek", { position_seconds: second });
  await waitFor(page, () => globalThis.__yolo.state.streamNetwork === "relay" && globalThis.__yoloPlayer?.player?.getStatus() === "playing", null, "the relay plays on", 90_000);
  const relayed = await page.evaluate(() => ({ time: globalThis.__yoloPlayer.player.getCurrentTime(), src: globalThis.__yoloPlayer.player.url }));
  assert.ok(relayed.src.startsWith(`${yolo.origin}/m/`), relayed.src);
  assert.ok(relayed.time >= second - 2, `the position is kept: ${relayed.time} for ${second}`);
  assert.deepEqual(errors, []);

  // Workers Logs say which path each stream took and why each one ended.
  const logged = (pattern) => yolo.workerLog().split(/\n(?=\{)/).some((line) => pattern.every((part) => line.includes(part)));
  assert.ok(logged(["event: 'stream'", "reason: 'recovery'", "network: 'wan'"]));
  assert.ok(logged(["event: 'stream'", "reason: 'recovery'", "network: 'relay'"]));
  await eventually(() => logged(["type: 'media_path_fallback'", "from: 'lan'", "to: 'wan'"]) && logged(["type: 'media_path_fallback'", "from: 'wan'", "to: 'relay'"]), "both fallbacks in the device's telemetry", 20_000);
});
