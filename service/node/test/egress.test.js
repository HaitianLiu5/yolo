import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { after, test } from "node:test";
import { createEgress, RENEW_BEFORE_MS, RETRY_FAILED_MS } from "../src/egress/egress.js";
import { readEgress, routesFor } from "../src/egress/rules.js";
import { loadPlugins } from "../src/plugins.js";

// The node's egress layer (Agent Note 2026-10-13-node-egress-proxy): hosts a
// rule matches go through the proxies it lists, everything else direct, for
// the node's own requests and its child processes alike.

const servers = [];
async function listen(server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
after(() => Promise.all(servers.map((server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(() => resolve());
}))));

// The site: answers with the Host it was asked for.
const site = await listen(createServer((request, response) => response.end(`site ${request.headers.host}`)));

// An HTTP proxy that takes only `password`, and records what it was asked.
function fakeProxy({ password }) {
  const proxy = { hits: [], password };
  const allowed = (request) => request.headers["proxy-authorization"] === `Basic ${Buffer.from(`owner:${proxy.password}`).toString("base64")}`;
  const server = createServer((request, response) => {
    proxy.hits.push({ method: request.method, target: request.url, allowed: allowed(request) });
    if (!allowed(request)) return void response.writeHead(407).end();
    const target = new URL(request.url);
    httpRequest({ host: "127.0.0.1", port: target.port, path: target.pathname, headers: request.headers }, (answer) => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    }).end();
  });
  server.on("connect", (request, client) => {
    proxy.hits.push({ method: "CONNECT", target: request.url, allowed: allowed(request) });
    if (!allowed(request)) return void client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    const upstream = connect(Number(request.url.split(":").pop()), "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  proxy.ready = listen(server).then((port) => {
    proxy.port = port;
    return proxy;
  });
  return proxy;
}

const quiet = () => {
  const lines = [];
  const log = (fields, message) => lines.push(`${message} ${JSON.stringify(fields)}`);
  return { lines, logger: { debug: log, info: log, warn: log, error: log } };
};

// An egress layer whose "abroad" proxy is `proxy`, with a provider that
// hands out `passwords` in turn, and `rules`.
function egressWith(proxy, rules, { passwords = [proxy.password], fail = false, now, expiresAt } = {}) {
  const asked = [];
  const { lines, logger } = quiet();
  const egress = createEgress({ config: { proxies: { abroad: { provider: "fixed", options: { region: "far" } } }, rules }, logger, now });
  egress.registerProvider("fixed", {
    endpoint(options, { refused }) {
      asked.push({ options, refused });
      if (fail) throw new Error("no line today");
      return { url: `http://127.0.0.1:${proxy.port}`, username: "owner", password: passwords[Math.min(asked.length - 1, passwords.length - 1)], expiresAt };
    },
  }, "test");
  return { egress, asked, lines };
}

test("rules: the first matching rule gives the routes, a wildcard matches subdomains only, and other hosts go direct", () => {
  const egress = readEgress({
    proxies: { abroad: { provider: "fixed" } },
    rules: [
      { hosts: ["api.video.example"], via: ["direct"] },
      { hosts: ["*.video.example", "video.example"], via: ["abroad"] },
      { hosts: ["*.cdn.example"], via: ["direct", "abroad"] },
    ],
  });
  assert.deepEqual(routesFor(egress, "https://api.video.example/play"), ["direct"]);
  assert.deepEqual(routesFor(egress, "https://www.video.example/play"), ["abroad"]);
  assert.deepEqual(routesFor(egress, "video.example"), ["abroad"]);
  assert.deepEqual(routesFor(egress, "https://notvideo.example/"), ["direct"]);
  assert.deepEqual(routesFor(egress, "https://a.b.cdn.example:8443/x"), ["direct", "abroad"]);
  assert.deepEqual(routesFor(readEgress(null), "https://www.video.example/"), ["direct"]);
});

test("rules: a route that names no proxy, a proxy named direct, or a malformed host is refused at startup", () => {
  assert.throws(() => readEgress({ rules: [{ hosts: ["a.example"], via: ["abroad"] }] }), /"abroad" is not "direct" or a name/);
  assert.throws(() => readEgress({ proxies: { direct: { provider: "fixed" } } }), /not "direct"/);
  assert.throws(() => readEgress({ proxies: { abroad: { provider: "fixed" } }, rules: [{ hosts: ["https://a.example/"], via: ["abroad"] }] }), /hosts must list host names/);
  assert.throws(() => readEgress({ proxies: { abroad: {} } }), /must name a proxy provider/);
});

test("without rules the egress layer is the plain fetch and starts no listener", async () => {
  const egress = createEgress();
  assert.equal(egress.fetch, globalThis.fetch);
  await egress.start();
  assert.equal(egress.proxyUrl(), null);
  assert.equal(egress.status(), null);
});

