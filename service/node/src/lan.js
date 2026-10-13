import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { YoloError } from "@useyolo/core";
import { createEdgeListener } from "./edge.js";
import { silentLogger } from "./log.js";

// The node's LAN listener (Agent Note 2026-10-12-lan-direct-play), one of the
// media listeners of edge.js: HTTPS on the machine's private IPv4 address,
// for peers with private, link-local, or loopback addresses only. Besides
// /edge/probe it answers the probe at /lan/probe, for players from before
// 0.5, until the release after it (Agent Note 2026-10-13-versions-and-releases).
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
export const ADDRESS_CHECK_MS = 60_000;
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
  const portValue = Number(env.LAN_PORT ?? DEFAULT_LAN_PORT);
  const port = Number.isInteger(portValue) && portValue >= 0 && portValue <= 65_535 ? portValue : DEFAULT_LAN_PORT;
  const maxVideoKbps = (() => {
    const value = Number(env.LAN_MAX_VIDEO_KBPS);
    return Number.isFinite(value) && value >= 500 ? Math.floor(value) : DEFAULT_LAN_MAX_VIDEO_KBPS;
  })();
  // LAN_ADDRESS pins the address (a loopback one serves tests).
  const pinned = isPrivateIPv4(env.LAN_ADDRESS) || /^127\.\d+\.\d+\.\d+$/.test(env.LAN_ADDRESS || "") ? env.LAN_ADDRESS : null;
  const address = () => pinned || detectLanAddress(interfaces());
  const listener = createEdgeListener({
    path: "lan",
    dir: resolve(runtimeDir, ".lan"),
    port,
    addresses: () => [address()],
    media,
    lanProbe: true,
    refusePeer: (peer) => (isLocalPeer(peer) ? null : new YoloError("forbidden", "Only devices on the home network")),
    logger,
    now,
    createServer,
  });
  let watcher = null;

  return {
    maxVideoKbps,
    address,

    // Read the saved name, key and chain, listen if they are complete, and
    // follow address changes.
    async start() {
      listener.load();
      await listener.reconcile();
      watcher ??= setInterval(() => {
        listener.reconcile().catch((failure) => logger.warn({ err: failure.message }, "LAN listener check failed"));
      }, ADDRESS_CHECK_MS);
      watcher.unref?.();
    },

    async close() {
      clearInterval(watcher);
      watcher = null;
      await listener.close();
    },

    /** Whether a stream may be served on the LAN path now. */
    ready: () => listener.ready(),
    origin: () => (listener.ready() ? listener.origin() : null),

    status: () => ({ ...listener.status(), address: address() }),

    // PUT /internal/v1/lan: the name and the allowed page origin. Answers
    // the status and a certificate request for the name.
    async configure({ name, allowOrigin } = {}) {
      if (port === 0) throw new YoloError("invalid_request", "LAN direct play is turned off on this node (LAN_PORT=0)");
      const csr = await listener.configure({ name, allowOrigin });
      return { ...this.status(), csr };
    },

    // PUT /internal/v1/lan/certificate: the chain for the configured name
    // and this node's key.
    async install(input = {}) {
      await listener.install(input);
      return this.status();
    },
  };
}
