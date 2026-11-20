# Agent Note: Yolo's client protocol

Status: implemented

English | [中文](2026-10-19-client-protocol.zh.md)

## Problem

What a screen must do to be a Yolo screen was defined by its one implementation, the browser player. The pieces are recorded in several notes ([/v1](../../implemented/architecture/2026-10-07-v1-http-api.md), [Hub and realtime channel](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md), [device code pairing](../../implemented/feature/2026-10-07-device-code-pairing.md), [capability negotiation](../../implemented/architecture/2026-10-07-capability-negotiation.md), [media off the Worker](../../implemented/architecture/2026-10-13-media-off-the-worker.md)), but nothing said which of them a client must implement, which it may leave out, how a client finds a server, or how it learns that the server has moved on. The player ships with the Worker, so it never had to know. A native client ships on its own schedule ([Apple TV client](../../proposed/feature/2026-10-19-apple-tv-client.md)), and a third-party protocol is not the answer ([Jellyfin plugin, rejected](../../rejected/feature/2026-10-11-jellyfin-protocol-plugin.md)).

## Decision

Yolo's **client protocol** is a published, versioned contract that every screen implements, the browser player included. Each part keeps its owning note; this note owns the list of parts, the version, what a client may leave out, discovery, and how a client is proven.

### The parts

| Part | What a client does | Owner |
|---|---|---|
| Discovery | Finds the server's address and checks it with `GET /.well-known/yolo` | Below |
| Pairing | The OAuth device grant: shows the code, polls for its device credential, and forgets it on `4003` or a refused credential | [Device code pairing](../../implemented/feature/2026-10-07-device-code-pairing.md) |
| HTTP | The `/v1` routes a device credential may call, and the error shape | [/v1](../../implemented/architecture/2026-10-07-v1-http-api.md) |
| Realtime | A ticket, one WebSocket, `hello` with capabilities, reports, `ended`, `error`, `network`, and the heartbeat | [Hub and realtime channel](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md) |
| Media | The `load`'s stream descriptor, every URL resolved against its `origin`, the media paths a welcome lists, probed in order with the server's origin as `Origin`, which a browser sends itself and a native client sets, since a media origin known by its IP address answers the probe only to that origin | [Media off the Worker](../../implemented/architecture/2026-10-13-media-off-the-worker.md) |

