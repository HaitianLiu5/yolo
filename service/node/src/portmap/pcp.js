import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { isIP } from "node:net";

// NAT-PMP (RFC 6886) and PCP (RFC 6887), the two protocols a home router
// answers on UDP 5351 of its LAN address, for remote direct play
// (Agent Note 2026-10-13-media-off-the-worker). Both map one TCP port of the
// router's public address to the node; PCP is tried first, and a router that
// speaks only NAT-PMP answers a PCP request with "unsupported version".
//
// A request is retransmitted after 250 ms, doubling, a few times; only an
// answer from the gateway's own address and port is read.

export const PORT_MAPPING_PORT = 5351;
export const RETRY_DELAYS_MS = Object.freeze([250, 500, 1_000, 2_000]);
const TCP = 6;
const NAT_PMP_TCP = 2;
const NAT_PMP_EXTERNAL_ADDRESS = 0;
const PCP_VERSION = 2;
const PCP_MAP = 1;

// Why a mapping failed, as the owner's settings say it.
export class PortMapError extends Error {
  constructor(code, message, { protocol = null } = {}) {
    super(message);
    this.name = "PortMapError";
    this.code = code;
    this.protocol = protocol;
  }
}

const NAT_PMP_RESULTS = ["success", "unsupported_version", "refused", "network_failure", "no_resources", "unsupported_opcode"];
const PCP_RESULTS = [
  "success", "unsupported_version", "refused", "malformed_request", "unsupported_opcode", "unsupported_option", "malformed_option",
  "network_failure", "no_resources", "unsupported_protocol", "user_quota", "cannot_provide_external", "address_mismatch", "excessive_peers",
];

/**
 * One request and its answer. `accept(buffer)` returns the parsed answer, or
 * undefined for a datagram that is not the answer (another request's, or
 * garbage).
 */
export function exchange({ gateway, port = PORT_MAPPING_PORT, bind = null, message, accept, delays = RETRY_DELAYS_MS }) {
  return new Promise((resolve, reject) => {
    const family = isIP(gateway) === 6 ? "udp6" : "udp4";
    const socket = createSocket(family);
    let timer = null;
    let attempt = 0;
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    };
    socket.on("error", (error) => finish(new PortMapError("network_failure", error.message)));
    socket.on("message", (buffer, from) => {
      if (from.address.replace(/^::ffff:/, "") !== gateway || from.port !== port) return;
      let value;
      try {
        value = accept(buffer);
      } catch (error) {
        finish(error);
        return;
      }
      if (value !== undefined) finish(null, value);
    });
    const send = () => {
      if (attempt >= delays.length) {
        finish(new PortMapError("timeout", `No answer from ${gateway}:${port}`));
        return;
      }
      socket.send(message, port, gateway);
      timer = setTimeout(send, delays[attempt]);
      attempt += 1;
    };
    socket.bind({ address: bind ?? undefined, port: 0 }, send);
  });
}

// --- NAT-PMP -------------------------------------------------------------

function natPmpResult(buffer, opcode) {
  if (buffer.length < 8 || buffer[0] !== 0 || buffer[1] !== 128 + opcode) return undefined;
  const code = buffer.readUInt16BE(2);
  if (code !== 0) throw new PortMapError(NAT_PMP_RESULTS[code] ?? `result_${code}`, `NAT-PMP answered ${NAT_PMP_RESULTS[code] ?? code}`, { protocol: "natpmp" });
  return { epoch: buffer.readUInt32BE(4) };
}

/** The router's public IPv4 address, as NAT-PMP reports it. */
export async function natPmpExternalAddress(options) {
  return exchange({
    ...options,
    message: Buffer.from([0, NAT_PMP_EXTERNAL_ADDRESS]),
    accept: (buffer) => {
      const result = natPmpResult(buffer, NAT_PMP_EXTERNAL_ADDRESS);
      if (!result || buffer.length < 12) return undefined;
      return { ...result, address: [...buffer.subarray(8, 12)].join(".") };
    },
  });
}

/**
 * Maps TCP `externalPort` (a suggestion the router may change) to
 * `internalPort` of the address the request comes from; `lifetime` 0 with
 * `externalPort` 0 removes the mapping.
 */
export async function natPmpMap({ internalPort, externalPort, lifetime, ...options }) {
  const message = Buffer.alloc(12);
  message[1] = NAT_PMP_TCP;
  message.writeUInt16BE(internalPort, 4);
  message.writeUInt16BE(externalPort, 6);
  message.writeUInt32BE(lifetime, 8);
  return exchange({
    ...options,
    message,
    accept: (buffer) => {
      const result = natPmpResult(buffer, NAT_PMP_TCP);
      if (!result || buffer.length < 16 || buffer.readUInt16BE(8) !== internalPort) return undefined;
      return { ...result, externalPort: buffer.readUInt16BE(10), lifetime: buffer.readUInt32BE(12) };
    },
  });
}

// --- PCP -------------------------------------------------------------------

// An IPv4 address as PCP carries it: IPv4-mapped IPv6 (::ffff:a.b.c.d).
function mappedAddress(address) {
  const bytes = Buffer.alloc(16);
  bytes[10] = 0xff;
  bytes[11] = 0xff;
  String(address || "0.0.0.0").split(".").forEach((part, index) => {
    bytes[12 + index] = Number(part) || 0;
  });
  return bytes;
}

const readMappedAddress = (bytes) => (bytes.subarray(0, 12).equals(mappedAddress("0.0.0.0").subarray(0, 12)) ? [...bytes.subarray(12, 16)].join(".") : null);

export const newNonce = () => randomBytes(12);

/**
 * A PCP MAP request for TCP from `internalAddress`:`internalPort`. The same
 * `nonce` renews or (with `lifetime` 0) deletes the mapping. A router that
 * speaks only NAT-PMP throws code "unsupported_version".
 */
export async function pcpMap({ internalAddress, internalPort, externalPort, lifetime, nonce, ...options }) {
  const message = Buffer.alloc(60);
  message[0] = PCP_VERSION;
  message[1] = PCP_MAP;
  message.writeUInt32BE(lifetime, 4);
  mappedAddress(internalAddress).copy(message, 8);
  nonce.copy(message, 24);
  message[36] = TCP;
  message.writeUInt16BE(internalPort, 40);
  message.writeUInt16BE(externalPort, 42);
  mappedAddress("0.0.0.0").copy(message, 44);
  return exchange({
    ...options,
    message,
    accept: (buffer) => {
      // A NAT-PMP router answers a version it does not know in its own format.
      if (buffer.length >= 4 && buffer[0] === 0) throw new PortMapError("unsupported_version", "The router speaks NAT-PMP, not PCP", { protocol: "pcp" });
      if (buffer.length < 24 || buffer[0] !== PCP_VERSION || buffer[1] !== (0x80 | PCP_MAP)) return undefined;
      const code = buffer[3];
      if (code !== 0) throw new PortMapError(PCP_RESULTS[code] ?? `result_${code}`, `PCP answered ${PCP_RESULTS[code] ?? code}`, { protocol: "pcp" });
      if (buffer.length < 60 || !buffer.subarray(24, 36).equals(nonce)) return undefined;
      return {
        lifetime: buffer.readUInt32BE(4),
        epoch: buffer.readUInt32BE(8),
        externalPort: buffer.readUInt16BE(42),
        externalAddress: readMappedAddress(buffer.subarray(44, 60)),
      };
    },
  });
}
