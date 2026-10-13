# Agent Note: Devices negotiate playback by capabilities

Status: implemented

English | [中文](2026-10-07-capability-negotiation.zh.md)

## Problem

Drive-In's server was written for one player: the Tesla canvas player. A normal browser, a phone, or a TV needs different formats, codecs, resolutions, and subtitle handling, and a format choice hard-coded for Tesla would have to be unpicked in every place it hid.

## Decision

Each device declares its **capabilities** in its `hello` message, and playback is negotiated from them; the Tesla canvas player is one capability profile among others ([`service/core/src/capabilities.js`](../../../../service/core/src/capabilities.js)):

```js
{
  renderer: "canvas-webcodecs" | "html5-video" | "native" | "external" | "remote",
  delivery: ["hls", "mp4"],
  video: ["avc1", "hvc1", "av01", "vp09"],   // preferred first
  audio: ["mp4a", "opus"],
  maxHeight: 720,
  subtitles: "client-vtt" | "native-vtt" | "burn-in",
  audioOnly: false,
}
```

The device reports its **viewport** in every `report`; the Hub keeps each device's latest viewport and passes it to the node with the next `prepare`. The Tesla client reports physical pixels (`devicePixelRatio: 1`): its [display size](../feature/2026-10-11-display-size.md) changes the CSS viewport but must not make Yolo believe the screen grew. Changing quality or viewport preserves the playback position.

Negotiation has two layers. A source plugin's `prepare(source, context)` receives the capabilities, viewport, start position, and track chooser, and decides what to fetch upstream; the node's media pipeline then turns that Input into a delivery the device can read, all under the same-origin `/m/{token}/…` ([media pipeline](2026-10-11-node-media-pipeline.md)). Subtitles follow the same split: a text subtitle is delivered as WebVTT and drawn by the device, which can show several at once; an image subtitle is burned into the picture by the source, and choosing one rebuilds the session.

**The Tesla profile is Drive-In's long-standing behavior** (`TESLA_CANVAS_CAPABILITIES` in `@useyolo/core`): the player accepts only `hls` and `mp4` deliveries and renders with canvas and WebCodecs (`avc1` video, `mp4a` audio, 720p); separate audio and video are joined into fMP4 HLS before they reach it; Plex transcodes at a fixed 720p; text subtitles are drawn in the browser and image subtitles are burned in by Plex. A normal browser or phone is a different profile; the plugin and the node choose format, bitrate, and subtitle handling from it.

**Yolo Web's profiles.** In a computer's or phone's browser that can run the canvas engine (cross-origin isolated, with WebCodecs and AudioWorklet), Yolo Web sends `WEB_CANVAS_CAPABILITIES`: the Tesla profile's deliveries and codecs, up to 1080p. A browser that cannot run it sends `REMOTE_CAPABILITIES` (`renderer: "remote"`): it shows and controls playback but never plays. The Hub never picks a remote for a play that names no device, and refuses to play or move playback onto one ([Hub](2026-10-07-hub-and-realtime-channel.md)).

**What only the canvas engine reads.** The node asks `readsSplitFiles` and `waitsForLiveRunway` in `@useyolo/core`, which are true for `canvas-webcodecs` only. Separate audio and video files without a segment index go to the canvas engine as `split-mp4`, and to any other renderer as one stream that ffmpeg makes; a live playlist with a runway of segments not yet published goes to the canvas engine only ([media pipeline](2026-10-11-node-media-pipeline.md)).

## Alternatives considered

**Hard-coding the Tesla behavior.** Browsers and phones need different formats and subtitle handling, and every hard-coded choice would have to be found and generalized later.

## Consequences

A new kind of screen is a new capability profile, not a change to the service. The `external` renderer is reserved for media that cannot pass through the node: Spotify's audio is DRM-protected and may not be relayed, so Yolo could only control it through Spotify Connect and let Spotify's own devices play (music is outside [1.0](../../proposed/feature/2026-10-11-yolo-1-0.md)). Every source plugin must honor the capabilities it is given, and two layers decide each stream, so a wrong picture can come from either the plugin's choice or the node's delivery; the `stream_selected` and `stream_first_frame` events report both ([device telemetry](../feature/2026-10-11-device-telemetry.md)).
