# Agent Note: The player on smart TVs' own web engines

Status: proposed

English | [中文](2026-10-26-tv-web-client.zh.md)

## Problem

A smart TV that runs Samsung's Tizen or LG's webOS has a web engine but no Yolo client. The [native Apple TV app](2026-10-19-apple-tv-client.md) exists because tvOS has no web engine; these TVs do, so the player itself can run on them. Three things stand in the way, all found on a Samsung QN90B (2022, Tizen 6.5).

- **No way in.** A TV has no browser bar the owner would type Yolo's address into; an installed app has to open it.
- **No pointer.** The remote has arrows, OK, Back, and media keys. The player is built for touch and a mouse: without focus movement nothing on the home screen can be reached, and Back does nothing.
- **An old engine.** Tizen 6.5's engine is Chromium 85. The player's CSS uses `oklch()` colors (Chrome 111), container units (105), `:has()` (105), `inset` (87), and `aspect-ratio` (88), and its JavaScript `replaceChildren` (86), `Array.prototype.at` (92), and `structuredClone` (98). On that engine the page renders white, the pairing screen falls apart, and card artwork has no height. A `<button>` positioned absolutely does not stretch between `left` and `right` there either.

Playback is not in the way: in web mode `<video>` with hls.js over Media Source Extensions played a 1080p H.264 stream by LAN direct play with no dropped frames, with sound and text subtitles ([two engines](../../implemented/architecture/2026-10-12-two-playback-engines.md), [LAN direct play](../../implemented/feature/2026-10-12-lan-direct-play.md)).

## Proposal

The TV runs the same player Yolo serves at its site root, opened by a small installed app and adapted in three places.

**The Tizen app.** `clients/tizen/` holds a Tizen web app (`config.xml`, a page, and `main.js`) that registers the remote's media keys, which only an installed app's own page can, and then replaces itself with the instance's player. The instance's address is not committed: `node clients/tizen/build.js --origin https://<instance>` writes it into `origin.js` and signs `dist/Yolo.wgt` with the Tizen CLI's active profile. In developer mode a self-signed Tizen author certificate installs it; no Samsung account is needed. Everything else the TV shows comes from the instance, so a Worker deploy updates the TV with every other screen.

**Pairing as a TV.** `guessDevice` recognizes a smart TV's engine before the browser and system names, which these engines also carry (Tizen's user agent names Safari and Linux): Tizen pairs as "Samsung TV" and webOS as "LG TV", both `kind: "tv"`.

**The remote** (`clients/player/src/tv-remote.js`), on a screen paired as a TV or in a TV's engine before it pairs:

- The arrows move focus to the nearest control in their direction on the layer on top: an open dialog, an agent's choices, the home screen, or the player's controls when they are up. Left and right stay in their row and stop at its end; up and down take the nearest control below or above, a sideways offset costing twice the distance. A row's mouse-only scroll arrows are skipped, and a row scrolls as focus moves along it.
- An agent's notes and pictures in a corner ([agent canvas](../architecture/2026-10-21-agent-canvas.md)) belong to the home screen's layer and the player controls' layer, and share no row with them, so past a row's end left and right cross between that layer and the notes. Choices take focus when they appear; when they go, focus goes back to where it was on the home screen, or leaves the player's controls hidden. The canvas draws its objects again only when they change, since the focused one would otherwise be lost each time the Hub's state arrives.
- Focus entering a page goes back to where it last was on that page, else to the first card.
- OK presses the focused control as the browser does, and picks a radio choice; on a radio group left and right pick the next choice.
- Back closes the dialog on top or dismisses an agent's choices, then hides the player's controls, then leaves the player for the home screen, then leaves a show's page; in a text field it leaves the field.
- Over the picture with the controls hidden, left and right seek as a computer's arrows do (`controls.js`), and up, down, and OK bring the controls up with focus on play.
- The media keys play, pause, seek, skip, and stop. Tizen's Back and media keys are read by key code, since its key names vary.

**The old engine.** The player builds for engines as old as Chromium 85 without changing what newer browsers draw. `vite.config.js` adds `chrome85` to the build's targets, so Vite lowers the JavaScript syntax and, through lightningcss, nesting, `:is()`, and the logical box properties. `clients/player/old-engine-css.js`, a PostCSS plugin, lowers what that leaves: an `oklch()` color inside sRGB becomes the same `rgb()` (all 54 of the player's are), `inset` becomes its four sides, a container-unit value gets a viewport-unit copy under `@supports not (width: 1cqw)` (#app, the container, fills the window unless the owner chose a display size), a `:focus-visible` rule gets a `:focus` copy under `@supports not selector(:focus-visible)`, and `aspect-ratio` gets `--yolo-aspect-ratio` beside it. `src/old-engine.js`, which `main.js` imports first, fills the missing methods (`replaceChildren`, `at`, `findLast`, `Object.hasOwn`, `structuredClone`, `AbortSignal.timeout` and `any`) only where an engine lacks them, and where `aspect-ratio` does not exist it sizes each box a rule with `--yolo-aspect-ratio` matches by its width and the ratio its computed style holds. `:has()` cannot be lowered; its few rules (the controls held up while focused, a card's hover actions) do nothing on such an engine. The card's whole-card button sets its width and height besides `inset: 0`, which Chromium 85 does not stretch a `<button>` by. Each item was proved on the QN90B by a layer injected over its debugger; the build as a whole is still to be loaded there.

### Stages

1. The Tizen app, pairing as a TV, and the remote. Built: on the QN90B, through the debugger, arrows, OK, and Back move through the home screen, a show's episodes, settings, and the player's controls.
2. The compatibility layer in the player's build, so the app works when opened from the TV's home screen. Built; not yet loaded on the TV.
3. A clearer focus ring for a room's viewing distance, 4K streams (the engine reports a 1920×1080 viewport, so `maxHeight` is 1080 today), and an LG webOS app.

## Alternatives considered

**A native Tizen app over Samsung's AVPlay.** It would play with the TV's own player and reach 4K and HDR, but it rewrites the client protocol, browsing, subtitles, and danmaku for one vendor's API, as the Apple TV app must because tvOS has no web engine. These TVs have one, so the player runs as it is and gains every later feature with each deploy.

**Packaging the built player inside the `.wgt`.** The page would load offline and could carry its own polyfills, but its origin would be the app's, not Yolo's, so the same-origin rules for `/m/*` and the realtime channel, the device credential in storage, and COOP/COEP would all need exceptions, and every Yolo release would need a new install on the TV. Opening the instance's own page keeps one player and one origin.

**An Android TV box on the TV's HDMI input.** It runs a current Chromium or a native app, so none of this compatibility work would be needed, but it adds hardware the owner has to buy, and the TV's own system stays without Yolo. A native Android TV app may still follow for its own reasons.

**Vite's CSS target alone.** With `chrome85` in the targets, lightningcss lowers most colors and selectors, but it leaves container units, `:focus-visible`, `aspect-ratio`, and an `inset` holding `var()` or `calc()`, and two longhand `oklch()` colors went through unlowered; each of those broke the TV's pages. The plugin covers exactly those.

**`oklch()` kept under `@supports` with an `rgb()` fallback.** It would keep wide-gamut colors for newer browsers, but every color the player uses lies inside sRGB, where `rgb()` is the same color, so the build writes `rgb()` and leaves a color outside sRGB as it is.

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
