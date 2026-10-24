# Agent Note: A native iPhone and iPad client

Status: proposed

English | [中文](2026-10-23-iphone-and-ipad-client.zh.md)

## Problem

On an iPhone or iPad, Yolo is the browser player in Safari ([Yolo Web](../../implemented/feature/2026-10-11-yolo-web-client.md)): it plays through `<video>` with native HLS and AirPlay, and acts as a remote for other screens. What Safari does not give is what a phone is for. Playback stops when the owner switches apps or locks the phone, there is no picture in picture with Yolo's own subtitles, the lock screen shows nothing to control, and once Safari suspends the tab the realtime connection drops, so an agent's command to the phone waits for the next welcome. Pairing a TV means scanning its QR code with the Camera and approving in Safari, apart from Yolo.

The [Apple TV client](2026-10-19-apple-tv-client.md) already speaks the [client protocol](../../implemented/architecture/2026-10-19-client-protocol.md) in Swift: YoloKit has discovery, pairing, `/v1`, the realtime channel, media paths, playback reconciliation, browsing, subtitles, danmaku, adaptive quality, and Ask, and the tvOS app passed the conformance kit. Its stage 4 is an iPhone and iPad target, worth building only for what Safari does not give. This note is that target.

## Proposal

An iOS target in the same Xcode project, `clients/apple/Yolo.xcodeproj`, that runs on iPhone and iPad, written in Swift with SwiftUI and AVPlayer, and implements the client protocol as a screen of `kind: "phone"`. Like the TV app it carries no content and no provider's name. It is both a screen that plays and a remote for the owner's other screens.

### Sharing YoloKit and the app layer

YoloKit stays what it is: the protocol in Swift, apart from any UI, already built for `.iOS(.v18)`, and tested on macOS by `swift test`. The iOS target links it as the tvOS target does. Two things in YoloKit become parameters instead of constants: the OAuth `client_id` (`yolo-apple-tv` today; the iPhone app pairs as `yolo-apple-ios`) and the device kind (`tv` or `phone`), passed by the app to `PairingClient` and `hello`. `Capabilities` gains `.iPhone(maxHeight:decodesHEVC:)`.

Most of the tvOS app's own code is not about the TV: `AppModel.swift` runs discovery, pairing, the realtime channel, media path probing, the reconciliation after a welcome, and the danmaku and Ask models, and `TVPlayer.swift` plays a `load` with AVPlayer, reports it, draws text subtitles, samples adaptive quality, and gives up a stalled stream on its path. That layer moves to `clients/apple/Shared/`, compiled into both targets, so the TV and the phone recover from a dead connection with the same code the conformance kit proved. The device-specific parts stay per target: `ThisDevice` (name, display size, capabilities), the player's controller (the TV's transport bar menus, the phone's PiP and menus), and every view. `TVPlayer` splits into the shared `Player` and the TV's `PlayerScreen`. Where a shared file differs by platform it uses `#if os(tvOS)`, kept rare.

### Screens

The app uses SwiftUI's `TabView` with `.sidebarAdaptable`: Home, Search, Ask, and Settings are a tab bar on iPhone and a sidebar on iPad, each tab its own `NavigationStack` (Home → a library → its items → a show's episodes). Rows and grids use adaptive columns, so the same views lay out from a phone held upright to an iPad in landscape, Split View, and Stage Manager.

- **iPhone upright:** the tab bar at the bottom, horizontal rows for history and each library, the now-playing bar above the tab bar.
- **iPhone sideways:** the same tabs with wider grids; the player fills the screen and is where the phone turns to landscape by itself.
- **iPad:** the sidebar, larger grids, and the player full screen or in picture in picture beside browsing.

The player is `AVPlayerViewController` presented full screen: its controls, scrubbing, the AirPlay button, and the PiP button are the system's. Text subtitles, AI subtitles included, are drawn in `contentOverlayView` as on the TV, since AVPlayer cannot attach a sidecar WebVTT file to an HLS stream. Pairing, Settings, and the update prompts reuse the TV's screens' logic with phone layouts.

### Playback: picture in picture, AirPlay, and background audio

The audio session is `.playback` with the `audio` background mode, so sound goes on when the owner locks the phone or leaves the app, and `AVPlayerViewController` updates Now Playing and the lock screen's controls itself. While it plays in the background the process keeps running, and with it the realtime connection and the reports. Once playback is paused in the background, iOS suspends the app after a few seconds and the connection drops; the Hub then sees the phone offline, and a command an agent sends meanwhile is made up for after the next welcome by the reconciliation the protocol already requires ([what a dead connection takes](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md#what-a-dead-connection-takes)).