**Required and optional.** A client must handle `welcome`, `load`, `pause`, `resume`, `seek`, `stop`, `tracks`, `deactivate`, `media` (probing its paths again and reporting `network` when its path changes), a stream that fails on the path in use (moving to the next path that works and rebuilding at the same position, as [media off the Worker](../../implemented/architecture/2026-10-13-media-off-the-worker.md) requires), and the broadcasts it shows, must keep the realtime rules that protect the Hub (the exact `HEARTBEAT_PING`, no answer to a broadcast, a back-off of at least 30 seconds after a rate limit), and must make up after a welcome for what a dead connection took: the pause, resume, and seek the welcome's `commands` name, the subtitles in the welcome's `state.tracks` when the stream on screen can switch to them in place, and its own unheard `ended` and `idle` ([what a dead connection takes](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md#what-a-dead-connection-takes)). Without that, an agent's pause that went into a dead socket is lost while the agent was told it worked, and the screen's next report overwrites it. A client may leave out `danmaku`, `keep`, the [account's language](../feature/2026-11-06-account-language.md), `/v1/agent`, the [agent canvas](../../proposed/architecture/2026-10-21-agent-canvas.md) (a client that declares no `canvas` capability gets none of its messages, and an agent asks in words instead), and telemetry; the Hub already serves a client that ignores them.

### Versions

`CLIENT_PROTOCOL` in `@useyolo/core` (`service/core/src/protocol.js`) is one integer, sent by the client in `hello` as `protocol`. `/.well-known/yolo` serves `clientProtocols` (`CLIENT_PROTOCOLS`), every number the Hub serves, so a client checks it before pairing. A change that the previous release's clients cannot follow raises it, as `NODE_PROTOCOL` does for the node ([versions and releases](../../implemented/process/2026-10-13-versions-and-releases.md)); the Hub serves the current and the previous number. Serving a number means keeping its shapes: the Hub keeps the number each realtime connection's `hello` named and speaks to it in that number, and a client sends its number on every `/v1` request in a `Yolo-Protocol` header (`CLIENT_PROTOCOL_HEADER`; the player's `api.js` adds it), so a route whose shape changed answers in the old shape to a client that names the previous number (a request without the header counts as the first number). A raise therefore keeps the previous shape beside the new one for one release, then drops it.

`CLIENT_PROTOCOL` is 2, raised for a session per screen ([screen sessions](2026-10-31-screen-sessions.md)), and the Hub serves 1 and 2. A protocol-2 connection's welcome carries this screen's own session as `state`, the other screens' as `sessions`, and `profile` and `profiles`; it hears every screen's `state` and every screen's `queue` as `{ deviceId, items }`, and `devices` with `profiles`. A protocol-1 connection keeps the shapes it had, scoped to its own screen: its welcome's `state` and every `state` it hears are its own session, its `queue` is its own `{ queue }`, and another screen continuing its session reaches it as the `pause` it already handles; it plays on its own beside other screens and cannot see or continue theirs. Protocol 2's `/v1` changes are additive, and a paired screen's request without `deviceId` is for its own session, so the Worker does not read the header. The browser player and the Apple apps speak 2. Every client sends `protocol`, the browser player included. When `clientProtocols` shares no number with the client, it says so at once, before pairing or at its next start: a client older than every number shows the owner where to update it, and one newer than every number says the server needs upgrading. A paired client that the Hub no longer serves gets a welcome with `upgrade: true`, `clientProtocols`, and nothing else, and the connection closes; a native client shows the same prompt instead of failing mid-play, and a browser tab loaded before the upgrade reloads, at most once a minute (`main.js`), and does not reconnect for a minute (`realtime.js`), so a tab whose reload is held back does not spend the Hub's connection allowance. A `hello` without `protocol` comes from a page older than this protocol and counts as its first number. That page does not know `upgrade: true`, so once the Hub stops serving the first number it closes such a connection with 1008 (`helloProtocolAction()` decides which of the three a hello gets), the rate-limit close the page already obeys: it waits 30 seconds and tries again instead of playing on a channel it cannot follow, until the owner reloads it.

### Discovery

The owner pairs a client with an address, nothing else: the instance's domain, or its workers.dev host without one. The client reads `https://<address>/.well-known/yolo`, checks that the JSON answer's `name` is `"Yolo"`, as `/.well-known/yolo` already answers, and that its `clientProtocols` include one the client speaks, and starts pairing there. On the home network the media node advertises `_yolo._tcp` by Bonjour with one TXT key, `origin`, whose value is the control plane's origin in UTF-8 (`origin=https://yolo.example.com`, no path or trailing slash): `PUBLIC_ORIGIN`, else the page origin its LAN or remote listener allows. The operating system's responder publishes it (`service/node/src/bonjour.js`): `dns-sd` on macOS, `avahi-publish` on Linux; elsewhere, or without the command, the node advertises nothing, and `BONJOUR=0` turns it off. The node checks the origin every minute and republishes when it changed or the command exited. The client checks it as it checks a typed address, so a TV at home finds the address without typing. Anyone on the network can advertise `_yolo._tcp`, and a server someone else runs could approve its own pairing code without the owner, so the client starts pairing with an address it discovered only after the owner confirms its host, shown in full, with one press; the pairing screen shows the host again beside the code. The owner's passkey signs in only on the owner's own domain, so a server someone else advertises can never take the owner's approval. The address is the only thing a client stores apart from its device credential.

### Clients carry no content

A client carries no sources, no catalog, and no provider's name, logo, or URL: every title, image, and stream it shows comes from the server it paired with, as the rule against provider names keeps `service/` neutral. A client is then a player for the owner's own server, like other media-server clients.

### Proving a client

A client is proven by walking it on the local stack ([agent acceptance](../testing/2026-11-20-agent-acceptance.md)): every client, the browser player in car and web mode, the iOS app, and the tvOS app, pairs with the same stack, plays what an agent sends, follows the commands and the broadcasts, and offers Continue here and Move to across the others. A debug build of a native client takes the stack's address at launch (`-YoloServer`). A conformance kit, a scripted control plane that dropped commands and killed connections on cue against a native client, was removed with the other tests: it had no recorded run.

## Alternatives considered

**The player as the reference.** A second client would reverse-engineer `player.js` and its tests, and nothing would tell either client when the other one's assumptions changed.

**A third-party protocol** such as Jellyfin's ([rejected](../../rejected/feature/2026-10-11-jellyfin-protocol-plugin.md)). Its clients would never show what makes Yolo different, and an agent controls them only as far as each app obeys.

**A schema-generated protocol (OpenAPI, Protocol Buffers).** It adds a generator and a build step to each client for an API of a few dozen routes and about twenty message types; the JSON shapes in the owning notes and every client walked on one stack check the same things.

## Consequences

- **A native client can check a server before pairing and learn when it moved on,** without shipping with the Worker. Walking every client on one stack proves each against the required part, the browser player included.
- **A published contract slows the player.** A realtime change the previous release cannot follow now costs a protocol raise and an update on every native client; most changes stay additive instead.
- **Only what is walked is proven.** Recovery after a dead connection took many fixes in the player, and a path no one walks on a client goes unproven there; the in-car checks and the owner's own screens carry the rest.
- **Bonjour reaches only the home network,** and some networks block multicast; away from home, the owner types the address. It also depends on the system's responder: a Linux node without Avahi advertises nothing.

Each client's pairing on the local stack shows which hellos the Hub serves, the node's advertisement is seen by the apps' Bonjour at home, and `clientProtocols` comes from `/.well-known/yolo`.
