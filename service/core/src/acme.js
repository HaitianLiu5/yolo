import { YoloError } from "./errors.js";
import { base64url } from "./ids.js";

// A small ACME client (RFC 8555) with WebCrypto, so that the Worker and the
// node share it: the account key is ECDSA P-256 (ES256), and the certificate
// request comes from the node, which keeps its own key. The Worker validates
// the node's media names by DNS-01 (Agent Note 2026-10-12-lan-direct-play);
// the node validates the home's public address itself by HTTP-01 or
// TLS-ALPN-01 (RFC 8738, Agent Note 2026-10-13-media-off-the-worker).

export const LETS_ENCRYPT_STAGING_DIRECTORY = "https://acme-staging-v02.api.letsencrypt.org/directory";

const encoder = new TextEncoder();
const b64text = (text) => base64url(encoder.encode(text));
const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;

export class AcmeError extends YoloError {
  constructor(message, { type = null, status = 0, identifier = null } = {}) {
    super("resolve_failed", message);
    this.name = "AcmeError";
    this.type = type;
    this.httpStatus = status;
    // The identifier whose authorization failed, when one did.
    this.identifier = identifier;
  }
}

/** A new account key, as a private JWK. */
export async function createAccountKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return crypto.subtle.exportKey("jwk", pair.privateKey);
}

const publicJwk = ({ crv, kty, x, y }) => ({ crv, kty, x, y });

/** RFC 7638 thumbprint of the account key. */
export const thumbprint = async (jwk) => base64url(await sha256(JSON.stringify(publicJwk(jwk))));

/** The key authorization of a challenge token (RFC 8555 section 8.1): the HTTP-01 answer. */
export const keyAuthorization = async (token, jwk) => `${token}.${await thumbprint(jwk)}`;

/** The TXT value for a dns-01 challenge (RFC 8555 section 8.4). */
export async function dnsChallengeValue(token, jwk) {
  return base64url(await sha256(await keyAuthorization(token, jwk)));
}

/**
 * @param {object} options
 * @param {string} options.directoryUrl
 * @param {JsonWebKey} options.accountKey  private JWK
 * @param {string | null} [options.accountUrl]  the account's URL (kid), once known
 */
export function createAcmeClient({ directoryUrl, accountKey, accountUrl = null, fetchImpl = (...args) => fetch(...args), sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  let directory = null;
  let nonce = null;
  let signingKey = null;
  let kid = accountUrl;

  async function getDirectory() {
    if (directory) return directory;
    const response = await fetchImpl(directoryUrl, { headers: { accept: "application/json" } });
    if (!response.ok) throw new AcmeError(`The ACME directory answered ${response.status}`, { status: response.status });
    directory = await response.json();
    return directory;
  }

  async function freshNonce() {
    const response = await fetchImpl((await getDirectory()).newNonce, { method: "HEAD" });
    const value = response.headers.get("replay-nonce");
    if (!value) throw new AcmeError("The ACME server gave no nonce");
    return value;
  }

  // A JWS-signed POST; `payload` undefined is POST-as-GET. A bad nonce is
  // retried once with a fresh one.
  async function post(url, payload, { accept = null, retried = false } = {}) {
    signingKey ??= await crypto.subtle.importKey("jwk", accountKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const header = { alg: "ES256", nonce: nonce ?? await freshNonce(), url, ...(kid ? { kid } : { jwk: publicJwk(accountKey) }) };
    nonce = null;
    const protectedPart = b64text(JSON.stringify(header));
    const payloadPart = payload === undefined ? "" : b64text(JSON.stringify(payload));
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(`${protectedPart}.${payloadPart}`));
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/jose+json", ...(accept ? { accept } : {}) },
      body: JSON.stringify({ protected: protectedPart, payload: payloadPart, signature: base64url(new Uint8Array(signature)) }),
    });
    nonce = response.headers.get("replay-nonce") || null;
    if (response.ok) return response;
    const problem = await response.json().catch(() => null);
    if (problem?.type === "urn:ietf:params:acme:error:badNonce" && !retried) return post(url, payload, { accept, retried: true });
    throw new AcmeError(`ACME ${problem?.type?.split(":").pop() || response.status}: ${problem?.detail || "request failed"}`, { type: problem?.type ?? null, status: response.status });
  }

  const json = async (url, payload) => {
    const response = await post(url, payload);
    return { location: response.headers.get("location"), retryAfter: Number(response.headers.get("retry-after")) || 0, body: await response.json() };
  };

  // Ask again until `done(body)`, honouring Retry-After.
  async function poll(url, done, what, identifier = null) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const { body, retryAfter } = await json(url);
      if (done(body)) return body;
      if (body.status === "invalid") {
        const detail = body.error?.detail || body.challenges?.find((challenge) => challenge.error)?.error?.detail || "";
        throw new AcmeError(`The ACME ${what} is invalid${detail ? `: ${detail}` : ""}`, { type: body.error?.type ?? null, identifier });
      }
      if (Date.now() > deadline) throw new AcmeError(`The ACME ${what} did not complete in time`, { identifier });
      await sleep(Math.min(10_000, Math.max(POLL_MS, retryAfter * 1000)));
    }
  }

  return {
    get accountUrl() {
      return kid;
    },

    // The account for this key, created on first use (no contact address).
    async account() {
      if (kid) return kid;
      const response = await post((await getDirectory()).newAccount, { termsOfServiceAgreed: true });
      kid = response.headers.get("location");
      if (!kid) throw new AcmeError("The ACME server gave no account URL");
      return kid;
    },

    /**
     * One certificate for `identifiers` ([{ type: "dns" | "ip", value }]).
     * For each pending authorization `solve(identifier)` names the
     * challenge to answer: `{ type, present({ identifier, token,
     * keyAuthorization }) → handle, ready?(handle), remove(handle) }`, or
     * null when none can be. `profile` (RFC draft acme-profiles) is asked
     * for when the directory lists it. Resolves to the PEM chain.
     */
    async issue({ identifiers, csr, profile = null, solve }) {
      await this.account();
      const { newOrder, meta } = await getDirectory();
      const asked = profile && meta?.profiles && profile in meta.profiles ? { profile } : {};
      const order = await json(newOrder, { identifiers, ...asked });
      for (const authorizationUrl of order.body.authorizations || []) {
        const { body: authorization } = await json(authorizationUrl);
        if (authorization.status === "valid") continue;
        const identifier = authorization.identifier ?? null;
        const solver = solve(identifier);
        const challenge = solver && (authorization.challenges || []).find((candidate) => candidate.type === solver.type);
        if (!challenge) throw new AcmeError(`The ACME server offered no ${solver?.type ?? "usable"} challenge for ${identifier?.value ?? "an identifier"}`, { identifier });
        const handle = await solver.present({ identifier, token: challenge.token, keyAuthorization: await keyAuthorization(challenge.token, accountKey) });
        try {
          await solver.ready?.(handle);
          await json(challenge.url, {});
          await poll(authorizationUrl, (body) => body.status === "valid", "authorization", identifier);
        } finally {
          await solver.remove(handle);
        }
      }
      await json(order.body.finalize, { csr });
      const finished = await poll(order.location, (body) => body.status === "valid" && body.certificate, "order");
      const response = await post(finished.certificate, undefined, { accept: "application/pem-certificate-chain" });
      return response.text();
    },
  };
}

/** A PEM certificate request as base64url DER, as the finalize call takes it. */
export function csrFromPem(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (!body) throw new YoloError("resolve_failed", "The node gave no certificate request");
  return body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
