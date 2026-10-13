import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { signOperatorRequest, YoloError } from "@useyolo/core";
import { createEdgeListener } from "./edge.js";
import { ADDRESS_CHECK_MS, detectLanAddress, isPrivateIPv4 } from "./lan.js";
import { silentLogger } from "./log.js";
import { createPortMapper } from "./portmap/index.js";

// The node's remote listener (Agent Note 2026-10-13-media-off-the-worker),
// the media listener of edge.js that faces the internet: HTTPS on the
// private IPv4 address the router forwards to (and on the machine's global
// IPv6 address when WAN_IPV6 says so), under a second name in the owner's
// zone whose DNS-only record holds the home's public address. A device on
// any network, the car on LTE included, plays from it directly.
//
// The internet reaches it with nothing in front, so on top of edge.js's
// rules (its own name in Host and TLS, /m/* by token, the probe, nothing
// else) it bounds what one peer can do: a peer whose requests fail 20 times
// in a minute (a forged token, an unknown path, another name) is cut off for
// 10 minutes; at most 32 open connections per peer and 256 in all, and 20
// new connections a second in all; slow headers, slow requests, and idle
// keep-alive connections are closed; TLS 1.2 or newer. One log line per
// media answer says its status, size, and time, never its URL.
//
// The router mapping comes from portmap/ (PCP, NAT-PMP, UPnP IGD, or the
// owner's manual forward); the home's public address as the internet sees
// it comes from the control plane's /.well-known/yolo, asked over IPv4 with
// the operator signature. When the router's own public address is a shared
// (100.64.0.0/10) or private one, or differs from what the internet sees,
// the home is behind carrier-grade or double NAT and the path cannot work.

export const DEFAULT_WAN_PORT = 9444;
const PUBLIC_ADDRESS_MS = 5 * 60_000;
const PUBLIC_ADDRESS_TIMEOUT_MS = 8_000;
// Answers that mean the peer is not a player following the protocol.
const FAILURE_STATUSES = new Set([400, 403, 404, 405, 421]);
export const GUARD_LIMITS = Object.freeze({
  maxFailures: 20, failureWindowMs: 60_000, banMs: 10 * 60_000, maxPerPeer: 32, maxTotal: 256, maxNewPerSecond: 20, maxTracked: 10_000,
});

const peerOf = (address) => String(address || "").replace(/^::ffff:/, "");

/** A carrier-grade NAT (100.64.0.0/10) or private IPv4 address: not reachable from the internet. */
export function isSharedOrPrivate(address) {
  const [a, b] = String(address || "").split(".").map(Number);
  return isPrivateIPv4(address) || (a === 100 && b >= 64 && b <= 127);
}

/** The machine's global IPv6 address on a wired or Wi-Fi interface, or null. */
export function detectGlobalIPv6(interfaces = networkInterfaces()) {
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!/^(?:en|eth|wl)/i.test(name)) continue;
    const found = (entries || []).find((entry) => (entry.family === "IPv6" || entry.family === 6) && !entry.internal && /^[23][0-9a-f]{3}:/i.test(entry.address));
    if (found) return found.address;
  }
  return null;
}

/**
 * Per-peer limits of the remote listener. `admit()` runs for every new TCP
 * connection, before TLS; `failed()` for every answer that counts against
 * its peer.
 */
