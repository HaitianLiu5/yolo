# Agent Note: Adapt quality by replacing the stream

Status: implemented

English | [中文](2026-10-11-adaptive-quality.zh.md)

## Problem

A car's mobile connection varies from strong to barely usable within one drive. A fixed quality either stalls on a weak connection or wastes a strong one. The canvas player cannot switch variants inside a stream the way a native HLS player does: it plays one rendition, so any quality change means a new stream, which costs a short pause.

## Decision

The client measures throughput and asks Yolo for a new stream with a lower or higher bitrate cap when needed ([`clients/tesla/src/quality.js`](../../../../clients/tesla/src/quality.js)), with either playback engine ([two engines](../architecture/2026-10-12-two-playback-engines.md)). The canvas engine measures with its HLS prefetcher; the `<video>` engine with hls.js's bandwidth estimate or, without hls.js, by how fast the buffer grows while the browser fetches. A quality change is `POST /v1/playback/play` with `reason: "quality"`, the current position, the `sessionId` it replaces, and `maxVideoKbps`. The policy is slow to change and quick only when playback already suffers:

- **Down:** when throughput stays below the stream's bitrate × 1.15 while the player is stalled for 8 seconds, or while a short buffer drains for 20 seconds. The new cap is 75% of the measured throughput minus audio, rounded down to a rung of the ladder 400, 700, 1000, 1500, 2200, 3000, 4000 kbps.
- **Up:** one rung at a time, only after throughput has stayed at or above the next rung's bitrate × 1.6 with at least 30 seconds of buffer for 90 seconds, and never within 2 minutes of a step down. An upgrade followed by a downgrade within 5 minutes doubles the wait before the next upgrade, up to 15 minutes. From the top rung, the next step up is `maxVideoKbps: null`, no cap.
- Live streams do not adapt.
- **The browser's own switching.** The cap is the ceiling for the `<video>` engine too: hls.js and native HLS switch by themselves among the variants of a multi-variant playlist that the node kept under the cap, and Yolo's rebuild adapts a stream with one variant. Where hls.js switches variants itself, a draining buffer is left to it, and the cap steps down only after a stall of 8 seconds.

On the service side:

- The Hub remembers the `maxVideoKbps` of each device's own requests (including `null`) for 30 minutes and applies it to anything else that device plays, including items an agent starts; a request without the field uses the remembered value. An agent cannot set it for a device.
- The node takes the lower of the device's cap and its own (`STREAM_MAX_VIDEO_BITRATE_KBPS`, or `LAN_MAX_VIDEO_KBPS` on the [LAN path](2026-10-12-lan-direct-play.md)), at least 200 kbps, and passes it to the source's `prepare` as `limits.maxVideoKbps`; the stream descriptor's `limits: { maxVideoKbps, ceilingKbps, capped }` tells the device which cap applied. When every HLS variant exceeds the cap, the smallest stays ([media pipeline](../architecture/2026-10-11-node-media-pipeline.md)).
- The yt-dlp plugin picks formats under the cap, or the smallest when none fits; the Plex plugin lowers its transcode bitrate to the cap, and the picture drops to 480p, 360p, or 240p. The device's `maxHeight` still applies on top: a cap only ever lowers quality.

The player shows no technical numbers while it waits: only a spinner, which shows the start-up buffer percentage after 1.5 seconds. The `quality_change_requested`, `quality_change_failed`, `bandwidth_insufficient`, and `network_unstable` events record each decision ([device telemetry](2026-10-11-device-telemetry.md)).

## Alternatives considered

**Keep the selected quality fixed**, as Drive-In did: its in-car checks required that quality never change automatically, and Plex's fixed 720p transcode keeps the player's 210-second buffer intact. A weak connection then stalls with no way out short of the owner picking another stream.

**Switch variants inside one stream, as native HLS players do.** The canvas player cannot: it plays one rendition per stream, so every quality change is a new stream. The `<video>` engine does, among the variants under the cap, but transcodes and joined split files have one variant, so the cap still adapts them.

**Let agents set the cap.** The cap reflects the device's own connection, which only the device measures.

## Consequences

Weak connections degrade to a lower bitrate instead of stalling, and strong ones climb back slowly enough not to flap. Every change costs a brief rebuild at the same position, and a remembered cap follows the device to the next item for 30 minutes, so a car that just left a dead spot may start the next video lower than it could.
