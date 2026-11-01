// The owner's side of Yolo from this page (Agent Note 2026-10-11-yolo-web-client):
// the passkey session and the settings routes under /v1/owner
// (Agent Note 2026-10-07-v1-http-api). They use the owner's session cookie,
// never the device credential, and every request carries X-Yolo-Owner, which
// Yolo requires so other sites cannot make them.
//
// Signing in runs WebAuthn on this page with Yolo's own sign-in endpoints
// (/auth/passkey/*), so the page does not reload and playback goes on.

import { t } from "./i18n.js";

export class OwnerError extends Error {
  constructor(message, { code = "internal", status = 0, cause } = {}) {
    super(message, { cause });
    this.name = "OwnerError";
    this.code = code;
    this.status = status;
  }
}

async function call(path, { method = "GET", body, owner = true } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(owner ? { "X-Yolo-Owner": "1" } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new OwnerError(t("Yolo could not be reached"), { code: "network", status: 0, cause: error });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new OwnerError(data?.error?.message || t("Yolo answered {status}", { status: response.status }), { code: data?.error?.code || "internal", status: response.status });
  }
  return data;
}

// --- WebAuthn: base64url <-> bytes around the JSON Yolo's server speaks ----

const fromBase64Url = (value) => Uint8Array.from(
  atob(String(value).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(value).length + 3) % 4)),
  (char) => char.charCodeAt(0),
);
const toBase64Url = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const passkeysSupported = () => typeof globalThis.PublicKeyCredential === "function" && Boolean(navigator.credentials);

function friendly(error) {
  if (error?.name === "NotAllowedError") return new OwnerError(t("The passkey prompt was closed or timed out"), { code: "cancelled" });
  if (error?.name === "SecurityError") return new OwnerError(t("Passkeys do not work on this address"), { code: "unsupported" });
  return error;
}

/** Sign the owner in with a passkey; resolves once Yolo set the session. */
export async function signInWithPasskey() {
  if (!passkeysSupported()) throw new OwnerError(t("This browser cannot use passkeys"), { code: "unsupported" });
  const options = await call("/auth/passkey/login/options", { method: "POST", body: {}, owner: false });
  options.challenge = fromBase64Url(options.challenge);
  options.allowCredentials = (options.allowCredentials || []).map((credential) => ({ ...credential, id: fromBase64Url(credential.id) }));
  let credential;
  try {
    credential = await navigator.credentials.get({ publicKey: options });
  } catch (error) {
    throw friendly(error);
  }
  await call("/auth/passkey/login/verify", {
    method: "POST",
    owner: false,
    body: {
      response: {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: credential.type,
        clientExtensionResults: credential.getClientExtensionResults(),
        authenticatorAttachment: credential.authenticatorAttachment,
        response: {
          clientDataJSON: toBase64Url(credential.response.clientDataJSON),
          authenticatorData: toBase64Url(credential.response.authenticatorData),
          signature: toBase64Url(credential.response.signature),
          userHandle: credential.response.userHandle ? toBase64Url(credential.response.userHandle) : undefined,
        },
      },
    },
  });
}

/** Add another passkey for the signed-in owner (no pairing code needed). */
export async function addPasskey(name) {
  if (!passkeysSupported()) throw new OwnerError(t("This browser cannot create passkeys"), { code: "unsupported" });
  const options = await call("/auth/passkey/register/options", { method: "POST", body: {}, owner: false });
  options.challenge = fromBase64Url(options.challenge);
  options.user.id = fromBase64Url(options.user.id);
  options.excludeCredentials = (options.excludeCredentials || []).map((credential) => ({ ...credential, id: fromBase64Url(credential.id) }));
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: options });
  } catch (error) {
    throw friendly(error);
  }
  await call("/auth/passkey/register/verify", {
    method: "POST",
    owner: false,
    body: {
      name,
      response: {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: credential.type,
        clientExtensionResults: credential.getClientExtensionResults(),
        authenticatorAttachment: credential.authenticatorAttachment,
        response: {
          clientDataJSON: toBase64Url(credential.response.clientDataJSON),
          attestationObject: toBase64Url(credential.response.attestationObject),
          transports: credential.response.getTransports?.() || [],
        },
      },
    },
  });
}

// --- Owner routes ---------------------------------------------------------------

export const owner = {
  session: () => call("/v1/owner/session"),
  signOut: () => call("/v1/owner/session/sign-out", { method: "POST" }),
  devices: () => call("/v1/owner/devices"),
  renameDevice: (id, changes) => call(`/v1/owner/devices/${encodeURIComponent(id)}`, { method: "PATCH", body: changes }),
  removeDevice: (id) => call(`/v1/owner/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // Profiles, who watches (Agent Note 2026-10-31-screen-sessions).
  profiles: () => call("/v1/owner/profiles"),
  addProfile: (name) => call("/v1/owner/profiles", { method: "POST", body: { name } }),
  renameProfile: (id, name) => call(`/v1/owner/profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } }),
  removeProfile: (id) => call(`/v1/owner/profiles/${encodeURIComponent(id)}`, { method: "DELETE" }),
  approvePairing: (userCode, { name, kind } = {}) => call("/v1/owner/pairing/approve", { method: "POST", body: { userCode, name, kind } }),
  agents: () => call("/v1/owner/agents"),
  revokeAgent: (id) => call(`/v1/owner/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  passkeys: () => call("/v1/owner/passkeys"),
  // The media paths: LAN direct play, remote access, and the relay, a change
  // of the switches, and a check now (Agent Note 2026-10-13-media-off-the-worker).
  media: () => call("/v1/owner/media"),
  setMedia: (changes) => call("/v1/owner/media", { method: "PATCH", body: changes }),
  checkMedia: () => call("/v1/owner/media/check", { method: "POST" }),
  removePasskey: (id) => call(`/v1/owner/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // The links of the covers agents show, and resetting them
  // (Agent Note 2026-10-07-remote-mcp-server).
  // The languages the owner speaks to Yolo, first first (Agent Note
  // 2026-10-18-agent-from-the-screen).
  voice: () => call("/v1/owner/voice"),
  setVoice: (languages) => call("/v1/owner/voice", { method: "PUT", body: { languages } }),
  imageLinks: () => call("/v1/owner/image-links"),
  resetImageLinks: () => call("/v1/owner/image-links/reset", { method: "POST" }),
  shares: () => call("/v1/owner/shares"),
  revokeShare: (id) => call(`/v1/owner/shares/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
};

/** Whether the owner is signed in on this browser; false when Yolo cannot say. */
export async function ownerSignedIn() {
  try {
    return (await owner.session()).signedIn === true;
  } catch {
    return false;
  }
}
