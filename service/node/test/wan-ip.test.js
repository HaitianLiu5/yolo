import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connect as tlsConnect } from "node:tls";
import { createMediaPipeline } from "../src/media/pipeline.js";
import { createWan } from "../src/wan.js";

// Remote direct play without a domain (Agent Note 2026-10-13-media-off-the-worker,
// Agent Note 2026-10-13-no-domain-deployment): the node obtains a
// certificate for the home's public address itself, from a stand-in ACME
// server on loopback that checks every JWS, asks for the `shortlived`
// profile and `ip` identifiers, and validates HTTP-01 or TLS-ALPN-01 by
// connecting to the node's ports as the CA would through the router.

const secret = "wan-ip-test-secret";
const PAGE = "https://yolo-control.owner.workers.dev";
const HOME = "73.63.154.63";
const MOVED = "73.63.154.99";
const DAY = 24 * 60 * 60_000;
const ACME_IDENTIFIER_OID = Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x1f]);

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const thumbprint = ({ crv, kty, x, y }) => b64(createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest());

const freePort = () => new Promise((done) => {
  const server = createNetServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

function httpGet(port, path, host) {
  return new Promise((done, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => done({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// What the CA's TLS-ALPN-01 check sees (RFC 8737, RFC 8738): the reverse
// name as SNI, `acme-tls/1`, and a certificate for the address that carries
// the digest of the key authorization.
function alpnCheck(port, address, keyAuthorization) {
  const servername = `${address.split(".").reverse().join(".")}.in-addr.arpa`;
  return new Promise((done) => {
    const socket = tlsConnect({ host: "127.0.0.1", port, servername, ALPNProtocols: ["acme-tls/1"], rejectUnauthorized: false }, () => {
      const certificate = socket.getPeerX509Certificate();
      const digest = createHash("sha256").update(keyAuthorization).digest();
      const extension = Buffer.concat([ACME_IDENTIFIER_OID, Buffer.from([0x01, 0x01, 0xff, 0x04, 0x22, 0x04, 0x20]), digest]);
      const ok = socket.alpnProtocol === "acme-tls/1" && certificate?.subjectAltName === `IP Address:${address}` && certificate.raw.includes(extension);
      socket.destroy();
      done(ok);
    });
    socket.on("error", () => done(false));
  });
}

// RFC 8555 as far as these orders need, with the CA's validation of each
// challenge done against the node's own ports on loopback.
async function acmeServer(t, { runtimeDir, ports }) {
  const nonces = new Set();
  const accounts = new Map();
  const orders = [];
  const validations = [];
  let base;
  const nonce = () => {
    const value = b64(crypto.getRandomValues(new Uint8Array(12)));
    nonces.add(value);
    return value;
  };
  const sign = async (order, csrDer) => {
    const files = { csr: join(runtimeDir, `order-${order.id}.csr`), ext: join(runtimeDir, `order-${order.id}.cnf`), cert: join(runtimeDir, `order-${order.id}.pem`) };
    const lines = csrDer.toString("base64").match(/.{1,64}/g).join("\n");
    await writeFile(files.csr, `-----BEGIN CERTIFICATE REQUEST-----\n${lines}\n-----END CERTIFICATE REQUEST-----\n`);
    await writeFile(files.ext, `subjectAltName=${order.identifiers.map((identifier) => `IP:${identifier.value}`).join(",")}\n`);
    execFileSync("openssl", ["x509", "-req", "-in", files.csr, "-signkey", join(runtimeDir, ".lan/wan/key.pem"), "-days", "7", "-extfile", files.ext, "-out", files.cert], { stdio: "ignore" });
    return readFile(files.cert, "utf8");
  };
  async function validate(order, authz, type) {
    const keyAuthorization = `${authz.token}.${thumbprint(order.jwk)}`;
    let ok = false;
    if (type === "http-01") {
      const answer = await httpGet(ports.challenge(), `/.well-known/acme-challenge/${authz.token}`, authz.identifier.value).catch(() => null);
      ok = answer?.status === 200 && answer.body === keyAuthorization;
    } else {
      ok = await alpnCheck(ports.media(), authz.identifier.value, keyAuthorization);
    }
    validations.push({ type, identifier: authz.identifier.value, ok });
    authz.status = ok ? "valid" : "invalid";
  }
  const server = createHttpServer(async (req, res) => {
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { "replay-nonce": nonce(), "content-type": typeof body === "string" ? "application/pem-certificate-chain" : "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const url = new URL(req.url, base);
    if (url.pathname === "/directory") {
      return reply(200, { newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order`, meta: { profiles: { classic: "90 days", shortlived: "160 hours" } } });
    }
    if (url.pathname === "/nonce") return reply(200, "");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const jws = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const header = decode(jws.protected);
    assert.equal(header.url, url.href);
    assert.ok(nonces.delete(header.nonce), "a fresh nonce");
    const jwk = header.jwk ?? accounts.get(header.kid);
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(jws.signature, "base64url"), new TextEncoder().encode(`${jws.protected}.${jws.payload}`)), "a valid ES256 signature");
    const payload = jws.payload ? decode(jws.payload) : undefined;
    if (url.pathname === "/account") {
      const kid = `${base}/acct/${accounts.size + 1}`;
      accounts.set(kid, header.jwk);
      return reply(201, { status: "valid" }, { location: kid });
    }
    if (url.pathname === "/order") {
      const id = orders.length;
      const order = {
        id, jwk, profile: payload.profile ?? null, identifiers: payload.identifiers, status: "pending",
        authzs: payload.identifiers.map((identifier) => ({ identifier, status: "pending", token: b64(crypto.getRandomValues(new Uint8Array(16))) })),
      };
      orders.push(order);
      return reply(201, { status: "pending", identifiers: order.identifiers, authorizations: order.authzs.map((_, index) => `${base}/authz/${id}/${index}`), finalize: `${base}/finalize/${id}` }, { location: `${base}/orders/${id}` });
    }
    const [, kind, id, index, type] = url.pathname.split("/");
    const order = orders[Number(id)];
    if (kind === "authz") {
      const authz = order.authzs[Number(index)];
      return reply(200, {
        status: authz.status,
        identifier: authz.identifier,
        challenges: ["http-01", "tls-alpn-01"].map((name) => ({ type: name, url: `${base}/challenge/${id}/${index}/${name}`, token: authz.token })),
      });
    }
    if (kind === "challenge") {
      await validate(order, order.authzs[Number(index)], type);
      return reply(200, { status: "processing" });
    }
    if (kind === "finalize") {
      assert.ok(order.authzs.every((authz) => authz.status === "valid"));
      order.chain = await sign(order, Buffer.from(payload.csr, "base64url"));
      order.status = "valid";
      return reply(200, { status: "valid", certificate: `${base}/cert/${id}` }, { location: `${base}/orders/${id}` });
    }
    if (kind === "orders") return reply(200, { status: order.status, ...(order.status === "valid" ? { certificate: `${base}/cert/${id}` } : {}) });
    if (kind === "cert") return reply(200, order.chain);
    return reply(404, { type: "urn:ietf:params:acme:error:malformed", detail: url.pathname });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((done) => server.close(done)));
  return { directory: `${base}/directory`, orders, validations };
}

// A router mapping as wan.js sees one; `refuse` makes the router say no.
function fakeMapper({ externalPort, home = { address: HOME }, refuse = false }) {
  const calls = [];
  let mapped = null;
  // What the router said at its last mapping or renewal.
  let said = home.address;
  return {
    calls,
    refresh: async () => {
      calls.push(["refresh"]);
      said = home.address;
    },
    ensure: async (address) => {
      if (mapped === address) return;
      calls.push(["map", address]);
      mapped = refuse ? null : address;
      said = home.address;
    },
    map: async (address) => {
      calls.push(["map", address]);
      mapped = refuse ? null : address;
      said = home.address;
      return mapped ? { externalPort } : null;
    },
    unmap: async () => {
      calls.push(["unmap"]);
      mapped = null;
    },
    status: () => ({
      mode: "auto", gateway: "192.0.2.1", method: mapped ? "upnp" : null, externalAddress: mapped ? said : null, externalPort: mapped ? externalPort : null, expiresAt: null,
      error: refuse ? "The router at 192.0.2.1 made no port mapping (pcp: NOT_AUTHORIZED; natpmp: timeout; upnp: 718)" : null,
    }),
  };
}

async function setup(t, { mediaExternalPort = 9444, refuse80 = false } = {}) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "yolo-wan-ip-"));
  const media = createMediaPipeline({ secret, runtimeDir, stopGraceMs: 20 });
  media.init();
  const env = { WAN_ADDRESS: "127.0.0.1", WAN_PORT: String(await freePort()), WAN_CHALLENGE_PORT: String(await freePort()), WAN_EXTERNAL_PORT: String(mediaExternalPort) };
  const acme = await acmeServer(t, { runtimeDir, ports: { media: () => Number(env.WAN_PORT), challenge: () => Number(env.WAN_CHALLENGE_PORT) } });
  const clock = { now: Date.now() };
  const home = { address: HOME };
  const mapper = fakeMapper({ externalPort: mediaExternalPort, home });
  const challengeMapper = fakeMapper({ externalPort: 80, home, refuse: refuse80 });
  const wan = createWan({ runtimeDir, media, secret, env, mapper, challengeMapper, now: () => clock.now, publicAddress: async () => home.address });
  await wan.start();
  t.after(async () => {
    await wan.close();
    await media.close();
    await rm(runtimeDir, { recursive: true, force: true });
  });
  return { wan, acme, clock, home, mapper, challengeMapper, env };
}

function wanRequest(wan, chain, path, { host, origin = PAGE, method = "GET" } = {}) {
  const { port } = wan.status();
  return new Promise((done, reject) => {
    // A browser sends no server name to an address (RFC 6066).
    const req = httpsRequest({
      host: "127.0.0.1", port, path, method, servername: "", ca: chain, agent: false, checkServerIdentity: () => undefined,
      headers: { host: host ?? `${HOME}:${port}`, ...(origin ? { origin } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("with no domain the node certifies the home's public address by HTTP-01 through a router port 80 it maps only for the order, and renews on a new address and before expiry", async (t) => {
  const { wan, acme, clock, home, mapper, challengeMapper, env } = await setup(t);
  const status = await wan.configure({ certificate: "ip", allowOrigin: PAGE, enabled: true, acmeDirectory: acme.directory });

  assert.equal(status.certificate, "ip");
  assert.equal(status.listening, true);
  assert.equal(status.origin, `https://${HOME}:9444`, "the router's external port, by address");
  assert.deepEqual(status.identifiers, [HOME]);
  assert.deepEqual(acme.orders.map((order) => [order.profile, order.identifiers]), [["shortlived", [{ type: "ip", value: HOME }]]]);
  assert.deepEqual(acme.validations, [{ type: "http-01", identifier: HOME, ok: true }]);
  assert.deepEqual(challengeMapper.calls, [["map", "127.0.0.1"], ["unmap"]], "port 80 is mapped for the order and removed after it");
  assert.deepEqual([status.challenge.type, status.challenge.externalPort, status.order.error], ["http-01", 80, null]);
  await assert.rejects(httpGet(Number(env.WAN_CHALLENGE_PORT), "/.well-known/acme-challenge/x", HOME), "the challenge port closes after the order");
  const chain = acme.orders[0].chain;
  assert.equal(new X509Certificate(chain).checkIP(HOME), HOME);

  // The page's own requests are served; a scanner by address learns nothing.
  const probe = await wanRequest(wan, chain, "/edge/probe");
  assert.equal(probe.status, 200);
  assert.deepEqual(JSON.parse(probe.body), { ok: true, name: HOME, path: "wan" });
  assert.equal(probe.headers["access-control-allow-origin"], PAGE);
  const scanner = await wanRequest(wan, chain, "/edge/probe", { origin: null });
  assert.deepEqual([scanner.status, scanner.body.length, scanner.headers["access-control-allow-origin"]], [404, 0, undefined], "no Yolo answer and no control origin without the page's Origin");
  const root = await wanRequest(wan, chain, "/", { origin: null });
  assert.deepEqual([root.status, root.body.length, root.headers["access-control-allow-origin"]], [404, 0, undefined]);
  assert.equal((await wanRequest(wan, chain, "/edge/probe", { host: "yolo.example.com" })).status, 421, "a name is not this listener's");
  assert.equal((await wanRequest(wan, chain, "/m/ses_x.usr_x.9999999999.forged/f/0")).status, 403, "the token before any session work");

  // Nothing due: no order.
  clock.now += 6 * 60_000;
  await wan.check();
  assert.equal(acme.orders.length, 1);

  // The ISP gives the home another address: the router is asked again at
  // once rather than read as another NAT, a certificate for the new address
  // follows, and so does the origin.
  home.address = MOVED;
  clock.now += 6 * 60_000;
  await wan.check();
  assert.ok(mapper.calls.some(([call]) => call === "refresh"));
  assert.equal(wan.status().nat, null);
  assert.deepEqual(acme.orders.at(-1).identifiers, [{ type: "ip", value: MOVED }]);
  assert.equal(wan.status().origin, `https://${MOVED}:9444`);
  assert.equal(wan.ready(), true);

  // Two thirds into the 160-hour lifetime it is renewed.
  clock.now += 5 * DAY;
  await wan.check();
  assert.equal(acme.orders.length, 3);
});

test("a router that will not map port 80 gets the manual forward in the status, and no failed authorization is spent", async (t) => {
  const { wan, acme, env } = await setup(t, { refuse80: true });
  const status = await wan.configure({ certificate: "ip", allowOrigin: PAGE, enabled: true, acmeDirectory: acme.directory });
  assert.equal(status.listening, false);
  assert.equal(acme.orders.length, 0);
  assert.match(status.order.error, new RegExp(`Forward TCP port 80 to 127\\.0\\.0\\.1:${env.WAN_CHALLENGE_PORT}`));
  assert.match(status.order.error, /WAN_CHALLENGE_MAPPING=manual/);
  assert.match(status.order.error, /WAN_EXTERNAL_PORT=443/, "or the one forward of 443 that serves both");
  assert.equal(status.error, status.order.error, "the listener's error, which yolo doctor shows");
  assert.ok(status.order.retryAt > Date.now() - 1, "the next try waits");
});

test("with the remote listener's router port on 443 the listener itself answers TLS-ALPN-01, and the origin has no port", async (t) => {
  const { wan, acme, challengeMapper } = await setup(t, { mediaExternalPort: 443 });
  const status = await wan.configure({ certificate: "ip", allowOrigin: PAGE, enabled: true, acmeDirectory: acme.directory });
  assert.deepEqual(acme.validations, [{ type: "tls-alpn-01", identifier: HOME, ok: true }]);
  assert.deepEqual(challengeMapper.calls, [], "no second router port");
  assert.equal(status.challenge.type, "tls-alpn-01");
  assert.equal(status.origin, `https://${HOME}`);
  const probe = await wanRequest(wan, acme.orders[0].chain, "/edge/probe", { host: HOME });
  assert.equal(probe.status, 200);
});