test("fetch sends a matched host through its proxy with the provider's credentials and an unmatched host direct", async () => {
  const proxy = await fakeProxy({ password: "first" }).ready;
  const { egress, asked } = egressWith(proxy, [{ hosts: ["localhost"], via: ["abroad"] }]);
  assert.equal(await (await egress.fetch(`http://localhost:${site}/a`)).text(), `site localhost:${site}`);
  assert.equal(await (await egress.fetch(`http://localhost:${site}/b`)).text(), `site localhost:${site}`);
  assert.equal(await (await egress.fetch(`http://127.0.0.1:${site}/c`)).text(), `site 127.0.0.1:${site}`);
  assert.ok(proxy.hits.length >= 1 && proxy.hits.every((hit) => hit.allowed && hit.target.includes(`localhost:${site}`)), JSON.stringify(proxy.hits));
  assert.deepEqual(asked, [{ options: { region: "far" }, refused: false }], "the endpoint is asked for once and reused");
  assert.equal(egress.status().proxies.abroad.status, "ready");
  await egress.close();
});

test("a proxy that refuses the credentials makes the node ask its provider again, once", async () => {
  const proxy = await fakeProxy({ password: "second" }).ready;
  const { egress, asked, lines } = egressWith(proxy, [{ hosts: ["localhost"], via: ["abroad"] }], { passwords: ["first", "second"] });
  assert.equal((await egress.fetch(`http://localhost:${site}/`)).status, 200);
  assert.deepEqual(asked.map(({ refused }) => refused), [false, true]);
  assert.ok(lines.every((line) => !line.includes("first") && !line.includes("second")), "no log line carries a password");
  await egress.close();
});

test("a proxy-only host never goes direct when its proxy is unavailable, while a host that also lists direct does", async () => {
  const proxy = await fakeProxy({ password: "first" }).ready;
  const { egress, lines } = egressWith(proxy, [
    { hosts: ["localhost"], via: ["abroad"] },
    { hosts: ["127.0.0.1"], via: ["abroad", "direct"] },
  ], { fail: true });
  await assert.rejects(egress.fetch(`http://localhost:${site}/`), (error) => error.code === "EGRESS_PROXY_UNAVAILABLE" && /abroad is unavailable: no line today/.test(error.message));
  assert.equal(await (await egress.fetch(`http://127.0.0.1:${site}/`)).text(), `site 127.0.0.1:${site}`);
  assert.equal(proxy.hits.length, 0);
  assert.ok(lines.some((line) => line.includes("Egress route failed")));
  assert.equal(egress.status().proxies.abroad.status, "unavailable");
  await egress.close();
});

test("an endpoint is asked for again shortly before it expires", async () => {
  const proxy = await fakeProxy({ password: "first" }).ready;
  let clock = 1_000_000;
  const { egress, asked } = egressWith(proxy, [{ hosts: ["localhost"], via: ["abroad"] }], { now: () => clock, expiresAt: 1_000_000 + 10 * 60_000 });
  await (await egress.fetch(`http://localhost:${site}/`)).text();
  clock += 10 * 60_000 - RENEW_BEFORE_MS + 1;
  await (await egress.fetch(`http://localhost:${site}/`)).text();
  assert.equal(asked.length, 2);
  await egress.close();
});

// A request through the loopback listener as a child process makes it:
// CONNECT host:port, then plain HTTP over the tunnel.
function throughListener(listener, host, port) {
  return new Promise((resolve, reject) => {
    const { port: listenerPort } = new URL(listener);
    const request = httpRequest({ host: "127.0.0.1", port: listenerPort, method: "CONNECT", path: `${host}:${port}` });
    request.once("connect", (response, socket) => {
      if (response.statusCode !== 200) return resolve({ status: response.statusCode });
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
      let body = "";
      socket.on("data", (chunk) => { body += chunk; });
      socket.once("close", () => resolve({ status: 200, body: body.split("\r\n\r\n").pop() }));
    });
    request.once("error", reject);
    request.end();
  });
}

test("the loopback listener tunnels a matched host through the proxy and every other host direct", async () => {
  const proxy = await fakeProxy({ password: "second" }).ready;
  const { egress } = egressWith(proxy, [{ hosts: ["localhost"], via: ["abroad"] }], { passwords: ["first", "second"] });
  await egress.start();
  const listener = egress.proxyUrl();
  assert.match(listener, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(egress.proxyFor(`https://localhost:${site}/a.mp4`), listener);
  assert.equal(egress.proxyFor(`https://127.0.0.1:${site}/a.mp4`), null);

  assert.deepEqual(await throughListener(listener, "localhost", site), { status: 200, body: `site localhost:${site}` });
  assert.deepEqual(proxy.hits.map(({ method, allowed }) => [method, allowed]), [["CONNECT", false], ["CONNECT", true]], "a refused endpoint is renewed once");
  assert.deepEqual(await throughListener(listener, "127.0.0.1", site), { status: 200, body: `site 127.0.0.1:${site}` });
  assert.equal(proxy.hits.length, 2, "an unmatched host never reaches the proxy");

  // Plain HTTP with an absolute URL, as a child process sends an http:// request.
  const plain = await new Promise((resolve, reject) => {
    httpRequest({ host: "127.0.0.1", port: new URL(listener).port, path: `http://localhost:${site}/plain` }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(body));
    }).once("error", reject).end();
  });
  assert.equal(plain, `site localhost:${site}`);
  assert.equal(proxy.hits.at(-1).method, "CONNECT");
  await egress.close();
  assert.equal(egress.proxyUrl(), null);
});

