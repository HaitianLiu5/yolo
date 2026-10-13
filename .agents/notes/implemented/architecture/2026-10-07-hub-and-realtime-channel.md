# Agent Note: The Hub, one queue, and the realtime channel

Status: implemented

English | [中文](2026-10-07-hub-and-realtime-channel.zh.md)

## Problem

Something has to own "what is playing now" across an agent, a car, and other screens, push commands to whichever screen plays, and hear back where playback is. Drive-In had one player connected to one server and let a second player window kick out the first. Yolo has several devices per user, an always-on control plane billed by Durable Object wall time, and clients that may be buggy or asleep in a parked car.

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
- Clients never answer a broadcast (`state`, `queue`, `playlists`, `devices`) with a `report` or any other message, which would loop with the Hub.

**From the device:**

| type | Fields | Meaning |
|---|---|---|
| `hello` | `deviceId?, name, kind, capabilities` | Without `deviceId` the server assigns one. A paired device (whose ticket came from a device credential) can only be itself, and `deviceId` is ignored; a removed device is closed with 4003 |
| `report` | `sessionId, status, position, duration, playing, viewport?` | Only from the active device, at least every 5 seconds and at once on a status change. A report for a session other than the current one is ignored. `status: "idle"` means the device left the video itself (Back): the Hub records the position, stops the node's session, and keeps the item paused on that device, marked `leftAt`, for its now-playing bar to play again ([progress and resume](../feature/2026-10-11-yolo-owns-progress-and-resume.md)) |
| `ended` | `sessionId` | Playback finished; the Hub takes the next queue item |
| `error` | `sessionId, code, message` | Playback failed; the Hub decides whether to rebuild the session or stop |
| `ack` | `id` | Acknowledges a command |
| `ping` | none | The heartbeat string |

**From the server:**

| type | To | Meaning |
|---|---|---|
| `welcome` | The device that just connected | `deviceId` and the current `state`, `queue`, and `playlists`. If `state` shows this device still playing (a page reload, the car waking up), the device asks for a new stream with `reason: "recovery"` |
| `load` | The active device | The stream descriptor (`stream`), the item with its Source (needed to rebuild the stream), `startTime`, `autoplay`, and `reason` (`play`, `recovery`, `seek`, `quality`, `transfer`, `tracks`). `tracks` means a track change needed a new session, such as a Plex image subtitle or another audio track |
| `pause`, `resume`, `stop`, `seek` | The active device | Control commands |
| `tracks` | The active device | Change subtitles or audio, with the subtitles' VTT URLs |
| `deactivate` | The previously active device | Playback moved elsewhere; this device stops and becomes a remote. `reason: "replaced"` is the same device connected from another window |
| `state`, `queue`, `playlists`, `devices` | Every device | Broadcasts of changes |
| `pong` | The device that sent `ping` | Sent by the runtime's auto-response |

The Hub writes the active device's reports to Yolo's history ([progress and resume](../feature/2026-10-11-yolo-owns-progress-and-resume.md)), and the order of requests from a waking device is covered in [wake request ordering](../bug-fix/2026-10-11-wake-request-ordering.md).

### The channel stays in core

The realtime channel is part of Yolo's core, not a device plugin. Drive-In is its first device and negotiates playback through its [capabilities](2026-10-07-capability-negotiation.md); Yolo Web in a computer's or phone's browser uses the same channel and is a remote for whichever device plays. The device-plugin interface will be designed when the first third-party device arrives (a Jellyfin session or an Apple TV), from that device's real needs.

### Mapping from Drive-In's messages

The Tesla client speaks only v1. Drive-In's `play` became `load`; `subtitlesAvailable` and `subtitleSelect` became `load.tracks` and `tracks`; `status` and `playerState` became `report`; the single-player `playerAccepted`/`playerRejected` became `welcome`/`deactivate`; `queueUpdated`/`playlistsUpdated` became `queue`/`playlists`; `reload` is gone.

## Alternatives considered

**A queue per device, as Plex does.** One person has one pair of eyes and never watches on two screens at once, so one queue and one active device match how Yolo is used.

**A device plugin for the realtime channel from the start.** Both first-phase clients (the Tesla client and Yolo Web) are Yolo's own and speak the same protocol; an interface with one implementation could not be designed well (decided 2026-10-11).

**Server-initiated heartbeats.** A server timer would wake the Hub every interval and bill its wall time for every connected device; device-sent pings answered by the auto-response cost nothing.

## Consequences

Every device sees one consistent playback state, and moving playback between screens is one call. Heartbeats and idle connections cost no Durable Object time, and the limits bound what a misbehaving client can cost. Two people cannot watch different things on one account, which suits the single-owner model and would need revisiting for households. Third-party players need a device-plugin interface that does not exist yet.
