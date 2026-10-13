import { YoloError } from "@useyolo/core";

// In-memory stand-ins for the Hub's storage and WebSocket transport, and for
// the media node behind nodeFetch().

export function createMemoryStorage() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return structuredClone(map.get(key));
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
  };
}

export function createFakeTransport(connected = []) {
  const sent = [];
  const broadcasts = [];
  const closed = [];
  const online = new Set(connected);
  const waiters = new Map();
  return {
    sent,
    broadcasts,
    closed,
    online,
    waiters,
    close(deviceId, code, reason) {
      closed.push({ deviceId, code, reason });
      online.delete(deviceId);
    },
    // A socket of the device said hello (hub.js marks it, sends the welcome,
    // then wakes requests waiting for it).
    hello(deviceId) {
      online.add(deviceId);
      const waiting = waiters.get(deviceId) || [];
      waiters.delete(deviceId);
      for (const done of waiting) done(true);
    },
    waitForHello(deviceId, timeoutMs) {
      if (online.has(deviceId)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (said) => {
          clearTimeout(timer);
          resolve(said);
        };
        const timer = setTimeout(() => {
          waiters.set(deviceId, (waiters.get(deviceId) || []).filter((other) => other !== done));
          done(false);
        }, timeoutMs);
        waiters.set(deviceId, [...(waiters.get(deviceId) || []), done]);
      });
    },
    connectedDeviceIds: () => new Set(online),
    send(deviceId, message) {
      if (!online.has(deviceId)) return false;
      sent.push({ deviceId, message });
      return true;
    },
    broadcast(message) {
      broadcasts.push(message);
    },
  };
}

// Routes are keyed "METHOD /path", where `*` matches one path segment;
// handlers get (body or query, path).
export function createFakeNode(routes = {}) {
  const calls = [];
  const node = {
    calls,
    offline: false,
    routes: { ...routes },
    async request(path, { method = "GET", body, query } = {}) {
      calls.push({ method, path, body, query });
      if (node.offline) throw new YoloError("node_offline", "Media node is offline");
      const handler = node.routes[`${method} ${path}`] ?? Object.entries(node.routes).find(([key]) => (
        key.includes("*") && new RegExp(`^${key.replace(/[.?]/g, "\\$&").replace(/\*/g, "[^/]+")}$`).test(`${method} ${path}`)
      ))?.[1];
      if (!handler) throw new YoloError("not_found", `No fake route for ${method} ${path}`);
      return structuredClone(await handler(method === "GET" ? query : body, path));
    },
    get(path, query, options = {}) {
      return node.request(path, { ...options, query });
    },
    post(path, body = {}, options = {}) {
      return node.request(path, { ...options, method: "POST", body });
    },
  };
  return node;
}

// What the fake node's URL source answers when it claims a URL.
export const webSource = (url) => ({ plugin: "web", id: url.toLowerCase(), url });
const fakeTitle = (source) => (source.plugin === "library" ? `Movie ${source.id}` : "A video");

// A node with one node renderer ("legacy"), a library source ("library"), and a source that claims every
// URL ("web").
export function createDefaultNode() {
  return createFakeNode({
    "GET /internal/v1/health": () => ({ version: "0.2.0", legacy: { online: true } }),
    "GET /internal/v1/renderers": () => ({
      renderers: [{ id: "legacy", name: "Car", kind: "car", online: true, capabilities: { renderer: "external" } }],
    }),
    "POST /internal/v1/claim": (body) => ({ source: webSource(body.url) }),
    "POST /internal/v1/prepare": (body) => ({
      sessionId: body.sessionId,
      delivery: { type: "external", renderer: body.renderer },
      title: fakeTitle(body.source),
      duration: 600,
      isLive: false,
      startTime: body.startTime,
      tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
    }),
    "POST /internal/v1/metadata": (body) => {
      const source = body.source ?? webSource(body.url);
      return { source, title: fakeTitle(source), thumbnail: null, duration: 600, isLive: false };
    },
    "POST /internal/v1/sessions/*/control": () => ({ ok: true }),
    "POST /internal/v1/sessions/*/stop": () => ({ ok: true }),
    "GET /internal/v1/library": () => ({ libraries: [{ id: "library:1", title: "Movies", type: "movie" }] }),
    "GET /internal/v1/library/search": (query) => ({
      results: [{ id: "library:42", kind: "movie", title: `Result for ${query.q}` }],
    }),
  });
}
