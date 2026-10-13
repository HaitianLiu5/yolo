# Agent Note: The media node's internal API

Status: implemented

English | [中文](2026-10-07-node-internal-api.zh.md)

## Problem

The control plane decides what plays where; the node resolves sources, runs media sessions, and talks to the home network. The two halves need one narrow contract, so that neither reaches into the other's state, the node can be offline without breaking the control plane, and only the control plane can ask the node to act.

## Decision

The node ([`service/node/src/app.js`](../../../../service/node/src/app.js)) serves `/internal/v1/*` only on `127.0.0.1`, to the control plane, which reaches it through [`nodeFetch()`](2026-10-08-workers-vpc-node-access.md). Every request is signed, as defense in depth on top of the private transport: the headers `x-yolo-timestamp` and `x-yolo-signature` carry `HMAC-SHA256(nodeSecret, timestamp\nmethod\npath-and-query\nSHA-256(body))` in base64url, and a clock skew over five minutes is rejected. Its two media listeners serve only `/m/*` and `/edge/probe` over HTTPS: on the machine's private LAN address to devices at home ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)), and through a router port to devices anywhere while the owner has remote access on ([media off the Worker](2026-10-13-media-off-the-worker.md)).

| Method | Path | Purpose |
|---|---|---|
| GET | `/internal/v1/health` | Version, internal protocol, uptime, `media` (sessions, transcodes, cache statistics), `sources` (each source's state), `plugins` (each plugin's load state and error), `lan` (the LAN listener: `enabled`, `port`, `address`, `name`, `origin`, `listening`, `notBefore`, `notAfter`, `error`), `wan` (the remote listener: the same, plus `addresses`, `ipv6`, `mapping` with the router's `mode`, `method`, `externalAddress`, `externalPort`, and `error`, `publicAddress`, `nat`, `natReason`, and `guard`, its connection counts) |
| POST | `/internal/v1/claim` | `{ url }` → `{ source }`: the node asks its source plugins in order and the first to claim wins; `not_found` if none does. The control plane calls it before playing any URL |
| POST | `/internal/v1/prepare` | `{ sessionId, source, capabilities, viewport, startTime, reason, tracks: { preferences }, limits, network, mediaToken }` → a stream descriptor ([media pipeline](2026-10-11-node-media-pipeline.md)) with `network` and `origin`: `network` names the media path (`lan`, `wan`, or `relay`; `tunnel` reads as `relay`), and `lan` or `wan` takes that listener while it serves, the relay otherwise; the descriptor says the path served and the listener's origin. The plugin's `prepare()` resolves the source and the pipeline serves it, with `mediaToken` bound to this session. `startTime: null` lets the source pick the start. **Calling it again with the same `sessionId` rebuilds the session**, which is how track changes work |
| POST | `/internal/v1/sessions/:id/stop` | Stops a session: the token is invalidated after about 10 seconds, ffmpeg is reclaimed, and the source's `stop()` runs (for example to stop a Plex transcode) |
| POST | `/internal/v1/sessions/:id/tracks` | `{ source, subtitles?, audio?, position }` → `{ tracks, reload }`. A change of `vtt` subtitles only keeps the stream and `reload` is empty; a `burn` subtitle or another audio track rebuilds the session at `position`, and `reload` is the new stream descriptor |
| POST | `/internal/v1/sessions/:id/progress` | Progress forwarded by the control plane; the node hands it to the source's `progress()` (Plex writes its own progress) |
| GET | `/internal/v1/tracks?source=` | A source's tracks; `source` is the Source as JSON |
| POST | `/internal/v1/metadata` | `{ source }` or `{ url }` (claimed first) → `{ source, title, thumbnail, duration, isLive }`; used by `search` to resolve a URL and to title queue items |
| GET | `/internal/v1/library/…` | One-to-one with the [`/v1` library routes](2026-10-07-v1-http-api.md). Library and item ids are `<source>:<id>`, and the node finds the plugin by the prefix; search and the library list merge every source and list failed ones under `unavailable` |
| GET | `/internal/v1/thumbnail?url=` | An image on another host, for [`/v1/thumbnail`](2026-10-07-v1-http-api.md): the image with its type, or `forbidden` when the host is not a public address (see **Thumbnails** below) |
| POST | `/internal/v1/playlists/expand` | `{ url }` → `{ title, url, items: [{ source, title, thumbnail, duration }] }`, expanded by the source plugins in order |
| POST | `/internal/v1/owner-code/verify`, `/consume` | Owner pairing codes ([passkey sign-in](2026-10-08-passkey-owner-sign-in.md)) |
| PUT | `/internal/v1/lan` | `{ name, allowOrigin }` → the LAN listener's status and `csr`, a certificate request for `name` with the node's own key |
| PUT | `/internal/v1/lan/certificate` | `{ name, chain }` → the status: the chain for the node's key and `name` is installed without a restart |
| PUT | `/internal/v1/wan` | `{ name, allowOrigin, enabled }` → the remote listener's status and `csr`; `enabled: false` (the owner's remote access off) closes the listener and deletes the router mapping ([media off the Worker](2026-10-13-media-off-the-worker.md)) |
| PUT | `/internal/v1/wan/certificate` | `{ name, chain }` → the status, as for the LAN listener |
| GET/HEAD | `/m/{token}/…` | Media, authorized only by the media token in the path ([same-origin passthrough](2026-10-07-same-origin-media-passthrough.md)), also on the LAN listener: `f/{n}` files or segments (byte ranges, disk cache), `p/{n}.m3u8` rewritten playlists (`?at=` for live rewind), `l/{n}/{seq}` live DVR segments, `dash/master.m3u8` and friends for joined audio and video, `x/{file}` ffmpeg output, and `sub/{n}.vtt` subtitles |

