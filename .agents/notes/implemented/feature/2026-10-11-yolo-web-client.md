# Agent Note: Yolo Web, a browser client with settings

Status: implemented

English | [中文](2026-10-11-yolo-web-client.zh.md)

## Problem

The player in the car was Yolo's only screen. On a computer or phone, the owner could not browse the library, play in the browser, or use the browser as a remote for the car. There was no settings page either: revoking an agent meant deleting its records from `OAUTH_KV` by hand, passkeys and devices could be managed only through `/v1` and MCP, and the car's display size sat as a row of percentage chips at the bottom of the home screen, where on a Mac it showed meaningless steps (100%, 77%, 68%, …).

## Decision

### One app with two profiles

The car's screen and Yolo Web are one app, the player ([`clients/player`](../../../../clients/player)), served at the site root as one bundle whose [`player.js`](../../../../clients/player/src/player.js) drives two playback engines ([two engines](../architecture/2026-10-12-two-playback-engines.md)). [`profile.js`](../../../../clients/player/src/profile.js) chooses a profile and sets it as `<html data-profile>`:

| | `car` | `web` |
|---|---|---|
| When | The owner's device type is "car", or, until Yolo has said the type, the [Tesla fingerprint](2026-10-07-device-code-pairing.md) matches | Every other type: a computer's or phone's browser |
| Display size | Offered in settings ([display size](2026-10-11-display-size.md)) | None: the browser's own zoom |
| Engine | The canvas engine | The canvas engine on a page the Tesla fingerprint recognizes; otherwise the browser's `<video>` element, or the canvas engine when only that runs |
| Capabilities in `hello` | `CAR_CANVAS_CAPABILITIES` | `CAR_CANVAS_CAPABILITIES` on a page the Tesla fingerprint recognizes; otherwise `WEB_NATIVE_CAPABILITIES` with the browser's codecs and a `maxHeight` of 2160, 1440, 1080, or 720 by display (`displayMaxHeight`), `WEB_CANVAS_CAPABILITIES` with the canvas engine, or `REMOTE_CAPABILITIES` when the browser can play with neither ([capability negotiation](../architecture/2026-10-07-capability-negotiation.md)) |
| A tap on an item | Plays on this screen | Plays where playback is now (below) |
| Pairing | The QR code first | The owner's passkey first, the code as the way from another device |

The owner's type (chosen when pairing, or later in settings) wins over the fingerprint for the profile (the layout, the display size, and where a tap plays) and is remembered for the next visit; a change applies to the layout at once. The type does not decide the engine of a page the Tesla fingerprint recognizes: such a page always plays with the canvas engine and announces `CAR_CANVAS_CAPABILITIES`, so the type cannot correct a false match there ([two engines](../architecture/2026-10-12-two-playback-engines.md)). On any other page a change of type applies to the engine from the next stream and to the capabilities from the next connection. COOP/COEP on every page of the app and the autoplay rule (muted with "Tap for sound" when the browser blocks sound) hold in both profiles; canvas rendering is the car's.

### Layout across window sizes

