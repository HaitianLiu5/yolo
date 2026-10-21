# Agent Note: Adapt quality by replacing the stream

Status: implemented

English | [中文](2026-10-11-adaptive-quality.zh.md)

## Problem

A car's mobile connection varies from strong to barely usable within one drive. A fixed quality either stalls on a weak connection or wastes a strong one. The canvas engine cannot switch variants inside a stream the way a native HLS player does: it plays one rendition, so any quality change means a new stream, which costs a short pause.

## Decision

The client measures throughput and asks Yolo for a new stream with a lower or higher bitrate cap when needed ([`clients/player/src/quality.js`](../../../../clients/player/src/quality.js)), with either playback engine ([two engines](../architecture/2026-10-12-two-playback-engines.md)). The canvas engine measures with its HLS prefetcher; the `<video>` engine with hls.js's bandwidth estimate or, without hls.js, by how fast the buffer grows while the browser fetches. A quality change is `POST /v1/playback/play` with `reason: "quality"`, the current position, the `sessionId` it replaces, and `maxVideoKbps`. The policy is slow to change and quick only when playback already suffers:

- **Down:** when throughput stays below the stream's bitrate × 1.15 while the player is stalled for 8 seconds, or while a short buffer drains for 20 seconds. The new cap is 75% of the measured throughput minus audio, rounded down to a rung of the ladder 400, 700, 1000, 1500, 2200, 3000, 4000, 6000, 9000, 13000 kbps. The rungs above 4000 serve the direct paths, whose ceilings are higher than the relay's: a stall there need not drop to 4 Mbps.
- **Up:** one rung at a time, only after throughput has stayed at or above the next rung's bitrate × 1.6 with at least 30 seconds of buffer for 90 seconds, and never within 2 minutes of a step down. An upgrade followed by a downgrade within 5 minutes doubles the wait before the next upgrade, up to 15 minutes. From the top rung, the next step up is `maxVideoKbps: null`, no cap.
- **Faster than normal speed** ([two engines](../architecture/2026-10-12-two-playback-engines.md#playback-speed)), the stream needs that much more throughput: at 2, a step down needs throughput below twice the bitrate × 1.15 and takes half as much for the new cap, and a step up needs twice the rung's bitrate × 1.6. A slower speed asks no less than normal, since the owner can go back to normal at any moment.
- Live streams do not adapt.
- **The browser's own switching.** The cap is the ceiling for the `<video>` engine too: hls.js and native HLS switch by themselves among the variants of a multi-variant playlist that the node kept under the cap, and Yolo's rebuild adapts a stream with one variant. Where hls.js switches variants itself, a draining buffer is left to it, and the cap steps down only after a stall of 8 seconds.
- **Only on a current measurement, and not at the end.** When no download has finished for 30 seconds and none is in flight, the buffer drains because nothing is being fetched, which no bitrate fixes, so the cap moves neither down nor up. Thirty seconds is more than two of the longest segments (10 seconds of audio) and the prefetcher's 12-second inactivity timeout. The canvas engine's prefetcher reports the age of its newest sample; the `<video>` engine reports none and keeps the rules above. With less than 20 seconds of the item left, or the rest of it already buffered, quality is not rebuilt at all: a new stream waits for Yolo and the source and plays only once 3 seconds of it are buffered, which costs more of the item than it can save. On 2026-10-16 a car stepped down on an estimate 3.5 minutes old, 11 seconds before the end, after its read-ahead had stopped ([a refused read-ahead](../bug-fix/2026-10-16-refused-read-ahead.md)).

On the service side:

- The Hub remembers the `maxVideoKbps` of each device's own requests (including `null`) for 30 minutes and applies it to anything else that device plays, including items an agent starts; a request without the field uses the remembered value. An agent cannot set it for a device.
- The node takes the lower of the device's cap and its own ceiling for the stream's [media path](../architecture/2026-10-13-media-off-the-worker.md), at least 200 kbps, and passes it to the source's `prepare` as `limits.maxVideoKbps`; the stream descriptor's `limits: { maxVideoKbps, ceilingKbps, capped }` tells the device which cap applied. When every HLS variant exceeds the cap, the smallest stays ([media pipeline](../architecture/2026-10-11-node-media-pipeline.md)). The ceilings are node settings:

| Path | Setting | Default | Why |
|---|---|---|---|
| [LAN direct play](2026-10-12-lan-direct-play.md) | `LAN_MAX_VIDEO_KBPS` (at least 500) | 200,000 kbps | The home network carries any original, a disc remux included |
| Remote direct play | `WAN_MAX_VIDEO_KBPS` (at least 500) | 20,000 kbps | The home's upload carries it to one screen: enough for 1440p and 2160p web video and a 2160p Plex transcode |
| The relay through Cloudflare | `STREAM_MAX_VIDEO_BITRATE_KBPS` (500 to 20,000) | 4800 kbps | Conservative, because the relay is the fallback and every byte crosses Cloudflare twice |

- The yt-dlp plugin picks formats under the cap, or the smallest when none fits. The Plex plugin lowers its transcode bitrate to the cap: the car's picture drops to 480p, 360p, or 240p, and a `<video>` or native device's picture follows the cap, its own size where the cap carries more than 720p and the car's ladder under 8 Mbps ([capability negotiation](../architecture/2026-10-07-capability-negotiation.md)). The device's `maxHeight` still applies on top: a cap only ever lowers quality.
- A source may start a stream below the cap when its upstream measured too slow for the formats it selected, as the yt-dlp plugin does for a slow Bilibili mirror; the stream then reports that lower cap with `capped: true`, so the device steps up from it by the rule above, and a step up keeps the formats it asked for ([media pipeline](../architecture/2026-10-11-node-media-pipeline.md)). Like the device's own cap, it follows the device to the next item.

The player shows no technical numbers while it waits, only the spinner ([device telemetry](2026-10-11-device-telemetry.md)). It keeps the last picture under the spinner until the new stream shows one, and leaves the controls as they were: unlike a seek or a track change, which the owner asked for, a quality change neither raises them nor shows the progress bar's seek indicator ([in-car design](../architecture/2026-07-13-in-car-design-principles.md)). On 2026-10-21 it raised them in the car, and a tap meant for pause landed on the progress bar just above the button and sought 5 minutes back. The `quality_change_requested`, `quality_change_failed`, `bandwidth_insufficient`, and `network_unstable` events record each decision ([device telemetry](2026-10-11-device-telemetry.md)).

## Alternatives considered

**Keep the selected quality fixed**, as the original Tesla-only player did: its in-car checks required that quality never change automatically, and Plex's fixed 720p transcode keeps the player's 210-second buffer intact. A weak connection then stalls with no way out short of the owner picking another stream.

**Switch variants inside one stream, as native HLS players do.** The canvas engine cannot: it plays one rendition per stream, so every quality change is a new stream. The `<video>` engine does, among the variants under the cap, but transcodes and joined split files have one variant, so the cap still adapts them.

**Let agents set the cap.** The cap reflects the device's own connection, which only the device measures.

## Consequences

Weak connections degrade to a lower bitrate instead of stalling, and strong ones climb back slowly enough not to flap. Every change costs a brief rebuild at the same position, and a remembered cap follows the device to the next item for 30 minutes, so a car that just left a dead spot may start the next video lower than it could.
