# Agent Note: Control plane on Cloudflare, media node at home

Status: implemented

English | [中文](2026-10-07-control-plane-on-cloudflare-media-node-at-home.zh.md)

## Problem

The earlier single-process server was one Node process (Express and `ws`) on the owner's home machine. It resolved URLs with yt-dlp, transcoded with ffmpeg, proxied Plex, and drove the original Tesla-only player, a `<canvas>` player in the Tesla browser; a cloudflared tunnel exposed it, and none of its HTTP, WebSocket, or proxy routes required authentication. Most of its logic sat in a 4,200-line `server/index.js` with module-level state. Agents controlled it through a local CLI, which ChatGPT and claude.ai cannot use: they need a public HTTPS address with OAuth.

The goal was a private, agent-driven media service — later also music, podcasts, and audiobooks — with the in-car player as one of several clients. The media half (yt-dlp, ffmpeg, a 20 GB disk cache, Plex on the home network) cannot run on Cloudflare Workers.

## Decision

Yolo has two halves. The **control plane** is a Cloudflare Worker (`service/control`) with D1, a Durable Object per user (the Hub), and KV. The **media node** (`service/node`) is a Node process on the home machine. The Worker is the only public entry point; the home machine exposes nothing, and the control plane reaches it as described in [Workers VPC node access](2026-10-08-workers-vpc-node-access.md).

```
Clients (the player in a car, a browser, or a phone; agents)
   │  HTTPS + WSS, one origin
   ▼
Control plane: Cloudflare Worker (Hono)
   ├ /                the player (Workers Static Assets, COOP/COEP)
   ├ /v1/*            HTTP API
   ├ /v1/realtime     WebSocket → Hub Durable Object (one per user)
   ├ /mcp             MCP (Streamable HTTP)
   ├ /oauth/*         authorization server and device grant
   ├ /.well-known/*   OAuth metadata
   ├ /device          screen pairing approval page
   ├ /login, /auth/*  owner sign-in with a passkey
   ├ /account         the owner's account page
   ├ /m/*             media, passed through to the node unchanged
   ├ cron (5 min)     the node's LAN name, address record, and certificate
   └ D1: users, devices, queue, playlists, history, track preferences
   │  Workers VPC binding (through Cloudflare Tunnel; the node has no public address)
   ▼
Media node: Node on the home machine (Hono)
   ├ /internal/v1/*   called only by the control plane
   ├ /m/*             media sessions, authorized by the media token in the path
   └ LAN listener     HTTPS on the private address: /m/* and /lan/probe for devices at home
```

The Hub owns "what is playing now"; the node owns media sessions (proxies, ffmpeg, upstream transcodes). They talk only through the [node's internal API](2026-10-07-node-internal-api.md). When the node is offline, the pages, MCP, and queue management keep working; playing and browsing the library return `node_offline`.

Both halves use **Hono**, whose routes are Web-standard `Request`/`Response` handlers that run on Workers and on Node alike. Media goes through Cloudflare first: one address works anywhere, which is the lowest barrier for the owner. A device at home that reaches the node's LAN listener fetches media from it directly instead ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)). v1 serves one user with several devices; multi-user households and several nodes are outside v1, but the protocol leaves room for them.

Routes that anyone can reach without a credential are limited per client address with Workers rate-limit bindings ([`service/control/src/rate-limit.js`](../../../../service/control/src/rate-limit.js)), because each such request can write KV, query D1, or reach the home node. Sign-in (`/login`, `/auth/*`), pairing (`/device` and the device grant), and OAuth (`/oauth/*`) allow 60 requests a minute per address. An address whose `/m/*` tokens the node refused (403, or 410) more than 30 times in a minute gets 429 for `/m/*` for a minute, without reaching the node; a valid media token is never counted. The bindings are in the template, so every instance and the e2e stack have them; the counters are per Cloudflare location.

### Deployment

An instance is deployed from its own checkout with `npm run yolo`, as [agent deployment](../feature/2026-10-13-agent-deployment.md) describes and [`skills/yolo-deploy`](../../../../skills/yolo-deploy/SKILL.md) walks through. The ignored instance file holds the domain and the Cloudflare ids; `provision` creates D1, KV, the tunnel, and the Workers VPC service that points at `127.0.0.1:9191` on the home machine; `migrate` backs up D1 and applies the migrations; `deploy` builds the player (`clients/player/dist`, which the Worker serves as static assets) and deploys the Worker with `NODE_SECRET` from the node's `.env`; and `service install` runs the node and cloudflared as services on the home machine. The Worker is served only on its custom domain (`workers_dev: false`) and keeps Workers Logs on for its own structured lines, without invocation logs ([device telemetry](../feature/2026-10-11-device-telemetry.md)). The optional Worker secret `LAN_DNS_TOKEN`, a Cloudflare API token with Zone Read and DNS Edit on the zone, turns on [LAN direct play](../feature/2026-10-12-lan-direct-play.md); the Worker's cron trigger does the rest.

The control plane and the node are upgraded one after the other, in the order [versions and releases](../process/2026-10-13-versions-and-releases.md) sets. The owner's first sign-in is in [passkey owner sign-in](2026-10-08-passkey-owner-sign-in.md), and pairing a screen in [device code pairing](../feature/2026-10-07-device-code-pairing.md).

On the Workers Paid plan, a budget alert shows unexpected usage within a day. In the dashboard, open **Manage Account → Billing → Billable Usage → Set Budget Alert**, enter an amount such as $5, and select **Create** (or **Notifications → Add → Budget Alert**); Cloudflare adds a $10 alert by default to Pay-as-you-go accounts that have none. The free plan sends no bill: past its daily limits, requests fail instead.

## Alternatives considered

**Plan A: everything in one process at home, with Cloudflare only providing the tunnel.** Plan B won because it plugs into Cloudflare's infrastructure and its ready-made OAuth and MCP libraries, keeps the Worker as the only entry so the home machine is never exposed directly, keeps pages and MCP available while the node is offline, and can grow to several users later.

**Express on both halves.** Express runs only on Node.

### Why not vinext?

vinext, a Vite-based reimplementation of Next.js whose first deployment target is Workers, does not fit Yolo. The media half (yt-dlp, ffmpeg, better-sqlite3 at the time, a 20 GB disk cache, the LAN Plex server) cannot run on Workers. Deployed as a Node standalone server instead, it loses the Workers bindings, and the Next.js routing model has no WebSocket upgrade. The player is a plain JavaScript application, with a canvas engine and a `<video>` engine, that gains nothing from React Server Components or page routing.

**LAN-direct media first.** Media through Cloudflare works anywhere with no per-network setup, so it stays the default; [LAN direct play](../feature/2026-10-12-lan-direct-play.md) is an addition for devices at home that reach the node.

## Consequences

The control plane is reachable whenever Cloudflare is, and the home machine accepts no inbound connections. Yolo depends on a Cloudflare account; running without one is an [open proposal](../../proposed/architecture/2026-10-07-self-hosting-without-cloudflare.md), and relaying video through the Worker is most likely outside Cloudflare's terms on Free, Pro, and Business zones ([media off the Worker](../../proposed/architecture/2026-10-13-media-off-the-worker.md)). Two deployables run separately, and a protocol number decides whether they can talk while one of them is being upgraded; media travels from home to Cloudflare and back even when the player sits on the same network, unless the player reaches the node's LAN listener and fetches from it directly ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)).