Picture in picture comes from `AVPlayerViewController` once the audio session plays in the background; leaving the app while playing starts it. The overlay does not travel into the PiP window or onto an AirPlay display, so text subtitles show there only once the node lists them as WebVTT renditions in the HLS playlist, which is deferred. AirPlay plays through `allowsExternalPlayback`, with the phone still the Yolo device. When the owner has a paired Yolo screen such as the Apple TV app, the device picker offers moving playback there first, which makes that screen the device agents control.

The capabilities are those of the TV with the phone's screen: `renderer: "native"`, `delivery: ["hls", "mp4"]`, `containers: ["mp4"]`, `avc1` then `hvc1` where the model decodes it, `mp4a`, `ac-3`, and `ec-3`, `subtitles: "client-vtt"`, and `maxHeight` from the screen's shorter side in pixels, 1080 on current iPhones and iPads.

### The phone as a remote

The browser player's remote is `remote.js` (the now-playing bar for what plays on another screen, its transport controls, and the device picker) and `play-target.js` (where a tap plays). The app ports both. `PlayTarget.swift` in YoloKit decides where a tap plays by the same rules: on the device that is playing or paused when that is another online screen, so the phone acts as a remote; otherwise here. Its tests are the JavaScript module's cases. The now-playing bar reads only the Hub's `state`, `devices`, and `queue` broadcasts, never answers them, and sends every command over `/v1` (`/v1/playback/pause`, `resume`, `seek`, `next`, `stop`, and `PUT /v1/playback/device` to move playback), with the picture from `/v1/frame` while paused, as `remote.js` does. A suspended app hears no broadcasts, so on return the bar shows the welcome's state, not a stale one.

### Pairing, and approving a TV with the phone

The phone pairs itself as the TV does: Bonjour on the home network (shown in full and confirmed with one tap) or a typed address, `/.well-known/yolo`, then the device grant. Since the owner holds the device that shows the code, scanning it makes no sense: the app opens `verification_uri_complete` at once in `ASWebAuthenticationSession`, where the owner signs in with the passkey the phone already knows for the owner's domain, and keeps polling `/oauth/token` as the protocol requires, as the browser player approves its own code ([device code pairing](../../implemented/feature/2026-10-07-device-code-pairing.md)). A button opens the sheet again, and the QR code and short code wait under "Use another device" for approval elsewhere.

