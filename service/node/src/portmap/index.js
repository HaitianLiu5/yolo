import { silentLogger } from "../log.js";
import { defaultGateway } from "./gateway.js";
import { natPmpExternalAddress, natPmpMap, newNonce, pcpMap, PortMapError } from "./pcp.js";
import { findGatewayService, upnpExternalAddress, upnpMap, upnpUnmap } from "./upnp.js";

// The router port mapping of remote direct play
// (Agent Note 2026-10-13-media-off-the-worker). In `auto` mode the node asks
// its default gateway for one TCP mapping to the remote listener, by PCP,
// then NAT-PMP, then UPnP IGD, the first that answers; it renews the mapping
// before half its lifetime has passed (re-reading the public address each
// time), maps again when the listener's address changes, and deletes the
// mapping when the listener closes. In `manual` mode the owner forwards the
// port on the router and the node sends nothing to it.

export const MAPPING_LIFETIME_SECONDS = 7_200;
const MAX_RENEW_MS = 15 * 60_000;
const RETRY_MS = 5 * 60_000;
export const METHODS = Object.freeze(["pcp", "natpmp", "upnp"]);

const DEFAULT_PROTOCOLS = { pcpMap, natPmpMap, natPmpExternalAddress, findGatewayService, upnpMap, upnpUnmap, upnpExternalAddress };

/**
 * @param {object} options
 * @param {"auto"|"manual"} options.mode
 * @param {number} options.internalPort  the remote listener's port
 * @param {number} options.externalPort  the port asked of the router (auto), or the one the owner forwarded (manual)
 * @param {string | null} [options.gateway]  the router's address; detected when null
 * @param {object} [options.transport]  test seams: { port, delays, ssdpAddress, ssdpPort, fetchImpl }
 */
