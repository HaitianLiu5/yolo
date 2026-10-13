import { sign } from "node:crypto";

// A PKCS#10 certificate request (RFC 2986) for one DNS name, signed with the
// LAN listener's ECDSA P-256 key (Agent Note 2026-10-12-lan-direct-play).
// The control plane sends it to the ACME server; the key never leaves the
// node. Node's crypto can sign but not build a request, so this writes the
// few DER structures one needs.

function length(size) {
  if (size < 0x80) return Buffer.from([size]);
  const bytes = [];
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...parts) => der(0x30, ...parts);
const set = (...parts) => der(0x31, ...parts);

function oid(dotted) {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

const OID = {
  commonName: "2.5.4.3",
  subjectAltName: "2.5.29.17",
  extensionRequest: "1.2.840.113549.1.9.14",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
};

/**
 * The DER request for `name`. The subject's common name is set when the
 * name fits its 64-character limit; the subjectAltName carries it always.
 * @param {{ name: string, privateKey: import("node:crypto").KeyObject, publicKey: import("node:crypto").KeyObject }} input
 * @returns {Buffer}
 */
export function certificateRequest({ name, privateKey, publicKey }) {
  const ascii = Buffer.from(name, "ascii");
  const subject = name.length <= 64 ? sequence(set(sequence(oid(OID.commonName), der(0x0c, ascii)))) : sequence();
  const altNames = sequence(oid(OID.subjectAltName), der(0x04, sequence(der(0x82, ascii))));
  const attributes = der(0xa0, sequence(oid(OID.extensionRequest), set(sequence(altNames))));
  const info = sequence(der(0x02, Buffer.from([0])), subject, publicKey.export({ type: "spki", format: "der" }), attributes);
  const signature = sign("sha256", info, { key: privateKey, dsaEncoding: "der" });
  return sequence(info, sequence(oid(OID.ecdsaWithSha256)), der(0x03, Buffer.from([0]), signature));
}

/** PEM armor for a DER request. */
export function requestPem(derBytes) {
  const lines = derBytes.toString("base64").match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
}
