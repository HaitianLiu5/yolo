# Agent Note: Same-origin media passthrough with path tokens

Status: implemented

English | [中文](2026-10-07-same-origin-media-passthrough.zh.md)

## Problem

Media is served by the home node, but the player runs in a browser that reaches only the control plane. The player page is cross-origin isolated (COOP/COEP) for its [SharedArrayBuffer audio clock](2026-04-04-canvas-playback-engine.md), and under `Cross-Origin-Embedder-Policy: credentialless` a cross-origin request carries no cookies. Native players and a future LAN-direct connection carry no cookies either. Media therefore needs a credential that travels with the URL itself and a route that does not add a second authentication layer.

## Decision

Media reaches devices through the control plane on the player's own origin. The Worker serves the Tesla client at the site root as Workers Static Assets (`clients/tesla/dist`, whose `public/_headers` adds COOP/COEP), and Yolo's own routes are listed in `assets.run_worker_first` in `service/control/wrangler.jsonc`; every other path is a static file or the client's `index.html`. [`service/control/src/media.js`](../../../../service/control/src/media.js) passes `GET` and `HEAD` requests under `/m/*` to the node unchanged, forwarding only the range and cache-validation headers, and returns the node's answer as it is, including `410 SESSION_EXPIRED`.

A media URL is authorized only by the **media token** in its path; no cookie and no node request signature is involved:

- The Hub issues one token per session: `HMAC-SHA256(nodeKey, sessionId|userId|exp)`. The node verifies it locally, without calling the control plane ([`service/node/src/media/pipeline.js`](../../../../service/node/src/media/pipeline.js)).
- The token is a **path prefix**, `/m/{token}/…`, so relative URLs in an HLS manifest carry it automatically, and the node prefixes every URI it rewrites the same way.
- A token lives as long as its session, at most 12 hours (`MEDIA_TOKEN_TTL_SECONDS`). When a session stops, the node keeps it for about 10 seconds, because a player that has not yet received the next `load` may still fetch segments. After that, requests with the token get `410` with `X-Yolo-Error-Code: SESSION_EXPIRED`, and the player asks for a new stream. A session the node does not know (after a node restart, for example) answers the same way; a forged token gets `403`.

Device credentials on `/v1` are a separate matter: they are checked against D1 on every request, so revoking a device takes effect immediately ([device code pairing](../feature/2026-10-07-device-code-pairing.md)).

## Alternatives considered

**A separate `media.` subdomain served straight from the tunnel.** Under COOP/COEP a cross-origin request carries no cookie, so it would need its own credential scheme and CORP headers, and it would expose a second public entry point to the home machine. Passing media through the Worker on the same origin keeps one authentication layer and left the player code unchanged.

**Cloudflare Access with a cookie** (the media half of the authentication choice). Native players, cross-origin requests, and LAN-direct connections do not send that cookie; a signed URL works for all of them.

**Tokens in a query parameter.** HLS manifests reference segments by relative URL, which drops the query string; a path prefix survives relative resolution.

## Consequences

The player, the realtime socket, and every media byte share one origin, so the page stays cross-origin isolated without CORP on media responses, and only the media token guards `/m/*`. The same URL could serve a LAN-direct connection later because nothing in it depends on the Worker. All media passes through Cloudflare, which subjects it to Cloudflare's terms for video ([open question](../../proposed/process/2026-10-07-cloudflare-video-terms.md)) and adds a hop when the player is at home. A leaked media URL plays until its session ends or the token expires.
