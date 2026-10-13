# Agent Note: Yolo Web, a browser client with settings

Status: implemented

English | [中文](2026-10-11-yolo-web-client.zh.md)

## Problem

The Tesla client was Yolo's only screen. On a computer or phone, the owner could not browse the library, play in the browser, or use the browser as a remote for the car. There was no settings page either: revoking an agent meant deleting its records from `OAUTH_KV` by hand, passkeys and devices could be managed only through `/v1` and MCP, and the car's display size sat as a row of percentage chips at the bottom of the home screen, where on a Mac it showed meaningless steps (100%, 77%, 68%, …).

## Decision

### One app with two profiles

Yolo Web and the Tesla client (Drive-In) are one app, [`clients/tesla`](../../../../clients/tesla), served at the site root with one bundle and one player over two playback engines ([two engines](../architecture/2026-10-12-two-playback-engines.md)). [`profile.js`](../../../../clients/tesla/src/profile.js) chooses a profile and sets it as `<html data-profile>`:

| | `car` | `web` |
|---|---|---|
| When | The owner's device type is "car", or, until Yolo has said the type, the [Tesla fingerprint](2026-10-07-device-code-pairing.md) matches | Every other type: a computer's or phone's browser |
| Display size | Offered in settings ([display size](2026-10-11-display-size.md)) | None: the browser's own zoom |
| Engine | The canvas engine | The browser's `<video>` element; the canvas engine when only that runs |
| Capabilities in `hello` | `TESLA_CANVAS_CAPABILITIES` | `WEB_NATIVE_CAPABILITIES` with the browser's codecs (up to 1080p), `WEB_CANVAS_CAPABILITIES` with the canvas engine, or `REMOTE_CAPABILITIES` when the browser can play with neither ([capability negotiation](../architecture/2026-10-07-capability-negotiation.md)) |
| A tap on an item | Plays on this screen | Plays where playback is now (below) |
| Pairing | The QR code first | The owner's passkey first, the code as the way from another device |

The owner's type (chosen when pairing, or later in settings) wins over the fingerprint and is remembered for the next visit; a change applies to the layout at once, to the engine from the next stream, and to the capabilities from the next connection. COOP/COEP on every page of the app and the autoplay rule (muted with "Tap for sound" when the browser blocks sound) hold in both profiles; canvas rendering is the car's.

### Layout across window sizes

- **The car**, about 773×601 CSS pixels at a pixel ratio of 1.53, lays the page out 946 pixels wide at the default display size. A slim header (the Yolo mark, search, settings) sits above the rows; settings open as a sheet over the right two thirds of the window (`min(620px, 66cqw)`). The browser window ends above the car's app dock, so nothing is kept clear of it ([design principles](../architecture/2026-07-13-in-car-design-principles.md)).
- **A computer** shows the same rows with wider gutters, search centred and at most 560 pixels wide, settings as a sheet from the right edge (`clamp(380px, 42cqw, 560px)`), and the now-playing bar floating at most 960 pixels wide.
- **A phone** (640 pixels or narrower) shows the mark without its word, settings over the whole window, the device picker as a bottom sheet, and the now-playing bar with the device's name only; rows put their actions under their text instead of squeezing it.

### Where a tap plays

[`play-target.js`](../../../../clients/tesla/src/play-target.js) decides. The car plays on itself: it is the screen in front of the people in it. Yolo Web plays where playback is now, as Spotify Connect does: on the device that is playing or paused, when that is another online device, so a phone or computer used as a remote never takes playback away by accident; with nothing playing elsewhere, it plays in this browser. A browser that cannot play sends the tap to the last device that played, or to the only other online device; with several, the owner picks one.

### The remote

While another device plays, the home screen shows a now-playing bar ([`remote.js`](../../../../clients/tesla/src/remote.js)): the item, "Playing on" the device, a progress line extrapolated from the Hub's `position` and `positionAt`, back 10 seconds, play/pause, next in queue, and a device picker that moves playback with `PUT /v1/playback/device`, to this browser too when it can play. Every command goes over `/v1` with this device's credential; the bar only reads the Hub's `state`, `queue`, and `devices` broadcasts and never answers them ([Hub](../architecture/2026-10-07-hub-and-realtime-channel.md)).

### Search

The header's search field queries `/v1/library/search` as the owner types (after 300 ms, from two characters); a pasted http(s) link offers **Play link** and **Add to queue**, and a source plugin claims it when it plays.

