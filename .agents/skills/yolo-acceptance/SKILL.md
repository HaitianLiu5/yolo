---
name: yolo-acceptance
description: Use after every Yolo change, before reporting it done or opening its pull request - run the whole stack on this machine with npm run stack, walk the paths the change touches on the real web player (car and web mode), the iOS app, and the tvOS app, and report what was walked with screenshots, command output, and MCP answers, and what was not.
---

# Accept a change by walking it

Whoever makes a change proves it: run Yolo, use it the way the owner does on every screen the change reaches, and look at the result. There are no unit tests, scripted end-to-end tests, or CI gates to lean on, and none are added in place of this step ([agent acceptance](../../notes/implemented/testing/2026-11-20-agent-acceptance.md)). Merging and releasing wait for the owner, never for a check.

## 1. The static checks

```bash
npm run check
```

It runs the documentation gates, builds the player and the Worker, and runs the rule checks: no provider names under `service/`, every text of the player, the owner pages, and the Apple apps with its Chinese, no other host in what the Worker serves, one version with its CHANGELOG entry, every catalog plugin described, and every skill linked. About 15 seconds. A change under `clients/apple/` also builds both apps in Release, since TestFlight gets Release and `#if DEBUG` hides code from a Debug build:

```bash
xcodebuild -project clients/apple/Yolo.xcodeproj -scheme YoloTV -configuration Release -destination 'generic/platform=tvOS Simulator' build
xcodebuild -project clients/apple/Yolo.xcodeproj -scheme YoloiOS -configuration Release -destination 'generic/platform=iOS Simulator' build
```

## 2. Start the stack

```bash
npm run stack
```

Run it in the background and wait for `Yolo is running at http://127.0.0.1:<port>`. It builds the player, then starts the media node and the control plane under `wrangler dev --local` on free ports, with local D1 and KV, an owner, and media ffmpeg makes: a WebM (`direct`), fMP4 HLS (`hls`), MPEG-TS HLS with HE-AAC (`hlsTs`), separate DASH audio and video behind a yt-dlp that answers locally (`dashSplit`), a live stream whose segments go out one every 5 seconds over the stack's first minute (`live`; `stack:walk` watches it play on instead of pausing and seeking), a Plex that answers locally, a folder library (a movie and a Matroska episode with a subtitle file), and a library of events. `.stack/stack.json` holds the address, the media's URLs, and the owner's session. Ctrl-C stops it and deletes what it made. It needs ffmpeg and, for the car's H.264, Google Chrome (or `PLAYWRIGHT_CHROMIUM_EXECUTABLE`).

It never touches Cloudflare, the live node, its runtime directory, or port 9191, and a stack node does not advertise itself by Bonjour. Never point a check at the owner's own instance without asking.

While it runs:

| Command | Does |
|---|---|
| `npm run stack -- approve <CODE> <kind>` | the owner allows a screen's code (`car`, `browser`, `phone`, `tablet`, `tv`); `-` for the newest code a screen shows |
| `npm run stack -- pending` | the codes screens show now, newest first (an app shows its own only behind "Use another device") |
| `npm run stack -- mcp <tool> '<json>'` | an agent's MCP call, with a token the stack got through the real OAuth flow |
| `npm run stack -- api <path> ['<json>']` | `/v1` as that agent |
| `npm run stack -- owner-code` | the 6-digit code for a passkey on `/login` |
| `npm run stack:walk -- <screen> [stream] [--sim <udid>]` | the main path on one screen, with a screenshot per step |

## 3. Walk the paths the change touches

Pick every row the change can affect; a change to the Hub, `/v1`, the realtime channel, MCP, or a source reaches every screen, so walk it on the web player, the iOS app, and the tvOS app: the clients must behave the same. When unsure, walk the main path on all five screens.

