import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { makeMedia, plexFixture } from "./fixtures.js";
import { eventually, launchBrowser, openPage, pair, waitFor } from "./tesla-helpers.js";
import { startYolo } from "./yolo-stack.js";

// LAN direct play (Agent Note 2026-10-12-lan-direct-play) in Chromium: the
// node's LAN listener on 127.0.0.1 under a name the browser maps there, with
// a certificate for the node's own request (signed here by openssl, as the
// ACME server signs it). A computer's browser plays a Plex original through
// <video> from the LAN origin without ever seeing the Plex token; when the
// LAN goes away, the recovery plays on through the tunnel at the same
// position.

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const NAME = "yolo-lan-e2e.example.com";
const PLEX_TOKEN = "plex-e2e-token-0123456789";

const freePort = () => new Promise((done) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

test("a browser at home plays the original from the node's LAN origin, and falls back to the tunnel at the same position", { timeout: 180_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "yolo-e2e-lan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await makeMedia(dir, { seconds: 60 });
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=60", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=60",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-c:a", "aac", "-movflags", "+faststart", join(dir, "movie.mp4")]);
  const plex = await plexFixture(t, dir, { duration: 60_000, original: "movie.mp4" });
  const yolo = await startYolo(t, {
    pluginConfig: { plugins: [{ source: join(root, "plugins/source-plex"), options: { url: plex.url, token: PLEX_TOKEN } }] },
    nodeEnv: { LAN_ADDRESS: "127.0.0.1", LAN_PORT: String(await freePort()) },
  });

  // What the control plane does with the node's request: a certificate for its name.
  const configured = (await yolo.node("/internal/v1/lan", { name: NAME, allowOrigin: yolo.origin }, "PUT")).body;
  await writeFile(join(dir, "req.pem"), configured.csr);
  await writeFile(join(dir, "ext.cnf"), `subjectAltName=DNS:${NAME}\n`);
  await exec("openssl", ["x509", "-req", "-in", join(dir, "req.pem"), "-signkey", join(yolo.dir, "node/.lan/key.pem"), "-days", "2", "-extfile", join(dir, "ext.cnf"), "-out", join(dir, "cert.pem")]);
  const { origin, listening } = (await yolo.node("/internal/v1/lan/certificate", { name: NAME, chain: await readFile(join(dir, "cert.pem"), "utf8") }, "PUT")).body;
  assert.equal(listening, true);

  const context = await launchBrowser(t, { args: [`--host-resolver-rules=MAP ${NAME} 127.0.0.1`], context: { ignoreHTTPSErrors: true } });
  const { page, errors } = await openPage(context, yolo.origin);
  const pageLog = [];
  page.on("console", (message) => pageLog.push(message.text()));
  await pair(yolo, page);
  await waitFor(page, () => globalThis.__yolo.profile.engine === "native", null, "the <video> engine");
  // The welcome names the origin once the control plane's check found the
  // node ready (KV); here the page is told directly. Turning the switch on probes.
  const probe = await page.evaluate(async (lan) => {
    await globalThis.__yolo.lan.setOrigin(lan);
    return globalThis.__yolo.lan.setEnabled(true);
  }, { origin, notAfter: Date.now() + 86_400_000 });
  assert.equal(probe.outcome, "ok");

  const agent = await yolo.agentToken();
  await yolo.mcp(agent, "play", { item_id: "plex:7" });
  await waitFor(page, () => globalThis.__yoloPlayer?.player?.getStatus() === "playing" && globalThis.__yoloPlayer.player.getCurrentTime() > 2, null, "the original plays", 40_000);
  const playing = await page.evaluate(() => ({ src: globalThis.__yoloPlayer.player.video.currentSrc, mode: globalThis.__yoloPlayer.player.mode }));
  assert.ok(playing.src.startsWith(`${origin}/m/`), playing.src);
  assert.equal(playing.mode, "progressive");
  assert.ok(!plex.calls.some((call) => call.path.endsWith("/start.m3u8")), "Plex transcodes nothing");
  const seen = await page.evaluate(() => JSON.stringify([globalThis.__yolo.state, performance.getEntriesByType("resource").map((entry) => entry.name)]));
  assert.ok(!seen.includes(PLEX_TOKEN) && !pageLog.join("\n").includes(PLEX_TOKEN), "the page never sees the Plex token");

  // The LAN goes away (the node takes another name); a seek needs bytes it cannot get.
  await yolo.node("/internal/v1/lan", { name: "yolo-lan-gone.example.com", allowOrigin: yolo.origin }, "PUT");
  await yolo.mcp(agent, "seek", { position_seconds: 40 });
  await waitFor(page, () => globalThis.__yolo.state.streamNetwork === "tunnel" && globalThis.__yoloPlayer?.player?.getStatus() === "playing", null, "the tunnel plays on", 60_000);
  const after = await page.evaluate(() => ({ time: globalThis.__yoloPlayer.player.getCurrentTime(), network: globalThis.__yolo.lan.network() }));
  assert.equal(after.network, "tunnel");
  assert.ok(after.time >= 38, `the position is kept: ${after.time}`);
  assert.deepEqual(errors, []);
  // Workers Logs say which path each stream took and why the LAN one ended.
  const logged = (pattern) => yolo.workerLog().split(/\n(?=\{)/).some((line) => pattern.every((part) => line.includes(part)));
  assert.ok(logged(["event: 'stream'", "reason: 'recovery'", "network: 'tunnel'"]));
  await eventually(() => logged(["type: 'lan_fallback'", "position: 40"]), "the fallback in the device's telemetry", 20_000);
});
