# Agent Note: The player on smart TVs' own web engines

Status: proposed

English | [中文](2026-10-26-tv-web-client.zh.md)

## Problem

A smart TV that runs Samsung's Tizen or LG's webOS has a web engine but no Yolo client. The [native Apple TV app](2026-10-19-apple-tv-client.md) exists because tvOS has no web engine; these TVs do, so the player itself can run on them. Three things stand in the way, all found on a Samsung QN90B (2022, Tizen 6.5).

- **No way in.** A TV has no browser bar the owner would type Yolo's address into; an installed app has to open it.
- **No pointer.** The remote has arrows, OK, Back, and media keys. The player is built for touch and a mouse: without focus movement nothing on the home screen can be reached, and Back does nothing.
- **An old engine.** Tizen 6.5's engine is Chromium 85. The player's CSS uses `oklch()` colors (Chrome 111), container units (105), `:has()` (105), `inset` (87), and `aspect-ratio` (88), and its JavaScript `replaceChildren` (86), `Array.prototype.at` (92), and `structuredClone` (98). On that engine the page renders white, the pairing screen falls apart, and card artwork has no height. A `<button>` positioned absolutely does not stretch between `left` and `right` there either.

Playback is not in the way: in the web profile `<video>` with hls.js over Media Source Extensions played a 1080p H.264 stream by LAN direct play with no dropped frames, with sound and text subtitles ([two engines](../../implemented/architecture/2026-10-12-two-playback-engines.md), [LAN direct play](../../implemented/feature/2026-10-12-lan-direct-play.md)).

## Proposal

The TV runs the same player Yolo serves at its site root, opened by a small installed app and adapted in three places.

**The Tizen app.** `clients/tizen/` holds a Tizen web app (`config.xml`, a page, and `main.js`) that registers the remote's media keys, which only an installed app's own page can, and then replaces itself with the instance's player. The instance's address is not committed: `node clients/tizen/build.js --origin https://<instance>` writes it into `origin.js` and signs `dist/Yolo.wgt` with the Tizen CLI's active profile. In developer mode a self-signed Tizen author certificate installs it; no Samsung account is needed. Everything else the TV shows comes from the instance, so a Worker deploy updates the TV with every other screen.

**Pairing as a TV.** `guessDevice` recognizes a smart TV's engine before the browser and system names, which these engines also carry (Tizen's user agent names Safari and Linux): Tizen pairs as "Samsung TV" and webOS as "LG TV", both `kind: "tv"`.

**The remote** (`clients/player/src/tv-remote.js`), on a screen paired as a TV or in a TV's engine before it pairs:

- The arrows move focus to the nearest control in their direction on the layer on top: an open dialog, the home screen, or the player's controls when they are up. Left and right stay in their row and stop at its end; up and down take the nearest control below or above, a sideways offset costing twice the distance. A row's mouse-only scroll arrows are skipped, and a row scrolls as focus moves along it.
- Focus entering a page goes back to where it last was on that page, else to the first card.
- OK presses the focused control as the browser does, and picks a radio choice; on a radio group left and right pick the next choice.
- Back closes the dialog on top, then hides the player's controls, then leaves the player for the home screen, then leaves a show's page; in a text field it leaves the field.
- Over the picture with the controls hidden, left and right seek as a computer's arrows do (`controls.js`), and up, down, and OK bring the controls up with focus on play.
- The media keys play, pause, seek, skip, and stop. Tizen's Back and media keys are read by key code, since its key names vary.

**The old engine.** The player gains a compatibility layer for engines as old as Chromium 85, so every page in the TV loads with it, not only one opened through a debugger: the missing JavaScript methods as a polyfill module imported first, and the CSS lowered at build time, with `oklch()` values converted to sRGB under `@supports not (color: oklch(0% 0 0))` so newer browsers keep their colors, container units mapped to viewport units, `inset` and the logical box properties expanded, and `aspect-ratio` kept by a script that sizes matching elements on old engines only. Its exact shape is the open part of this proposal; the layer injected over the TV's debugger during development proved each item above.

### Stages

1. The Tizen app, pairing as a TV, and the remote. Built: on the QN90B, through the debugger, arrows, OK, and Back move through the home screen, a show's episodes, settings, and the player's controls.
2. The compatibility layer in the player's build, so the app works when opened from the TV's home screen.
3. A clearer focus ring for a room's viewing distance, 4K streams (the engine reports a 1920×1080 viewport, so `maxHeight` is 1080 today), and an LG webOS app.

## Alternatives considered

**A native Tizen app over Samsung's AVPlay.** It would play with the TV's own player and reach 4K and HDR, but it rewrites the client protocol, browsing, subtitles, and danmaku for one vendor's API, as the Apple TV app must because tvOS has no web engine. These TVs have one, so the player runs as it is and gains every later feature with each deploy.

**Packaging the built player inside the `.wgt`.** The page would load offline and could carry its own polyfills, but its origin would be the app's, not Yolo's, so the same-origin rules for `/m/*` and the realtime channel, the device credential in storage, and COOP/COEP would all need exceptions, and every Yolo release would need a new install on the TV. Opening the instance's own page keeps one player and one origin.

**An Android TV box on the TV's HDMI input.** It runs a current Chromium or a native app, so none of this compatibility work would be needed, but it adds hardware the owner has to buy, and the TV's own system stays without Yolo. A native Android TV app may still follow for its own reasons.

**The engine's spatial navigation.** Chromium's built-in spatial navigation is a browser setting, not something a page turns on, and it knows nothing of the player's layers: it would move focus into the hidden controls behind the home screen, which this engine cannot mark `inert` (Chrome 102).

## Acceptance criteria

- Opening Yolo from the TV's home screen shows the player in its dark theme with posters at their shape, pairs as a TV by QR code or code, and plays by LAN direct play.
- Every screen of the home screen, a show's page, settings, and the player can be reached and used with the remote alone, and Back always leads toward the home screen.
- Newer browsers render exactly as before the compatibility layer, and `npm run check` passes.

## Risks

- **The compatibility layer is a second rendering path.** Each new CSS feature or JavaScript method the player adopts can break the TV again. A build check that lists features newer than the oldest supported engine would catch them; without one, breakage shows only on a TV.
- **Developer-mode installs.** Installing needs the TV's developer mode with this Mac's address and a TV restart, and the Tizen CLI. Publishing to Samsung's store would remove that, with Samsung's review and certificate.
- **Media keys may not reach the page.** Only the installed app's own page can register them; whether the registration holds after it hands the window to the instance's page is unverified.
- **1080p.** The engine reports a 1920×1080 viewport on a 4K panel, so the player asks for 1080p; 4K needs the TV's own player or a way to read the panel's size.
