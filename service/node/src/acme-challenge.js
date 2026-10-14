import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { isIP } from "node:net";
import { createSecureContext } from "node:tls";
import { addressBytes, der, generalName, OID, oid, pem, sequence, set } from "./lan-csr.js";
import { silentLogger } from "./log.js";

// The node's answers to the CA when it certifies the home's public address
// itself (Agent Note 2026-10-13-media-off-the-worker): HTTP-01 on a plain
// HTTP listener that the router's port 80 reaches, open only while an order
// runs, and TLS-ALPN-01 (RFC 8737, RFC 8738) on the remote listener when the
// router's port 443 reaches it. Nothing here is served outside an order.

export const ACME_TLS_PROTOCOL = "acme-tls/1";
const ACME_IDENTIFIER = "1.3.6.1.5.5.7.1.31";
const CHALLENGE_PATH = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{1,128})$/;
const DAY = 24 * 60 * 60_000;

/** The name a TLS-ALPN-01 check sends as SNI: the reverse name of an address (RFC 8738), or the DNS name. */
export function reverseName(value) {
  if (isIP(value) === 4) return `${value.split(".").reverse().join(".")}.in-addr.arpa`;
  if (isIP(value) === 6) return `${[...addressBytes(value).toString("hex")].reverse().join(".")}.ip6.arpa`;
  return String(value).toLowerCase();
}

// UTCTime, YYMMDDHHMMSSZ.
const utcTime = (ms) => der(0x17, Buffer.from(new Date(ms).toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z", "ascii"));

/**
 * The self-signed certificate a TLS-ALPN-01 check expects: one subjectAltName
 * for the identifier and the critical acmeIdentifier extension holding the
 * SHA-256 of the key authorization. A fresh key each time; it signs nothing
 * else.
 */
export function alpnCertificate({ identifier, keyAuthorization, now = Date.now() }) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) || 1;
  const name = sequence(set(sequence(oid(OID.commonName), der(0x0c, Buffer.from("ACME TLS-ALPN-01", "ascii")))));
  const digest = createHash("sha256").update(keyAuthorization).digest();
  const extensions = der(0xa3, sequence(
    sequence(oid(OID.subjectAltName), der(0x04, sequence(generalName(identifier.value)))),
    sequence(oid(ACME_IDENTIFIER), der(0x01, Buffer.from([0xff])), der(0x04, der(0x04, digest))),
  ));
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), sequence(oid(OID.ecdsaWithSha256)), name,
    sequence(utcTime(now - DAY), utcTime(now + 7 * DAY)), name, publicKey.export({ type: "spki", format: "der" }), extensions,
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: pem("CERTIFICATE", sequence(tbs, sequence(oid(OID.ecdsaWithSha256)), der(0x03, Buffer.from([0]), signature))),
  };
}

/**
 * The answers of the order that runs now: `solver(type)` is what the ACME
 * client presents and removes; `answer(token)` serves HTTP-01, `context()`
 * and `alpn()` serve TLS-ALPN-01 on a TLS server.
 */
export function createChallenges({ contextOptions = {} } = {}) {
  const answers = new Map();
  const contexts = new Map();
  return {
    answer: (token) => answers.get(token) ?? null,
    context: (servername) => contexts.get(String(servername || "").toLowerCase()) ?? null,
    // The protocol for a TLS client's ALPN offer: `acme-tls/1` only for a
    // name whose check is pending, else HTTP/1.1.
    alpn({ servername, protocols = [] }) {
      if (protocols.includes(ACME_TLS_PROTOCOL) && contexts.has(String(servername || "").toLowerCase())) return ACME_TLS_PROTOCOL;
      return protocols.includes("http/1.1") ? "http/1.1" : undefined;
    },
    solver(type) {
      if (type === "http-01") {
        return {
          type,
          present: ({ token, keyAuthorization }) => {
            answers.set(token, keyAuthorization);
            return token;
          },
          remove: (token) => answers.delete(token),
        };
      }
      return {
        type: "tls-alpn-01",
        present: ({ identifier, keyAuthorization }) => {
          const servername = reverseName(identifier.value);
          contexts.set(servername, createSecureContext({ ...contextOptions, ...alpnCertificate({ identifier, keyAuthorization }) }));
          return servername;
        },
        remove: (servername) => contexts.delete(servername),
      };
    },
  };
}

/**
 * The HTTP-01 listener: `GET /.well-known/acme-challenge/{token}` for the
 * pending tokens, 404 for anything else. `open()` answers, per binding,
 * whether it listens.
 */
export function createChallengeListener({ challenges, logger = silentLogger }) {
  let servers = [];
  const handle = (req, res) => {
    const token = req.method === "GET" ? CHALLENGE_PATH.exec(req.url || "")?.[1] : null;
    const answer = token ? challenges.answer(token) : null;
    res.writeHead(answer ? 200 : 404, { "content-type": "text/plain", "cache-control": "no-store", connection: "close" });
    res.end(answer ?? "");
  };
  return {
    async open(bindings) {
      const results = [];
      for (const { address, port } of bindings) {
        const server = createHttpServer(handle);
        server.headersTimeout = 10_000;
        server.requestTimeout = 10_000;
        server.keepAliveTimeout = 1_000;
        results.push(await new Promise((done) => {
          server.once("error", (failure) => done({ address, port, error: failure.code || failure.message }));
          server.listen(port, address, () => {
            servers.push(server);
            done({ address, port, error: null });
          });
        }));
      }
      logger.info({ kind: "edge", path: "wan", event: "challenge_open", bindings: results }, "Certificate check listener opened");
      return results;
    },
    async close() {
      const closing = servers;
      servers = [];
      await Promise.all(closing.map((server) => new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections?.();
      })));
    },
  };
}
