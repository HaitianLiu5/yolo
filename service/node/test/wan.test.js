import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Agent, request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signMediaToken, signNodeRequest } from "@useyolo/core";
import { createNodeApp } from "../src/app.js";
import { createEdgeApp } from "../src/edge.js";
import { createMediaPipeline } from "../src/media/pipeline.js";
import { loadPlugins } from "../src/plugins.js";
import { createPeerGuard, createWan } from "../src/wan.js";

// The remote listener (Agent Note 2026-10-13-media-off-the-worker) over real
// TLS on loopback, with a stand-in for the router mapping: what the internet
// can reach, and what one peer may do.

const secret = "wan-test-secret";
const NAME = "yolo-wan-test.example.com";
const PAGE = "https://yolo.example.com";
const PUBLIC = "73.63.154.63";

const freePort = () => new Promise((done) => {
  const server = createNetServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

// The router mapping as the listener sees it, recording what it was asked.
function fakeMapper({ externalPort = 443, externalAddress = PUBLIC } = {}) {
  const calls = [];
  let mapped = null;
  return {
    calls,
    ensure: async (address) => {
      calls.push(["map", address]);
      mapped = address;
    },
    unmap: async () => {
      calls.push(["unmap"]);
      mapped = null;
    },
    status: () => ({ mode: "auto", gateway: "192.0.2.1", method: mapped ? "natpmp" : null, externalAddress: mapped ? externalAddress : null, externalPort: mapped ? externalPort : null, expiresAt: null, error: null }),
  };
}

async function setup(t, { mapper = fakeMapper() } = {}) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "yolo-wan-"));
  const media = createMediaPipeline({ secret, runtimeDir, stopGraceMs: 20 });
  media.init();
  const wan = createWan({
    runtimeDir, media, secret, env: { WAN_ADDRESS: "127.0.0.1", WAN_PORT: String(await freePort()) }, mapper, publicAddress: async () => PUBLIC,
  });
  await wan.start();
  t.after(async () => {
    await wan.close();
    await media.close();
    await rm(runtimeDir, { recursive: true, force: true });
  });
  const configured = await wan.configure({ name: NAME, allowOrigin: PAGE });
  assert.equal(configured.listening, false, "no certificate yet, so nothing listens and nothing is mapped");
  assert.deepEqual(mapper.calls, []);
  const files = { csr: join(runtimeDir, "req.pem"), ext: join(runtimeDir, "ext.cnf"), cert: join(runtimeDir, "cert.pem") };
  await writeFile(files.csr, configured.csr);
  await writeFile(files.ext, `subjectAltName=DNS:${NAME}\n`);
  execFileSync("openssl", ["x509", "-req", "-in", files.csr, "-signkey", join(runtimeDir, ".lan/wan/key.pem"), "-days", "2", "-extfile", files.ext, "-out", files.cert], { stdio: "ignore" });
  const chain = await readFile(files.cert, "utf8");
  await wan.install({ name: NAME, chain });
  return { runtimeDir, media, wan, chain, mapper };
}

