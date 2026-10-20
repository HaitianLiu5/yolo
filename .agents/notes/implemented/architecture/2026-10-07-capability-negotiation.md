# Agent Note: Devices negotiate playback by capabilities

Status: implemented

English | [中文](2026-10-07-capability-negotiation.zh.md)

## Problem

The earlier single-process server was written for one player: the original Tesla-only player, which draws to a canvas. A normal browser, a phone, or a TV needs different formats, codecs, resolutions, and subtitle handling, and a format choice hard-coded for Tesla would have to be unpicked in every place it hid.

## Decision

Each device declares its **capabilities** in its `hello` message, and playback is negotiated from them; the canvas engine in the car is one capability profile among others ([`service/core/src/capabilities.js`](../../../../service/core/src/capabilities.js)):

```js
{
  renderer: "canvas-webcodecs" | "html5-video" | "native" | "external" | "remote",
  delivery: ["hls", "mp4"],
  containers: ["mp4"],                       // progressive files it plays as they are
  video: ["avc1", "hvc1", "av01", "vp09"],   // preferred first
  audio: ["mp4a", "opus", "flac", "ac-3", "ec-3"],
  maxHeight: 720,
  subtitles: "client-vtt" | "native-vtt" | "burn-in",
  audioOnly: false,
}
```

The device reports its **viewport** in every `report`; the Hub keeps each device's latest viewport and passes it to the node with the next `prepare`. The player reports physical pixels (`devicePixelRatio: 1`): in the car profile its [display size](../feature/2026-10-11-display-size.md) changes the CSS viewport but must not make Yolo believe the screen grew. Changing quality or viewport preserves the playback position.

Negotiation has two layers. A source plugin's `prepare(source, context)` receives the capabilities, viewport, start position, and track chooser, and decides what to fetch upstream; the node's media pipeline then turns that Input into a delivery the device can read, all under `/m/{token}/…` ([media pipeline](2026-10-11-node-media-pipeline.md)). On the LAN path the context also answers `playable(media)`: whether the device plays a source's original file as it is, judged from `containers`, the codecs, and `maxHeight` ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)). Subtitles follow the same split: a text subtitle is delivered as WebVTT and drawn by the device, which can show several at once; an image subtitle is burned into the picture by the source, and choosing one rebuilds the session.

**The car's capability set** (`CAR_CANVAS_CAPABILITIES` in `@useyolo/core`) is what the car profile announces, and what a page the Tesla fingerprint recognizes announces in either profile ([two engines](2026-10-12-two-playback-engines.md)): the player accepts only `hls` and `mp4` deliveries and renders with canvas and WebCodecs (`avc1` video, `mp4a` audio, 720p); separate audio and video with a segment index are joined into fMP4 HLS before they reach it; Plex transcodes at a fixed 720p; text subtitles are drawn in the browser and image subtitles are burned in by Plex. A normal browser or phone announces a different set; the plugin and the node choose format, bitrate, and subtitle handling from it.

**Yolo Web's profiles.** In a computer's or phone's browser whose `<video>` element plays Yolo's streams, Yolo Web plays through it and sends `WEB_NATIVE_CAPABILITIES` (`renderer: "html5-video"`, `hls` and `mp4`), with `video` and `audio` replaced by the codecs the browser reports for its HLS path (`MediaSource.isTypeSupported` with hls.js, `canPlayType` with native HLS): avc1 and mp4a first, then `hvc1`, `vp09`, and `av01` where it decodes them ([two engines](2026-10-12-two-playback-engines.md)). `maxHeight` is the short side of the screen in physical pixels, rounded to 2160 (from 1800), 1440 (from 1300), 1080 (from 900), or 720, and 1080 when the browser does not say. A browser without that path but able to run the canvas engine (cross-origin isolated, with WebCodecs and AudioWorklet) sends `WEB_CANVAS_CAPABILITIES`: the car's deliveries and codecs, up to 1080p. A browser that can play with neither sends `REMOTE_CAPABILITIES` (`renderer: "remote"`): it shows and controls playback but never plays. The Hub never picks a remote for a play that names no device, and refuses to play or move playback onto one ([Hub](2026-10-07-hub-and-realtime-channel.md)).

**How sources use the ceiling.** `maxHeight` is the tallest picture worth sending to the device, and the stream's `limits.maxVideoKbps` is the bitrate its media path carries, lowered by the device's [adaptive cap](../feature/2026-10-11-adaptive-quality.md). The yt-dlp plugin targets `maxHeight` under that bitrate: fast motion (50 fps or more) at most 1440p, because 2160p60 costs about twice the bitrate for little gain and a software decoder may not keep up; below 50 fps at least 1080p, as the car has always had. In each height band it takes H.264 first and then the device's other codecs in its order, but those only as MP4 files that the node joins by byte range, in SDR: WebM or HLS would make the node transcode to H.264. YouTube offers H.264 only up to 1080p and its taller VP9 in WebM, so a 1440p screen in Chrome gets YouTube's AV1, and Safari without AV1 gets 1080p H.264. A codec family that the device did not announce is never chosen. The Plex plugin gives a `<video>` or native device its picture size where the limit carries more than 720p (1080p from 8 Mbps, 1440p from 12 Mbps, 2160p from 20 Mbps), and Plex's direct stream copies the original's video when it fits; under 8 Mbps, as on the relay, it gets the car's 720p ladder. The node keeps an HLS master playlist's variants no taller than `maxHeight` too, so the car keeps 720p H.264 on every path, also where the remote ceiling would admit a 1080p or 2160p variant ([media pipeline](2026-10-11-node-media-pipeline.md)).

**What only the canvas engine reads.** The node asks `readsSplitFiles` and `waitsForLiveRunway` in `@useyolo/core`, which are true for `canvas-webcodecs` only. Separate audio and video files without a segment index go to the canvas engine as `split-mp4`, and to any other renderer as one stream that ffmpeg makes; a live playlist with a runway of segments not yet published goes to the canvas engine only ([media pipeline](2026-10-11-node-media-pipeline.md)).

## Alternatives considered

**Hard-coding the Tesla behavior.** Browsers and phones need different formats and subtitle handling, and every hard-coded choice would have to be found and generalized later.

**One 720p target for every device.** Through 0.5.0 the yt-dlp plugin capped every device at the car's 720p and preferred H.264, Plex transcoded every stream away from home at 720p, and the node capped remote direct play at the relay's 4.8 Mbps. A 1440p monitor or a phone then showed a soft picture although its media path carried more.

## Consequences

A new kind of screen is a new capability profile, not a change to the service. The `external` renderer is reserved for media that cannot pass through the node: Spotify's audio is DRM-protected and may not be relayed, so Yolo could only control it through Spotify Connect and let Spotify's own devices play (music is outside [1.0](../../proposed/feature/2026-10-11-yolo-1-0.md)). Every source plugin must honor the capabilities it is given, and two layers decide each stream, so a wrong picture can come from either the plugin's choice or the node's delivery; the `stream_selected` and `stream_first_frame` events report both ([device telemetry](../feature/2026-10-11-device-telemetry.md)).
