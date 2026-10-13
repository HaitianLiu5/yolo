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
