import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signMediaToken, signNodeRequest } from "@useyolo/core";
import { createNodeApp } from "../src/app.js";
import { createLan } from "../src/lan.js";
import { createMediaPipeline } from "../src/media/pipeline.js";
import { loadPlugins } from "../src/plugins.js";

// The LAN listener (Agent Note 2026-10-12-lan-direct-play) over real TLS: a
// certificate for the node's own request, signed here by openssl as the
// ACME server would sign it.

const secret = "lan-test-secret";
const NAME = "yolo-lan-test.example.com";
const PAGE = "https://yolo.example.com";
const UPSTREAM_SECRET = "upstream-credential-1234";
const FILE = Buffer.alloc(32 * 1024, 9);

const freePort = () => new Promise((done) => {
  const server = createNetServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

async function setup(t) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "yolo-lan-"));
  const upstreamRequests = [];
  const upstream = createServer((req, res) => {
    upstreamRequests.push(req.headers);
    const [, start, end] = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "bytes=0-") || [];
    const from = Number(start);
    const to = Math.min(end ? Number(end) : FILE.length - 1, FILE.length - 1);
    res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/${FILE.length}`, "content-length": to - from + 1, "x-upstream-token": UPSTREAM_SECRET });
    res.end(FILE.subarray(from, to + 1));
  });
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  const media = createMediaPipeline({ secret, runtimeDir, stopGraceMs: 20 });
  media.init();
  const lan = createLan({ runtimeDir, media, env: { LAN_ADDRESS: "127.0.0.1", LAN_PORT: String(await freePort()) } });
  await lan.start();
  t.after(async () => {
    await lan.close();
    await media.close();
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
    await rm(runtimeDir, { recursive: true, force: true });
  });
  return { runtimeDir, media, lan, upstreamRequests, upstreamUrl: `http://127.0.0.1:${upstream.address().port}/movie.mp4` };
}

// What the ACME server does with the node's request: a certificate for it.
async function sign(runtimeDir, csr, serial) {
  const files = { csr: join(runtimeDir, "req.pem"), ext: join(runtimeDir, "ext.cnf"), cert: join(runtimeDir, "cert.pem") };
  await writeFile(files.csr, csr);
  await writeFile(files.ext, `subjectAltName=DNS:${NAME}\n`);
  execFileSync("openssl", ["x509", "-req", "-in", files.csr, "-signkey", join(runtimeDir, ".lan/key.pem"), "-days", "2", "-set_serial", String(serial), "-extfile", files.ext, "-out", files.cert], { stdio: "ignore" });
  return readFile(files.cert, "utf8");
}

