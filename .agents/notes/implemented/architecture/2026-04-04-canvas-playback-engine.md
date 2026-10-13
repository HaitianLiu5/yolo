# Agent Note: Render to canvas, not to a video element

Status: implemented

English | [中文](2026-04-04-canvas-playback-engine.zh.md)

## Problem

Tesla's browser can freeze a native `<video>` element while the vehicle is moving, which defeats an in-car player (for passengers, or while parked). The player must decode and present frames itself, keep picture and sound in sync without the browser's media pipeline, and stay within the memory of a car's browser on a mobile connection.

## Decision

In the car's profile the client decodes media with Mediabunny and WebCodecs and draws each frame to a `<canvas>` ([`clients/tesla/src/engine/mediabunny-player.js`](../../../../clients/tesla/src/engine/mediabunny-player.js) and its helpers in the same folder). The car never plays through `<video>`. Yolo Web, the same app in a computer's or phone's browser, plays through the browser's own `<video>` element instead, behind the same engine interface ([two engines](2026-10-12-two-playback-engines.md)).

- **The audio clock.** Decoded PCM goes through a lock-free ring buffer on a `SharedArrayBuffer` with `Atomics` ([`audio-ring-buffer.js`](../../../../clients/tesla/src/engine/audio-ring-buffer.js)): the main thread writes samples, an AudioWorklet reads and plays them, and the number of samples played is the clock for the whole player. A stream without audio, or one whose audio ends early, continues on a wall clock from the same position.
- **Cross-origin isolation.** Browsers allow `SharedArrayBuffer` only on cross-origin isolated pages, so the page carries `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`: in production from [`clients/tesla/public/_headers`](../../../../clients/tesla/public/_headers), in development from `clients/tesla/vite.config.js`. Without them `load()` in `mediabunny-player.js` throws; there is no fallback. They stay on every page of the app, also where Yolo Web plays through `<video>`, because the page learns its profile only after it loads. Because the client is on the same origin as `/m/*` and `/v1/realtime`, media responses need no CORP ([same-origin passthrough](2026-10-07-same-origin-media-passthrough.md)); the one other media origin, the node's LAN listener, answers with CORS and `Cross-Origin-Resource-Policy: cross-origin` ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)).
- **Bounded memory.** The decoded video queue holds 6 to 16 frames, sized for about 0.2 seconds. Network jitter is absorbed by buffering encoded segments instead: the HLS prefetcher keeps up to 210 seconds ahead within 128 MiB.
- **Single-flight prefetch.** The HLS prefetcher fetches one segment at a time, so background buffering never competes with the segment the player needs now.
- **Position is preserved.** Changing quality or viewport replaces the stream at the current position.

## Alternatives considered

**A native `<video>` element.** It freezes while the vehicle moves, which is the problem the project exists to solve.

**libmedia's AVPlayer** (WebAssembly decoding with WebGL rendering), which Drive-In used first and which also needed `SharedArrayBuffer`. Mediabunny with the browser's WebCodecs decoders replaced it on 2026-07-13; the change records no further reason.

## Consequences

Playback works while the car moves, at the price of owning what a `<video>` element would do: demuxing, audio output, A/V sync, buffering, and recovery. Cross-origin isolation is permanent: COOP cuts the link between the page and any popup it opens, so the player page cannot sign in through a popup, and screens pair by QR code instead ([device code pairing](../feature/2026-10-07-device-code-pairing.md)). Every media response must come from the player's origin. Removing the COOP/COEP headers, or moving the client to another origin than `/m/*`, breaks playback outright.
