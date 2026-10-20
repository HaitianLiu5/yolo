import { signNodeRequest, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyNodeRequest } from "./signing.js";

// The internal protocol between the control plane and the media node
// (Agent Note 2026-10-07-node-internal-api). The number goes up when a release
// changes /internal/v1 in a way the other side's previous release cannot
// follow. The control plane sends its number on every request; the node
// accepts its own and the one before, so either side may be upgraded first
// within one release (the node first, as `yolo upgrade` does). A control plane
// that sends no number speaks protocol 0, the protocol of the releases before
// numbering.
export const NODE_PROTOCOL = 1;
export const PROTOCOL_HEADER = "x-yolo-protocol";

export function requestProtocol(value) {
  if (value == null || value === "") return 0;
  const protocol = Number(value);
  return Number.isInteger(protocol) && protocol >= 0 ? protocol : null;
}

export function acceptsProtocol(protocol, current = NODE_PROTOCOL) {
  return protocol === current || protocol === current - 1;
}

// Yolo's client protocol (Agent Note 2026-10-19-client-protocol): what a
// screen speaks to /v1 and the realtime channel. The number goes up when a
// release changes them in a way the previous release's clients cannot follow;
// the Hub serves the current number and the one before, listed in
// /.well-known/yolo as `clientProtocols`. A client sends its number in
// `hello` as `protocol` and on /v1 requests in CLIENT_PROTOCOL_HEADER. A
// hello without one comes from a page older than the protocol and counts as
// the first number.
export const FIRST_CLIENT_PROTOCOL = 1;
export const CLIENT_PROTOCOL = 1;
export const CLIENT_PROTOCOLS = Object.freeze([CLIENT_PROTOCOL - 1, CLIENT_PROTOCOL].filter((number) => number >= FIRST_CLIENT_PROTOCOL));
export const CLIENT_PROTOCOL_HEADER = "yolo-protocol";

// What the Hub does with a hello: "serve" it, answer a client it no longer
// serves with an `upgrade: true` welcome ("upgrade"), or, for a page older
// than the protocol that cannot read that welcome, close the connection with
// the rate-limit close it already obeys ("legacy").
export function helloProtocolAction(protocol, served = CLIENT_PROTOCOLS) {
  if (protocol === undefined || protocol === null) return served.includes(FIRST_CLIENT_PROTOCOL) ? "serve" : "legacy";
  return Number.isInteger(protocol) && served.includes(protocol) ? "serve" : "upgrade";
}

// The operator's signed probe of the control plane's /.well-known/yolo: the
// same HMAC as node requests, under its own headers and with an "operator:"
// path, so neither request can stand in for the other.
export const OPERATOR_TIMESTAMP_HEADER = "x-yolo-operator-timestamp";
export const OPERATOR_SIGNATURE_HEADER = "x-yolo-operator-signature";

export async function signOperatorRequest(secret, { method = "GET", path, timestamp = Date.now() }) {
  const signed = await signNodeRequest(secret, { method, path: `operator:${path}`, timestamp });
  return { [OPERATOR_TIMESTAMP_HEADER]: signed[TIMESTAMP_HEADER], [OPERATOR_SIGNATURE_HEADER]: signed[SIGNATURE_HEADER] };
}

export async function verifyOperatorRequest(secret, { method = "GET", path, headers, now = Date.now() }) {
  if (!secret) return false;
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]);
  const signature = get(OPERATOR_SIGNATURE_HEADER);
  if (!signature) return false;
  return verifyNodeRequest(secret, {
    method,
    path: `operator:${path}`,
    headers: { [TIMESTAMP_HEADER]: get(OPERATOR_TIMESTAMP_HEADER), [SIGNATURE_HEADER]: signature },
    now,
  });
}
