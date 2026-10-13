# Agent Note: One player over two engines: canvas in the car, `<video>` on the web

Status: implemented

English | [中文](2026-10-12-two-playback-engines.zh.md)

## Problem

The canvas engine (Mediabunny and WebCodecs drawing to `<canvas>`, with a `SharedArrayBuffer` audio clock) exists because Tesla can freeze a `<video>` element while the car moves ([canvas engine](2026-04-04-canvas-playback-engine.md)). Yolo Web used it in every browser too ([Yolo Web](../feature/2026-10-11-yolo-web-client.md)). Computer and phone browsers do not freeze `<video>`, so there the canvas engine is pure cost: demuxing in JavaScript, a decoded-frame queue, canvas painting, and an audio pipeline of its own, where the browser has a native media pipeline with hardware decoding. It also needs cross-origin isolation, which Safari does not give the page (it ignores `Cross-Origin-Embedder-Policy: credentialless`), so an iPhone or iPad could only be a remote. And what comes with `<video>` — Picture-in-Picture, the lock screen's media controls, AirPlay — was out of reach.

## Decision

The client has one player and two engines with one interface. [`player.js`](../../../../clients/tesla/src/player.js) owns everything above the engine: the player's controls, progress, menus, and error panel; reports and progress to the Hub; recovery; telemetry; adaptive quality; resume; and the Hub's commands (load, pause, resume, seek, tracks, stop). It drives either engine through the interface of [`engine/mediabunny-player.js`](../../../../clients/tesla/src/engine/mediabunny-player.js): `load`, `play`, `pause`, `seek`, `stop`, `destroy`, the states `loading`, `paused`, `playing`, `buffering`, `seeking`, `ended`, and `error`, `getCurrentTime`, `getStats`, `getSeekableRange`, `getLiveTimeline`, `setVolume`, `enableAudioOutput`, and `audioOutputState`.

### Which engine plays

The device's [profile](../feature/2026-10-11-yolo-web-client.md) chooses ([`engine/native-support.js`](../../../../clients/tesla/src/engine/native-support.js)):

| Profile | Engine | Otherwise |
|---|---|---|
| `car` | The canvas engine, unchanged | A remote, when the browser cannot run it |
| `web` | The browser's `<video>` element ([`engine/native-video-player.js`](../../../../clients/tesla/src/engine/native-video-player.js)), when it plays Yolo's streams | The canvas engine when only that runs; a remote when neither does |

**A Tesla never plays through `<video>`.** A page the Tesla fingerprint recognizes ([device code pairing](../feature/2026-10-07-device-code-pairing.md)) plays with the canvas engine and announces `TESLA_CANVAS_CAPABILITIES` in `hello`, whatever type the owner gave the device. A car paired as a browser keeps the web profile's layout and its rule for where a tap plays, but not the `<video>` engine; a Tesla that cannot run the canvas engine is a remote.

A `<video>` element plays Yolo's streams when it plays HLS by one path or the other, and H.264 with AAC. Apple's WebKit (Safari, and every browser on iPhone and iPad) plays HLS natively, which keeps AirPlay and the system's media pipeline. Elsewhere (Chrome, Edge, Firefox, Android) [hls.js](https://github.com/video-dev/hls.js) feeds Media Source Extensions. Progressive files play directly. hls.js is its own chunk, loaded the first time the `<video>` engine plays HLS through it, so the car never downloads it. Outside a Tesla, a change of the device's type changes the engine from the next stream on.

### What the `<video>` engine does