export function createPeerGuard({ limits = GUARD_LIMITS, now = () => Date.now(), onBan = () => {} } = {}) {
  const open = new Map();
  const failures = new Map();
  const banned = new Map();
  let total = 0;
  let second = { at: 0, count: 0 };
  const refused = { banned: 0, perPeer: 0, total: 0, rate: 0 };
  const trim = (map) => {
    if (map.size > limits.maxTracked) map.delete(map.keys().next().value);
  };

  const isBanned = (peer) => {
    const until = banned.get(peer);
    if (until > now()) return true;
    if (until) banned.delete(peer);
    return false;
  };

  return {
    banned: isBanned,
    admit(peer) {
      let reason = null;
      if (isBanned(peer)) reason = "banned";
      else if ((open.get(peer) ?? 0) >= limits.maxPerPeer) reason = "perPeer";
      else if (total >= limits.maxTotal) reason = "total";
      else {
        const t = now();
        if (t - second.at >= 1_000) second = { at: t, count: 0 };
        if (second.count >= limits.maxNewPerSecond) reason = "rate";
        else second.count += 1;
      }
      if (reason) {
        refused[reason] += 1;
        return false;
      }
      open.set(peer, (open.get(peer) ?? 0) + 1);
      total += 1;
      return true;
    },
    release(peer) {
      const count = (open.get(peer) ?? 1) - 1;
      if (count > 0) open.set(peer, count);
      else open.delete(peer);
      total = Math.max(0, total - 1);
    },
    // Returns whether this failure cut the peer off.
    failed(peer) {
      const t = now();
      const entry = failures.get(peer);
      const next = entry && t - entry.at < limits.failureWindowMs ? { at: entry.at, count: entry.count + 1 } : { at: t, count: 1 };
      failures.set(peer, next);
      trim(failures);
      if (next.count < limits.maxFailures || isBanned(peer)) return false;
      banned.set(peer, t + limits.banMs);
      trim(banned);
      failures.delete(peer);
      onBan(peer, next.count);
      return true;
    },
    // Timeouts and the connection gate on one server.
    attach(server) {
      server.headersTimeout = 10_000;
      server.requestTimeout = 30_000;
      server.keepAliveTimeout = 5_000;
      server.prependListener("connection", (socket) => {
        const peer = peerOf(socket.remoteAddress);
        if (!this.admit(peer)) {
          socket.destroy();
          return;
        }
        socket.once("close", () => this.release(peer));
      });
    },
    stats: () => ({ open: total, peers: open.size, banned: banned.size, refused: { ...refused } }),
  };
}

/**
 * The home's public IPv4 address as the control plane sees this node's
 * request: GET {allowOrigin}/.well-known/yolo?address=1 over IPv4, signed as
 * the operator, whose answer carries `operator.address`.
 */
