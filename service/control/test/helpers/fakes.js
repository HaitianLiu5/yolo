import { YoloError } from "@useyolo/core";
import { HubCore } from "../../src/hub/hub-core.js";
import { createServices } from "../../src/services.js";
import { upsertDevice } from "../../src/store/devices.js";
import { createTestD1 } from "./d1.js";

// Stand-ins for the Hub's storage and sockets, Workers KV, and the media node
// behind nodeFetch(), and a control plane built from them over real D1.

export const USER = "usr_test";

export function createMemoryKv() {
  const map = new Map();
  return {
    map,
    get: async (key) => (map.has(key) ? map.get(key) : null),
    put: async (key, value) => void map.set(key, String(value)),
    delete: async (key) => void map.delete(key),
    // Pages of two, so callers follow the cursor.
    async list({ prefix = "", cursor } = {}) {
      const names = [...map.keys()].filter((key) => key.startsWith(prefix) && (!cursor || key > cursor)).sort();
      const keys = names.slice(0, 2).map((name) => ({ name }));
      return names.length <= 2 ? { keys, list_complete: true } : { keys, list_complete: false, cursor: keys.at(-1).name };
    },
  };
}

export function createMemoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => map.delete(key),
  };
}

// The Hub's sockets: `online` holds the devices that said hello.
export function createFakeTransport() {
  const online = new Set();
  const closed = [];
  return {
    online, closed,
    connectedDeviceIds: () => new Set(online),
    waitForHello: async (deviceId) => online.has(deviceId),
    send: (deviceId) => online.has(deviceId),
    broadcast: () => {},
    close: (deviceId, code, reason) => closed.push({ deviceId, code, reason }) && online.delete(deviceId),
  };
}

// Routes are keyed "METHOD /path", `*` matching one segment; a handler gets
// the body (or the query for GET). A raw request gets a Response of the
// handler's `body`, as nodeFetch() returns it.
export function createFakeNode(routes = {}) {
  const node = {
    calls: [], offline: false, routes: { ...routes },
    async request(path, { method = "GET", body, query, raw = false } = {}) {
      node.calls.push({ method, path, body, query });
      if (node.offline) throw new YoloError("node_offline", "Media node is offline");
      const key = `${method} ${path}`;
      const handler = node.routes[key] ?? Object.entries(node.routes)
        .find(([pattern]) => pattern.includes("*") && new RegExp(`^${pattern.replace(/\*/g, "[^/]+")}$`).test(key))?.[1];
      if (!handler) throw new YoloError("not_found", `No fake route for ${key}`);
      const result = await handler(method === "GET" ? query : body);
      return raw ? new Response(result.body) : structuredClone(result);
    },
    get: (path, query, options = {}) => node.request(path, { ...options, query }),
    post: (path, body = {}, options = {}) => node.request(path, { ...options, method: "POST", body }),
  };
  return node;
}

// A library source ("library"): its items' metadata and streams.
export const createDefaultNode = () => createFakeNode({
  "POST /internal/v1/metadata": ({ source }) => ({ source, title: `Movie ${source.id}`, duration: 600, isLive: false }),
  "POST /internal/v1/prepare": (body) => ({
    sessionId: body.sessionId, delivery: { type: "hls", url: `/m/${body.sessionId}/p/0.m3u8` }, title: `Movie ${body.source.id}`, duration: 600,
    isLive: false, startTime: body.startTime, tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
  }),
  "POST /internal/v1/sessions/*/*": () => ({ ok: true }),
});

// HubCore and the service layer over real migrations, with a settable clock.
export function createTestControlPlane({ node = createDefaultNode(), db = createTestD1() } = {}) {
  db.raw.prepare("INSERT OR IGNORE INTO users (id, user_id, display_name, created_at) VALUES (?, ?, 'Owner', 0)").run(USER, USER);
  const transport = createFakeTransport();
  const storage = createMemoryStorage();
  const logs = [];
  const log = (record) => logs.push(record);
  let clock = 1_000_000;
  const hub = new HubCore({ userId: USER, storage, db, node, transport, now: () => clock, log });
  const services = createServices({ db, userId: USER, hub, node, log });
  return { db, node, transport, hub, services, storage, logs, advance: (ms) => { clock += ms; } };
}

// A paired screen that said hello.
export async function onlineScreen(plane, { name = "Car", kind = "car", capabilities = {} } = {}) {
  const device = await upsertDevice(plane.db, USER, { name, kind, capabilities });
  plane.transport.online.add(device.id);
  return device;
}