Approving another screen is a scan. Settings has "Pair a screen", which opens the camera (VisionKit's `DataScannerViewController`), reads a QR code, and accepts it only when it is an `https` URL on the origin this app is paired with; it then opens that URL in `ASWebAuthenticationSession` for the passkey approval. A code for another server is refused with its host shown, so the phone never approves on a server it was not paired with. The system Camera keeps working too, since the QR code is a plain web URL.

### Ask with voice

Ask sends the owner's words to `/v1/agent` as the TV does, through YoloKit's `Agent.swift`. When `/v1/agent`'s status says the media node has a transcriber, a microphone beside the field records 16 kHz mono WAV with `AVAudioEngine`, turns the player down while it listens, stops on a tap or a pause, posts it to `/v1/agent/transcriptions` with the device's language, and fills the field, sent two seconds later unless the owner edits it, as the browser player's Ask does ([agent from the screen](../../implemented/feature/2026-10-18-agent-from-the-screen.md)). Without a transcriber, the field's keyboard dictation is the voice input, with no permission to ask. Info.plist carries `NSMicrophoneUsageDescription`.

### Stages

1. **A screen that plays.** The shared layer moved out of `TV/` with the TV app unchanged in behavior; the iOS target with tabs for Home, Search, and Settings; pairing by Bonjour or a typed address, approved on the phone itself or from another device; history, libraries, search, and episodes; playback in `AVPlayerViewController` with AirPlay, resume, reports, `ended`, media path probing, and the realtime protocol's required part; the conformance kit passing against the iPhone Simulator.
2. **What Safari does not give.** Background audio, picture in picture, the lock screen, subtitle and audio menus, AI subtitles re-read as they grow, adaptive quality, and share links.
3. **The remote.** The now-playing bar for other screens, the device picker, `PlayTarget`, and "Pair a screen" by scanning.
4. **Ask and danmaku.** Ask with the microphone, and danmaku drawn over the picture with the TV's layout.

### Proving it with the conformance kit

The kit already starts a client in the Simulator through `YOLO_CONFORMANCE_LAUNCH`. The iOS debug build takes `-YoloConformanceURL` as the TV build does, through the shared `Conformance.swift`, keeps its pairing in memory, and answers `debug_state` on the kit's `/debug` with the same fields:

```bash
YOLO_CONFORMANCE_KIND=phone YOLO_CONFORMANCE_LAUNCH='xcrun simctl terminate <udid> <bundle id>; sleep 1; xcrun simctl launch <udid> <bundle id> -YoloConformanceURL {url}' npm run test:conformance
```

The kit's pairing scenario checks `device_kind: "tv"` today; it takes the expected kind from `YOLO_CONFORMANCE_KIND`, `tv` by default. Every other scenario holds unchanged for a phone. Stage 1 ships only when the kit passes on the iPhone Simulator, and the TV app passes it again after the shared layer moves.

### Repository and building

`clients/apple/iOS/` holds the iOS views and `ThisDevice`, `clients/apple/Shared/` the shared app layer, and `Config/` gains `TV.xcconfig` and `iOS.xcconfig` over `Base.xcconfig`, which keeps only what both share, so `SDKROOT` and the device family are per target. Both apps sign as one bundle id, `$(BUNDLE_ID_PREFIX).yolo`, so one App Store Connect record and one TestFlight group carry both platforms (universal purchase, as other media-server clients ship); the team and prefix come from the ignored `Local.xcconfig`, never a tracked file. A bundle id cannot be renamed once its record exists, so the TV app leaves the record it first shipped under for this one. A scheme `YoloiOS` builds the iOS app, and `archive.sh` takes the platform as an argument (`tvos` or `ios`). The iOS Info.plist lists `_yolo._tcp` in `NSBonjourServices`, `NSLocalNetworkUsageDescription`, `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, and `UIBackgroundModes: audio`.

## Alternatives considered

**Stay with Safari.** It costs nothing and already plays, but it stops in the background, has no lock screen controls for Yolo, loses the realtime connection when the tab is suspended, and leaves pairing a TV to the Camera and Safari. Those are the reasons to have the app at all.

**A web view wrapping the browser player.** It would keep one UI, but `WKWebView` has the same limits as Safari for background playback and suspended connections, the canvas engine's SharedArrayBuffer needs cross-origin isolation a web view does not reliably give, and AVPlayer is still needed for PiP and the lock screen.

**Moving the app layer into YoloKit.** It would make one package of everything, but the layer depends on AVKit, UIKit, and SwiftUI observation, which `swift test` on macOS does not build the same way, and YoloKit's value is that the protocol is tested apart from any UI. A `Shared/` folder compiled into both targets keeps that.

**Copying the TV app's model into the iOS target.** Fastest to start, but two copies of the reconciliation after a welcome would drift, and that logic took the most fixes in the player.

**Native passkeys with associated domains.** `ASAuthorizationPlatformPublicKeyCredentialProvider` would approve without a web sheet, but it needs a `webcredentials:` entitlement for each owner's domain and an `apple-app-site-association` file served by the Worker naming the team and bundle id. `ASWebAuthenticationSession` already uses the passkey Safari knows for the domain, with no service change.

**On-device speech recognition (`SFSpeechRecognizer`) for Ask.** It works without a transcriber on the node, but asks for a second permission, and the keyboard's dictation already gives on-device recognition when the node has none; the node's transcriber keeps the words the same on every screen.

**A separate bundle id for iOS, keeping the TV app's record.** The TV app would not move to a new record, but the iPhone app would need a second record and TestFlight group for one app that plays from the same server, and the TV's id ends in `.tv`.

## Acceptance criteria

On the owner's iPhone and iPad, installed from TestFlight: the app finds the owner's server by Bonjour at home or takes its address, pairs and is approved with a passkey on the phone itself; passes the conformance kit on the iPhone Simulator, and the TV app still passes it; browses history, search, libraries, and episodes upright and sideways on iPhone and in the iPad sidebar; plays `hls`, `direct`, `dash_split`, and `plex` streams by LAN direct play, and away from home by remote direct play or the relay; reports progress that resumes in the car and on the TV; keeps playing with sound when locked, shows lock screen controls, and plays in picture in picture; an agent plays, pauses, seeks, and moves playback to and from the phone through MCP; the phone controls and moves playback on the Apple TV; scanning the TV's pairing QR code in the app approves it; and Ask takes the owner's voice.

## Risks

- **Moving the TV's code.** The shared layer leaves `TV/` in stage 1, so a mistake breaks the TV app that already works. The conformance kit runs against both targets before the change lands.
- **A suspended app is offline.** Paused in the background, the phone drops its connection within seconds, and the device list shows it offline until the owner opens it; an agent cannot start playback on a phone it cannot reach. Waking it by push notification would need APNs on the service and is left out.
- **Subtitles in PiP and on AirPlay.** The overlay is not in the PiP window or on an AirPlay display, so text subtitles disappear there until the node puts WebVTT renditions into the HLS playlist.
- **Remote direct play without a domain.** A phone is away from home far more than a TV, and on an instance without a domain the remote origin carries a certificate for an IP address, which App Transport Security has not been tested against; until it is, such a phone plays through the relay away from home.
- **App Review.** TestFlight internal testing covers the owner's devices; the App Store question is the TV note's, with the same guideline.
- **More UI to keep.** A third screen layout (phone, iPad, TV) for every feature that reaches the clients, and `npm run check` builds none of it; a macOS CI job that builds both targets and runs `swift test` covers that, and is the same job the TV note asks for.