export async function lookupPublicAddress({ allowOrigin, secret }) {
  const url = new URL("/.well-known/yolo?address=1", allowOrigin);
  const headers = await signOperatorRequest(secret, { path: "/.well-known/yolo" });
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((done, fail) => {
    const req = send(url, { family: 4, headers: { ...headers, accept: "application/json" }, timeout: PUBLIC_ADDRESS_TIMEOUT_MS }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        try {
          done(JSON.parse(text)?.operator?.address ?? null);
        } catch {
          fail(new Error(`The control plane answered ${res.statusCode}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("The control plane did not answer")));
    req.on("error", fail);
    req.end();
  });
}

const integer = (value, fallback, min = 0) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= 65_535 ? number : fallback;
};

/**
 * @param {object} options
 * @param {string} options.runtimeDir  the key and certificate go to <runtimeDir>/.lan/wan/
 * @param {string} options.secret  NODE_SECRET, which signs the public-address request
 * @param {Record<string, string | undefined>} [options.env]  WAN_PORT, WAN_MAPPING, WAN_EXTERNAL_PORT,
 *   WAN_GATEWAY, WAN_ADDRESS, WAN_IPV6
 */
export function createWan({
  runtimeDir,
  media,
  secret,
  env = process.env,
  logger = silentLogger,
  now = () => Date.now(),
  interfaces = () => networkInterfaces(),
  createServer = createHttpsServer,
  publicAddress: lookup = lookupPublicAddress,
  mapper: givenMapper = null,
}) {
  const port = integer(env.WAN_PORT ?? DEFAULT_WAN_PORT, DEFAULT_WAN_PORT);
  const mode = env.WAN_MAPPING === "manual" ? "manual" : "auto";
  const requestedPort = integer(env.WAN_EXTERNAL_PORT, port || DEFAULT_WAN_PORT, 1);
  const pinned = isPrivateIPv4(env.WAN_ADDRESS) || /^127\.\d+\.\d+\.\d+$/.test(env.WAN_ADDRESS || "") ? env.WAN_ADDRESS : null;
  const ipv6Setting = String(env.WAN_IPV6 || "").trim();
  const address = () => pinned || detectLanAddress(interfaces());
  const ipv6 = () => (!ipv6Setting || ipv6Setting === "off" ? null : ipv6Setting === "on" ? detectGlobalIPv6(interfaces()) : ipv6Setting);
  const mapper = givenMapper ?? createPortMapper({ mode, internalPort: port, externalPort: requestedPort, gateway: env.WAN_GATEWAY || null, logger });
  const guard = createPeerGuard({
    now,
    onBan: (peer, failures) => logger.warn({ kind: "edge", path: "wan", event: "peer_banned", peer, failures }, "Remote listener refused a peer for 10 minutes"),
  });
  const externalPort = () => mapper.status().externalPort;
  let listener = null;
  listener = createEdgeListener({
    path: "wan",
    dir: resolve(runtimeDir, ".lan", "wan"),
    port,
    addresses: () => [address(), ipv6()],
    media,
    hosts: (name) => [...new Set([name, `${name}:${externalPort() ?? requestedPort}`, `${name}:${port}`])],
    origin: (name) => {
      const external = externalPort() ?? requestedPort;
      return `https://${name}${external === 443 ? "" : `:${external}`}`;
    },
    refusePeer: (peer) => (guard.banned(peer) ? new YoloError("rate_limited", "Too many failed requests from this address") : null),
    onAnswer: ({ peer, status, media: isMedia, method, ms, bytes }) => {
      if (FAILURE_STATUSES.has(status)) guard.failed(peer);
      if (isMedia) logger.info({ kind: "media", path: "wan", method, status, bytes, ms }, "media answer");
    },
    tune: (server) => guard.attach(server),
    serverOptions: () => ({
      maxHeaderSize: 8_192,
      handshakeTimeout: 10_000,
      // A TLS client that names another host gets no certificate.
      SNICallback: (servername, done) => done(servername === listener.config().name ? null : new Error("unknown server name")),
    }),
    contextOptions: { minVersion: "TLSv1.2" },
    logger,
    now,
    createServer,
  });
  let watcher = null;
  let outside = { address: null, at: 0, error: null };

  // Map the router port while the listener serves on IPv4, and only then.
  async function syncMapping() {
    const bound = listener.bound().find((candidate) => !candidate.includes(":"));
    if (bound) await mapper.ensure(bound);
    else if (mapper.status().method) await mapper.unmap();
  }

  async function refreshOutside({ force = false } = {}) {
    const { allowOrigin, enabled } = listener.config();
    if (!allowOrigin || !enabled || port === 0) return;
    if (!force && now() - outside.at < PUBLIC_ADDRESS_MS) return;
    try {
      outside = { address: await lookup({ allowOrigin, secret }), at: now(), error: null };
    } catch (failure) {
      outside = { ...outside, at: now(), error: failure.message };
    }
  }

  async function check() {
    await listener.reconcile();
    await syncMapping();
    await refreshOutside();
  }

  // The router's public address against the internet's view of it.
  function nat() {
    const routerAddress = mapper.status().externalAddress;
    if (routerAddress && isSharedOrPrivate(routerAddress)) return { state: "cgnat", reason: `The router's own public address ${routerAddress} is a carrier-grade NAT or private address` };
    if (routerAddress && outside.address && routerAddress !== outside.address) return { state: "cgnat", reason: `The router says its public address is ${routerAddress}, but the internet sees ${outside.address}: another router or the ISP translates again` };
    return null;
  }

  const mapped = () => listener.ready() && externalPort() != null;

  return {
    async start() {
      listener.load();
      await check().catch((failure) => logger.warn({ err: failure.message }, "Remote listener check failed"));
      watcher ??= setInterval(() => {
        check().catch((failure) => logger.warn({ err: failure.message }, "Remote listener check failed"));
      }, ADDRESS_CHECK_MS);
      watcher.unref?.();
    },

    // The listener stops and the router mapping is deleted.
    async close() {
      clearInterval(watcher);
      watcher = null;
      await listener.close();
      await mapper.unmap();
    },

    /** Whether a stream may be served on the remote path now. */
    ready: () => mapped() && !nat(),
    origin: () => (mapped() ? listener.origin() : null),

    status() {
      const behind = nat();
      return {
        ...listener.status(),
        origin: mapped() ? listener.origin() : null,
        address: address(),
        ipv6: ipv6(),
        addresses: listener.bound(),
        mapping: mapper.status(),
        publicAddress: outside.address,
        publicAddressError: outside.error,
        nat: behind?.state ?? null,
        natReason: behind?.reason ?? null,
        guard: guard.stats(),
      };
    },

    // PUT /internal/v1/wan: the name, the allowed page origin, and whether
    // the owner has remote access on. Answers the status and a certificate
    // request for the name.
    async configure({ name, allowOrigin, enabled = true } = {}) {
      if (port === 0) throw new YoloError("invalid_request", "Remote direct play is turned off on this node (WAN_PORT=0)");
      const csr = await listener.configure({ name, allowOrigin, enabled: enabled !== false });
      await syncMapping();
      await refreshOutside({ force: !outside.at });
      return { ...this.status(), csr };
    },

    // PUT /internal/v1/wan/certificate
    async install(input = {}) {
      await listener.install(input);
      await syncMapping();
      return this.status();
    },
  };
}
