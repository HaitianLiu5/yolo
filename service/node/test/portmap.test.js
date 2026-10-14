import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { test } from "node:test";
import { createPortMapper } from "../src/portmap/index.js";
import { parseProcRoute, parseRouteGet } from "../src/portmap/gateway.js";

// The router port mapping of remote direct play
// (Agent Note 2026-10-13-media-off-the-worker) against fake routers on
// loopback: NAT-PMP and PCP on a UDP port, UPnP IGD as an SSDP responder and
// an HTTP server.

const PUBLIC = "73.63.154.63";
const FAST = { delays: [20, 40] };

// A router on UDP that speaks PCP and NAT-PMP, NAT-PMP only, or neither.
async function udpRouter(t, { pcp = false, natpmp = true } = {}) {
  const socket = createSocket("udp4");
  const requests = [];
  socket.on("message", (buffer, from) => {
    const reply = (message) => socket.send(message, from.port, from.address);
    if (buffer[0] === 2) {
      const request = { protocol: "pcp", lifetime: buffer.readUInt32BE(4), nonce: buffer.subarray(24, 36).toString("hex"), internalPort: buffer.readUInt16BE(40), externalPort: buffer.readUInt16BE(42) };
      requests.push(request);
      if (!pcp) {
        if (natpmp) reply(Buffer.from([0, 0x80 | buffer[1], 0, 1, 0, 0, 0, 0]));
        return;
      }
      const answer = Buffer.alloc(60);
      answer[0] = 2;
      answer[1] = 0x81;
      answer.writeUInt32BE(request.lifetime, 4);
      buffer.copy(answer, 24, 24, 36);
      answer[36] = 6;
      answer.writeUInt16BE(request.internalPort, 40);
      answer.writeUInt16BE(request.lifetime ? request.externalPort : 0, 42);
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, ...PUBLIC.split(".").map(Number)]).copy(answer, 44);
      reply(answer);
      return;
    }
    if (!natpmp || buffer[0] !== 0) return;
    if (buffer[1] === 0) {
      requests.push({ protocol: "natpmp", op: "address" });
      reply(Buffer.from([0, 128, 0, 0, 0, 0, 0, 1, ...PUBLIC.split(".").map(Number)]));
      return;
    }
    const request = { protocol: "natpmp", op: "map", internalPort: buffer.readUInt16BE(4), externalPort: buffer.readUInt16BE(6), lifetime: buffer.readUInt32BE(8) };
    requests.push(request);
    const answer = Buffer.alloc(16);
    answer[1] = 130;
    answer.writeUInt16BE(request.internalPort, 8);
    answer.writeUInt16BE(request.lifetime ? request.externalPort : 0, 10);
    answer.writeUInt32BE(request.lifetime, 12);
    reply(answer);
  });
  await new Promise((done) => socket.bind(0, "127.0.0.1", done));
  t.after(() => socket.close());
  return { port: socket.address().port, requests };
}

// A UPnP IGD: an SSDP responder and the description and control URLs.
async function upnpRouter(t, { permanentOnly = false } = {}) {
  const calls = [];
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url === "/desc.xml") {
        res.end(`<?xml version="1.0"?><root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>`);
        return;
      }
      const action = /#(\w+)"/.exec(req.headers.soapaction || "")?.[1];
      const lease = Number(/<NewLeaseDuration>(\d+)</.exec(body)?.[1]);
      calls.push({ action, lease: Number.isFinite(lease) ? lease : null, client: /<NewInternalClient>([^<]*)</.exec(body)?.[1] ?? null });
      if (action === "AddPortMapping" && permanentOnly && lease !== 0) {
        res.writeHead(500, { "content-type": "text/xml" });
        res.end("<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>725</errorCode><errorDescription>OnlyPermanentLeasesSupported</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>");
        return;
      }
      res.end(action === "GetExternalIPAddress" ? `<s:Envelope><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>${PUBLIC}</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>` : "<s:Envelope><s:Body/></s:Envelope>");
    });
  });
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const ssdp = createSocket("udp4");
  ssdp.on("message", (buffer, from) => {
    if (!buffer.toString().startsWith("M-SEARCH")) return;
    // Another device's answer first: its description is never fetched.
    ssdp.send(Buffer.from("HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.9:1/desc.xml\r\n\r\n"), from.port, from.address);
    ssdp.send(Buffer.from(`HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:${http.address().port}/desc.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n`), from.port, from.address);
  });
  await new Promise((done) => ssdp.bind(0, "127.0.0.1", done));
  t.after(async () => {
    ssdp.close();
    http.closeAllConnections();
    await new Promise((done) => http.close(done));
  });
  return { ssdpPort: ssdp.address().port, calls };
}

