import { createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { errorBody, YoloError } from "@useyolo/core";
import { silentLogger } from "./log.js";
import { certificateRequest, requestPem } from "./lan-csr.js";

// The node's LAN listener (Agent Note 2026-10-12-lan-direct-play): HTTPS on
// the machine's private IPv4 address, under a name in the owner's zone that
// the control plane points at that address. It serves `/m/*` (GET, HEAD and
// CORS preflights) and `/lan/probe`, nothing else; the internal API stays on
// the loopback listener. The media token in the path stays the only
// credential.
//
// The control plane configures it through /internal/v1/lan: the name and the
// page origin allowed by CORS. The node keeps its own ECDSA key under
// <runtime>/.lan/ and answers with a certificate request; the control plane
// returns the certificate chain it obtained by ACME DNS-01, and the listener
// swaps it in without a restart. Every 60 seconds the node checks its address
// and moves the listener when DHCP gave it another one.

export const DEFAULT_LAN_PORT = 9443;
// The ceiling on the LAN path: effectively none (200 Mbps is above any disc
// remux); a device's adaptive-quality cap still lowers it.
export const DEFAULT_LAN_MAX_VIDEO_KBPS = 200_000;
const ADDRESS_CHECK_MS = 60_000;
const NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const EXPOSED_HEADERS = "Content-Range, Accept-Ranges, Content-Length, ETag, X-Yolo-Error-Code";
const ALLOWED_REQUEST_HEADERS = "Range, X-Drive-In-Prefetch";
// Virtual and tunnel interfaces whose private addresses are not the home LAN.
const SKIPPED_INTERFACES = /^(?:lo|utun|bridge|docker|br-|veth|vmnet|vboxnet|virbr|tailscale|zt|wg|llw|awdl|anpnet|ap\d)/i;
const PREFERRED_INTERFACES = /^(?:en|eth|wl)/i;

const octets = (address) => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address));
  return match ? match.slice(1).map(Number) : null;
};