### Settings

Settings are a modal sheet at `/settings` ([`settings.js`](../../../../clients/tesla/src/settings.js)), opened from the gear in the home header, in three groups:

- **This screen**: the name and type Yolo has for this device, the display size (car only), **Play over the home network** with what this screen's last probe found ([LAN direct play](2026-10-12-lan-direct-play.md)), and **Forget this screen** (`DELETE /v1/devices/self`), which unpairs it. The device credential is enough for these.
- **Your Yolo**: devices (rename with the type as a segmented choice, remove), connected agents (one row per OAuth client, revoke), passkeys (list, add another, remove all but the last), the home network's status (the node's LAN name, address, and certificate, with a check now), and signing out. They use the [owner routes](../architecture/2026-10-07-v1-http-api.md#owner-routes) behind the owner's passkey session, never the device credential. Signing in runs WebAuthn on the page with the existing `/auth/passkey/*` endpoints, so playback is not interrupted; the car, whose browser may not do passkeys, also shows a QR code that opens these settings on a phone.
- **About**: the version and commit, the media node's state and version, and `/diag`.

The sheet works with touch and with a keyboard: 48 px targets, nothing that needs hover, focus kept inside, Escape and a visible Close (and a tap beside the sheet) to leave, and back closes it. A destructive action asks once more in place ("Remove?") instead of opening another dialog.

### Pairing a browser

A browser pairs with the same device grant as the car ([device code pairing](2026-10-07-device-code-pairing.md)). In the web profile the pairing screen leads with the owner's passkey: signed in on this browser (or after signing in there), one press approves the page's own code through `POST /v1/owner/pairing/approve`. It is the same single-use, 10-minute code and the same explicit approval, without a second device; another site cannot make the request (the owner routes' same-origin checks).

### Testing

[`test/e2e/yolo-web.test.js`](../../../../test/e2e/yolo-web.test.js) covers owner settings behind the passkey session (a device credential and a cross-site request are refused; rename, revoke an agent, the last passkey kept, sign out), a browser that pauses the car, takes playback over, and hands it back, and pairing with the passkey plus playback at 1440×900 and at a phone's 390×844. [`test/e2e/native-video.test.js`](../../../../test/e2e/native-video.test.js) covers playback through the `<video>` engine. [`test/e2e/display-scale.test.js`](../../../../test/e2e/display-scale.test.js) covers settings and the display size in the car's profile and their absence on a computer. Unit tests cover the profile, where a tap plays, and the owner routes.

## Alternatives considered

**A device plugin for the web client.** Both phase-one clients are Yolo's own and speak the same protocol, so the realtime channel stays in the core; an interface with a single implementation could not be designed well.

**A separate web app.** Since software 2026.26 the car's browser presents itself as desktop Chrome, so the server cannot route a car and a computer to different apps; two apps would also duplicate the shell, pairing, and realtime code and drift apart. One app chooses its profile on the device instead.

**Cookie authentication on `/v1`, so a signed-in browser needs no pairing.** It would expose every `/v1` route to cross-site requests and break the one-token model of the [OAuth server](../architecture/2026-10-07-oauth-authorization-server.md). Every browser is a paired device instead; the owner's session serves only owner settings and approving the browser's own code.

**Owner settings on the server-rendered `/account` page.** Settings have to work in the car as a touch sheet over the home screen without leaving playback, and they show what only the client knows (this device, its display size). The server-rendered pages keep the flows that must work before a device is paired: sign-in, approving a pairing, and an agent's consent ([owner web pages](../architecture/2026-10-12-owner-web-pages.md)).

**A tap always plays on this screen.** A phone used as a remote would take playback away from the car whenever someone browsed on it.

## Consequences

The owner can browse, search, play, and control any screen from a computer or phone, manage devices, agents, and passkeys without touching `OAUTH_KV`, and pair a browser with a passkey alone. The car's behavior is unchanged: it plays on itself, keeps its canvas rendering, and finds its display size in settings. Safari on iPhone and iPad, which cannot run the canvas engine, plays through its own `<video>` element; only a browser that can play with neither engine is a remote. The profile follows the owner's type for the device, so a car paired as a browser loses its display size until its type is set to car in settings; it still plays with the canvas engine ([two engines](../architecture/2026-10-12-two-playback-engines.md)). Sources and plugins are not managed in settings yet; they stay in `yolo.config.json` on the node.
