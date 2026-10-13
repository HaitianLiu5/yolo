# Agent Note: Pair screens with a QR device code

Status: implemented

English | [中文](2026-10-07-device-code-pairing.zh.md)

## Problem

A car's screen needs a credential of its own, but typing a password on it is impractical, it has no camera, and a pop-up sign-in cannot work on the cross-origin isolated player page ([canvas engine](../architecture/2026-04-04-canvas-playback-engine.md)). Any code-based pairing invites device-code phishing: someone could start a pairing on their own device and talk the owner into approving it. A screen must also be removable at once, and Tesla's browser no longer says that it is a Tesla.

## Decision

New screens pair with the OAuth 2.0 Device Authorization Grant (RFC 8628), which `workers-oauth-provider` lacks, so the control plane implements it in [`service/control/src/auth/device.js`](../../../../service/control/src/auth/device.js), with codes and credentials in `store/pairing.js` and the client side in [`clients/tesla/src/pairing.js`](../../../../clients/tesla/src/pairing.js):

1. The device sends `POST /oauth/device_authorization` (form or JSON; any `client_id`, plus Yolo's `device_name` and `device_kind`) and receives `device_code`, a `user_code` (`XXXX-XXXX` from the consonants `BCDFGHJKLMNPQRSTVWXZ`), `verification_uri`, `verification_uri_complete`, `expires_in: 600`, and `interval: 5`. It shows `verification_uri_complete` as a QR code plus the short code as a fallback. Before the owner has registered a passkey, the request is refused.
2. The owner scans the QR code with a phone, which opens `/device?code=…`, and signs in with a passkey if needed; the sign-in page shows which screen asks. The approval page shows, prominently, the short code the screen should show and when the device asked; the device's name and type in Yolo (car, browser, phone, TV, other) as one editable step that starts from the device's own guess; and **Allow**, which the owner must press. Afterwards it says what happens next ([owner web pages](../architecture/2026-10-12-owner-web-pages.md)). The approval accepts only same-origin submissions.
3. The device polls `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` at the given interval and gets RFC 8628's `authorization_pending`, `slow_down`, `access_denied`, or `expired_token`. After approval it receives its **device credential**, `{ access_token: "ydt_…", token_type: "Bearer", device_id }`, exactly once. A code works once and expires after 10 minutes.
4. Approval creates the device record with the owner's chosen name and type; a later `hello` does not overwrite them, and renaming uses `PATCH /v1/devices/:id` or the `rename_device` tool. The credential does not expire, D1 stores only its hash (`device_tokens`), and every request checks D1 (`resolveExternalToken`), so revocation takes effect immediately. It carries what a playback device needs: the three `/v1` scopes and realtime tickets; it cannot use `/mcp`, the owner's settings routes, or rename or remove other devices, but it can forget itself (`DELETE /v1/devices/self`). Its realtime connection is bound to its own device, so `hello` cannot claim another.
5. Revocation: removing the device in Yolo's settings, `DELETE /v1/devices/:id`, the `remove_device` tool, or the device forgetting itself deletes the device and its credential, the Hub closes its connections with code 4003, and the screen returns to the pairing screen.

The authorization server metadata advertises `device_authorization_endpoint` and the device-code grant type.

**A browser can approve its own code.** In a computer's or phone's browser ([Yolo Web](2026-10-11-yolo-web-client.md)), the owner signed in with a passkey on that browser approves the page's own pending code with one press, through `POST /v1/owner/pairing/approve` ([owner routes](../architecture/2026-10-07-v1-http-api.md#owner-routes)). It is the same single-use, 10-minute code and an explicit approval by the owner's passkey session, without scanning from a second device; another site cannot send the request.

### Guessing the device's name and type

The device's own guess is the default name and type on the approval page, where the owner can change both. A page the fingerprint recognizes as a Tesla also plays with the canvas engine and announces `TESLA_CANVAS_CAPABILITIES` in `hello`, whatever type the owner chooses; the type decides only its layout and where a tap plays ([two engines](../architecture/2026-10-12-two-playback-engines.md)). From software 2026.26, Tesla's browser sends the user agent of desktop Chrome on Linux, without "Tesla", from a "Cisco IoT" network, so the user agent alone cannot identify a car. [`clients/tesla/src/device-fingerprint.js`](../../../../clients/tesla/src/device-fingerprint.js) first checks the user agent (older software includes `Tesla`, `QtWebEngine`, or `QtCarBrowser`) and otherwise scores the screen: `devicePixelRatio` 1.45–1.65 (2 points), `innerWidth` 700–850 (2), `innerHeight` 520–680 (2), `screen.width` 1150–1400 (1), `screen.height` 700–870 (1), `visualViewport.scale` about 1 (1), `innerWidth / screen.width` 0.55–0.68 (2; Tesla's own interface takes about 38% of the width), a screen aspect ratio of 1.50–1.68 (2), and desktop Chrome (1). Nine of 14 points mean a car ("Tesla", `car`); otherwise the browser names itself by browser and system ("Chrome on Mac", "Safari on iPhone"), with the type `phone` when its user agent says it is a phone and `browser` otherwise. The thresholds and signals follow the community project teodorstavrov/Tesla-Waze-4 (`src/lib/browser.ts`). The owner's car measured `innerWidth` 773, `innerHeight` 601, DPR 1.53, and a 1254×784 screen, a full score. In full-screen mode the width and width ratio no longer match and the score can fall below the threshold; the score breakdown is reported in the `env` event ([device telemetry](2026-10-11-device-telemetry.md)) so the rules can be tuned on real data ([proposal](../../proposed/feature/2026-10-11-tesla-detection-from-car-telemetry.md)).

## Alternatives considered

**Only a short code typed by hand.** Scanning saves typing on any device; the car has no camera, so the car shows the code and the phone scans it. The short code remains as the fallback for typing at `/device`.

**Signing in on the car's screen.** Typing a password there is impractical, and a pop-up sign-in cannot work on the player page.

## Consequences

Pairing takes a scan and one tap, and the phishing guard is the approval page itself: the device's details shown prominently, a 10-minute single-use code, and an explicit Allow. Device credentials never expire or rotate and are revoked only by removing the device, which suits one owner with a few screens of their own. Detection of the car is heuristic and can mislabel a screen. The type the owner chooses at approval corrects the layout and where a tap plays, and a car the fingerprint misses plays with the canvas engine once its type is car; a browser the fingerprint wrongly takes for a Tesla keeps the canvas engine and `TESLA_CANVAS_CAPABILITIES` (at most 720p) whatever its type.