**When the node is offline**, `prepare` fails with `node_offline`; the pages, MCP, and queue management keep working, and the player says the media node is offline. A URL added to the queue while the node is offline stays an unclaimed `{ url }` until it is played.

**Thumbnails.** A source's `thumbnail` is an image on another host, such as a video site's image server ([source plugin API](2026-10-11-source-plugin-api.md)). A screen that loaded it itself would show that host the screen's address, so the node fetches it ([`thumbnails.js`](../../../../service/node/src/thumbnails.js)) and screens load it from Yolo's own origin. The image server then sees the home's address, as it does for the node's media requests, and the Worker sends no request to a host that a plugin names. The URL comes from a plugin, a stored row, or any holder of a read token, so the fetch is guarded against server-side request forgery. It takes only http(s) URLs without credentials. Every address the name resolves to must be public, which excludes loopback, private, shared, link-local, documentation, multicast, and reserved ranges and their IPv4-mapped and NAT64 forms. The check runs in the socket's own lookup, so DNS rebinding cannot change the address between the check and the connection, and it runs again on each of at most three redirects. The answer must be a JPEG, PNG, WebP, GIF, or AVIF image (no SVG) of at most 4 MiB, and the whole fetch must finish within 10 seconds. The node keeps the last 32 MiB of images in memory and fetches each URL once at a time; the control plane marks the answer `private, max-age=86400`, so a screen's browser keeps it for a day. A source whose images are on the home network serves them through `artwork` instead.

**Upgrades.** The path stays `/internal/v1` while the Source format and endpoints evolve; a protocol number says whether two sides understand each other. The control plane sends `NODE_PROTOCOL` in `x-yolo-protocol` on every request (none means protocol 0), and the node accepts its own number and the one before, answering anything else with `node_offline` and both sides' numbers. A release that changes this API in a way the previous release's other side cannot follow raises the number, so the node can be upgraded first and the Worker after it ([versions and releases](../process/2026-10-13-versions-and-releases.md)). `/internal/v1/health` reports the node's `version` and `protocol`.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

Everything the control plane knows about media comes through this table, so the node can change its pipeline, plugins, and caches freely behind it. Requests are authenticated twice (the private transport and the signature), but the signature cannot distinguish the owner from the control plane, which is why issuing owner codes is kept off this API. The protocol number turns the lockstep between the control plane and the node into a check: a mismatch fails every request with a message naming the side to upgrade, instead of failing on a Source the other side cannot read.
