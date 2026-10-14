import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { sealImageLink, YoloError } from "@useyolo/core";
import { createImageLinks, imageRef, serveImageLink } from "../../src/image-links.js";
import { handleMcpRequest } from "../../src/mcp/handler.js";
import { imageLinkVersion, RESET_ALL_IMAGE_LINKS_SQL, resetImageLinks } from "../../src/store/image-links.js";
import { createFakeNode, webSource } from "../helpers/fakes.js";
import { createTestControlPlane, onlineScreen, USER } from "../helpers/setup.js";

// Image links for agents (Agent Note 2026-10-07-remote-mcp-server): covers
// that ChatGPT or Claude load without a credential, from a link on Yolo's own
// origin that keeps working in old chats until the owner resets image links.

const SECRET = "test-node-secret-of-enough-length";
const ORIGIN = "https://yolo.example.com";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const ARTWORK = "/v1/library/items/library%3A42/artwork?variant=poster";
const WEB_IMAGE = "https://img.example/vi/1/hq.jpg";
const LINK = /^https:\/\/yolo\.example\.com\/i\/[A-Za-z0-9_-]+$/;

const linksFor = (db) => createImageLinks({ secret: SECRET, origin: ORIGIN, userId: USER, version: () => imageLinkVersion(db, USER, { fresh: true }) });

test("a thumbnail names a library item's artwork or an image on the web; nothing else can become a link", () => {
  assert.deepEqual(imageRef(ARTWORK), { kind: "artwork", itemId: "library:42", variant: "poster" });
  assert.deepEqual(imageRef("/v1/library/items/library%3A42/artwork"), { kind: "artwork", itemId: "library:42", variant: "poster" });
  assert.deepEqual(imageRef(WEB_IMAGE), { kind: "remote", url: WEB_IMAGE });
  assert.deepEqual(imageRef(`/v1/thumbnail?url=${encodeURIComponent(WEB_IMAGE)}`), { kind: "remote", url: WEB_IMAGE });
  for (const value of [
    null, 42, "", "/v1/me", "/v1/library/items/42/artwork", "/v1/library/items/library%3A42/artwork?variant=..%2Fx", "/m/token/p/0.m3u8",
    "/i/abc", "javascript:alert(1)", "file:///etc/passwd", "data:image/png;base64,AAAA", "ftp://img.example/v.jpg",
    "https://user:pw@img.example/v.jpg", `https://img.example/${"a".repeat(2100)}`, "//img.example/v.jpg", "img.example/v.jpg",
  ]) {
    assert.equal(imageRef(value), null, String(value));
  }
});

// A node whose library search, URL lookups, and streams carry thumbnails, as
// the real node's do.
function nodeWithImages() {
  return createFakeNode({
    "GET /internal/v1/health": () => ({ version: "0.5.0" }),
    "POST /internal/v1/claim": (body) => ({ source: webSource(body.url) }),
    "GET /internal/v1/library/search": (query) => ({
      results: [
        { id: "library:42", kind: "movie", title: `Result for ${query.q}`, thumbnail: ARTWORK },
        { id: "library:43", kind: "movie", title: "No picture", thumbnail: null },
        { id: "library:44", kind: "movie", title: "Not an image Yolo serves", thumbnail: "/v1/me" },
      ],
    }),
    "POST /internal/v1/metadata": (body) => {
      const source = body.source ?? webSource(body.url);
      return { source, title: "A video", thumbnail: WEB_IMAGE, duration: 600, isLive: false };
    },
    "GET /internal/v1/details": () => ({ title: "Movie 42", duration: 600 }),
    "GET /internal/v1/tracks": () => ({ subtitles: [], audio: [] }),
    "POST /internal/v1/prepare": (body) => ({
      sessionId: body.sessionId,
      delivery: { type: "hls", url: `/m/${body.sessionId}/p/0.m3u8` },
      title: "Movie 42",
      thumbnail: ARTWORK,
      duration: 600,
      isLive: false,
      startTime: body.startTime,
      tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
    }),
  });
}

