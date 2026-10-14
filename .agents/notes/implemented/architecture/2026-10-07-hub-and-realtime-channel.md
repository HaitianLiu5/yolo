# Agent Note: The Hub, one queue, and the realtime channel

Status: implemented

English | [中文](2026-10-07-hub-and-realtime-channel.zh.md)

## Problem

Something has to own "what is playing now" across an agent, a car, and other screens, push commands to whichever screen plays, and hear back where playback is. The original Tesla-only player had one window connected to one server, and a second player window kicked out the first. Yolo has several devices per user, an always-on control plane billed by Durable Object wall time, and clients that may be buggy or asleep in a parked car.

## Decision

### One queue, one active device

Each user has one **Hub**, a Durable Object ([`service/control/src/hub/hub-core.js`](../../../../service/control/src/hub/hub-core.js), wrapped by `hub.js`). It owns the user's single `PlaybackState`, a single Spotify-style queue, and which device is **active**: at most one device plays at a time. Moving playback to another device (`PUT /v1/playback/device`, the `transfer` tool) carries the position along, and the old device receives `deactivate` and becomes a remote control. If the same device connects from another window, only the newest connection plays; the old window receives `deactivate` with `reason: "replaced"` and offers a take-over button that reconnects. A play that names no device goes to the active device, or else to the only online device that can play; a remote ([capabilities](2026-10-07-capability-negotiation.md) with `renderer: "remote"`) is never picked and cannot be named.

### The realtime channel

Devices connect to `wss://…/v1/realtime` after trading their token for a ticket ([OAuth](2026-10-07-oauth-authorization-server.md)). Every message shares one envelope, `{ v: 1, type, id?, ... }`; a command with an `id` expects an `ack`.

**Heartbeat from the device.** The device sends `{"v":1,"type":"ping"}` every 25 seconds, because Cloudflare closes a WebSocket idle for 100 seconds. The string must match exactly (`HEARTBEAT_PING` in `@useyolo/core`): the Durable Object's WebSocket auto-response answers `{"v":1,"type":"pong"}` without waking the Hub, so heartbeats cost no Hub wall time. The server sets no timer and sends no heartbeat of its own.

**Limits**, so that a buggy client cannot keep the Hub awake and billing:

- At most 16 connections per user and 20 new connections per minute; beyond that, `429 rate_limited`.
- At most 30 messages per connection per 10 seconds, heartbeats excluded; beyond that, the server closes the connection with `1008 rate_limited`.
- Clients reconnect with exponential backoff and wait at least 30 seconds after a `1008` or `429`.
- Clients never answer a broadcast (`state`, `queue`, `playlists`, `devices`) with a `report` or any other message, which would loop with the Hub. A `media` message makes a screen probe its paths again, and it sends `network` only when its path changes; the Hub answers `network` with no broadcast.

**From the device:**

| type | Fields | Meaning |
|---|---|---|
| `hello` | `deviceId?, name, kind, capabilities` | Without `deviceId` the server assigns one. A paired device (whose ticket came from a device credential) can only be itself, and `deviceId` is ignored; a removed device is closed with 4003 |
| `report` | `sessionId, status, position, duration, playing, viewport?, health?` | Only from the active device, at least every 5 seconds and at once on a status change. A report for a session other than the current one is ignored. `health` comes about every 15 seconds while playing, and at once for a new stream, a new stall, or a change of buffering: `{ engine, bufferSeconds, throughputKbps, buffering, stalls, stallSeconds, recentStalls: [{ ago, seconds }], width, height, videoCodec, droppedFrames }`, the player's own measurements; the Hub keeps the latest per device, with the last stream it loaded and its recent rebuilds, for playback health ([`playback-health.js`](../../../../service/control/src/hub/playback-health.js)). `status: "idle"` means the device left the video itself (Back): the Hub records the position, stops the node's session, and keeps the item paused on that device, marked `leftAt`, for its now-playing bar to play again ([progress and resume](../feature/2026-10-11-yolo-owns-progress-and-resume.md)) |
| `ended` | `sessionId` | Playback finished; the Hub takes the next queue item |
| `error` | `sessionId, code, message` | Playback failed; the Hub decides whether to rebuild the session or stop |
| `ack` | `id` | Acknowledges a command |
| `network` | `path, reason?, probes?, hairpin?` | The media path the device takes (`lan`, `wan`, `relay`, or null for none) and each probe's outcome, with `hairpin` (`ok` or `failed`) from a device the welcome marked as at home: whether the router loops back to the home's public address, sent when its choice changes, once after each welcome, and when a stream fails on its path. The Hub keeps the latest value per device and passes the path to the node with the next `prepare`, or refuses with `media_unreachable` when there is none or it is the relay while the relay is off; the device's own play requests carry it too, and win. A report from a player before 0.5 carries only `lan` ([media off the Worker](2026-10-13-media-off-the-worker.md)) |
| `ping` | none | The heartbeat string |

