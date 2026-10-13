# Agent Note: The media node's internal API

Status: implemented

English | [中文](2026-10-07-node-internal-api.zh.md)

## Problem

The control plane decides what plays where; the node resolves sources, runs media sessions, and talks to the home network. The two halves need one narrow contract, so that neither reaches into the other's state, the node can be offline without breaking the control plane, and only the control plane can ask the node to act.

## Decision

The node ([`service/node/src/app.js`](../../../../service/node/src/app.js)) serves `/internal/v1/*` only on `127.0.0.1`, to the control plane, which reaches it through [`nodeFetch()`](2026-10-08-workers-vpc-node-access.md). Every request is signed, as defense in depth on top of the private transport: the headers `x-yolo-timestamp` and `x-yolo-signature` carry `HMAC-SHA256(nodeSecret, timestamp\nmethod\npath-and-query\nSHA-256(body))` in base64url, and a clock skew over five minutes is rejected. Its second listener, HTTPS on the machine's private LAN address, serves only `/m/*` and `/lan/probe` to devices at home ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)).

| Method | Path | Purpose |
|---|---|---|
| GET | `/internal/v1/health` | Version, internal protocol, uptime, `media` (sessions, transcodes, cache statistics), `sources` (each source's state), `plugins` (each plugin's load state and error), `lan` (the LAN listener: `enabled`, `port`, `address`, `name`, `origin`, `listening`, `notBefore`, `notAfter`, `error`) |
| POST | `/internal/v1/claim` | `{ url }` → `{ source }`: the node asks its source plugins in order and the first to claim wins; `not_found` if none does. The control plane calls it before playing any URL |
| POST | `/internal/v1/prepare` | `{ sessionId, source, capabilities, viewport, startTime, reason, tracks: { preferences }, limits, network, renderer, mediaToken }` → a stream descriptor ([media pipeline](2026-10-11-node-media-pipeline.md)) with `network` and `origin`: `network: "lan"` takes the LAN path while the LAN listener serves. Without `renderer` it serves a realtime device: the plugin's `prepare()` resolves the source and the pipeline serves it, with `mediaToken` bound to this session. `startTime: null` lets the source pick the start. **Calling it again with the same `sessionId` rebuilds the session**, which is how track changes work |
| POST | `/internal/v1/sessions/:id/stop` | Stops a session: the token is invalidated after about 10 seconds, ffmpeg is reclaimed, and the source's `stop()` runs (for example to stop a Plex transcode) |
| POST | `/internal/v1/sessions/:id/tracks` | `{ source, subtitles?, audio?, position }` → `{ tracks, reload }`. A change of `vtt` subtitles only keeps the stream and `reload` is empty; a `burn` subtitle or another audio track rebuilds the session at `position`, and `reload` is the new stream descriptor |
| POST | `/internal/v1/sessions/:id/progress` | Progress forwarded by the control plane; the node hands it to the source's `progress()` (Plex writes its own progress) |
| POST | `/internal/v1/sessions/:id/control` | `{ action: pause \| resume \| stop \| seek, position? }`, for node renderers only; the Hub sends realtime devices their commands directly |
| GET | `/internal/v1/tracks?source=` | A source's tracks; `source` is the Source as JSON |
| POST | `/internal/v1/metadata` | `{ source }` or `{ url }` (claimed first) → `{ source, title, thumbnail, duration, isLive }`; used by `search` to resolve a URL and to title queue items |
| GET | `/internal/v1/renderers` | Players the node drives itself (node renderers) with their state and progress |
| GET | `/internal/v1/library/…` | One-to-one with the [`/v1` library routes](2026-10-07-v1-http-api.md). Library and item ids are `<source>:<id>`, and the node finds the plugin by the prefix; search and the library list merge every source and list failed ones under `unavailable` |
| POST | `/internal/v1/playlists/expand` | `{ url }` → `{ title, url, items: [{ source, title, thumbnail, duration }] }`, expanded by the source plugins in order |
| POST | `/internal/v1/owner-code/verify`, `/consume` | Owner pairing codes ([passkey sign-in](2026-10-08-passkey-owner-sign-in.md)) |
| PUT | `/internal/v1/lan` | `{ name, allowOrigin }` → the LAN listener's status and `csr`, a certificate request for `name` with the node's own key |
| PUT | `/internal/v1/lan/certificate` | `{ name, chain }` → the status: the chain for the node's key and `name` is installed without a restart |
| GET/HEAD | `/m/{token}/…` | Media, authorized only by the media token in the path ([same-origin passthrough](2026-10-07-same-origin-media-passthrough.md)), also on the LAN listener: `f/{n}` files or segments (byte ranges, disk cache), `p/{n}.m3u8` rewritten playlists (`?at=` for live rewind), `l/{n}/{seq}` live DVR segments, `dash/master.m3u8` and friends for joined audio and video, `x/{file}` ffmpeg output, and `sub/{n}.vtt` subtitles |

**When the node is offline**, `prepare` fails with `node_offline`; the pages, MCP, and queue management keep working, and the player says the media node is offline. A URL added to the queue while the node is offline stays an unclaimed `{ url }` until it is played.

**Node renderers.** The node may drive a player itself, which the control plane treats as a device with the id `node:<id>` and controls through `/sessions/:id/control`. The earlier single-process server was once attached this way (`node:legacy`); the node ships no renderer, so `/renderers` returns an empty list and `/prepare` with a `renderer` answers `not_found`, while the control plane still supports such devices.

**Upgrades.** The path stays `/internal/v1` while the Source format and endpoints evolve; a protocol number says whether two sides understand each other. The control plane sends `NODE_PROTOCOL` in `x-yolo-protocol` on every request (none means protocol 0), and the node accepts its own number and the one before, answering anything else with `node_offline` and both sides' numbers. A release that changes this API in a way the previous release's other side cannot follow raises the number, so the node can be upgraded first and the Worker after it ([versions and releases](../process/2026-10-13-versions-and-releases.md)). `/internal/v1/health` reports the node's `version` and `protocol`.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

Everything the control plane knows about media comes through this table, so the node can change its pipeline, plugins, and caches freely behind it. Requests are authenticated twice (the private transport and the signature), but the signature cannot distinguish the owner from the control plane, which is why issuing owner codes is kept off this API. The protocol number turns the lockstep between the control plane and the node into a check: a mismatch fails every request with a message naming the side to upgrade, instead of failing on a Source the other side cannot read.