/** An RFC 1918 address: what the listener may bind to. */
export function isPrivateIPv4(address) {
  const [a, b] = octets(address) || [];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A peer the listener answers: private, link-local or loopback, in IPv4 or IPv6. */
export function isLocalPeer(address) {
  const text = String(address || "").toLowerCase().replace(/^::ffff:/, "");
  const v4 = octets(text);
  if (v4) return isPrivateIPv4(text) || v4[0] === 127 || (v4[0] === 169 && v4[1] === 254);
  return text === "::1" || /^f[cd][0-9a-f]{2}:/.test(text) || /^fe[89ab][0-9a-f]:/.test(text);
}

/** The machine's home LAN IPv4 address: a wired or Wi-Fi interface first. */
export function detectLanAddress(interfaces = networkInterfaces()) {
  const candidates = Object.entries(interfaces)
    .filter(([name]) => !SKIPPED_INTERFACES.test(name))
    .sort(([a], [b]) => Number(!PREFERRED_INTERFACES.test(a)) - Number(!PREFERRED_INTERFACES.test(b)));
  for (const [, entries] of candidates) {
    const found = (entries || []).find((entry) => (entry.family === "IPv4" || entry.family === 4) && !entry.internal && isPrivateIPv4(entry.address));
    if (found) return found.address;
  }
  return null;
}

function originOf(value) {
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

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

// Headers on every answer: CORS for the control plane's page, readable
// ranges and typed errors, COEP-compatible, and never a document.
function lanHeaders(response, allowOrigin) {
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
 * The LAN listener's HTTP app. `config()` gives the current name, port and
 * allowed origin; `media` is the pipeline (media/pipeline.js).
 */
export function createLanApp({ config, media }) {
  const app = new Hono();
  app.onError((error, c) => c.json(errorBody(error instanceof YoloError ? error : new YoloError("internal", "LAN request failed")), 500));
  app.use("*", async (c, next) => {
    const { name, port, allowOrigin } = config();
    // Only this name: a DNS rebinding page reaches the listener under its
    // own name, which is refused here.
    const host = String(c.req.header("host") || "").toLowerCase();
    if (!name || (host !== name && host !== `${name}:${port}`)) {
      return json(421, errorBody(new YoloError("invalid_request", "This listener serves only its own name")));
    }
    if (!isLocalPeer(getConnInfo(c).remote.address)) {
      return json(403, errorBody(new YoloError("forbidden", "Only devices on the home network")));
    }
    await next();
    c.res = lanHeaders(c.res, allowOrigin);
  });
  const preflight = (c) => {
    const headers = {
      "access-control-allow-methods": "GET, HEAD",
      "access-control-allow-headers": ALLOWED_REQUEST_HEADERS,
      "access-control-max-age": "600",
      vary: "Access-Control-Request-Headers",
    };
    if (c.req.header("access-control-request-private-network") === "true") headers["access-control-allow-private-network"] = "true";
    return new Response(null, { status: 204, headers });
  };
  app.options("/lan/probe", preflight);
  app.get("/lan/probe", (c) => json(200, { ok: true, name: config().name }));
  app.all("/m/*", (c) => {
    if (c.req.method === "OPTIONS") return preflight(c);
    return media.handle(c.req.raw);
  });
  app.notFound(() => json(404, errorBody(new YoloError("not_found", "No such endpoint on the LAN listener"))));
  return app;
}

/**
 * @param {object} options
 * @param {string} options.runtimeDir  keys and certificates go to <runtimeDir>/.lan/
 * @param {object} options.media  the media pipeline
 * @param {Record<string, string | undefined>} [options.env]  LAN_PORT, LAN_ADDRESS, LAN_MAX_VIDEO_KBPS
 */
export function createLan({
  runtimeDir,
  media,
  env = process.env,
  logger = silentLogger,
  now = () => Date.now(),
  interfaces = () => networkInterfaces(),
  createServer = createHttpsServer,
}) {
  const dir = resolve(runtimeDir, ".lan");
  const files = { state: resolve(dir, "state.json"), key: resolve(dir, "key.pem"), chain: resolve(dir, "chain.pem") };
  const portValue = Number(env.LAN_PORT ?? DEFAULT_LAN_PORT);
  const port = Number.isInteger(portValue) && portValue >= 0 && portValue <= 65_535 ? portValue : DEFAULT_LAN_PORT;
  const maxVideoKbps = (() => {
    const value = Number(env.LAN_MAX_VIDEO_KBPS);
    return Number.isFinite(value) && value >= 500 ? Math.floor(value) : DEFAULT_LAN_MAX_VIDEO_KBPS;
  })();
  // LAN_ADDRESS pins the address (a loopback one serves tests).
  const pinned = isPrivateIPv4(env.LAN_ADDRESS) || /^127\.\d+\.\d+\.\d+$/.test(env.LAN_ADDRESS || "") ? env.LAN_ADDRESS : null;

  let config = { name: null, allowOrigin: null };
  let privateKey = null;
  let chain = null;
  let validity = null;
  let server = null;
  let bound = null;
  let error = null;
  let watcher = null;
  let pending = Promise.resolve();

  const write = (path, text, mode = 0o600) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.tmp`, text, { mode });
    renameSync(`${path}.tmp`, path);
  };

  function load() {
    try {
      if (existsSync(files.state)) {
        const saved = JSON.parse(readFileSync(files.state, "utf8"));
        config = { name: NAME.test(saved.name) ? saved.name : null, allowOrigin: originOf(saved.allowOrigin) };
      }
      if (existsSync(files.key)) privateKey = createPrivateKey(readFileSync(files.key, "utf8"));
      if (existsSync(files.chain) && privateKey && config.name) {
        const text = readFileSync(files.chain, "utf8");
        validity = inspectChain(text, { name: config.name, privateKey });
        chain = text;
      }
    } catch (failure) {
      error = `Saved LAN state is unusable: ${failure.message}`;
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

  const address = () => pinned || detectLanAddress(interfaces());
  const valid = () => Boolean(chain && validity && validity.notAfter > now());
  const origin = () => (config.name ? `https://${config.name}${port === 443 ? "" : `:${port}`}` : null);

  function stopServer() {
    const closing = server;
    server = null;
    bound = null;
    if (!closing) return Promise.resolve();
    return new Promise((done) => {
      closing.close(() => done());
      closing.closeAllConnections?.();
    });
  }

  const keyPem = () => privateKey.export({ type: "pkcs8", format: "pem" });

  // Listen when everything is there, on the current address. One change at
  // a time: the address watcher and the control plane's calls may overlap.
  function reconcile() {
    pending = pending.catch(() => {}).then(reconcileNow);
    return pending;
  }

  async function reconcileNow() {
    const want = port > 0 && config.name && config.allowOrigin && valid() ? address() : null;
    if (server && bound === want) return;
    await stopServer();
    if (!want) return;
    const app = createLanApp({ config: () => ({ ...config, port }), media });
    const next = createAdaptorServer({ fetch: app.fetch, createServer, serverOptions: { key: keyPem(), cert: chain } });
    await new Promise((done) => {
      next.once("error", (failure) => {
        error = `The LAN listener cannot listen on ${want}:${port}: ${failure.code || failure.message}`;
        logger.warn({ address: want, port, err: failure.message }, "LAN listener failed to start");
        done();
      });
      next.listen(port, want, () => {
        server = next;
        bound = want;
        error = null;
        logger.info({ address: want, port, name: config.name }, "LAN listener started");
        done();
      });
    });
  }

  return {
    maxVideoKbps,

    // Read the saved name, key and chain, listen if they are complete, and
    // follow address changes.
    async start() {
      load();
      await reconcile();
      watcher ??= setInterval(() => {
        reconcile().catch((failure) => logger.warn({ err: failure.message }, "LAN listener check failed"));
      }, ADDRESS_CHECK_MS);
      watcher.unref?.();
    },

    async close() {
      clearInterval(watcher);
      watcher = null;
      await stopServer();
    },

    /** Whether a stream may be served on the LAN path now. */
    ready: () => Boolean(server) && valid(),
    origin: () => (server && valid() ? origin() : null),

    status() {
      return {
        enabled: port > 0,
        port,
        address: address(),
        name: config.name,
        origin: origin(),
        listening: Boolean(server),
        notBefore: validity?.notBefore ?? null,
        notAfter: validity?.notAfter ?? null,
        error,
      };
    },

    // PUT /internal/v1/lan: the name and the allowed page origin. Answers
    // the status and a certificate request for the name.
    async configure({ name, allowOrigin } = {}) {
      if (port === 0) throw new YoloError("invalid_request", "LAN direct play is turned off on this node (LAN_PORT=0)");
      const wanted = String(name || "").toLowerCase();
      if (!NAME.test(wanted)) throw new YoloError("invalid_request", "name must be a DNS name");
      const pageOrigin = originOf(allowOrigin);
      if (!pageOrigin) throw new YoloError("invalid_request", "allowOrigin must be an origin");
      const key = ensureKey();
      if (wanted !== config.name || pageOrigin !== config.allowOrigin) {
        if (wanted !== config.name) {
          chain = null;
          validity = null;
        }
        config = { name: wanted, allowOrigin: pageOrigin };
        write(files.state, JSON.stringify(config), 0o644);
        await reconcile();
      }
      const csr = certificateRequest({ name: wanted, privateKey: key, publicKey: createPublicKey(key) });
      return { ...this.status(), csr: requestPem(csr) };
    },

    // PUT /internal/v1/lan/certificate: the chain for the configured name
    // and this node's key. A running listener takes it for new connections.
    async install({ name, chain: pem } = {}) {
      if (!config.name || String(name || "").toLowerCase() !== config.name) throw new YoloError("invalid_request", "The certificate is for another name");
      if (!privateKey) throw new YoloError("invalid_request", "This node has no LAN key yet");
      const text = String(pem || "");
      const checked = inspectChain(text, { name: config.name, privateKey });
      if (checked.notAfter <= now()) throw new YoloError("invalid_request", "The certificate has expired");
      write(files.chain, text, 0o644);
      chain = text;
      validity = checked;
      if (server) server.setSecureContext({ key: keyPem(), cert: chain });
      await reconcile();
      return this.status();
    },
  };
}
