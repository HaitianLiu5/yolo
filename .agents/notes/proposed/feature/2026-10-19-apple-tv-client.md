# Agent Note: A native Apple TV client

Status: proposed

English | [中文](2026-10-19-apple-tv-client.zh.md)

## Problem

Apple TV has no Yolo client. The player is one browser app ([two engines](../../implemented/architecture/2026-10-12-two-playback-engines.md)), and tvOS gives apps no web engine: there is no Safari and no `WKWebView`, so the player cannot run there in any form. iPhone and iPad already play in Safari through `<video>` with native HLS and AirPlay, and Android TV and Fire TV can run the player in a WebView; Apple TV is the one common screen that the player cannot reach.

The service is not the obstacle. `/v1` and the realtime channel serve any client ([/v1](../../implemented/architecture/2026-10-07-v1-http-api.md), [Hub](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md)), a device declares what it plays in `hello` and `renderer: "native"` is already one of the renderers ([capability negotiation](../../implemented/architecture/2026-10-07-capability-negotiation.md)), and screens pair by the OAuth device grant that TV apps use to sign in ([device code pairing](../../implemented/feature/2026-10-07-device-code-pairing.md)). What a new platform costs is the client: the playback lifecycle, recovery, and realtime rules that `player.js`, `realtime.js`, and `missed-commands.js` carry for the browser.

## Proposal

