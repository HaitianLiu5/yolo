import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { signNodeRequest } from "@useyolo/core";
import { createNodeApp } from "../src/app.js";
import { loadPlugins } from "../src/plugins.js";
import { createThumbnails, isPublicAddress } from "../src/thumbnails.js";

// The node fetches web-video thumbnails for screens, so no image server sees
// a screen's address; the URL is not trusted (server-side request forgery).

// A name that resolves to `addresses`, whatever the name.
const resolvesTo = (...addresses) => (hostname, options, callback) => {
  const all = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  if (options.all) callback(null, all);
  else callback(null, all[0].address, all[0].family);
};

// An image server on loopback; `isPublic` lets the tests reach it.
async function imageServer(t, routes) {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(request.url);
    routes[request.url]?.(request, response) ?? response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
}

test("only public addresses are fetched", () => {
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::6810:85e5", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fd00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "not an address",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("a thumbnail URL that is not public http(s) is refused before any connection", async () => {
  const thumbnails = createThumbnails({ lookup: resolvesTo("192.168.1.10") });
  for (const url of ["file:///etc/passwd", "ftp://img.test/a.jpg", "https://user:pass@img.test/a.jpg", `https://img.test/${"a".repeat(2050)}`]) {
    await assert.rejects(thumbnails.get(url), { code: "invalid_request" }, url);
  }
  for (const url of [
    "http://127.0.0.1/internal/v1/health", "http://[::1]/", "http://169.254.169.254/latest/meta-data/",
    "http://2130706433/", "http://[::ffff:10.0.0.1]/", "https://img.test/a.jpg",
  ]) {
    await assert.rejects(thumbnails.get(url), { code: "forbidden" }, url);
  }
  // One private answer among public ones is enough to refuse the name.
  await assert.rejects(createThumbnails({ lookup: resolvesTo("8.8.8.8", "10.0.0.1") }).get("https://img.test/a.jpg"), { code: "forbidden" });
});

test("a redirect is checked like the first URL", async (t) => {
  const { origin } = await imageServer(t, {
    "/moved": (request, response) => response.writeHead(302, { location: "http://router.test/admin" }).end(),
  });
  const thumbnails = createThumbnails({ lookup: resolvesTo("192.168.1.1"), isPublic: (address) => address === "127.0.0.1" });
  await assert.rejects(thumbnails.get(`${origin}/moved`), { code: "forbidden" });
});

test("an image is fetched once, within the size cap and the time limit, and only as an image", async (t) => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const { origin, hits } = await imageServer(t, {
    "/a.jpg": (request, response) => response.writeHead(200, { "content-type": "image/jpeg" }).end(jpeg),
    "/b.jpg": (request, response) => response.writeHead(301, { location: "/a.jpg" }).end(),
    "/page": (request, response) => response.writeHead(200, { "content-type": "text/html" }).end("<script></script>"),
    "/vector": (request, response) => response.writeHead(200, { "content-type": "image/svg+xml" }).end("<svg/>"),
    "/big": (request, response) => response.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(2048)),
    "/slow": (request, response) => response.writeHead(200, { "content-type": "image/png" }),
  });
  const thumbnails = createThumbnails({ isPublic: (address) => address === "127.0.0.1", maxBytes: 1024, timeoutMs: 300 });
  assert.deepEqual(await thumbnails.get(`${origin}/a.jpg`), { type: "image/jpeg", body: jpeg });
  assert.deepEqual(await thumbnails.get(`${origin}/a.jpg`), { type: "image/jpeg", body: jpeg });
  assert.deepEqual(await thumbnails.get(`${origin}/b.jpg`), { type: "image/jpeg", body: jpeg });
  assert.deepEqual(hits, ["/a.jpg", "/b.jpg", "/a.jpg"]);
  for (const path of ["/page", "/vector", "/big", "/slow", "/missing"]) {
    await assert.rejects(thumbnails.get(`${origin}${path}`), { code: "resolve_failed" }, path);
  }
});

test("/internal/v1/thumbnail refuses what is not a public http(s) image", async () => {
  const app = createNodeApp({ secret: "s", plugins: await loadPlugins([]) });
  const call = async (url) => {
    const path = `/internal/v1/thumbnail?${new URLSearchParams({ url })}`;
    const response = await app.request(path, { headers: await signNodeRequest("s", { method: "GET", path }) });
    return [response.status, (await response.json()).error.code];
  };
  assert.deepEqual(await call("http://10.0.0.1/a.jpg"), [403, "forbidden"]);
  assert.deepEqual(await call("file:///etc/passwd"), [400, "invalid_request"]);
});
