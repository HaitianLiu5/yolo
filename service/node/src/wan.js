import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { AcmeError, createAccountKey, createAcmeClient, csrFromPem, signOperatorRequest, YoloError } from "@useyolo/core";
import { createChallengeListener, createChallenges } from "./acme-challenge.js";
import { createEdgeListener, originOf } from "./edge.js";
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
//
// Two certificate modes, set by the control plane's PUT /internal/v1/wan:
// - `name`: the control plane names the listener in the owner's zone and
//   brings the certificate it obtained by ACME DNS-01 for the node's key.
// - `ip`, for an instance without a domain
//   (Agent Note 2026-10-13-no-domain-deployment): the listener's
//   identity is the home's public IPv4 address (and its global IPv6 address
//   while WAN_IPV6 is on and the CA reaches it), and the node obtains a
//   Let's Encrypt `shortlived` certificate for it itself. The CA reaches the
//   node by HTTP-01 through the router's port 80, which the node maps to
//   WAN_CHALLENGE_PORT only while an order runs, or by TLS-ALPN-01 on this
//   listener when its router port is 443. It orders when it has no
//   certificate for the current address, two thirds into the certificate's
//   life, and at once when the address changes; failures wait 30 minutes,
//   doubling up to 6 hours. The ACME account key stays in .lan/wan/ip.json.

export const DEFAULT_WAN_PORT = 9444;
export const DEFAULT_CHALLENGE_PORT = 9480;
// What the IP mode asks of the CA: Let's Encrypt issues address
// certificates only under this profile, for 160 hours.
export const IP_PROFILE = "shortlived";
const CHALLENGE_MAPPING_SECONDS = 600;
const ORDER_WAIT_MS = 20_000;
const RETRY_BASE_MS = 30 * 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
// An IPv6 address the CA could not reach is left out of the next orders for a day.
const IPV6_RETRY_MS = 24 * 60 * 60_000;
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

