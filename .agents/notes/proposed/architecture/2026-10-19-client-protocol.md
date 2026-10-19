# Agent Note: Yolo's client protocol

Status: proposed

English | [中文](2026-10-19-client-protocol.zh.md)

## Problem

What a screen must do to be a Yolo screen is defined by its one implementation, the browser player. The pieces are recorded in several notes ([/v1](../../implemented/architecture/2026-10-07-v1-http-api.md), [Hub and realtime channel](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md), [device code pairing](../../implemented/feature/2026-10-07-device-code-pairing.md), [capability negotiation](../../implemented/architecture/2026-10-07-capability-negotiation.md), [media off the Worker](../../implemented/architecture/2026-10-13-media-off-the-worker.md)), but nothing says which of them a client must implement, which it may leave out, how a client finds a server, or how it learns that the server has moved on. The player ships with the Worker, so it never had to know. A native client ships on its own schedule ([Apple TV client](../feature/2026-10-19-apple-tv-client.md)), and a third-party protocol is not the answer ([Jellyfin plugin, rejected](../../rejected/feature/2026-10-11-jellyfin-protocol-plugin.md)).

## Proposal

Yolo's **client protocol** is a published, versioned contract that every screen implements, the browser player included. Each part keeps its owning note; this note owns the list of parts, the version, what a client may leave out, discovery, and the conformance kit.

### The parts

| Part | What a client does | Owner |
|---|---|---|
| Discovery | Finds the server's address and checks it with `GET /.well-known/yolo` | Below |
| Pairing | The OAuth device grant: shows the code, polls for its device credential, and forgets it on `4003` or a refused credential | [Device code pairing](../../implemented/feature/2026-10-07-device-code-pairing.md) |
| HTTP | The `/v1` routes a device credential may call, and the error shape | [/v1](../../implemented/architecture/2026-10-07-v1-http-api.md) |
| Realtime | A ticket, one WebSocket, `hello` with capabilities, reports, `ended`, `error`, `network`, and the heartbeat | [Hub and realtime channel](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md) |
| Media | The `load`'s stream descriptor, every URL resolved against its `origin`, the media paths a welcome lists, probed in order | [Media off the Worker](../../implemented/architecture/2026-10-13-media-off-the-worker.md) |