function lanRequest(lan, chain, path, { method = "GET", headers = {} } = {}) {
  const { port } = lan.status();
  return new Promise((done, reject) => {
    const req = httpsRequest({ host: "127.0.0.1", port, path, method, servername: NAME, ca: chain, agent: false, headers: { host: `${NAME}:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), serial: res.socket.getPeerCertificate?.()?.serialNumber }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the LAN listener serves only its probe and media, to its own name, and takes a new certificate without a restart", async (t) => {
  const { runtimeDir, media, lan } = await setup(t);
  const configured = await lan.configure({ name: NAME, allowOrigin: PAGE });
  assert.match(configured.csr, /BEGIN CERTIFICATE REQUEST/);
  assert.equal(configured.listening, false, "no certificate yet, so nothing listens");
  const first = await sign(runtimeDir, configured.csr, 1);
  assert.equal((await lan.install({ name: NAME, chain: first })).listening, true);

  const probe = await lanRequest(lan, first, "/lan/probe");
  assert.equal(probe.status, 200);
  assert.deepEqual(JSON.parse(probe.body), { ok: true, name: NAME });
  assert.equal(probe.headers["access-control-allow-origin"], PAGE);
  assert.equal(probe.headers["cross-origin-resource-policy"], "cross-origin");
  assert.equal(probe.headers["x-content-type-options"], "nosniff");

  // The internal API and owner commands are not on this listener.
  assert.equal((await lanRequest(lan, first, "/internal/v1/health")).status, 404);
  assert.equal((await lanRequest(lan, first, "/local/v1/owner-code", { method: "POST" })).status, 404);
  // Another Host (a DNS rebinding page, or the bare address) is refused.
  assert.equal((await lanRequest(lan, first, "/lan/probe", { headers: { host: "attacker.example" } })).status, 421);
  // Media needs its token; a preflight allows the range and prefetch headers.
  assert.equal((await lanRequest(lan, first, "/m/ses_x.usr_x.9999999999.forged/f/0")).status, 403);
  assert.equal((await lanRequest(lan, first, "/m/x/f/0", { method: "POST" })).status, 405);
  const preflight = await lanRequest(lan, first, "/m/x/f/0", { method: "OPTIONS", headers: { origin: PAGE, "access-control-request-method": "GET", "access-control-request-headers": "range" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], PAGE);
  assert.equal(preflight.headers["access-control-allow-headers"], "Range");
  assert.equal(media.size, 0);

  // A renewed certificate serves new connections at once.
  const renewed = await sign(runtimeDir, configured.csr, 2);
  await lan.install({ name: NAME, chain: renewed });
  assert.equal((await lanRequest(lan, renewed, "/lan/probe")).serial, "02");
});

test("a LAN stream gets the LAN ceiling and origin, and the source's credentials stay on the node", async (t) => {
  const { runtimeDir, media, lan, upstreamRequests, upstreamUrl } = await setup(t);
  const contexts = [];
  const plugins = await loadPlugins([{
    name: "fixture",
    enabled: true,
    options: {},
    factory: (yolo) => yolo.registerSource("files", {
      prepare: async (_source, context) => {
        contexts.push(context);
        return { title: "Film", input: { type: "file", url: upstreamUrl, headers: { "X-Upstream-Token": UPSTREAM_SECRET }, cache: false } };
      },
    }),
  }]);
  await plugins.start();
  const app = createNodeApp({ secret, plugins, media, lan });
  const configured = await lan.configure({ name: NAME, allowOrigin: PAGE });
  const chain = await sign(runtimeDir, configured.csr, 3);
  await lan.install({ name: NAME, chain });

  const prepare = async (sessionId, network) => {
    const body = JSON.stringify({
      sessionId, network, source: { plugin: "files", id: "1" }, capabilities: { renderer: "html5-video" },
      mediaToken: await signMediaToken(secret, { sessionId, userId: "usr_lan", exp: Math.floor(Date.now() / 1000) + 600 }),
    });
    const path = "/internal/v1/prepare";
    const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", ...await signNodeRequest(secret, { method: "POST", path, body }) }, body });
    return { status: response.status, text: await response.text() };
  };

  const tunnel = await prepare("ses_tunnel", "tunnel");
  assert.equal(tunnel.status, 200);
  assert.deepEqual([JSON.parse(tunnel.text).network, JSON.parse(tunnel.text).origin], ["tunnel", null]);
  const lanStream = await prepare("ses_lan", "lan");
  const stream = JSON.parse(lanStream.text);
  assert.deepEqual([stream.network, stream.origin], ["lan", `https://${NAME}:${lan.status().port}`]);
  assert.deepEqual(contexts.map((context) => [context.network, context.limits.maxVideoKbps]), [["tunnel", 4800], ["lan", lan.maxVideoKbps]]);
  assert.equal(contexts[1].playable({ container: "mp4", video: { codec: "avc1", height: 720 }, audio: [{ codec: "mp4a" }], kbps: 9000 }).decision, "direct");
  assert.ok(!lanStream.text.includes(UPSTREAM_SECRET), "the descriptor the device receives has no source credential");

  const served = await lanRequest(lan, chain, stream.delivery.url, { headers: { range: "bytes=0-1023" } });
  assert.equal(served.status, 206);
  assert.equal(served.headers["content-range"], `bytes 0-1023/${FILE.length}`);
  assert.match(served.headers["access-control-expose-headers"], /Content-Range/);
  assert.equal(upstreamRequests.at(-1)["x-upstream-token"], UPSTREAM_SECRET);
  assert.ok(!JSON.stringify(served.headers).includes(UPSTREAM_SECRET), "no upstream header reaches the device");
  assert.ok(!served.body.includes(UPSTREAM_SECRET));
});