- **The car**, about 773×601 CSS pixels at a pixel ratio of 1.53, lays the page out 946 pixels wide at the default display size. A slim header (the Yolo mark, Ask, and Ask's microphone on the left, where the driver reaches them, then search and settings) sits above the rows; settings open as a sheet over the right two thirds of the window (`min(620px, 66cqw)`). The browser window ends above the car's app dock, so nothing is kept clear of it ([design principles](../architecture/2026-07-13-in-car-design-principles.md)).
- **A computer** shows the same rows with wider gutters, search centred and at most 560 pixels wide, settings as a sheet from the right edge (`clamp(380px, 42cqw, 560px)`), and the now-playing bar floating at most 960 pixels wide.
- **A phone** (640 pixels or narrower) shows the mark without its word, settings over the whole window, the device picker as a bottom sheet, and the now-playing bar with the device's name only; rows put their actions under their text instead of squeezing it.

### Where a tap plays

[`play-target.js`](../../../../clients/player/src/play-target.js) decides. The car plays on itself: it is the screen in front of the people in it. Yolo Web plays where playback is now, as Spotify Connect does: on the device that is playing or paused, when that is another online device, so a phone or computer used as a remote never takes playback away by accident; with nothing playing elsewhere, it plays in this browser. A browser that cannot play sends the tap to the last device that played, or to the only other online device; with several, the owner picks one.

### The remote

While another device plays, the home screen shows a now-playing bar ([`remote.js`](../../../../clients/player/src/remote.js)): the item, "Playing on" the device, a progress line extrapolated from the Hub's `position` and `positionAt`, back 10 seconds, play/pause, next in queue, and a device picker that moves playback with `PUT /v1/playback/device`, to this browser too when it can play. Every command goes over `/v1` with this device's credential; the bar only reads the Hub's `state`, `queue`, and `devices` broadcasts and never answers them ([Hub](../architecture/2026-10-07-hub-and-realtime-channel.md)).

### Search

The header's search field queries `/v1/library/search` as the owner types (after 300 ms, from two characters); a pasted http(s) link offers **Play link** and **Add to queue**, and a source plugin claims it when it plays.

### Settings

Settings are a modal sheet at `/settings` ([`settings.js`](../../../../clients/player/src/settings.js)), opened from the gear in the home header, in three groups:

- **This screen**: the name and type Yolo has for this device, the display size (car only), **Danmaku** with its density, area, opacity, and text size ([danmaku](2026-10-13-danmaku.md)), **Play over the home network** with what this screen's last probe found ([LAN direct play](2026-10-12-lan-direct-play.md)), **Ask with**, the agent this screen's Ask asks, and **Microphone**, a check for asking by voice ([screens ask the owner's own agent](2026-10-18-agent-from-the-screen.md)), and **Forget this screen** (`DELETE /v1/devices/self`), which unpairs it. The device credential is enough for these.
- **Your Yolo**: devices (rename with the type as a segmented choice, remove), connected agents (one row per OAuth client, revoke) and **Reset image links**, which makes every cover link agents were given stop working ([cover images](2026-10-07-remote-mcp-server.md#cover-images)), passkeys (list, add another, remove all but the last), the home network's status (the node's LAN name, address, and certificate, with a check now), and signing out. They use the [owner routes](../architecture/2026-10-07-v1-http-api.md#owner-routes) behind the owner's passkey session, never the device credential. Signing in runs WebAuthn on the page with the existing `/auth/passkey/*` endpoints, so playback is not interrupted; the car, whose browser may not do passkeys, also shows a QR code that opens these settings on a phone.
- **About**: the version and commit, the media node's state and version, and `/diag`.

The sheet works with touch and with a keyboard: 48 px targets, nothing that needs hover, focus kept inside, Escape and a visible Close (and a tap beside the sheet) to leave, and back closes it. A destructive action asks once more in place ("Remove?") instead of opening another dialog.

### Pairing a browser

A browser pairs with the same device grant as the car ([device code pairing](2026-10-07-device-code-pairing.md)). In the web profile the pairing screen leads with the owner's passkey: signed in on this browser (or after signing in there), one press approves the page's own code through `POST /v1/owner/pairing/approve`. It is the same single-use, 10-minute code and the same explicit approval, without a second device; another site cannot make the request (the owner routes' same-origin checks).

### Starting up

A paired screen never waits for its realtime channel before it shows something, and never says "Connecting…". It keeps what it shows in `localStorage`, for the paired device only (`yolo.home.<device id>`, [`home-cache.js`](../../../../clients/player/src/home-cache.js)): the home screen's rows (the queue, playlists, Continue Watching, and the libraries' rows, each at most 200 items, the libraries dropped first when the record would pass 1.5 MB), the Hub's last `state`, and Yolo's devices, written a second after a change in what a start would show (not for a position alone) and when the page is hidden or goes away. Unpairing or forgetting the screen deletes it, and a write it still had pending never brings it back. A record a start cannot draw (a shape the release does not read) is deleted too, and the page starts as with nothing kept, the device's events saying `start_cache_failed`; it connects either way. Before the first paint, the first script of [`index.html`](../../../../clients/player/index.html) looks for the credential and that record and sets `<html data-boot>`; [`main.js`](../../../../clients/player/src/main.js) then shows the first screen while the channel connects:

- **With a record (a warm start):** the home screen as it was, with the now-playing bar from the kept state, still (its line does not run on). When the kept state says this screen would resume an item, as [`resume-decision.js`](../../../../clients/player/src/resume-decision.js) decides for a returning page, it shows that item's loading screen, with its artwork, instead. Yolo's answers then replace the rows in place: a row whose items are the same is not drawn again, so nothing flickers or loads its artwork twice.
- **Without one (a cold start):** the first open in a browser, or after its storage was cleared. The page paints the launch mark ([`launch.js`](../../../../clients/player/src/launch.js)): the Yolo mark comes up dim, one band of light crosses it, and it is lit, under a faint glow, in under a second; with reduced motion it shows lit and still. It has no minimum: the first screen with something to show (the welcome's resume, the home screen, a show, pairing, or a message) ends it with a 360 ms fade. A welcome later than 1.2 seconds after the start brings the home screen with skeletons instead.

Everything shown before the welcome is for looking only. Where a tap plays, what a returning page resumes, the kept player, and missed commands read only the welcome. A tap on an item before it waits for it, then decides where to play ([`welcome-wait.js`](../../../../clients/player/src/welcome-wait.js)): only the latest tap waits, its card held pressed, with the loading ring past the ring's delay; one made meanwhile takes its place, and one whose wait fails is dropped: when the channel stops or the screen pairs again, quietly; when no welcome comes within the 20 seconds a request waits for one, with the home screen's one-line notice "Yolo did not answer in time. Try again." In the car, which always plays on itself, the item's loading screen shows at once, and its request waits for the welcome as every request does ([wake request ordering](../bug-fix/2026-10-11-wake-request-ordering.md)). Such a tap wins over resuming: the first welcome after it, of the page or since it paired again, resumes nothing. The bar's buttons work the same way: the latest press waits, its button dimmed. Settings opened meanwhile know this screen by its credential. The home's data is asked for once for a start and its welcome: the requests leave with the start, and the load that welcome brings uses their answers, but keeps the queue and playlists the welcome sent, which are newer. A welcome that resumes an item or plays a tap drops those answers, so Back from that item asks Yolo again. Every load of the home screen (a start, Back from the player, a reconnect) shows it at once, its rows as they were until new ones replace them; a reconnect's load keeps where it is scrolled. A start on a show's address shows its episodes without waiting for the libraries' rows behind them.

Connecting and reconnecting show nothing over the content. A channel down for 4 seconds ([`connection-indicator.js`](../../../../clients/player/src/connection-indicator.js)) dims the home header's mark, with a small amber dot on its corner, and says so to screen readers; the next welcome clears it. The player and its loading screen show no such mark: playback goes on, and its requests wait for the channel. Only what needs the owner keeps a screen of its own: pairing, which shows the QR plate, the code, and the address as placeholders while it asks Yolo for a code; another window that plays now, whose **Take over here** then waits with the loading ring alone; and errors.

Waiting looks the same everywhere: the launch mark on a cold start, skeletons where items are on their way, with a soft shimmer that crosses a row card after card (still in the car: [design principles](../architecture/2026-07-13-in-car-design-principles.md)), and the item's artwork under the loading ring from a tap until the picture moves ([device telemetry](2026-10-11-device-telemetry.md)). No screen says "Connecting…" or "Loading…".

Measured on the end-to-end stack with 150 ms added to every request, roughly a mobile connection, the median of five reloads in the browser's window and the car's: a reload showed "Connecting…" for 0.7 seconds and the home screen's items after 1.2. A warm start now shows them at 0.56 seconds, just after the first paint, and a cold one at 0.92, with the welcome. A car waking into playback shows the item's loading screen at 0.75 seconds, where it showed it at 1.14, after 0.9 seconds of "Connecting…".

### Testing

[`test/e2e/web-playback.test.js`](../../../../test/e2e/web-playback.test.js) covers playback through the `<video>` engine, Back into the now-playing bar, pairing with the passkey plus playback at 1440×900 and at a phone's 390×844, and owner settings behind the passkey session (a device credential and a cross-site request are refused; rename, revoke an agent, the last passkey kept, sign out). A unit test covers the engine each profile chooses, and the control plane's unit tests the owner routes. [`start-up.test.js`](../../../../clients/player/test/unit/start-up.test.js) covers the kept record (one device's, what `index.html`'s first script finds, its size bound, and that unpairing deletes it for good), the press that waits for the welcome, and the connection mark's delay. The browser's reload after Back, and the car's wake, show the home screen and the bar, or the loading screen, from what the page kept before the welcome, then Yolo's own; a record the page cannot draw starts it cold; Back after the wake shows Yolo's history, not the start's; and the car, removed after a tap and paired again, shows its home screen.

## Alternatives considered

**A device plugin for the web client.** Both phase-one clients are Yolo's own and speak the same protocol, so the realtime channel stays in the core; an interface with a single implementation could not be designed well.

**A separate web app.** Since software 2026.26 the car's browser presents itself as desktop Chrome, so the server cannot route a car and a computer to different apps; two apps would also duplicate the shell, pairing, and realtime code and drift apart. One app chooses its profile on the device instead.

**Cookie authentication on `/v1`, so a signed-in browser needs no pairing.** It would expose every `/v1` route to cross-site requests and break the one-token model of the [OAuth server](../architecture/2026-10-07-oauth-authorization-server.md). Every browser is a paired device instead; the owner's session serves only owner settings and approving the browser's own code.

**Owner settings on the server-rendered `/account` page.** Settings have to work in the car as a touch sheet over the home screen without leaving playback, and they show what only the client knows (this device, its display size). The server-rendered pages keep the flows that must work before a device is paired: sign-in, approving a pairing, and an agent's consent ([owner web pages](../architecture/2026-10-12-owner-web-pages.md)).

**A tap always plays on this screen.** A phone used as a remote would take playback away from the car whenever someone browsed on it.

**A splash screen until the welcome.** It hides the wait instead of removing it: the ticket, the socket, the hello, and the welcome take three or four round trips before anything could show, 0.7 seconds of "Connecting…" at 150 ms each. What the screen kept shows at once, and the welcome only confirms or replaces it.

**Treating the kept state as Yolo's.** A tap would play where the kept state said, possibly on a device that has stopped since, and a returning page would resume, or apply missed commands, from a state hours old. The kept state only shows; the welcome decides.

## Consequences

The owner can browse, search, play, and control any screen from a computer or phone, manage devices, agents, and passkeys without touching `OAUTH_KV`, and pair a browser with a passkey alone. The car's behavior is unchanged: it plays on itself, keeps its canvas rendering, and finds its display size in settings. Safari on iPhone and iPad, which cannot run the canvas engine, plays through its own `<video>` element; only a browser that can play with neither engine is a remote. The profile follows the owner's type for the device, so a car paired as a browser loses its display size until its type is set to car in settings; it still plays with the canvas engine ([two engines](../architecture/2026-10-12-two-playback-engines.md)). Sources and plugins are not managed in settings yet; they stay in `yolo.config.json` on the node. A start shows what the screen kept, which can be a little behind: a row or the bar may change once Yolo answers, and the loading screen a start showed for an item Yolo no longer resumes gives way to the home screen. The browser's storage holds titles and artwork links of what the owner watched there, beside the device credential it already held.
