import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createThumbnails, isPublicAddress } from "../src/thumbnails.js";

// The node fetches web-video thumbnails for screens; the URL is not trusted
// (server-side request forgery).
const resolvesTo = (...addresses) => (hostname, options, callback) => {
  const all = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  if (options.all) callback(null, all);
  else callback(null, all[0].address, all[0].family);
};

test("only public http(s) addresses are fetched, before and after a redirect", async (t) => {
  for (const address of ["8.8.8.8", "2606:4700::6810:85e5", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(address), true, address);
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "64:ff9b::a00:1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  const thumbnails = createThumbnails({ lookup: resolvesTo("192.168.1.10") });
  for (const url of ["file:///etc/passwd", "ftp://img.test/a.jpg", "https://user:pass@img.test/a.jpg"]) await assert.rejects(thumbnails.get(url), { code: "invalid_request" }, url);
  for (const url of ["http://127.0.0.1/internal/v1/health", "http://169.254.169.254/latest/meta-data/", "http://2130706433/", "http://[::ffff:10.0.0.1]/", "https://img.test/a.jpg"]) {
    await assert.rejects(thumbnails.get(url), { code: "forbidden" }, url);
  }
  await assert.rejects(createThumbnails({ lookup: resolvesTo("8.8.8.8", "10.0.0.1") }).get("https://img.test/a.jpg"), { code: "forbidden" }, "one private answer is enough");

  const server = createServer((request, response) => (request.url === "/moved"
    ? response.writeHead(302, { location: "http://router.test/admin" }).end()
    : response.writeHead(200, { "content-type": "text/html" }).end("<script></script>")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const local = createThumbnails({ lookup: resolvesTo("192.168.1.1"), isPublic: (address) => address === "127.0.0.1" });
  await assert.rejects(local.get(`${origin}/moved`), { code: "forbidden" });
  await assert.rejects(local.get(`${origin}/page`), { code: "resolve_failed" }, "only an image");
});
