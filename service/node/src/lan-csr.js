import { sign } from "node:crypto";
import { isIP } from "node:net";

// A PKCS#10 certificate request (RFC 2986) for a media listener's names,
// signed with the listener's ECDSA P-256 key
// (Agent Note 2026-10-12-lan-direct-play). A name is a DNS name or, for
// remote direct play without a domain, an IP address
// (Agent Note 2026-10-13-media-off-the-worker). The ACME client sends it to
// the CA; the key never leaves the node. Node's crypto can sign but not
// build a request, so this writes the few DER structures one needs.

function length(size) {
  if (size < 0x80) return Buffer.from([size]);
  const bytes = [];
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
export const sequence = (...parts) => der(0x30, ...parts);
export const set = (...parts) => der(0x31, ...parts);

export function oid(dotted) {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

export const OID = Object.freeze({
  commonName: "2.5.4.3",
  subjectAltName: "2.5.29.17",
  extensionRequest: "1.2.840.113549.1.9.14",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
});

/** The 4 or 16 bytes of an IPv4 or IPv6 address. */
export function addressBytes(address) {
  if (isIP(address) === 4) return Buffer.from(address.split(".").map(Number));
  const [head, tail = null] = address.toLowerCase().split("::");
  const groups = (text) => (text ? text.split(":") : []).flatMap((group) => {
    if (group.includes(".")) {
      const [a, b, c, d] = group.split(".").map(Number);
      return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
    }
    return [group];
  });
  const left = groups(head);
  const right = tail === null ? [] : groups(tail);
  const all = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return Buffer.concat(all.map((group) => Buffer.from([parseInt(group, 16) >> 8, parseInt(group, 16) & 0xff])));
}

/** A GeneralName: dNSName [2] for a name, iPAddress [7] for an address. */
export const generalName = (name) => (isIP(name) ? der(0x87, addressBytes(name)) : der(0x82, Buffer.from(name, "ascii")));

/**
 * The DER request for `names` (or the one `name`). The subject's common name
 * is set when the first name is a DNS name that fits its 64-character
 * limit; the subjectAltName carries every name.
 * @param {{ name?: string, names?: string[], privateKey: import("node:crypto").KeyObject, publicKey: import("node:crypto").KeyObject }} input
 * @returns {Buffer}
 */
export function certificateRequest({ name, names = [name], privateKey, publicKey }) {
  const [first] = names;
  const subject = !isIP(first) && first.length <= 64 ? sequence(set(sequence(oid(OID.commonName), der(0x0c, Buffer.from(first, "ascii"))))) : sequence();
  const altNames = sequence(oid(OID.subjectAltName), der(0x04, sequence(...names.map(generalName))));
  const attributes = der(0xa0, sequence(oid(OID.extensionRequest), set(sequence(altNames))));
  const info = sequence(der(0x02, Buffer.from([0])), subject, publicKey.export({ type: "spki", format: "der" }), attributes);
  const signature = sign("sha256", info, { key: privateKey, dsaEncoding: "der" });
  return sequence(info, sequence(oid(OID.ecdsaWithSha256)), der(0x03, Buffer.from([0]), signature));
}

/** PEM armor for DER bytes. */
export function pem(label, derBytes) {
  const lines = derBytes.toString("base64").match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** PEM armor for a DER request. */
export const requestPem = (derBytes) => pem("CERTIFICATE REQUEST", derBytes);