function wanRequest(wan, chain, path, { method = "GET", headers = {}, servername = NAME, agent = false } = {}) {
  const { port } = wan.status();
  return new Promise((done, reject) => {
    // Without a server name the client checks the certificate against nothing.
    const identity = servername ? {} : { checkServerIdentity: () => undefined };
    const req = httpsRequest({ host: "127.0.0.1", port, path, method, servername, ca: chain, agent, ...identity, headers: { host: `${NAME}:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the remote listener serves only its probe and media, to its own name in Host and TLS, after the router mapping", async (t) => {
  const { wan, chain, media, mapper } = await setup(t);
  assert.deepEqual(mapper.calls, [["map", "127.0.0.1"]], "the port is mapped once the listener serves");
  const status = wan.status();
  assert.equal(status.origin, `https://${NAME}`, "the origin carries the router's external port (443: none)");
  assert.equal(status.publicAddress, PUBLIC);
  assert.equal(status.nat, null);

  const probe = await wanRequest(wan, chain, "/edge/probe");
  assert.equal(probe.status, 200);
  assert.deepEqual(JSON.parse(probe.body), { ok: true, name: NAME, path: "wan" });
  assert.equal(probe.headers["access-control-allow-origin"], PAGE);
  assert.equal(probe.headers["content-security-policy"], "default-src 'none'; sandbox");

  // No internal API, no owner commands, no LAN probe, no other method.
  assert.equal((await wanRequest(wan, chain, "/internal/v1/health")).status, 404);
  assert.equal((await wanRequest(wan, chain, "/local/v1/owner-code", { method: "POST" })).status, 404);
  assert.equal((await wanRequest(wan, chain, "/lan/probe")).status, 404);
  assert.equal((await wanRequest(wan, chain, "/m/x/f/0", { method: "POST" })).status, 405);
  // Another Host, or no TLS server name (a scanner by address), reaches no handler.
  assert.equal((await wanRequest(wan, chain, "/edge/probe", { headers: { host: "attacker.example" } })).status, 421);
  assert.equal((await wanRequest(wan, chain, "/edge/probe", { servername: "" })).status, 421);
  // A TLS client that names another host gets no certificate at all.
  await assert.rejects(wanRequest(wan, chain, "/edge/probe", { servername: "other.example.com" }));
  // A forged token is refused before any session work.
  const forged = await wanRequest(wan, chain, "/m/ses_x.usr_x.9999999999.forged/f/0");
  assert.equal(forged.status, 403);
  assert.ok(!forged.body.toString().includes("ses_x"));
  assert.equal(media.size, 0);
});

test("a peer whose requests keep failing is cut off for ten minutes", async (t) => {
  const { wan, chain } = await setup(t);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await wanRequest(wan, chain, "/m/ses_x.usr_x.9999999999.forged/f/0", { agent })).status, 403);
  }
  // The connection it holds gets 429; a new one is closed before TLS.
  assert.equal((await wanRequest(wan, chain, "/edge/probe", { agent })).status, 429);
  await assert.rejects(wanRequest(wan, chain, "/edge/probe"));
  assert.equal(wan.status().guard.banned, 1);
});

test("connections are bounded per peer, in all, and per second", () => {
  let clock = 0;
  const guard = createPeerGuard({ now: () => clock });
  for (let index = 0; index < 20; index += 1) assert.equal(guard.admit("198.51.100.1"), true);
  assert.equal(guard.admit("198.51.100.2"), false, "at most 20 new connections a second in all");
  clock += 1_000;
  for (let index = 0; index < 12; index += 1) assert.equal(guard.admit("198.51.100.1"), true);
  assert.equal(guard.admit("198.51.100.1"), false, "at most 32 open connections per peer");
  guard.release("198.51.100.1");
  assert.equal(guard.admit("198.51.100.1"), true);
  for (let index = 0; index < 19; index += 1) guard.failed("198.51.100.3");
  clock += 59_000;
  assert.equal(guard.failed("198.51.100.3"), true, "20 failures in a minute");
  assert.equal(guard.admit("198.51.100.3"), false);
  clock += 10 * 60_000;
  assert.equal(guard.admit("198.51.100.3"), true, "for ten minutes");
});

test("a remote stream has the uplink's ceiling and the remote origin; carrier-grade NAT or remote access off falls back to the relay", async (t) => {
  const mapper = fakeMapper({ externalPort: 9444 });
  const { wan, media, mapper: calls } = await setup(t, { mapper });
  const contexts = [];
  const plugins = await loadPlugins([{
    name: "fixture",
    enabled: true,
    options: {},
    factory: (yolo) => yolo.registerSource("files", {
      prepare: async (_source, context) => {
        contexts.push(context);
        return { title: "Film", input: { type: "file", url: "http://127.0.0.1:9/movie.mp4", cache: false } };
      },
    }),
  }]);
  await plugins.start();
  const app = createNodeApp({ secret, plugins, media, wan });
  const prepare = async (sessionId, network) => {
    const body = JSON.stringify({
      sessionId, network, source: { plugin: "files", id: "1" }, capabilities: { renderer: "html5-video" },
      mediaToken: await signMediaToken(secret, { sessionId, userId: "usr_wan", exp: Math.floor(Date.now() / 1000) + 600 }),
    });
    const path = "/internal/v1/prepare";
    const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", ...await signNodeRequest(secret, { method: "POST", path, body }) }, body });
    return response.json();
  };
  const remote = await prepare("ses_wan", "wan");
  assert.deepEqual([remote.network, remote.origin], ["wan", `https://${NAME}:9444`]);
  assert.deepEqual([contexts[0].network, contexts[0].limits.maxVideoKbps], ["tunnel", 4800], "the plugin sees the tunnel, at the uplink's ceiling");
  const relay = await prepare("ses_relay", "tunnel");
  assert.deepEqual([relay.network, relay.origin], ["relay", null], "the old name of the relay is the relay");

  // The router's own address is a carrier-grade NAT one: no remote path.
  mapper.status = () => ({ method: "natpmp", externalAddress: "100.70.1.2", externalPort: 9444, error: null });
  assert.equal(wan.status().nat, "cgnat");
  assert.deepEqual([(await prepare("ses_cgnat", "wan")).network], ["relay"]);

  // The owner turns remote access off: the listener stops and the mapping goes.
  await wan.configure({ name: NAME, allowOrigin: PAGE, enabled: false });
  assert.equal(wan.status().listening, false);
  assert.deepEqual(calls.calls.at(-1), ["unmap"]);
});

test("a listener's answers never carry a document type", async () => {
  const app = createEdgeApp({
    path: "wan",
    config: () => ({ name: NAME, hosts: [NAME], allowOrigin: PAGE }),
    media: { handle: () => new Response("<html>", { headers: { "content-type": "text/html" } }) },
  });
  const response = await app.request(`https://${NAME}/m/token/f/0`, { headers: { host: NAME } });
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