/** An IPv4 address a CA can reach on the internet. */
export function isPublicIPv4(address) {
  if (isIP(String(address || "")) !== 4 || isSharedOrPrivate(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return a !== 0 && a !== 127 && !(a === 169 && b === 254) && a < 224;
}

const bracket = (value) => (isIP(value) === 6 ? `[${value}]` : value);
const renewAt = ({ notBefore, notAfter }) => notBefore + ((notAfter - notBefore) * 2) / 3;
const httpUrl = (value) => {
  try {
    const url = new URL(String(value));
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};
const delay = (ms) => new Promise((done) => setTimeout(done, ms).unref?.());

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
 *   WAN_GATEWAY, WAN_ADDRESS, WAN_IPV6, WAN_CHALLENGE_PORT, WAN_CHALLENGE_MAPPING
 * @param {object} [options.mapper]  test seam: the remote listener's router mapping
 * @param {object} [options.challengeMapper]  test seam: the router's port 80 for HTTP-01
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
  challengeMapper: givenChallengeMapper = null,
  fetchImpl = (...args) => fetch(...args),
}) {
  const port = integer(env.WAN_PORT ?? DEFAULT_WAN_PORT, DEFAULT_WAN_PORT);
  const mode = env.WAN_MAPPING === "manual" ? "manual" : "auto";
  const requestedPort = integer(env.WAN_EXTERNAL_PORT, port || DEFAULT_WAN_PORT, 1);
  const challengePort = integer(env.WAN_CHALLENGE_PORT ?? DEFAULT_CHALLENGE_PORT, DEFAULT_CHALLENGE_PORT);
  const challengeMode = (env.WAN_CHALLENGE_MAPPING || env.WAN_MAPPING) === "manual" ? "manual" : "auto";
  const dir = resolve(runtimeDir, ".lan", "wan");
  const ipFile = resolve(dir, "ip.json");
  const pinned = isPrivateIPv4(env.WAN_ADDRESS) || /^127\.\d+\.\d+\.\d+$/.test(env.WAN_ADDRESS || "") ? env.WAN_ADDRESS : null;
  const ipv6Setting = String(env.WAN_IPV6 || "").trim();
  const address = () => pinned || detectLanAddress(interfaces());
  const ipv6 = () => (!ipv6Setting || ipv6Setting === "off" ? null : ipv6Setting === "on" ? detectGlobalIPv6(interfaces()) : ipv6Setting);
  const mapper = givenMapper ?? createPortMapper({ mode, internalPort: port, externalPort: requestedPort, gateway: env.WAN_GATEWAY || null, logger });
  const challengeMapper = givenChallengeMapper ?? createPortMapper({
    mode: challengeMode, internalPort: challengePort, externalPort: 80, lifetime: CHALLENGE_MAPPING_SECONDS, gateway: env.WAN_GATEWAY || null, logger,
  });
  const challenges = createChallenges({ contextOptions: { minVersion: "TLSv1.2" } });
  const challengeListener = createChallengeListener({ challenges, logger });
  // The IP mode's settings and its ACME account; `certificate` "name" is the
  // mode with a domain.
  let ip = {
    certificate: "name", allowOrigin: null, enabled: true, acmeDirectory: null, account: null,
    failures: 0, retryAt: null, attempted: null, error: null, validatedAt: null, ipv6Error: null, challenge: null,
  };
  let ordering = null;
  // While a TLS-ALPN-01 check runs, the listener listens before it has a certificate.
  let alpnOrder = false;
  // The router's public address as its last mapping said, for the carrier-grade NAT check.
  let routerSaid = null;
  const ipMode = () => ip.certificate === "ip";
  const guard = createPeerGuard({
    now,
    onBan: (peer, failures) => logger.warn({ kind: "edge", path: "wan", event: "peer_banned", peer, failures }, "Remote listener refused a peer for 10 minutes"),
  });
  const externalPort = () => mapper.status().externalPort;
  let listener = null;
  listener = createEdgeListener({
    path: "wan",
    dir,
    port,
    addresses: () => [address(), ipv6()],
    media,
    addressNames: true,
    listenUncertified: () => alpnOrder,
    hosts: (name, altNames = []) => [...new Set([name, ...altNames].flatMap((value) => {
      const host = bracket(value);
      return [host, `${host}:${externalPort() ?? requestedPort}`, `${host}:${port}`];
    }))],
    origin: (name) => {
      const external = externalPort() ?? requestedPort;
      return `https://${bracket(name)}${external === 443 ? "" : `:${external}`}`;
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
      // A TLS client that names another host gets no certificate, except the
      // CA's TLS-ALPN-01 check while an order runs.
      SNICallback: (servername, done) => {
        const challenge = challenges.context(servername);
        if (challenge) return done(null, challenge);
        const { name } = listener.config();
        return done(name && !isIP(name) && servername === name ? null : new Error("unknown server name"));
      },
      ALPNCallback: (offer) => challenges.alpn(offer),
    }),
    contextOptions: { minVersion: "TLSv1.2" },
    logger,
    now,
    createServer,
  });
  let watcher = null;
  let outside = { address: null, at: 0, error: null };

  function loadIp() {
    try {
      if (existsSync(ipFile)) ip = { ...ip, ...JSON.parse(readFileSync(ipFile, "utf8")) };
    } catch (failure) {
      logger.warn({ err: failure.message }, "Saved remote certificate state is unusable");
    }
  }

  // The account key is in here: owner-only.
  function saveIp() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(`${ipFile}.tmp`, JSON.stringify(ip), { mode: 0o600 });
    renameSync(`${ipFile}.tmp`, ipFile);
  }

  const pageOrigin = () => (ipMode() ? ip.allowOrigin : listener.config().allowOrigin);
  const switchedOn = () => (ipMode() ? ip.enabled : listener.config().enabled);
  const routerAddress = () => mapper.status().externalAddress ?? routerSaid;

  // The home's public IPv4 address: the internet's view, else the router's.
  function publicIPv4() {
    if (isPublicIPv4(outside.address)) return outside.address;
    const router = routerAddress();
    return isPublicIPv4(router) ? router : null;
  }

  // The global IPv6 address to certify too, unless the CA could not reach it lately.
  const ipv6Wanted = () => {
    const v6 = ipv6();
    return v6 && !(ip.ipv6Error && now() - ip.ipv6Error.at < IPV6_RETRY_MS) ? v6 : null;
  };

  // Map the router port while the listener serves on IPv4, and only then.
  async function syncMapping() {
    const bound = listener.bound().find((candidate) => !candidate.includes(":"));
    if (bound) await mapper.ensure(bound);
    else if (mapper.status().method) await mapper.unmap();
  }

  async function refreshOutside({ force = false } = {}) {
    const allowOrigin = pageOrigin();
    if (!allowOrigin || !switchedOn() || port === 0) return;
    if (!force && now() - outside.at < PUBLIC_ADDRESS_MS) return;
    const before = outside.address;
    try {
      outside = { address: await lookup({ allowOrigin, secret }), at: now(), error: null };
    } catch (failure) {
      outside = { ...outside, at: now(), error: failure.message };
    }
    // A new address: what the router said before is stale until it says
    // again, which a renewal of the mapping makes it do now.
    if (before && outside.address && outside.address !== before) {
      routerSaid = null;
      if (mapper.status().method) await mapper.refresh?.();
    }
  }

  async function check() {
    await listener.reconcile();
    await syncMapping();
    await refreshOutside();
    await ensureCertificate();
  }

  // The router's public address against the internet's view of it.
  function nat() {
    const router = routerAddress();
    if (router && isSharedOrPrivate(router)) return { state: "cgnat", reason: `The router's own public address ${router} is a carrier-grade NAT or private address` };
    if (router && outside.address && router !== outside.address) return { state: "cgnat", reason: `The router says its public address is ${router}, but the internet sees ${outside.address}: another router or the ISP translates again` };
    return null;
  }

  // In the IP mode the listener serves only under the current address.
  const mapped = () => listener.ready() && externalPort() != null && (!ipMode() || listener.config().name === publicIPv4());

  // --- The IP mode's certificate --------------------------------------------

  function ensureCertificate() {
    ordering ??= orderIfDue().catch((failure) => logger.warn({ err: failure.message }, "Remote certificate check failed")).finally(() => {
      ordering = null;
    });
    return ordering;
  }

  async function orderIfDue() {
    if (!ipMode() || !ip.enabled || !ip.allowOrigin || !ip.acmeDirectory || port === 0 || nat()) return;
    const v4 = publicIPv4();
    if (!v4) return;
    const v6 = ipv6Wanted();
    const wanted = [v4, ...(v6 ? [v6] : [])];
    const { name, altNames } = listener.config();
    const { notBefore, notAfter } = listener.status();
    const same = name === v4 && altNames.join() === wanted.slice(1).join();
    if (same && notAfter && now() < renewAt({ notBefore, notAfter })) return;
    if (ip.retryAt > now() && ip.attempted === wanted.join()) return;
    await order(wanted);
  }

  const refusedPort = (internal, detail) => [
    `The router would not map its port 80 to this node for the certificate check${detail ? ` (${detail})` : ""}.`,
    `Forward TCP port 80 to ${internal}:${challengePort} on the router and set WAN_CHALLENGE_MAPPING=manual,`,
    `or forward TCP port 443 to ${internal}:${port} and set WAN_EXTERNAL_PORT=443 and WAN_MAPPING=manual, which serves media at https://<public address> through that one port`,
  ].join(" ");

  async function issue({ identifiers, csr, type, v6 }) {
    const directory = ip.acmeDirectory;
    if (!ip.account || ip.account.directory !== directory) ip.account = { directory, key: await createAccountKey(), url: null };
    const acme = createAcmeClient({ directoryUrl: directory, accountKey: ip.account.key, accountUrl: ip.account.url, fetchImpl });
    try {
      return await acme.issue({
        identifiers: identifiers.map((value) => ({ type: "ip", value })),
        csr: csrFromPem(csr),
        profile: IP_PROFILE,
        // An IPv6 address has no NAT: the CA checks it on [address]:80.
        solve: (identifier) => challenges.solver(identifier?.value === v6 ? "http-01" : type),
      });
    } finally {
      ip.account.url = acme.accountUrl;
    }
  }

  // One order for `wanted` ([IPv4, IPv6?]). The challenge port and its router
  // mapping exist only while it runs.
  async function order(wanted) {
    const [v4, v6 = null] = wanted;
    const type = requestedPort === 443 ? "tls-alpn-01" : "http-01";
    const internal = address();
    ip.challenge = type === "http-01"
      ? { type, externalPort: 80, internalPort: challengePort, mapping: challengeMode, method: null }
      : { type, externalPort: 443, internalPort: port, mapping: mode, method: null };
    let withV6 = v6;
    let challengeMapped = false;
    let retryWithoutV6 = false;
    try {
      if (!internal) throw new YoloError("resolve_failed", "The node has no private IPv4 address for the router to forward to");
      const bindings = [];
      if (type === "http-01") {
        if (!challengePort) throw new YoloError("invalid_request", `WAN_CHALLENGE_PORT is 0, so the certificate check needs the router's port 443: set WAN_EXTERNAL_PORT=443`);
        bindings.push({ address: internal, port: challengePort });
      }
      if (v6) bindings.push({ address: v6, port: 80 });
      if (bindings.length) {
        const opened = await challengeListener.open(bindings);
        if (type === "http-01" && opened[0].error) throw new YoloError("resolve_failed", `The node cannot listen on ${internal}:${challengePort} for the certificate check (${opened[0].error})`);
        if (v6 && opened.at(-1).error) {
          withV6 = null;
          ip.ipv6Error = { at: now(), message: `The node cannot listen on [${v6}]:80 for the CA's check of its IPv6 address (${opened.at(-1).error})` };
        }
      }
      if (type === "http-01") {
        challengeMapped = true;
        const granted = await challengeMapper.map(internal);
        const said = challengeMapper.status();
        ip.challenge.method = said.method;
        if (said.externalAddress) routerSaid = said.externalAddress;
        if (!granted || granted.externalPort !== 80) throw new YoloError("resolve_failed", refusedPort(internal, said.error ?? (granted ? `it offered port ${granted.externalPort}` : null)));
        if (nat()) throw new YoloError("resolve_failed", nat().reason);
      }
      alpnOrder = type === "tls-alpn-01";
      const csr = await listener.configure({ name: v4, altNames: withV6 ? [withV6] : [], allowOrigin: ip.allowOrigin, enabled: ip.enabled });
      if (alpnOrder) {
        await syncMapping();
        ip.challenge.method = mapper.status().method;
        if (externalPort() !== 443) throw new YoloError("resolve_failed", mapper.status().error || `The router did not map its port 443 to this node; forward TCP port 443 to ${internal}:${port} and set WAN_MAPPING=manual`);
      }
      const identifiers = [v4, withV6].filter(Boolean);
      const chain = await issue({ identifiers, csr, type, v6: withV6 });
      alpnOrder = false;
      await listener.install({ name: v4, chain });
      Object.assign(ip, { failures: 0, retryAt: null, attempted: null, error: null, validatedAt: now() });
      logger.info({ kind: "edge", path: "wan", event: "certificate", identifiers, challenge: type, notAfter: listener.status().notAfter }, "Remote certificate for the home's address installed");
    } catch (failure) {
      retryWithoutV6 = Boolean(withV6) && failure?.identifier?.value === withV6;
      if (retryWithoutV6) {
        ip.ipv6Error = { at: now(), message: `The CA could not reach [${withV6}]:80: ${String(failure.message).slice(0, 240)}` };
      } else {
        // The CA's own failures count toward its limits; a refused port does not.
        const atCa = failure instanceof AcmeError;
        ip.failures = atCa ? (Number(ip.failures) || 0) + 1 : Number(ip.failures) || 0;
        const wait = atCa ? Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (ip.failures - 1)) : RETRY_BASE_MS;
        Object.assign(ip, { retryAt: now() + wait, attempted: wanted.join(), error: String(failure.message).slice(0, 600) });
        logger.warn({ kind: "edge", path: "wan", event: "certificate_error", message: ip.error, failures: ip.failures, retryAt: ip.retryAt }, "Remote certificate failed");
      }
    } finally {
      alpnOrder = false;
      await challengeListener.close();
      if (challengeMapped) await challengeMapper.unmap();
      await listener.reconcile();
      await syncMapping();
      saveIp();
    }
    if (retryWithoutV6) await order([v4]);
  }

  // PUT /internal/v1/wan with `certificate: "ip"`.
  async function configureIp({ allowOrigin, enabled = true, acmeDirectory }) {
    const page = originOf(allowOrigin);
    if (!page) throw new YoloError("invalid_request", "allowOrigin must be an origin");
    const directory = httpUrl(acmeDirectory);
    if (!directory) throw new YoloError("invalid_request", "acmeDirectory must be an http(s) URL");
    const on = enabled !== false;
    // A change of the owner's switch, the page, or the CA tries again at once.
    if (!ipMode() || ip.allowOrigin !== page || ip.enabled !== on || ip.acmeDirectory !== directory) {
      Object.assign(ip, { certificate: "ip", allowOrigin: page, enabled: on, acmeDirectory: directory, retryAt: null, failures: 0 });
      saveIp();
    }
    const current = listener.config();
    if (current.name && (current.enabled !== on || current.allowOrigin !== page)) {
      await listener.configure({ name: current.name, altNames: current.altNames, allowOrigin: page, enabled: on });
    }
    await syncMapping();
    await refreshOutside({ force: !outside.at });
    if (on) await Promise.race([ensureCertificate(), delay(ORDER_WAIT_MS)]);
  }

  return {
    async start() {
      loadIp();
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
      await challengeListener.close();
      await mapper.unmap();
      if (challengeMapper.status().method) await challengeMapper.unmap();
    },

    // The address watcher's round, now: the listener, the router mapping,
    // the public address, and in the IP mode the certificate.
    check,

    /** Whether a stream may be served on the remote path now. */
    ready: () => mapped() && !nat(),
    origin: () => (mapped() ? listener.origin() : null),

    status() {
      const behind = nat();
      const base = listener.status();
      const { name, altNames } = listener.config();
      return {
        ...base,
        certificate: ip.certificate,
        origin: mapped() ? listener.origin() : null,
        error: base.error ?? (ipMode() && !base.listening ? ip.error : null),
        address: address(),
        ipv6: ipv6(),
        addresses: listener.bound(),
        mapping: mapper.status(),
        publicAddress: outside.address,
        publicAddressError: outside.error,
        nat: behind?.state ?? null,
        natReason: behind?.reason ?? null,
        guard: guard.stats(),
        ...(ipMode() ? {
          identifiers: name && isIP(name) ? [name, ...altNames] : [],
          challenge: ip.challenge,
          order: {
            running: Boolean(ordering), failures: ip.failures, retryAt: ip.retryAt, error: ip.error, validatedAt: ip.validatedAt, ipv6Error: ip.ipv6Error?.message ?? null,
          },
        } : {}),
      };
    },

    // PUT /internal/v1/wan: the certificate mode, the allowed page origin,
    // and whether the owner has remote access on; with a domain also the
    // name, without one the ACME directory. Answers the status, with a
    // domain also a certificate request for the name.
    async configure({ certificate = "name", name, allowOrigin, enabled = true, acmeDirectory = null } = {}) {
      if (port === 0) throw new YoloError("invalid_request", "Remote direct play is turned off on this node (WAN_PORT=0)");
      if (certificate === "ip") {
        await configureIp({ allowOrigin, enabled, acmeDirectory });
        return this.status();
      }
      if (ipMode()) {
        ip.certificate = "name";
        saveIp();
      }
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