test("plugins register proxy providers and fetch through the egress layer; a plugin that fails to start takes its provider away", async () => {
  const proxy = await fakeProxy({ password: "first" }).ready;
  const egress = createEgress({ config: { proxies: { abroad: { provider: "fixed" } }, rules: [{ hosts: ["localhost"], via: ["abroad"] }] }, logger: quiet().logger });
  let pluginFetch;
  const host = await loadPlugins([
    { name: "provider", factory: (yolo) => yolo.registerProxyProvider("fixed", { endpoint: () => ({ url: `http://owner:first@127.0.0.1:${proxy.port}` }) }) },
    { name: "user", factory: (yolo) => { pluginFetch = yolo.fetch; } },
    { name: "broken", factory: (yolo) => { yolo.registerProxyProvider("broken", { endpoint: () => null }); yolo.on("start", () => { throw new Error("no"); }); } },
  ], { egress, logger: quiet().logger });
  await host.start();
  assert.equal(await (await pluginFetch(`http://localhost:${site}/`)).text(), `site localhost:${site}`);
  assert.equal(proxy.hits.at(-1).allowed, true);
  assert.deepEqual(host.status().find(({ name }) => name === "provider").proxyProviders, ["fixed"]);
  assert.equal(egress.hasProvider("broken"), false);
  assert.throws(() => egress.registerProvider("fixed", { endpoint() {} }), /already registered/);
  await egress.close();
});

// A provider with two lines: the first is `dead`, the second `proxy`; it
// hands out the second once the node says the first failed.
function egressWithLines(dead, proxy, rules, { now } = {}) {
  const asked = [];
  const { lines, logger } = quiet();
  const egress = createEgress({ config: { proxies: { abroad: { provider: "lines" } }, rules }, logger, now });
  egress.registerProvider("lines", {
    endpoint(options, context) {
      asked.push(context);
      const port = asked.some(({ failed }) => failed) ? proxy.port : dead.port;
      return { url: `http://127.0.0.1:${port}`, username: "owner", password: proxy.password };
    },
  }, "test");
  return { egress, asked, lines };
}

// A port nothing listens on.
async function closedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return { port };
}

// A proxy that answers every CONNECT with 502, as a line that lost its upstream does.
async function badGateway() {
  const server = createServer((request, response) => response.writeHead(502).end());
  server.on("connect", (request, client) => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  return { port: await listen(server) };
}

test("a proxy that cannot be reached makes the node ask its provider with failed, and the request goes on through the new endpoint", async () => {
  const proxy = await fakeProxy({ password: "first" }).ready;
  const { egress, asked } = egressWithLines(await closedPort(), proxy, [{ hosts: ["localhost"], via: ["abroad"] }]);
  assert.equal(await (await egress.fetch(`http://localhost:${site}/`)).text(), `site localhost:${site}`);
  assert.deepEqual(asked, [{ refused: false, failed: false }, { refused: false, failed: true }]);
  assert.equal(await (await egress.fetch(`http://localhost:${site}/again`)).text(), `site localhost:${site}`);
  assert.equal(asked.length, 2, "the new endpoint is reused");
  await egress.close();
});

test("a proxy that answers CONNECT with 502 makes the loopback listener move to the provider's next endpoint", async () => {
  const proxy = await fakeProxy({ password: "first" }).ready;
  const { egress, asked } = egressWithLines(await badGateway(), proxy, [{ hosts: ["localhost"], via: ["abroad"] }]);
  await egress.start();
  assert.deepEqual(await throughListener(egress.proxyUrl(), "localhost", site), { status: 200, body: `site localhost:${site}` });
  assert.deepEqual(asked.map(({ failed }) => failed), [false, true]);
  await egress.close();
});

test("a failed proxy is not retried with the same endpoint, and its provider is asked again only after a pause", async () => {
  const dead = await closedPort();
  let clock = 1_000_000;
  const { egress, asked } = egressWithLines(dead, dead, [{ hosts: ["localhost"], via: ["abroad"] }], { now: () => clock });
  await assert.rejects(egress.fetch(`http://localhost:${site}/`), /Through the egress proxy abroad/);
  assert.equal(asked.length, 2);
  await assert.rejects(egress.fetch(`http://localhost:${site}/`), /Through the egress proxy abroad/);
  assert.equal(asked.length, 2, "a second failure within the pause does not ask");
  clock += RETRY_FAILED_MS;
  await assert.rejects(egress.fetch(`http://localhost:${site}/`), /Through the egress proxy abroad/);
  assert.equal(asked.length, 3);
  await egress.close();
});
