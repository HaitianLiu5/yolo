import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Agent, request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEdgeApp } from "../src/edge.js";
import { createMediaPipeline } from "../src/media/pipeline.js";
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
function fakeMapper() {
  const calls = [];
  let mapped = false;
  return {
    calls,
    ensure: async (address) => {
      calls.push(["map", address]);
      mapped = true;
    },
    unmap: async () => {
      calls.push(["unmap"]);
      mapped = false;
    },
    status: () => ({ mode: "auto", method: mapped ? "natpmp" : null, externalAddress: mapped ? PUBLIC : null, externalPort: mapped ? 443 : null, error: null }),
  };
}

async function setup(t) {
  const mapper = fakeMapper();
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
  return { media, wan, chain, mapper };
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

test("the remote listener serves only its probe and media, to its own name in Host and TLS, and cuts off a peer that keeps failing", async (t) => {
  const { wan, chain, media, mapper } = await setup(t);
  assert.deepEqual(mapper.calls, [["map", "127.0.0.1"]], "the port is mapped once the listener serves");
  assert.equal(wan.status().origin, `https://${NAME}`, "the origin carries the router's external port (443: none)");
  const probe = await wanRequest(wan, chain, "/edge/probe");
  assert.deepEqual([probe.status, JSON.parse(probe.body), probe.headers["access-control-allow-origin"]], [200, { ok: true, name: NAME, path: "wan" }, PAGE]);
  assert.equal(probe.headers["content-security-policy"], "default-src 'none'; sandbox");
  // No internal API, no owner commands, no other method; another Host, or no
  // TLS server name (a scanner by address), reaches no handler.
  for (const [path, options, status] of [
    ["/internal/v1/health", {}, 404], ["/local/v1/owner-code", { method: "POST" }, 404], ["/m/x/f/0", { method: "POST" }, 405],
    ["/edge/probe", { headers: { host: "attacker.example" } }, 421], ["/edge/probe", { servername: "" }, 421],
  ]) assert.equal((await wanRequest(wan, chain, path, options)).status, status, `${path} ${JSON.stringify(options)}`);
  // A TLS client that names another host gets no certificate at all.
  await assert.rejects(wanRequest(wan, chain, "/edge/probe", { servername: "other.example.com" }));

  // A forged token is refused before any session work; 20 failures in all
  // cut the peer off: the connection it holds gets 429, a new one is closed before TLS.
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const forged = await wanRequest(wan, chain, "/m/ses_x.usr_x.9999999999.forged/f/0", { agent });
  assert.deepEqual([forged.status, forged.body.toString().includes("ses_x"), media.size], [403, false, 0]);
  const statuses = [];
  for (let index = 0; index < 20 && statuses.at(-1) !== 429; index += 1) statuses.push((await wanRequest(wan, chain, "/m/ses_x.usr_x.9999999999.forged/f/0", { agent })).status);
  assert.deepEqual(new Set(statuses), new Set([403, 429]));
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

test("a listener's answers never carry a document type, and one known by address answers only the page", async () => {
  const edge = (name) => createEdgeApp({
    path: "wan",
    config: () => ({ name, hosts: [name], allowOrigin: PAGE }),
    media: { handle: () => new Response("<html>", { headers: { "content-type": "text/html" } }) },
  });
  const media = await edge(NAME).request(`https://${NAME}/m/token/f/0`, { headers: { host: NAME } });
  assert.equal(media.headers.get("content-type"), "application/octet-stream");
  assert.equal(media.headers.get("x-content-type-options"), "nosniff");
  // A scanner by address learns neither that it reached Yolo nor the page's origin.
  const byAddress = edge(PUBLIC);
  for (const path of ["/edge/probe", "/"]) {
    const scanner = await byAddress.request(`https://${PUBLIC}${path}`, { headers: { host: PUBLIC } });
    assert.deepEqual([scanner.status, (await scanner.text()).length, scanner.headers.get("access-control-allow-origin")], [404, 0, null], path);
  }
  const page = await byAddress.request(`https://${PUBLIC}/edge/probe`, { headers: { host: PUBLIC, origin: PAGE } });
  assert.deepEqual([page.status, page.headers.get("access-control-allow-origin")], [200, PAGE]);
});