- **Capabilities.** The page announces `renderer: "html5-video"` with the codecs its HLS path plays (`MediaSource.isTypeSupported` for hls.js, `canPlayType` for native HLS), avc1 and mp4a first, up to 1080p ([capability negotiation](2026-10-07-capability-negotiation.md)).
- **Positions are the item's.** A `<video>` element counts from the stream's first segment. With hls.js the engine adds the media's own first timestamp (`INIT_PTS_FOUND`), which is the timeline the canvas engine reads. Native HLS does not expose it: for a stream the node may have trimmed to its start position (the descriptor's `trimToStart`, a transcode resumed part way), the part of the item's duration that the stream lacks stands in for it, accurate to the source's rounding of the duration (Plex's is whole seconds). A seek before such a stream's start asks Yolo for a new stream, as with the canvas engine.
- **Failures.** A 410 from the node is `SESSION_EXPIRED` and a 403 is `UPSTREAM_ACCESS_DENIED`, also where hls.js would keep asking again for a single variant's fragment. A `<video>` element never reports the status that failed, so after an element error, and after 8 seconds of waiting, the engine asks the node itself: a `HEAD` of the stream and, for native HLS, of its first variant playlist, which the node fetches from the source. A network error, a decode error, or 30 seconds without new data (`MEDIA_NETWORK_ERROR`, `MEDIA_DECODE_ERROR`, `MEDIA_STALLED`) rebuild the stream through the player's recovery; a stream the browser does not play (`MEDIA_UNSUPPORTED`) shows the error panel.
- **Subtitles stay Yolo's.** [`subtitles.js`](../../../../clients/tesla/src/subtitles.js) draws them over the picture, laid out from the element's picture size and timed by the engine's position. The engine keeps the browser's own captions off: hls.js renders no subtitles or captions, and a text track the browser shows is disabled.
- **Audio tracks.** Audio tracks a source lists (Plex's) switch through Yolo, which rebuilds the stream, as before. Audio renditions inside an HLS playlist that the source does not list switch in the engine (hls.js's audio tracks, the element's `audioTracks`), without a new stream.
- **Sound.** Playback starts with sound when the browser allows it; otherwise it plays muted with "Tap for sound" (a stream without video waits for a tap), and the first tap unmutes it while the gesture is active ([progress and resume](../feature/2026-10-11-yolo-owns-progress-and-resume.md)). The element plays at the system's volume; the canvas engine's gain boost does not apply.
- **What comes with `<video>`.** Hardware decoding. Picture-in-Picture and fullscreen buttons where the browser offers them ([`picture-controls.js`](../../../../clients/tesla/src/picture-controls.js)); fullscreen takes the whole player, so Yolo's controls and subtitles stay, and Safari on iPhone, which can only put the element itself in fullscreen, gets no button. The system's media controls (the lock screen, a phone's notification) through Media Session, with the item's artwork and seeking. AirPlay on Safari. A pause or a play from Picture-in-Picture or the system's controls becomes the owner's intent and reaches the Hub.
- **Live streams** play at the edge of the window the browser can seek in, and seeks stay inside it. The node gives a `<video>` element a live playlist that ends at the newest published segment and reaches 5 minutes back, without the canvas engine's runway of segments not yet published ([media pipeline](2026-10-11-node-media-pipeline.md)).

### Cross-origin isolation stays on every page

COOP and COEP stay on every page of the app ([canvas engine](2026-04-04-canvas-playback-engine.md)). One page serves both profiles, and it learns its profile only after it loads (the owner's type for the device, or the Tesla fingerprint), while the headers must come with the document itself; a car served the page without them could not play at all. The `<video>` engine neither needs isolation nor suffers from it: its media is same-origin, and `credentialless` still loads the cross-origin font stylesheet. Safari ignores `credentialless` and plays through `<video>` regardless.

### Adaptive quality with the browser's ABR

Yolo's cap stays the ceiling, and the browser adapts below it ([adaptive quality](../feature/2026-10-11-adaptive-quality.md)). For every device the node keeps only the variants of a multi-variant playlist that fit the device's `maxVideoKbps`; hls.js and native HLS switch among those by themselves. Yolo's quality controller still rebuilds the stream at another cap, and that is what adapts a stream with one variant (Plex's transcode, joined split files, a file). It measures with hls.js's bandwidth estimate or, without hls.js, by how fast the buffer grows while the browser fetches. Where hls.js switches variants itself, a draining buffer is left to it, and Yolo steps the cap down only after a stall.

### Testing

[`test/e2e/native-video.test.js`](../../../../test/e2e/native-video.test.js) plays `direct`, `hls`, `dash_split`, and the Plex fixture through the `<video>` engine in desktop Chromium: seeks, pause and resume, subtitles over the picture, an audio switch, recovery after a 410, progress and resume, fullscreen, and the autoplay rule. With `YOLO_E2E_WEBKIT=1` the same journeys also run in Playwright's WebKit, Safari's engine, where HLS plays natively and the page is not cross-origin isolated. The car's end-to-end tests pair as the car and keep testing the canvas engine. Unit tests cover the engine choice per profile, the `<video>` engine's positions and failures against a fake element and a fake hls.js, and the node's deliveries per renderer.

## Alternatives considered

**The canvas engine everywhere**, as before. It plays in Chrome, but costs CPU that the browser's own pipeline does not, cannot run in Safari (iPhone and iPad stay remotes), and gives up Picture-in-Picture, AirPlay, and the system's media controls.

**`<video>` everywhere, the car included.** Tesla can freeze `<video>` while the car moves, which is why the canvas engine exists.

**The owner's type alone chooses the engine.** The type is a label picked on the approval page, and a car can carry the type of a browser; it would then play through `<video>`. The fingerprint measures the browser itself, so in a Tesla it decides the engine and the capabilities, and the type keeps deciding the layout.

**A separate web player.** It would duplicate the controls, reports, recovery, telemetry, quality, and resume, and the two would drift apart; behind one interface the engines share all of them.

**hls.js in Safari too** (Safari has Media Source Extensions, and the iPhone has ManagedMediaSource). Native HLS keeps AirPlay, uses the system's power-efficient pipeline, and works in every browser on iOS; hls.js there would add a download and give AirPlay up.

**COOP and COEP only for the car's pages.** The page decides its profile after it loads, but the headers come with the document. Sending them per profile needs a signal the server trusts before the page runs, and a wrong guess leaves the car unable to play.

**A multi-variant playlist for every stream, all adaptation left to the browser.** Yolo's joined split files and transcodes have one variant: the node would have to join and probe every format the source offers, or the source would have to transcode several at once, which Plex does not. With Yolo's cap as the ceiling, every source works as it is, and the browser adapts wherever a playlist has variants.

**The browser's captions for subtitles.** Yolo's renderer lays out bilingual subtitles in its own fonts and shows several tracks at once; the browser's captions do neither the same way in every browser.

## Consequences

Computers and phones play with the browser's own media pipeline. In desktop Chrome on an Apple-silicon Mac, the same H.264 and AAC HLS stream costs about half the CPU of the canvas engine, summed over Chrome's processes: about 9% of one core against 17%, at 720p30 and at 1080p30 alike, with both engines showing 30 frames a second and almost none dropped (measured on 2026-10-12 in a visible window; headless Chrome does not pace frames like a real display and is no measure). Safari on iPhone and iPad plays instead of only controlling other screens, and Yolo Web gains Picture-in-Picture, fullscreen of the player, the system's media controls, and AirPlay. The car's behavior is unchanged, also where its type says browser. The fingerprint is the guard: a Tesla whose user agent and window measurements both stop matching it would play as its type says. The player keeps two engines behind one interface, and some failures surface differently: a `<video>` element never reports the status that failed, so the engine asks the node, and a stall the browser does not report is found by watching time and buffer. Under native HLS, the position in a stream resumed part way is as accurate as the source's duration. The runway live playlist, the split-file delivery, and the gain boost remain the canvas engine's. hls.js is a 180 kB (gzip) chunk that only HLS through Media Source Extensions loads.