**Required and optional.** A client must handle `welcome`, `load`, `pause`, `resume`, `seek`, `stop`, `tracks`, `deactivate`, `media` (probing its paths again and reporting `network` when its path changes), and the broadcasts it shows, must keep the realtime rules that protect the Hub (the exact `HEARTBEAT_PING`, no answer to a broadcast, a back-off of at least 30 seconds after a rate limit), and must make up after a welcome for what a dead connection took: the pause, resume, and seek the welcome's `commands` name, the subtitles in the welcome's `state.tracks` when the stream on screen can switch to them in place, and its own unheard `ended` and `idle` ([what a dead connection takes](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md#what-a-dead-connection-takes)). Without that, an agent's pause that went into a dead socket is lost while the agent was told it worked, and the screen's next report overwrites it. A client may leave out `danmaku`, `keep`, `/v1/agent`, and telemetry; the Hub already serves a client that ignores them.

### Versions

`CLIENT_PROTOCOL` in `@useyolo/core` is one integer, sent by the client in `hello` as `protocol`. `/.well-known/yolo` serves `clientProtocols`, every number the Hub serves, so a client checks it before pairing. A change that the previous release's clients cannot follow raises it, as `NODE_PROTOCOL` does for the node ([versions and releases](../../implemented/process/2026-10-13-versions-and-releases.md)); the Hub serves the current and the previous number. Every client sends `protocol`, the browser player included. When `clientProtocols` shares no number with the client, it says so at once, before pairing or at its next start: a client older than every number shows the owner where to update it, and one newer than every number says the server needs upgrading. A paired client that the Hub no longer serves gets a welcome with `upgrade: true` and the same prompt, instead of failing mid-play; a browser tab loaded before the upgrade reloads instead. A `hello` without `protocol` comes from a page older than this protocol and counts as its first number. That page does not know `upgrade: true`, so once the Hub stops serving the first number it closes such a connection with 1008, the rate-limit close the page already obeys: it waits 30 seconds and tries again instead of playing on a channel it cannot follow, until the owner reloads it.

### Discovery

The owner pairs a client with an address, nothing else: the instance's domain, or its workers.dev host without one. The client reads `https://<address>/.well-known/yolo`, checks that the JSON answer's `name` is `"Yolo"`, as `/.well-known/yolo` already answers, and that its `clientProtocols` include one the client speaks, and starts pairing there. On the home network the media node advertises `_yolo._tcp` by Bonjour with one TXT key, `origin`, whose value is the control plane's origin in UTF-8 (`origin=https://yolo.example.com`, no path or trailing slash). The node already knows that origin, the one its media listeners allow. The client checks it as it checks a typed address, so a TV at home finds the address without typing and, when only one server answers, goes straight to the pairing QR code. The address is the only thing a client stores apart from its device credential.

### Clients carry no content

A client carries no sources, no catalog, and no provider's name, logo, or URL: every title, image, and stream it shows comes from the server it paired with, as the rule against provider names keeps `service/` neutral. A client is then a player for the owner's own server, like other media-server clients.

### Conformance kit

A scripted control plane in Node, under `test/`, plays scenarios against a client over the real protocol: one for each required message and rule (each command, each broadcast, each report the client owes, the heartbeat, and the back-off), and the cases that went wrong in the player: pairing, a welcome that names a stream to recover, a pause, a seek, and a `tracks` message lost with a dead connection, `load`, a seek while a stream loads, `deactivate`, a `media` message that takes away the path in use, a rate limit, a `4003` close, and a client protocol the server no longer serves. It checks what the client sends, and, for a message that needs no reply (`stop`, `deactivate`, a broadcast), what the client shows: a client under test answers the kit's state query, which only debug builds carry. The kit sends `{ "type": "debug_state" }` over the realtime WebSocket it already serves, and the client answers on the same socket with `{ type: "debug_state", sessionId, paused, position, subtitle, active, shown }`: the `sessionId` of the stream it plays or null, whether it is paused, its position in seconds, the id of the subtitle track on screen or null, whether it is the active device, and `shown`, the `state`, queue, playlists, and devices it displays, in the shapes the Hub sent them. A release build ignores the message, as it ignores any type it does not know. The browser player runs it in `npm run check`; a native client runs it in its own CI against its simulator build.

## Alternatives considered

**The player as the reference.** A second client would reverse-engineer `player.js` and its tests, and nothing would tell either client when the other one's assumptions changed.

**A third-party protocol** such as Jellyfin's ([rejected](../../rejected/feature/2026-10-11-jellyfin-protocol-plugin.md)). Its clients would never show what makes Yolo different, and an agent controls them only as far as each app obeys.

**A schema-generated protocol (OpenAPI, Protocol Buffers).** It adds a generator and a build step to each client for an API of a few dozen routes and about twenty message types; the JSON shapes in the owning notes and the conformance kit check the same things.

## Acceptance criteria

`/.well-known/yolo` serves `clientProtocols`; the browser player and the Apple TV client both pass the conformance kit; the Apple TV client pairs with an address found by Bonjour at home and with one typed by the owner; and a client whose protocol is older than the Hub serves shows its update prompt.

## Risks

- **A published contract slows the player.** A realtime change the previous release cannot follow now costs a protocol raise and an update on every native client; most changes stay additive instead.
- **The kit only proves what it scripts.** Recovery after a dead connection took many fixes in the player, and a scenario left out of the kit is untested in every other client.
- **Bonjour reaches only the home network,** and some networks block multicast; away from home, the owner types the address.