const mapper = (transport, options = {}) => createPortMapper({
  gateway: "127.0.0.1", internalPort: 9444, externalPort: 9444, transport: { ...FAST, ssdpAddress: "127.0.0.1", ...transport }, setTimer: () => null, ...options,
});

test("a router that speaks only NAT-PMP gets a NAT-PMP mapping, renewed on the same port and removed on close", async (t) => {
  const router = await udpRouter(t, { natpmp: true });
  const ports = mapper({ port: router.port });
  await ports.map("127.0.0.1");
  assert.deepEqual({ ...ports.status(), expiresAt: undefined }, { mode: "auto", gateway: "127.0.0.1", method: "natpmp", externalAddress: PUBLIC, externalPort: 9444, requestedPort: 9444, expiresAt: undefined, error: null });
  await ports.refresh();
  await ports.unmap();
  const maps = router.requests.filter((request) => request.op === "map");
  assert.equal(router.requests[0].protocol, "pcp", "PCP is asked first");
  assert.deepEqual(maps.map(({ externalPort, lifetime }) => [externalPort, lifetime]), [[9444, 7200], [9444, 7200], [0, 0]]);
  assert.equal(ports.status().method, null);
});

test("PCP comes first, and its mapping is deleted with the nonce that made it", async (t) => {
  const router = await udpRouter(t, { pcp: true });
  const ports = mapper({ port: router.port });
  await ports.map("127.0.0.1");
  assert.equal(ports.status().method, "pcp");
  assert.equal(ports.status().externalAddress, PUBLIC);
  await ports.unmap();
  const [made, removed] = router.requests;
  assert.equal(removed.lifetime, 0);
  assert.equal(removed.nonce, made.nonce);
  assert.ok(router.requests.every((request) => request.protocol === "pcp"));
});

test("UPnP IGD maps when the router has no NAT-PMP or PCP, permanently where it allows only that, and only on the gateway", async (t) => {
  const silent = await udpRouter(t, { natpmp: false });
  const upnp = await upnpRouter(t, { permanentOnly: true });
  const ports = mapper({ port: silent.port, ssdpPort: upnp.ssdpPort });
  await ports.map("127.0.0.1");
  assert.equal(ports.status().method, "upnp");
  assert.equal(ports.status().externalAddress, PUBLIC);
  await ports.unmap();
  assert.deepEqual(upnp.calls.map(({ action, lease }) => [action, lease]), [["AddPortMapping", 7200], ["AddPortMapping", 0], ["GetExternalIPAddress", null], ["DeletePortMapping", null]]);
  assert.equal(upnp.calls[1].client, "127.0.0.1");
});

test("a router that maps nothing leaves the owner a manual forward, and manual mode sends the router nothing", async (t) => {
  const silent = await udpRouter(t, { natpmp: false });
  const ports = mapper({ port: silent.port, ssdpPort: silent.port });
  assert.equal(await ports.map("127.0.0.1"), null);
  assert.match(ports.status().error, /Forward TCP port 9444 .* port 9444 on the router and set WAN_MAPPING=manual/);

  const manual = mapper({ port: silent.port }, { mode: "manual", externalPort: 443 });
  const before = silent.requests.length;
  await manual.map("127.0.0.1");
  assert.equal(manual.status().method, "manual");
  assert.equal(manual.status().externalPort, 443);
  await manual.unmap();
  assert.equal(silent.requests.length, before);
});

test("the default gateway comes from the routing table", () => {
  assert.equal(parseProcRoute("Iface\tDestination\tGateway\tFlags\nwlan0\t0032A8C0\t00000000\t0001\neth0\t00000000\t0132A8C0\t0003\n"), "192.168.50.1");
  assert.equal(parseRouteGet("   route to: default\ndestination: default\n    gateway: 192.168.50.1\n  interface: en0\n"), "192.168.50.1");
  assert.equal(parseRouteGet("route: writing to routing socket: not in table"), null);
});