`npm run stack:walk -- <screen>` walks the main path (pair, an agent plays, pause, seek to 1:00, resume) and prints one JSON line per step with its screenshot, what the screen says (a browser's mode, engine, status, position, frames drawn), and what Yolo says (`get_status`). Look at every screenshot: the picture is the stream's test pattern, whose timecode in the corner matches the position.

| Screen | Setup | `stack:walk` screen |
|---|---|---|
| Web mode, computer | none | `web` (the `<video>` engine) |
| Web mode, phone | none | `phone` |
| Car mode (Tesla) | none | `car` (the canvas engine at the car's 773×601) |
| iPhone and iPad app | a Simulator of your own (below) | `ios --sim <udid>` |
| Apple TV app | a Simulator of your own (below) | `tv --sim <udid>` |

For the Apple apps, make a Simulator of your own so the owner's are untouched and the app does not find the owner's instance first, build the debug scheme for it, and install it:

```bash
udid=$(xcrun simctl create "Yolo Acceptance iPhone" com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-27-0)
xcrun simctl boot "$udid"
xcodebuild -project clients/apple/Yolo.xcodeproj -scheme YoloiOS -configuration Debug -destination "id=$udid" -derivedDataPath .stack/dd build
xcrun simctl install "$udid" .stack/dd/Build/Products/Debug-iphonesimulator/Yolo.app
npm run stack:walk -- ios hls --sim "$udid"
```

(`YoloTV`, an Apple TV device type and tvOS runtime from `xcrun simctl list`, and `Debug-appletvsimulator` for the TV.) A debug build launched with `-YoloServer <address>` pairs with that address, past Bonjour; the walk finds the app whose executable is `Yolo`, whatever bundle id `Local.xcconfig` gives it (`--bundle <id>` names one), launches it so, and resets the Simulator's Keychain first. Taps and the remote go through the Simulator tool or Simulator.app; `xcrun simctl io <udid> screenshot <file>` keeps what the screen shows.

The paths, how to walk each, and what passes:

| Path | How | Passes when |
|---|---|---|
| Pair | the walk's first steps; for a browser, also the QR code's page `/device` with the owner session cookie | the screen leaves its code for Home; `list_devices` has it online with its kind |
| An agent plays each stream type | `stack:walk -- <screen> <stream>` for `direct`, `hls`, `hlsTs`, `dashSplit`, the Plex item (`mcp search '{"query":"Fixture"}'`, then `play` with its id), the folder's episode | status `playing`, position past 3 s, the picture moves; the car's engine is `canvas`, web's `native` |
| Controls | the walk's pause, seek, and resume; `set_tracks` for subtitles and audio on Plex and the folder episode | Yolo and the screen agree on status and position (within 2 s); the subtitle is drawn over the picture |
| Home, browse, search | the screen's Home and Search after pairing, by screenshot or Playwright | libraries (League, Movies, Shows), search finds "Fixture", an item opens its details |
| Leave and resume | Back from the player, then reload (browser) or relaunch (app) | Home shows the item in the bar or "Continue from another screen" at its position, and plays on from there |
| Continue and move between screens | play on one screen, then `mcp transfer '{"device":"<other>"}'`, or Continue here on the other | the other screen plays at the same position; the first stops and does not resume by itself |
| The owner's passkey and settings | Playwright with a virtual authenticator: `/login` with `owner-code`, then the settings sheet | a passkey is made, settings open, a device credential alone is refused |
| Share link | `mcp share '{"url":"<hls>"}'`, open the link in a fresh browser | it plays without pairing; the owner's history is unchanged |
| A plugin or the node | Settings › Plugins on a screen, and MCP `list_plugins` | the change shows where the owner looks for it |

A page's own state is on `globalThis.__yolo` and `globalThis.__yoloPlayer`; `scripts/stack/browser.js` launches Chrome as the car, a phone, or a computer and reads it, for a path the walk does not take. Keep a script you write for one change in the scratchpad, not in the repository.

## 4. What the stack cannot show

Say these were not walked, unless the owner lets you check them on their instance or does so in the car:

- the real Tesla renderer, LTE, and the [in-car checks](../../notes/implemented/testing/2026-11-20-agent-acceptance.md#in-car-checks) for route and playback changes;
- real YouTube, Bilibili, Tencent, and Plex; the stack fakes their answers;
- LAN and remote direct play with real certificates, the Cloudflare path, Workers VPC, cron, and DNS;
- Safari's `<video>` engine (Playwright's WebKit is `launch({ engine: "webkit" })`, close but not Safari), and a real Apple TV or iPhone;
- `npm run yolo -- upgrade` on a real instance, which the owner approves step by step.

## 5. Report

Lead with what the change does now that it is walked, then for each path: the screen, what you did, and the evidence, a screenshot attached, the walk's JSON line, the command and its output, or the MCP answer. Then list what was not walked and why. A failure is reported as it is, with its output; never weaken a step until it passes.