**From the server:**

| type | To | Meaning |
|---|---|---|
| `welcome` | The device that just connected | `deviceId`, the current `state`, `queue`, and `playlists`, `media`: `{ paths: [{ path, origin, notAfter, home? }], relay, domain? }`, the node's listeners that serve with a valid certificate (`wan` only while it was reached from outside), `home: true` on `wan` when the device connected from the home's public address, whether the relay is on, and `domain: false` on an instance without a domain, and `lan`: `{ origin, notAfter }` for players from before 0.5. If `state` shows this device still playing (a page reload, the car waking up), the device asks for a new stream with `reason: "recovery"` |
| `load` | The active device | The stream descriptor (`stream`), the item with its Source (needed to rebuild the stream), `startTime`, `autoplay`, and `reason` (`play`, `recovery`, `seek`, `quality`, `transfer`, `tracks`). `tracks` means a track change needed a new session, such as a Plex image subtitle or another audio track |
| `pause`, `resume`, `stop`, `seek` | The active device | Control commands |
| `tracks` | The active device | Change subtitles or audio, with the subtitles' VTT URLs |
| `danmaku` | The device an agent named, or the active one | `settings`: the danmaku settings to change on that screen (`enabled`, `density`, `opacity`, `area`, `fontSize`), which the screen keeps itself ([danmaku](../feature/2026-10-13-danmaku.md)) |
| `deactivate` | The previously active device | Playback moved elsewhere; this device stops and becomes a remote. `reason: "replaced"` is the same device connected from another window |
| `state`, `queue`, `playlists`, `devices` | Every device | Broadcasts of changes |
| `media` | Every connected device | The welcome's `media` for that device, sent when the remote origin a welcome lists changes, such as the home's new address without a domain ([media off the Worker](2026-10-13-media-off-the-worker.md)) |
| `pong` | The device that sent `ping` | Sent by the runtime's auto-response |

The Hub writes the active device's reports to Yolo's history ([progress and resume](../feature/2026-10-11-yolo-owns-progress-and-resume.md)), and the order of requests from a waking device is covered in [wake request ordering](../bug-fix/2026-10-11-wake-request-ordering.md).

### The channel stays in core

The realtime channel is part of Yolo's core, not a device plugin. The player, in both profiles, is the channel's device and negotiates playback through its [capabilities](2026-10-07-capability-negotiation.md). In the car profile a tap plays on the car itself; in the web profile, in a computer's or phone's browser, the player plays (through `<video>` where the browser can) and also acts as a remote: a tap plays on another device that is playing or paused, and otherwise in this browser ([where a tap plays](../feature/2026-10-11-yolo-web-client.md)). The device-plugin interface will be designed when the first third-party device arrives (a Jellyfin session or an Apple TV), from that device's real needs.

## Alternatives considered

**A queue per device, as Plex does.** One person has one pair of eyes and never watches on two screens at once, so one queue and one active device match how Yolo is used.

**A device plugin for the realtime channel from the start.** Both profiles of the one player, car and web, are Yolo's own and speak the same protocol; an interface with one implementation could not be designed well.

**Server-initiated heartbeats.** A server timer would wake the Hub every interval and bill its wall time for every connected device; device-sent pings answered by the auto-response cost nothing.

## Consequences

Every device sees one consistent playback state, and moving playback between screens is one call. Heartbeats and idle connections cost no Durable Object time, and the limits bound what a misbehaving client can cost. Two people cannot watch different things on one account, which suits the single-owner model and would need revisiting for households. Third-party players need a device-plugin interface that does not exist yet.