export function createPortMapper({
  mode = "auto",
  internalPort,
  externalPort,
  gateway: pinnedGateway = null,
  lifetime = MAPPING_LIFETIME_SECONDS,
  logger = silentLogger,
  now = () => Date.now(),
  findGateway = () => defaultGateway(),
  protocols = DEFAULT_PROTOCOLS,
  transport = {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  let mapping = null;
  let gateway = pinnedGateway;
  let error = null;
  let timer = null;
  let pending = Promise.resolve();
  let address = null;

  const schedule = (ms) => {
    clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void refresh();
    }, ms);
    timer?.unref?.();
  };

  async function viaPcp(internalAddress, suggested) {
    const nonce = mapping?.method === "pcp" ? mapping.nonce : newNonce();
    const result = await protocols.pcpMap({ gateway, bind: internalAddress, internalAddress, internalPort, externalPort: suggested, lifetime, nonce, ...transport });
    return { method: "pcp", nonce, externalPort: result.externalPort, externalAddress: result.externalAddress, lifetime: result.lifetime };
  }

  async function viaNatPmp(internalAddress, suggested) {
    const result = await protocols.natPmpMap({ gateway, bind: internalAddress, internalPort, externalPort: suggested, lifetime, ...transport });
    const external = await protocols.natPmpExternalAddress({ gateway, bind: internalAddress, ...transport }).catch(() => null);
    return { method: "natpmp", externalPort: result.externalPort, externalAddress: external?.address ?? null, lifetime: result.lifetime };
  }

  async function viaUpnp(internalAddress, suggested) {
    const service = mapping?.method === "upnp" ? mapping.service : await protocols.findGatewayService({ gateway, bind: internalAddress, ...transport });
    const lease = await protocols.upnpMap(service, { internalAddress, internalPort, externalPort: suggested, lifetime }, transport);
    const externalAddress = await protocols.upnpExternalAddress(service, transport).catch(() => null);
    return { method: "upnp", service, externalPort: suggested, externalAddress, lifetime: lease };
  }

  async function mapNow(internalAddress) {
    if (mode === "manual") {
      mapping = { method: "manual", internalAddress, externalPort, externalAddress: null, lifetime: null, expiresAt: null };
      error = null;
      return mapping;
    }
    gateway ??= await findGateway();
    if (!gateway) {
      mapping = null;
      error = "The node found no default gateway; set WAN_GATEWAY to the router's address, or forward the port and set WAN_MAPPING=manual";
      schedule(RETRY_MS);
      return null;
    }
    // A renewal keeps the method and the port it got; a new address starts over.
    const keep = mapping && mapping.internalAddress === internalAddress && mapping.method !== "manual" ? mapping : null;
    if (mapping && !keep) await unmapNow();
    const suggested = keep?.externalPort ?? externalPort;
    const order = keep ? [keep.method, ...METHODS.filter((method) => method !== keep.method)] : METHODS;
    const failures = [];
    for (const method of order) {
      try {
        const result = await { pcp: viaPcp, natpmp: viaNatPmp, upnp: viaUpnp }[method](internalAddress, suggested);
        mapping = { ...result, internalAddress, expiresAt: result.lifetime ? now() + result.lifetime * 1000 : null };
        error = null;
        if (!keep || keep.externalPort !== mapping.externalPort || keep.method !== mapping.method) {
          logger.info({ method, gateway, internalAddress, internalPort, externalPort: mapping.externalPort, externalAddress: mapping.externalAddress }, "Router port mapping created");
        }
        schedule(Math.min(MAX_RENEW_MS, mapping.lifetime ? mapping.lifetime * 500 : MAX_RENEW_MS));
        return mapping;
      } catch (failure) {
        failures.push(`${method}: ${failure instanceof PortMapError ? failure.code : failure.message}`);
      }
    }
    mapping = null;
    error = `The router at ${gateway} made no port mapping (${failures.join("; ")}). Forward TCP port ${externalPort} to this machine's port ${internalPort} on the router and set WAN_MAPPING=manual`;
    logger.warn({ gateway, failures }, "Router port mapping failed");
    schedule(RETRY_MS);
    return null;
  }

  async function unmapNow() {
    const current = mapping;
    mapping = null;
    if (!current || current.method === "manual") return;
    const bind = current.internalAddress;
    try {
      if (current.method === "pcp") await protocols.pcpMap({ gateway, bind, internalAddress: bind, internalPort, externalPort: current.externalPort, lifetime: 0, nonce: current.nonce, ...transport });
      else if (current.method === "natpmp") await protocols.natPmpMap({ gateway, bind, internalPort, externalPort: 0, lifetime: 0, ...transport });
      else await protocols.upnpUnmap(current.service, { externalPort: current.externalPort }, transport);
      logger.info({ method: current.method, externalPort: current.externalPort }, "Router port mapping removed");
    } catch (failure) {
      logger.warn({ method: current.method, err: failure.message }, "Router port mapping could not be removed; it expires by itself");
    }
  }

  // One change at a time: renewals, address changes, and shutdown may overlap.
  const serial = (fn) => {
    pending = pending.catch(() => {}).then(fn);
    return pending;
  };

  function refresh() {
    return serial(() => (address ? mapNow(address) : null));
  }

  return {
    mode,
    /** Maps the port to `internalAddress`, or renews the mapping it has. */
    map(internalAddress) {
      address = internalAddress;
      return serial(() => mapNow(internalAddress));
    },
    refresh,
    /** Maps the port to `internalAddress` unless it is already mapped (or being retried) there. */
    ensure(internalAddress) {
      return internalAddress === address ? pending : this.map(internalAddress);
    },
    /** Deletes the mapping (the listener closed, or the node stops). */
    unmap() {
      address = null;
      clearTimer(timer);
      timer = null;
      return serial(unmapNow);
    },
    status: () => ({
      mode,
      gateway,
      method: mapping?.method ?? null,
      externalAddress: mapping?.externalAddress ?? null,
      externalPort: mapping?.externalPort ?? null,
      expiresAt: mapping?.expiresAt ?? null,
      error,
    }),
  };
}