A native tvOS app, written in Swift with SwiftUI and AVPlayer, that implements [Yolo's client protocol](../architecture/2026-10-19-client-protocol.md) as a screen of `kind: "tv"`. It carries no content: no sources, no catalog, and no provider's name, so everything it shows comes from the owner's own server. Its code lives in `clients/apple/`, one Xcode project, so an iPhone and iPad target can join later and share the protocol code.

**Pairing.** Pairing is a scan: the TV shows a QR code and the owner approves on a phone. The app first needs the server's address. On the home network the node advertises it by Bonjour, and when exactly one Yolo server answers, the app goes straight to the QR code, so pairing at home is opening the app and scanning; with several it lists them, and with none the owner types the domain, with the iPhone's keyboard if they like. It checks the address with `/.well-known/yolo`, then asks `POST /oauth/device_authorization` with its name and `device_kind: "tv"`, shows `verification_uri_complete` as a QR code with the short code beside it, and polls `POST /oauth/token`. The owner scans with a phone and approves with a passkey. The device credential goes into the Keychain; a `4003` close or a refused credential returns the app to pairing.

**Capabilities.** The app announces `renderer: "native"`, `delivery: ["hls", "mp4"]`, `containers: ["mp4"]`, the video codecs AVFoundation decodes on that model (`avc1` first, then `hvc1`), `mp4a`, `ac-3`, and `ec-3` for audio, `maxHeight` from the TV's current display mode (2160 on an Apple TV 4K on a 4K set), and `subtitles: "client-vtt"`. `readsSplitFiles` and `waitsForLiveRunway` stay false for `native`, so the node joins split files and hides a live runway as it does for `<video>`. Two changes ship before the app: the client protocol's server side (`clientProtocols`, version negotiation in `hello`, and the node's Bonjour advertisement), and the Plex plugin's transcode, which sizes the picture from `maxHeight` only for `html5-video` and gives every other renderer the car's fixed 720p profile; `native` takes the `html5-video` branch, so a Plex transcode on the TV reaches 2160p. Nothing else in playback changes.

**Playback.** AVPlayer plays the `load`'s stream, every URL resolved against the stream's `origin`, as the player does. `AVPlayerViewController` gives the system transport bar, Siri Remote scrubbing, and Now Playing; text subtitles, AI subtitles included, are WebVTT that the app draws in the controller's `contentOverlayView`, because AVPlayer cannot attach a sidecar WebVTT file to an HLS stream. The app probes the media paths the welcome lists, LAN first, and again on each `media` message, with the server's origin as the probe's `Origin` header, which URLSession does not send by itself, and reports `network` as the player's `media-paths.js` does, so at home it plays by LAN direct play ([LAN direct play](../../implemented/feature/2026-10-12-lan-direct-play.md)).

**Realtime.** The first version implements the protocol's required part, the reconciliation after a welcome included, and leaves out the optional one (`danmaku`, `keep`, Ask, telemetry). It never keeps a player behind its home screen, so it never sends `keep`.

**Versions.** The app carries Yolo's one version. It ships separately from the Worker, so a Worker can be newer than the app on the TV; the client protocol's version tells the app when to ask the owner to update it instead of failing mid-play.

**Building and installing.** The owner's Apple Developer Program membership, paid yearly, signs the app, and TestFlight internal testing installs it on the owner's Apple TV without App Review; each build lasts 90 days. A free Apple account installs only from Xcode, and that build stops opening after 7 days. Because the app carries no content and downloads from no third party, it can later go to the App Store as a player for one's own server, like other media-server clients. Builds need macOS and Xcode, so they run on the owner's Mac, not in a Linux container. The team id and signing settings live in an ignored local `xcconfig`, never in a tracked file. The root instructions gain an exception to "plain JavaScript" for `clients/apple/`.

### Stages

1. After those two changes ship: pairing by address or Bonjour, the home screen (history, search, libraries, episodes), playback with resume, media path probing, and realtime control, so an agent plays, pauses, seeks, and moves playback to the TV through MCP.
2. Subtitle and audio menus, AI subtitles re-read as they grow, and the adaptive cap ([adaptive quality](../../implemented/feature/2026-10-11-adaptive-quality.md)).
3. Danmaku drawn over the picture with the player's layout rules ([danmaku](../../implemented/feature/2026-10-13-danmaku.md)), and Ask by Siri Remote dictation ([agent from the screen](../../implemented/feature/2026-10-18-agent-from-the-screen.md)).
4. An iPhone and iPad target, worth building only for what Safari does not give: background playback, the lock screen, and a connection that survives the phone locking.

## Alternatives considered

**A Jellyfin-compatible protocol plugin**, so Infuse and Swiftfin play from Yolo ([rejected](../../rejected/feature/2026-10-11-jellyfin-protocol-plugin.md)). It is 40 to 60 endpoints plus session push, which no compatible server has implemented, Infuse takes no remote commands, and Swiftfin's are unverified. Even working, it shows none of danmaku, AI subtitles, Ask, or Yolo's own track and quality choices, and an agent controls the TV only as far as Swiftfin obeys. The native app keeps Yolo's own protocol, which every screen speaks.

**AirPlay from Yolo Web on an iPhone.** It works today without code, since Safari plays Yolo's HLS natively. But the phone stays the Yolo device: the Apple TV is a display that agents cannot address, and when the phone locks, Safari may drop the realtime connection and with it the agent's control (inferred, not measured).

**A device plugin on the node that drives the Apple TV over AirPlay** (pyatv, as the [plugin architecture](../../implemented/architecture/2026-10-11-plugin-architecture.md) lists). The TV would need no app, but it would have no browsing with the Siri Remote, no subtitles drawn by Yolo, a Python dependency on the node, and AirPlay URL playback from a non-Apple sender is unverified.

**A cross-platform toolkit (React Native for tvOS, Flutter).** AVPlayer still plays the video, so the toolkit adds a bridge and a second toolchain without removing the Swift needed for playback, and its tvOS support trails Apple's own focus engine.

## Acceptance criteria

On the owner's Apple TV, installed from TestFlight: the app finds the owner's server by Bonjour at home, or takes its typed domain, and pairs by a QR code and the owner's passkey; it passes the client protocol's conformance kit; browses history, search, and the libraries with the Siri Remote; plays `hls`, `direct`, `dash_split`, and `plex` streams by LAN direct play; an agent plays, pauses, seeks, and moves playback to and from the Apple TV through MCP; progress made on the TV resumes in the car; and removing the device in Yolo's settings returns the app to pairing.

## Risks

- **Two clients follow one protocol.** The realtime channel's recovery rules took many fixes in the player, and the app has to meet the same contract in Swift; every change to the channel now has a second client to update and test. The client protocol's version and conformance kit limit the damage to a prompt to update, not a broken TV.
- **Swift in the repository.** It builds only on macOS, so `npm run check` in a Linux container never compiles it; a macOS CI job builds the app and runs its unit tests, or the app breaks unseen.
- **Distribution beyond the owner.** TestFlight internal testing covers the owner's own devices. Other owners ([distribution](2026-10-11-distribution-to-other-owners.md)) need the App Store, whose review needs a demo server to sign in to and checks guideline 5.2.3 against downloading media from third-party sources; an app with no content and no provider names plays only what the owner's server sends, but whether review accepts that is unverified.
- **Remote direct play's certificate without a domain.** Away from home on an instance without a domain, the remote origin carries a certificate for an IP address, which App Transport Security has not been tested against; an Apple TV at home plays by LAN direct play and does not depend on it.
- **HDR.** Capabilities carry no dynamic range, so sources keep choosing SDR; an Apple TV 4K that plays HDR10 or Dolby Vision gets SDR until capabilities say what a screen shows.