async function connect(services, images) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", "localhost");
      return handleMcpRequest(new Request(url, { ...init, headers }), { services, scopes: ["read", "control", "manage"], images });
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const call = async (client, name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

test("agents get every thumbnail as an absolute link on Yolo's origin, the same one each time", async () => {
  const plane = createTestControlPlane({ node: nodeWithImages() });
  await onlineScreen(plane);
  const client = await connect(plane.services, linksFor(plane.db));

  const { results } = await call(client, "search", { query: "Alien" });
  const link = results[0].thumbnail;
  assert.match(link, LINK);
  assert.ok(!/library|artwork|poster|Alien/.test(link), link);
  assert.equal(results[1].thumbnail, null);
  // Not an image Yolo serves: no link, rather than one that would break.
  assert.equal(results[2].thumbnail, null);
  assert.equal((await call(client, "search", { query: "Alien" })).results[0].thumbnail, link);

  // A URL's own thumbnail, on another host, becomes a link too; the URL the
  // agent gave stays as it was.
  const url = "https://videos.example/watch?v=1";
  const [web] = (await call(client, "search", { query: url })).results;
  assert.equal(web.id, url);
  assert.match(web.thumbnail, LINK);
  assert.notEqual(web.thumbnail, link);

  // Nested items: what plays now, and the queue.
  await call(client, "play", { item_id: "library:42" });
  assert.equal((await call(client, "get_status")).playback.item.thumbnail, link);
  assert.equal((await call(client, "get_item")).thumbnail, link);
  await call(client, "queue_add", { url });
  assert.equal((await call(client, "queue_list"))[0].thumbnail, web.thumbnail);
  await client.close();

  // Without image links (as the player's /v1 sees results), thumbnails stay Yolo's own paths.
  const plain = await connect(plane.services);
  assert.equal((await call(plain, "search", { query: "Alien" })).results[0].thumbnail, ARTWORK);
  await plain.close();
});

function harness({ limit } = {}) {
  const plane = createTestControlPlane();
  const calls = [];
  let answer = () => new Response(PNG, { headers: { "content-type": "image/png" } });
  const services = {
    artwork: async (itemId, variant) => {
      calls.push(["artwork", itemId, variant]);
      return answer();
    },
    thumbnail: async (url) => {
      calls.push(["thumbnail", url]);
      if (new URL(url).hostname === "10.0.0.1") throw new YoloError("forbidden", "10.0.0.1 is not a public address");
      return answer();
    },
  };
  const env = { NODE_SECRET: SECRET, DB: plane.db, PUBLIC_ORIGIN: ORIGIN, ...(limit ? { IMAGE_LIMIT: limit } : {}) };
  const get = (url, init) => serveImageLink(new Request(url, init), env, { servicesFor: () => services });
  return {
    plane, calls, get, links: linksFor(plane.db),
    answerWith(fn) {
      answer = fn;
    },
  };
}

test("an image link serves the image without a credential, cached for good", async () => {
  const h = harness();
  const link = await h.links.link(ARTWORK);
  const response = await h.get(link);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  assert.deepEqual(h.calls, [["artwork", "library:42", "poster"]]);

  const head = await h.get(link, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);

  // An image on another host goes through the node's thumbnail fetch, with its guards.
  assert.equal((await h.get(await h.links.link(WEB_IMAGE))).status, 200);
  assert.deepEqual(h.calls.at(-1), ["thumbnail", WEB_IMAGE]);
  const refused = await h.get(await h.links.link("http://10.0.0.1/admin.png"));
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("cache-control"), "no-store");
});

test("a wrong signature, a tampered token, or a URL Yolo never signed is refused without reaching the node", async () => {
  const h = harness();
  const link = await h.links.link(ARTWORK);
  const token = link.slice(`${ORIGIN}/i/`.length);
  const flip = (at) => {
    const bytes = Buffer.from(token, "base64url");
    bytes[at] ^= 0x01;
    return `${ORIGIN}/i/${bytes.toString("base64url")}`;
  };
  const forged = [
    flip(5), // the signature
    flip(Buffer.from(token, "base64url").length - 1), // the sealed image
    flip(4), // the key version
    // An attacker's own image, sealed with another secret, or not sealed at all.
    `${ORIGIN}/i/${await sealImageLink("an attacker's secret of some length", 1, JSON.stringify([USER, "u", "https://evil.example/x.png"]))}`,
    `${ORIGIN}/i/${encodeURIComponent("https://evil.example/x.png")}`,
    `${ORIGIN}/i/${Buffer.from(JSON.stringify([USER, "u", "https://evil.example/x.png"])).toString("base64url")}`,
    // Even with Yolo's secret, a payload that names no image Yolo serves.
    `${ORIGIN}/i/${await sealImageLink(SECRET, 1, JSON.stringify([USER, "u", "file:///etc/passwd"]))}`,
    `${ORIGIN}/i/`,
  ];
  for (const url of forged) {
    const response = await h.get(url);
    assert.equal(response.status, 404, url);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await h.get(link, { method: "POST" })).status, 405);
  assert.deepEqual(h.calls, []);
});

test("resetting image links makes every earlier link fail and gives new ones", async () => {
  const h = harness();
  const before = await h.links.link(ARTWORK);
  assert.equal((await h.get(before)).status, 200);
  assert.deepEqual(await resetImageLinks(h.plane.db, USER, 5_000), { version: 2, resetAt: 5_000 });
  const old = await h.get(before);
  assert.equal(old.status, 410);
  assert.equal(old.headers.get("cache-control"), "no-store");
  const after = await linksFor(h.plane.db).link(ARTWORK);
  assert.notEqual(after, before);
  assert.equal((await h.get(after)).status, 200);

  // The operator's reset writes D1 directly; this isolate has version 2 in
  // its cache, and a link of the newer version makes it read again.
  h.plane.db.raw.exec(RESET_ALL_IMAGE_LINKS_SQL);
  const newest = await linksFor(h.plane.db).link(ARTWORK);
  assert.equal((await h.get(newest)).status, 200);
  assert.equal((await h.get(after)).status, 410);
});

test("only a picture passes: a node answer of another type is not served", async () => {
  const h = harness();
  h.answerWith(() => new Response("<svg onload=alert(1)>", { headers: { "content-type": "image/svg+xml" } }));
  const response = await h.get(await h.links.link(ARTWORK));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("an address over the image limit gets 429 before any work", async () => {
  const keys = [];
  const h = harness({ limit: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } });
  const response = await h.get(await h.links.link(ARTWORK), { headers: { "cf-connecting-ip": "203.0.113.9" } });
  assert.equal(response.status, 429);
  assert.deepEqual(keys, ["203.0.113.9"]);
  assert.deepEqual(h.calls, []);
});

test("the server and every tool that returns items tell agents to show the thumbnail link as it is and never invent one", async () => {
  const plane = createTestControlPlane({ node: nodeWithImages() });
  const client = await connect(plane.services, linksFor(plane.db));
  const instructions = client.getInstructions();
  assert.match(instructions, /thumbnail/);
  assert.match(instructions, /!\[/);
  assert.match(instructions, /never (?:make up|invent)/i);
  const { tools } = await client.listTools();
  for (const name of ["get_status", "search", "browse", "get_item", "queue_list", "playlist_get", "history"]) {
    const { description } = tools.find((tool) => tool.name === name);
    assert.match(description, /thumbnail[^.]*image/i, name);
    assert.match(description, /never invent/i, name);
  }
  await client.close();
});
