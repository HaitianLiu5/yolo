import { createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { resolve } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { errorBody, YoloError } from "@useyolo/core";
import { certificateRequest, requestPem } from "./lan-csr.js";
import { silentLogger } from "./log.js";

// The node's media listeners (Agent Note 2026-10-13-media-off-the-worker):
// HTTPS under a name in the owner's zone that the control plane points at
// the listener's address, with a certificate the control plane obtains by
// ACME DNS-01 for the node's own key. Two use this module: `lan` (lan.js),
// on the private address for devices at home, and `wan` (wan.js), on the
// address the router forwards from the internet.
//
// A listener serves `GET`/`HEAD` under `/m/{token}/…` through the media
// pipeline, CORS preflights, and `GET /edge/probe`, and nothing else; the
// internal API stays on the loopback listener and owner pairing codes on the
// Unix socket. The media token in the path is the only credential. A request
// whose Host or TLS server name is not the listener's own name gets 421.

export const NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const EXPOSED_HEADERS = "Content-Range, Accept-Ranges, Content-Length, ETag, X-Yolo-Error-Code";
const ALLOWED_REQUEST_HEADERS = "Range";

export function originOf(value) {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol) || url.origin !== String(value).replace(/\/$/, "")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// The chain's leaf: its validity and whether it is for `name` and `key`.
function inspectChain(chain, { name, privateKey }) {
  let leaf;
  try {
    leaf = new X509Certificate(chain);
  } catch {
    throw new YoloError("invalid_request", "The certificate chain is not PEM");
  }
  if (!leaf.checkPrivateKey(privateKey)) throw new YoloError("invalid_request", "The certificate is for another key");
  if (leaf.checkHost(name, { wildcards: false }) !== name) throw new YoloError("invalid_request", `The certificate does not name ${name}`);
  return { notBefore: new Date(leaf.validFrom).getTime(), notAfter: new Date(leaf.validTo).getTime() };
}

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

// Headers on every answer: CORS for the control plane's page, readable
// ranges and typed errors, COEP-compatible, and never a document.
function edgeHeaders(response, allowOrigin) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", allowOrigin);
  headers.set("access-control-expose-headers", EXPOSED_HEADERS);
  headers.set("timing-allow-origin", allowOrigin);
  headers.set("cross-origin-resource-policy", "cross-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.append("vary", "Origin");
  if (/html|xml/i.test(headers.get("content-type") || "")) headers.set("content-type", "application/octet-stream");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * One listener's HTTP app.
 * @param {object} options
 * @param {"lan"|"wan"} options.path
 * @param {() => { name: string|null, hosts: string[], allowOrigin: string|null }} options.config
 * @param {(address: string) => YoloError | null} [options.refusePeer]  why a peer may not use the listener
 * @param {(answer: { peer, method, media, status, ms, bytes }) => void} [options.onAnswer]  after each answer
 * @param {boolean} [options.lanProbe]  also answer the probe at /lan/probe, its path for players before 0.5
 */
export function createEdgeApp({ path, config, media, refusePeer = () => null, onAnswer = () => {}, lanProbe = false, now = () => Date.now() }) {
  const app = new Hono();
  app.onError(() => json(500, errorBody(new YoloError("internal", "Media request failed"))));
  app.use("*", async (c, next) => {
    const startedAt = now();
    const peer = String((c.env?.incoming ? getConnInfo(c).remote.address : null) || "").replace(/^::ffff:/, "");
    const { name, hosts, allowOrigin } = config();
    // Only this name, in the Host header and in TLS: a DNS rebinding page
    // and a scanner that connects by address reach no handler.
    const host = String(c.req.header("host") || new URL(c.req.url).host).toLowerCase();
    const servername = c.env?.incoming?.socket?.servername;
    let refusal = null;
    if (!name || !hosts.includes(host) || (servername !== undefined && servername !== name)) {
      refusal = json(421, errorBody(new YoloError("invalid_request", "This listener serves only its own name")));
    } else {
      const refused = refusePeer(peer);
      if (refused) refusal = json(refused.status, errorBody(refused));
    }
    if (refusal) {
      c.res = refusal;
    } else {
      await next();
      c.res = edgeHeaders(c.res, allowOrigin);
    }
    const length = Number(c.res.headers.get("content-length"));
    onAnswer({
      peer, method: c.req.method, media: c.req.path.startsWith("/m/"), status: c.res.status, ms: now() - startedAt, bytes: Number.isFinite(length) ? length : null,
    });
    return c.res;
  });
  const preflight = () => new Response(null, {
    status: 204,
    headers: { "access-control-allow-methods": "GET, HEAD", "access-control-allow-headers": ALLOWED_REQUEST_HEADERS, "access-control-max-age": "600", vary: "Access-Control-Request-Headers" },
  });
  app.options("/edge/probe", preflight);
  app.get("/edge/probe", () => json(200, { ok: true, name: config().name, path }));
  if (lanProbe) {
    app.options("/lan/probe", preflight);
    app.get("/lan/probe", () => json(200, { ok: true, name: config().name }));
  }
  app.all("/m/*", (c) => (c.req.method === "OPTIONS" ? preflight() : media.handle(c.req.raw)));
  app.notFound(() => json(404, errorBody(new YoloError("not_found", "No such endpoint on this listener"))));
  return app;
}

/**
 * A media listener's name, key, certificate, and servers.
 * @param {object} options
 * @param {"lan"|"wan"} options.path
 * @param {string} options.dir  key.pem, chain.pem, and state.json
 * @param {number} options.port  0 turns the listener off
 * @param {() => string[]} options.addresses  where to listen now
 * @param {(name: string) => string[]} [options.hosts]  Host values the listener answers
 * @param {(name: string) => string} [options.origin]  the origin devices use
 * @param {(server, config: () => object) => void} [options.tune]  limits on each server (wan.js)
 * @param {(config: () => object) => object} [options.serverOptions]  HTTP and TLS server options of each server
 * @param {object} [options.contextOptions]  TLS context options, kept when a new certificate is swapped in
 */
export function createEdgeListener({
  path,
  dir,
  port,
  addresses,
  media,
  hosts = (name) => [name, `${name}:${port}`],
  origin = (name) => `https://${name}${port === 443 ? "" : `:${port}`}`,
  refusePeer,
  onAnswer,
  lanProbe = false,
  tune = () => {},
  serverOptions = () => ({}),
  contextOptions = {},
  logger = silentLogger,
  now = () => Date.now(),
  createServer = createHttpsServer,
}) {
  const files = { state: resolve(dir, "state.json"), key: resolve(dir, "key.pem"), chain: resolve(dir, "chain.pem") };
  let config = { name: null, allowOrigin: null, enabled: true };
  let privateKey = null;
  let chain = null;
  let validity = null;
  let error = null;
  let pending = Promise.resolve();
  const servers = new Map();
  const errors = new Map();

  const write = (file, text, mode = 0o600) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, text, { mode });
    renameSync(`${file}.tmp`, file);
  };

  const keyPem = () => privateKey.export({ type: "pkcs8", format: "pem" });
  const valid = () => Boolean(chain && validity && validity.notAfter > now());
  const current = () => ({ name: config.name, hosts: config.name ? hosts(config.name) : [], allowOrigin: config.allowOrigin });

  function load() {
    try {
      if (existsSync(files.state)) {
        const saved = JSON.parse(readFileSync(files.state, "utf8"));
        config = { name: NAME.test(saved.name) ? saved.name : null, allowOrigin: originOf(saved.allowOrigin), enabled: saved.enabled !== false };
      }
      if (existsSync(files.key)) privateKey = createPrivateKey(readFileSync(files.key, "utf8"));
      if (existsSync(files.chain) && privateKey && config.name) {
        const text = readFileSync(files.chain, "utf8");
        validity = inspectChain(text, { name: config.name, privateKey });
        chain = text;
      }
    } catch (failure) {
      error = `Saved ${path} listener state is unusable: ${failure.message}`;
      chain = null;
      validity = null;
    }
  }

  function ensureKey() {
    if (privateKey) return privateKey;
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    write(files.key, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
    privateKey = pair.privateKey;
    return privateKey;
  }

  function stopServer(address) {
    const server = servers.get(address);
    servers.delete(address);
    if (!server) return Promise.resolve();
    return new Promise((done) => {
      server.close(() => done());
      server.closeAllConnections?.();
    });
  }

  async function startServer(address) {
    const app = createEdgeApp({ path, config: current, media, refusePeer, onAnswer, lanProbe, now });
    const next = createAdaptorServer({ fetch: app.fetch, createServer, serverOptions: { ...serverOptions(current), ...contextOptions, key: keyPem(), cert: chain } });
    tune(next, current);
    await new Promise((done) => {
      next.once("error", (failure) => {
        errors.set(address, `The ${path} listener cannot listen on ${address}:${port}: ${failure.code || failure.message}`);
        logger.warn({ path, address, port, err: failure.message }, "Media listener failed to start");
        done();
      });
      next.listen(port, address, () => {
        servers.set(address, next);
        errors.delete(address);
        logger.info({ path, address, port, name: config.name }, "Media listener started");
        done();
      });
    });
  }

  // Listen on every wanted address when everything is there. One change at
  // a time: the address watcher and the control plane's calls may overlap.
  async function reconcileNow() {
    const want = port > 0 && config.enabled && config.name && config.allowOrigin && valid() ? addresses().filter(Boolean) : [];
    for (const address of [...servers.keys()]) if (!want.includes(address)) await stopServer(address);
    for (const address of [...errors.keys()]) if (!want.includes(address)) errors.delete(address);
    for (const address of want) if (!servers.has(address)) await startServer(address);
  }

  const listening = () => servers.size > 0;

  return {
    load,
    reconcile() {
      pending = pending.catch(() => {}).then(reconcileNow);
      return pending;
    },
    async close() {
      await pending.catch(() => {});
      await Promise.all([...servers.keys()].map(stopServer));
    },
    config: () => ({ ...config }),
    bound: () => [...servers.keys()],
    listening,
    /** Whether a stream may be served on this path now. */
    ready: () => listening() && valid(),
    origin: () => (config.name ? origin(config.name) : null),
    status() {
      return {
        enabled: port > 0 && config.enabled,
        port,
        name: config.name,
        origin: config.name ? origin(config.name) : null,
        listening: listening(),
        notBefore: validity?.notBefore ?? null,
        notAfter: validity?.notAfter ?? null,
        error: [...errors.values()][0] ?? error,
      };
    },

    // The name and the allowed page origin from the control plane; answers
    // a certificate request for the name.
    async configure({ name, allowOrigin, enabled = true }) {
      const wanted = String(name || "").toLowerCase();
      if (!NAME.test(wanted)) throw new YoloError("invalid_request", "name must be a DNS name");
      const pageOrigin = originOf(allowOrigin);
      if (!pageOrigin) throw new YoloError("invalid_request", "allowOrigin must be an origin");
      const key = ensureKey();
      const next = { name: wanted, allowOrigin: pageOrigin, enabled: enabled !== false };
      if (JSON.stringify(next) !== JSON.stringify(config)) {
        if (wanted !== config.name) {
          chain = null;
          validity = null;
        }
        config = next;
        write(files.state, JSON.stringify(config), 0o644);
      }
      await this.reconcile();
      return requestPem(certificateRequest({ name: wanted, privateKey: key, publicKey: createPublicKey(key) }));
    },

    // The chain for the configured name and this node's key. Running
    // servers take it for new connections, without a restart.
    async install({ name, chain: pem } = {}) {
      if (!config.name || String(name || "").toLowerCase() !== config.name) throw new YoloError("invalid_request", "The certificate is for another name");
      if (!privateKey) throw new YoloError("invalid_request", `This node has no ${path} key yet`);
      const text = String(pem || "");
      const checked = inspectChain(text, { name: config.name, privateKey });
      if (checked.notAfter <= now()) throw new YoloError("invalid_request", "The certificate has expired");
      write(files.chain, text, 0o644);
      chain = text;
      validity = checked;
      for (const server of servers.values()) server.setSecureContext({ ...contextOptions, key: keyPem(), cert: chain });
      await this.reconcile();
    },
  };
}
