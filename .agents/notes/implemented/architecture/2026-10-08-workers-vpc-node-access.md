# Agent Note: Reach the media node through Workers VPC

Status: implemented

English | [中文](2026-10-08-workers-vpc-node-access.zh.md)

## Problem

The control plane on Cloudflare must call the media node on the home machine — for the internal API and for every media byte under `/m/*` — without giving the node a public address or a credential to rotate. Workers VPC, which lets a Worker reach a private service through Cloudflare Tunnel, was still in beta in September 2026, and nobody had measured whether it could carry continuous video traffic.

## Decision

The control plane reaches the node through a **Workers VPC service binding** (`NODE` in `service/control/wrangler.jsonc`) that points at `127.0.0.1:9191` on the machine running cloudflared. The node's internal API, with the media the control plane passes through under `/m/*`, listens only on `127.0.0.1`, and the node has no public hostname. Its LAN listener binds the machine's private LAN address and serves only `/m/*` and `/edge/probe` to devices at home ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)); while the owner has remote access on, its remote listener serves the same through a router port, under its own DNS-only name ([media off the Worker](2026-10-13-media-off-the-worker.md)). Media crosses Workers VPC only while the owner has the relay on.

Every control-plane call to the node goes through **`nodeFetch()`** in [`service/control/src/node-client.js`](../../../../service/control/src/node-client.js); no other code calls the node. `NODE_TRANSPORT` selects the path, so switching is a configuration change only:

- `vpc` (default): the `NODE` binding.
- `tunnel`: the tunnel's public hostname `NODE_PUBLIC_ORIGIN` behind Cloudflare Access, authenticated with a service token (`NODE_ACCESS_CLIENT_ID`, `NODE_ACCESS_CLIENT_SECRET`).

Either way every request is signed with `NODE_SECRET`, as defense in depth ([node internal API](2026-10-07-node-internal-api.md)). A node request that came back to the Worker would recurse and bill every hop, so `nodeFetch()` refuses a `NODE_PUBLIC_ORIGIN` on the Worker's own host, and the Worker answers any request that carries a node signature with `508`. Gateway errors (502–504, 520–524, 530) map to `node_offline`; media requests get the node's own answers back whatever their status.

### The streaming spike

Before building on it, a one-off spike Worker forwarded every request to the earlier home server by two alternating paths: `vpc` (Worker → VPC service binding → tunnel → `localhost:9090`) and `public` (Worker → the existing tunnel hostname). A bench script on a laptop requested a static file of about 1.5 MB (one 2.5-second segment of 720p video) every 4 seconds for 60 minutes, with a random query string so the `public` path could not be served from Cloudflare's cache. The pass criteria for the `vpc` path were: at most 0.5% failures, slow-tail throughput (p5) of at least 10 Mbps (twice the 4.8 Mbps of 720p), and a p95 time to first byte no worse than the `public` path's p95 × 1.5 + 100 ms.

The run on 2026-10-08 passed: 450 requests per path, no failure on the `vpc` path, p5 throughput 16.9 Mbps, and p95 time to first byte 125 ms against 123 ms on the `public` path. It measured static files only; the planned half-hour test with the real player was not run; production playback through `/m/*` is configured for the VPC path (`NODE_TRANSPORT: "vpc"`). The spike's code was removed after this note recorded its method and result; it proxied a server that no longer exists and is recoverable from Git history.

## Alternatives considered

**The tunnel's public hostname with a Cloudflare Access service token.** It works today and remains the configured fallback, but it gives the node a public address and a service token to rotate. Workers VPC needs neither.

## Consequences

The node has no public address and no rotating credential, and one function owns every call to it, so a transport change touches one module and one variable. Yolo depends on a beta Cloudflare product; if Workers VPC fails or changes, `NODE_TRANSPORT=tunnel` switches back without code changes. The spike proved bulk transfer and latency, not long-running playback with real HLS pacing, WebSocket sessions, or Plex transcodes; those are covered by everyday use rather than a measurement.
