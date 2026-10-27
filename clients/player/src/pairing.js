import { renderSVG } from "uqr";
import { saveCredential } from "./api.js";
import { requestJson } from "./network.js";
import { owner, ownerSignedIn, passkeysSupported, signInWithPasskey } from "./owner.js";
import { describeDevice } from "./realtime.js";
import { endLaunch } from "./launch.js";
import { t } from "./i18n.js";

// Pairing this browser with the owner's Yolo
// (Agent Note 2026-10-07-device-code-pairing, RFC 8628): show a QR code of
// verification_uri_complete and the short code, poll the token endpoint, and
// keep the device credential. The car has no camera and no comfortable
// keyboard: the owner scans the code with a phone, signs in with the passkey
// and presses Allow. Codes last 10 minutes; an expired one is replaced by a new
// one automatically.
//
// In a computer's or phone's browser (the web profile) the owner can also
// pair it right here: signed in with a passkey on this browser, one press
// approves this page's own code through /v1/owner/pairing/approve. It is the
// same grant, code, and explicit approval, without a second device.
//
// While Yolo is asked for a code, the QR plate, the code, and the address
// hold their places as placeholders (`asking`), with no words.

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const CLIENT_ID = "yolo-player";

const screen = () => document.getElementById("pair-screen");
const element = (id) => document.getElementById(id);

async function post(path, fields, label) {
  return requestJson(`${location.origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }, { label, timeoutMs: 15_000, retries: 0 });
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

let running = null;
let selfPairing = false;

// Resolves with { token, deviceId } once the owner allowed this device.
// `self`: offer to pair with the owner's passkey on this browser.
export function pairDevice({ self = false } = {}) {
  if (running) return running.promise;
  selfPairing = self;
  const controller = new AbortController();
  const promise = (async () => {
    screen().classList.remove("hidden");
    screen().classList.toggle("self", self);
    // The passkey's place shows from the start, its button ready once
    // there is a code to approve.
    if (self) {
      element("pair-self").classList.remove("hidden");
      element("pair-title").textContent = t("Use Yolo in this browser");
      element("pair-lead").textContent = t("Open");
      element("pair-passkey").disabled = true;
    }
    endLaunch();
    try {
      for (;;) {
        const result = await attempt(controller.signal);
        if (result) {
          saveCredential(result);
          return result;
        }
      }
    } finally {
      screen().classList.add("hidden");
      running = null;
    }
  })();
  running = { promise, controller };
  return promise;
}

// One code: show it, poll until allowed, denied or expired. Null to retry.
async function attempt(signal) {
  const status = element("pair-status");
  const { name, kind } = describeDevice();
  screen().classList.add("asking");
  element("pair-qr").replaceChildren();
  element("pair-code").textContent = "";
  element("pair-url").textContent = "";
  status.textContent = "";
  let started;
  try {
    started = await post("/oauth/device_authorization", { client_id: CLIENT_ID, device_name: name, device_kind: kind }, "Pairing");
  } catch (error) {
    status.textContent = t("Cannot reach Yolo ({message}). Retrying…", { message: error.message });
    await wait(10_000, signal);
    return null;
  }
  if (!started.ok) {
    status.textContent = started.data?.error_description || t("Yolo cannot pair devices right now. Retrying…");
    await wait(15_000, signal);
    return null;
  }
  const { device_code: deviceCode, user_code: userCode, verification_uri: uri, verification_uri_complete: complete } = started.data;
  let interval = Math.max(5, Number(started.data.interval) || 5) * 1000;
  const expiresAt = Date.now() + (Number(started.data.expires_in) || 600) * 1000;
  element("pair-qr").innerHTML = renderSVG(complete, { ecc: "M", border: 2, whiteColor: "#ffffff", blackColor: "#000000" });
  element("pair-code").textContent = userCode;
  element("pair-url").textContent = uri.replace(/^https?:\/\//, "");
  screen().classList.remove("asking");
  status.textContent = selfPairing ? t("Waiting for your approval…") : t("Waiting for you to allow this device on your phone…");
  // Approved here: poll at once instead of waiting out the interval.
  let kicked = false;
  let kick = () => {};
  const approvedHere = () => {
    kicked = true;
    kick();
  };
  if (selfPairing) offerSelfPairing(userCode, { name, kind, onApproved: approvedHere });

  while (Date.now() < expiresAt) {
    if (!kicked) await Promise.race([wait(interval, signal), new Promise((resolve) => { kick = resolve; })]);
    kicked = false;
    let response;
    try {
      response = await post("/oauth/token", { grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode, client_id: CLIENT_ID }, "Pairing poll");
    } catch {
      continue; // The car lost its connection for a moment.
    }
    if (response.ok && response.data?.access_token) {
      status.textContent = t("Paired.");
      return { token: response.data.access_token, deviceId: response.data.device_id };
    }
    const error = response.data?.error;
    if (error === "slow_down") interval += 5_000;
    else if (error === "access_denied") {
      status.textContent = t("The owner denied this device. A new code follows shortly.");
      await wait(5_000, signal);
      return null;
    } else if (error === "expired_token" || error === "invalid_grant") {
      return null;
    }
  }
  return null;
}

// The owner's passkey on this browser approves this page's own code.
function offerSelfPairing(userCode, { name, kind, onApproved }) {
  const box = element("pair-self");
  const button = element("pair-passkey");
  const status = element("pair-self-status");
  box.classList.remove("hidden");
  element("pair-title").textContent = t("Use Yolo in this browser");
  element("pair-lead").textContent = t("Open");
  status.textContent = "";
  button.disabled = false;
  void ownerSignedIn().then((signedIn) => {
    if (element("pair-code").textContent !== userCode) return;
    button.textContent = signedIn ? t("Pair this browser") : t("Sign in with passkey");
    button.dataset.signedIn = String(signedIn);
    if (!signedIn && !passkeysSupported()) {
      button.disabled = true;
      status.textContent = t("This browser cannot use passkeys; approve it from another device.");
    }
  });
  button.onclick = async () => {
    button.disabled = true;
    try {
      if (button.dataset.signedIn !== "true") {
        status.textContent = t("Waiting for your passkey…");
        await signInWithPasskey();
      }
      status.textContent = t("Pairing…");
      await owner.approvePairing(userCode, { name, kind });
      status.textContent = t("Paired.");
      onApproved();
    } catch (error) {
      // The session may be gone (signed out elsewhere): ask for the passkey next time.
      if (error?.status === 401) button.dataset.signedIn = "false";
      button.textContent = button.dataset.signedIn === "true" ? t("Pair this browser") : t("Sign in with passkey");
      status.textContent = error.message || String(error);
      button.disabled = false;
    }
  };
}
