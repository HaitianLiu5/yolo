# Agent Note: Media leaves the Worker

Status: implemented

English | [中文](2026-10-13-media-off-the-worker.zh.md)

## Problem

Away from home, every media byte Yolo played travelled from the node through the cloudflared tunnel and Workers VPC to the Worker, which served it under `/m/*` on the owner's public origin ([same-origin passthrough](2026-10-07-same-origin-media-passthrough.md), [Workers VPC](2026-10-08-workers-vpc-node-access.md)). Only a device at home avoided it, through [LAN direct play](../feature/2026-10-12-lan-direct-play.md). That detour costs every stream a second trip through Cloudflare, holds it to the relay's 4.8 Mbps ceiling, and spends the account's Workers requests, while a direct path from the node reaches the screen faster and at the home upload's full rate.

Cloudflare's Service-Specific Terms reserve the right to limit video that a Free, Pro, or Business zone serves through its CDN without one of its paid media services ([terms](https://www.cloudflare.com/service-specific-terms-application-services/)).

From 0.5 to 0.6 a new instance therefore started with the relay off, and its screens played nothing until a direct path worked. A friend's first deployment showed what that costs: his gateway answered neither NAT-PMP nor UPnP, which was off by default, so remote direct play failed, the LAN path did not apply, and every play request was refused with `media_unreachable`. Each instance is one person's own Cloudflare account for personal use, so the owner decided (2026-10-14) that the relay is a normal, supported path: it turns on by itself as the fallback.

## Decision

The Worker carries control: sign-in, the catalog, tokens, the Hub, and MCP. Media goes from the node to the device by the first direct path that works for that device, LAN or remote, because direct paths are faster and spend no Cloudflare bandwidth. The relay through the Worker, in the owner's own Cloudflare account, is the always-available fallback: by default it carries a screen's media only when no direct path works for that screen.

| Path | `network` | Origin | Reaches |
|---|---|---|---|
| LAN direct | `lan` | `https://yolo-lan-<id>.<zone>:9443`, a DNS-only record of the node's private address | Devices on the home network |
| Remote direct | `wan` | `https://yolo-wan-<id>.<zone>:<port>`, a DNS-only record of the home's public address, through a router port; without a domain `https://<public address>:<port>` ([media without a domain](../feature/2026-10-13-no-domain-deployment.md#media-without-a-domain)) | Any device on the internet, the car on LTE included |
| Relay | `relay` | `PUBLIC_ORIGIN`, through the tunnel and the Worker | Anywhere: when no direct path works (`auto`, the default), as the last path (`on`), or never (`off`) |

Every path serves the same `/m/{token}/…` URLs, authorized by the media token in the path alone, so a stream works on any origin without a change to the token or the node's sessions.

### Path selection on a device

[`clients/player/src/media-paths.js`](../../../../clients/player/src/media-paths.js) chooses this screen's path; both engines play whatever origin the stream names ([two engines](2026-10-12-two-playback-engines.md)).

- **Discovery.** The Hub's `welcome` carries `media: { paths: [{ path, origin, notAfter }], relay, relayMode }` ([`service/control/src/edge/paths.js`](../../../../service/control/src/edge/paths.js)): `lan` while the last LAN check found the listener serving with a valid certificate, `wan` while remote access is on and the last check from outside reached the listener (without a domain, while the node serves under the current address with the certificate whose validation reached it from outside), the relay's mode for this user, and `relay`, whether the relay may carry media at all, which players from before the modes read. It also carries `lan`, the LAN origin alone, for players from before 0.5 ([Hub and realtime channel](2026-10-07-hub-and-realtime-channel.md)). The `wan` entry carries `home: true` for a device whose realtime connection comes from the home's public address, and the welcome says `domain: false` on an instance without a domain, where the screen's LAN switch has nothing to find. When the remote origin a welcome lists changes, the Worker has each Hub send its connected screens `media`, the same content their welcome would carry ([`index.js`](../../../../service/control/src/index.js)).
- **Order.** `lan`, then `wan`, then `relay`. "Play over the home network" in settings keeps governing `lan` per screen ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)); `wan` resolves to a public address, needs no browser permission, and has no switch; `relay` is a candidate unless the mode is `off`, and always the last.
- **Probes.** Every listener answers `GET /edge/probe` with `{ ok, name, path }`; the LAN listener also keeps `/lan/probe` for players from before 0.5. A screen probes its candidates at once, on the welcome, on the Hub's `media` message, on the browser's `online` event, when the LAN switch changes, and 30 seconds after a stream failed, with a timeout of 2 seconds for `lan` and 5 for `wan`, and takes the first path in order whose probe answered, waiting for a higher path only until its probe finishes. Plex Web tests its direct connections the same way, in parallel, with the relay last. A play request waits for the round only as long as it is worth: the screen remembers the path each network's last complete round took (a network here being the listeners the welcome lists and whether it placed the screen at home). A direct path that worked there is waited for; where none did, the play takes the relay at once; on a network the screen has not seen, it waits at most 1 second, then takes the best path that has answered, else the relay. The round goes on, and the next stream takes the path it finds. With the relay `off`, a play waits for the round.
- **Reports.** The screen sends `{ v: 1, type: "network", path, reason, probes }` when its choice changes and once after each welcome, with each probe's outcome (`ok`, `timeout`, `failed`, `off`, `certificate`, the LAN's permission and rebinding outcomes, or `http_<status>`); `path` is null when nothing works. A screen marked `home` adds `hairpin`: `ok` when its `wan` probe answered, so the router loops back to its own public address, and `failed` when it got no answer. Its own play requests carry `network: <path>`. The Hub keeps the latest path and probes per device, as it kept `lan` or `tunnel`, and reads `tunnel` as `relay` and a report with only `lan` as `lan` or `relay`, for one release.
- **The stream.** The Hub passes the path to `prepare`. The node serves `lan` or `wan` only while that listener serves, and the relay otherwise, and returns the path it served with the listener's origin in the stream descriptor. Each path has its own ceiling: `lan` `LAN_MAX_VIDEO_KBPS` (200,000 by default), `wan` `WAN_MAX_VIDEO_KBPS` (20,000), which the home's upload carries to one screen, and `relay` `STREAM_MAX_VIDEO_BITRATE_KBPS` (4800), kept low because the relay is a fallback; the device's [adaptive cap](../feature/2026-10-11-adaptive-quality.md) lowers any of them. A source plugin sees `network` `lan` for LAN direct play and `tunnel` for every other path, and the path's ceiling as `limits.maxVideoKbps`, which decides what a `<video>` device's Plex transcode carries ([media pipeline](2026-10-11-node-media-pipeline.md)).
- **No path.** With the relay `auto` or `on`, a device whose last report found no path gets the relay: its welcome may predate the mode. With the relay `off`, the Hub refuses a device with no path, or one on the relay, before the node does any work, with `media_unreachable`. Its message names each path, what the device's probes found, and each fix, and its `details` carry the same for the screen: `reason`, and `fixes` as `{ action, text }`, where `relay` sets the relay to Automatic, `remote` turns remote access on, and `forward` is the router step with the port, the node's address, and the router's address as the node last reported them. The screen shows the reason and the fixes instead of a bare error, with a button that sets the relay to Automatic through the owner's passkey session on that browser, or opens settings to sign in (in the car, the code that opens settings on a phone), and then plays the item again. An agent's `play` returns the message. When the node had to fall back to the relay because a listener stopped serving and the relay is off, the Hub stops that session and refuses the same way.

### Fallback

A stream fails on its path once the engine's bounded retries give up. When the screen has a path below the stream's own, the recovery first moves the screen there (`failed()`), sends `network`, records `media_path_fallback`, and rebuilds the stream at the same position by that path, as a failed LAN stream moved to the tunnel before. Thirty seconds later the screen probes again; a stream that plays never moves up, and the next stream takes the best path, so a direct path that starts working, after a port forward or a new domain, carries the next stream. A car that leaves home Wi-Fi in the middle of a LAN stream continues on `wan`, and on the relay where `wan` does not answer, unless the relay is off.

### Remote direct play

#### Name, records, and certificate

With remote access on in settings, the Worker's cron run (every 5 minutes, and when the owner asks) runs [`service/control/src/edge/wan.js`](../../../../service/control/src/edge/wan.js) after the LAN maintenance, with the same DNS provider: the zone token, now `MEDIA_DNS_TOKEN` (Zone Read and DNS Edit; `LAN_DNS_TOKEN`, its name before 0.5, is read for one release), or a DNS provider plugin in a zone of its own ([DNS provider plugins](2026-10-14-dns-provider-plugins.md)):

1. It names the node `yolo-wan-<8 hex digits>.<zone>` once, outside the passkey relying party, as for the LAN name ([`edge/names.js`](../../../../service/control/src/edge/names.js)).
2. Through `nodeFetch()` it sends `PUT /internal/v1/wan` with the name, `PUBLIC_ORIGIN`, and `enabled: true`. The node answers the home's public address, its router mapping, its IPv6 address when it listens there, whether it is behind carrier-grade or double NAT, the certificate's validity, and a certificate request ([node internal API](2026-10-07-node-internal-api.md)).
3. It keeps DNS-only records from the name: A to the public IPv4 address, and AAAA to the node's global IPv6 address while the node listens on it, with a TTL of 60 seconds, moved when an address changes. Cloudflare's own documentation names a grey-clouded (DNS-only) subdomain as a remedy for restricted video.
4. It obtains a certificate for exactly that name by ACME DNS-01 with the LAN code, renewed two thirds into its lifetime, with the same backoff, and sends the chain to `PUT /internal/v1/wan/certificate`.
5. It checks from outside: the Worker fetches `https://<name>:<port>/edge/probe` with a 5-second timeout. With the `allow_custom_ports` compatibility flag, on by default since compatibility date 2024-09-02 (Yolo's is 2026-10-01), a Worker's `fetch()` uses the port in the URL for a host that is not proxied ([compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)), and `global_fetch_strictly_public` sends it over the public internet, so an answer proves that the router forwards the port from outside the home.

The remote name has its own key and certificate rather than sharing the LAN one: turning remote access on or off never reissues the LAN certificate, a failed or delayed issuance for one name never holds back the other's renewal, and a client that completes a handshake with the public listener sees only the remote name. It costs a second ACME order per renewal period, far inside Let's Encrypt's limits.

The states, in KV under `yolo:wan`: `off`, `pending` (named, not serving yet), `ok`, `cgnat`, `unreachable` (the outside check got no answer: the router does not forward the port, or the ISP or a firewall blocks it), `certificate`, and `error` with the failing step (`zone`, `node`, `address`, `dns`, `certificate`, `install`, `listener`, `router`). The welcome lists `wan` only while it is `ok`. Behind carrier-grade NAT the records are removed. When the owner turns remote access off, the run deletes the records and sends `enabled: false`, and the node closes the listener and deletes its router mapping.

#### Without a domain

The listener's identity is the home's public address, and the node obtains a Let's Encrypt `shortlived` certificate for it itself, by HTTP-01 through the router's port 80, which it maps only while an order runs, or by TLS-ALPN-01 on the listener when its router port is 443. The control plane sends the node `certificate: "ip"` instead of a name, writes no record, needs no `MEDIA_DNS_TOKEN`, and skips the check from outside, because a Worker cannot fetch an address and the CA's validation already reached the node from outside. The rationale and the mechanism are in [media without a domain](../feature/2026-10-13-no-domain-deployment.md#media-without-a-domain).

#### The home's public address and carrier-grade NAT

- **The internet's view.** The node asks the Worker's `GET /.well-known/yolo?address=1` over IPv4 with its operator signature, and the signed answer carries the address the request came from (`CF-Connecting-IP`) and nothing else ([agent deployment](../feature/2026-10-13-agent-deployment.md)). It asks when the control plane configures it and every 5 minutes, and the cron run moves the record when the answer changes. No third-party address service is involved.
- **The router's view.** The port mapping protocols report the router's own public address.
- **Carrier-grade or double NAT.** When the router's own public address is in `100.64.0.0/10` or an RFC 1918 range, or differs from the internet's view, the node reports `nat: "cgnat"` with the reason, serves no remote stream, and the cron run removes the records.

#### The router port

[`service/node/src/portmap/`](../../../../service/node/src/portmap/) maps one TCP port of the router's public address to the node, as Plex's server does. In `auto` mode (`WAN_MAPPING`, the default) the node asks its default gateway (from the routing table, or `WAN_GATEWAY`) by PCP (RFC 6887), then NAT-PMP (RFC 6886; a NAT-PMP router answers PCP with "unsupported version"), then UPnP IGD (`WANIPConnection` or `WANPPPConnection`, with a permanent mapping where the router allows only that), the first that answers. It asks for `WAN_EXTERNAL_PORT` (default `WAN_PORT`) and uses the port the router grants, renews the mapping before half its lifetime of 2 hours and at least every 15 minutes, reading the public address each time, maps again when its own address changes, and deletes the mapping when the listener closes or the node stops. Only the default gateway is asked, and only a UPnP description that the gateway's own address serves is used. A router that answers none of the three leaves an error that names the port to forward. In `manual` mode the owner forwards `WAN_EXTERNAL_PORT` on the router to the node's `WAN_PORT` and the node sends the router nothing. The node maps only while its remote listener serves, so a router sees a request only once the owner has turned remote access on and the certificate is installed.

#### The node's remote listener

[`service/node/src/wan.js`](../../../../service/node/src/wan.js) is the third listener, built with the LAN listener from one module ([`edge.js`](../../../../service/node/src/edge.js)), on `WAN_PORT` (9444; 0 turns it off). It binds the private IPv4 address the router forwards to (`WAN_ADDRESS`, else the LAN address), and the machine's global IPv6 address when `WAN_IPV6` is `on` or names the address, which the owner sets once the router's IPv6 firewall lets the port through. Its origin carries the router's external port, none when it is 443. Its key and certificate live in `<runtime>/.lan/wan/`.

### The threat model of the remote listener

The remote listener is the first part of Yolo that faces the internet with nothing in front of it.

- **What it protects.** The home machine, which holds `NODE_SECRET`, the plugins' credentials (the Plex token among them), and the owner's files; the media sessions, each authorized by a token that is valid for up to 12 hours; the home uplink; and the private key of the remote name.
- **Who reaches it.** Internet scanners, which find the port within minutes of the certificate reaching Certificate Transparency logs or by sweeping IPv4; anyone who learns a media URL; whoever runs the network a device is on (the car's carrier, a hotel's Wi-Fi); and a hostile page in the owner's browser.
- **What it exposes.** One TCP port: Node's TLS and HTTP parsing, the listener's routing, and the media pipeline's token check.

What the listener does against that:

- **Media only.** It serves `GET` and `HEAD` under `/m/{token}/…`, `OPTIONS` preflights, and `GET /edge/probe`, and answers anything else 404 or 405. The internal API is a separate server on `127.0.0.1:9191`, and owner pairing codes stay on the Unix socket ([passkey sign-in](2026-10-08-passkey-owner-sign-in.md)).
- **Its own name, in HTTP and in TLS.** A TLS client that names another server gets no certificate; a request whose `Host` or TLS server name is not the listener's name, a client that sends no server name included, gets 421. A scanner that connects by address and a DNS rebinding page reach no handler. Without a domain the listener is known by its address, which a scanner sends too, so it gives scanners empty answers and no control origin instead ([media without a domain](../feature/2026-10-13-no-domain-deployment.md#media-without-a-domain)).
- **The token before any work.** The pipeline checks the media token's format, expiry, and HMAC-SHA256 signature, with a constant-time comparison, before it looks up a session, calls a source, or fetches upstream. A forged token gets 403, an expired token or an ended session 410, with no detail.
- **Limits per peer.** A peer whose requests fail 20 times in a minute (a forged token, an unknown path, another name, another method) is refused for 10 minutes: its open connection gets 429 and new ones are closed before TLS. At most 32 open connections per peer and 256 in all, and at most 20 new connections a second in all. Headers must arrive within 10 seconds and a request within 30, headers are limited to 8 KB, the TLS handshake to 10 seconds, and an idle keep-alive connection closes after 5 seconds.
- **TLS 1.2 or newer**, with a certificate for exactly the name; the key never leaves the node.
- **The LAN listener's response policy.** `Access-Control-Allow-Origin` set to `PUBLIC_ORIGIN`, `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and never an HTML or XML content type.
- **Logs without tokens.** One line per media answer (`kind: "media"`, `path`, status, size, time) and a `kind: "edge"` line when a peer is refused; no URL is logged.
- **Off at any time.** Remote access off in settings removes the records, closes the listener, and deletes the router mapping; `WAN_PORT=0` turns it off on the node.

What remains:

- A flaw in Node's TLS or HTTP code, or in the media handler, is reachable from anywhere while remote access is on; the narrow surface, the limits, a current Node.js, and the switch bound it.
- A leaked media URL plays its session from anywhere until the session ends, as it does through the relay.
- The limits live in the node's memory: a restart forgets them, and many addresses together are not bounded per peer.
- The media token key is `NODE_SECRET` itself. Media tokens sign `sessionId|userId|exp` and internal requests sign `timestamp\nMETHOD\npath\nbodyHash`, which cannot collide, and the listener only verifies, so it is no signing oracle; a key derived for media tokens alone is deferred.
- DNS publishes the home's public address, which reveals the owner's ISP and rough location; Certificate Transparency publishes the name.

### The relay, the fallback

- **Three modes**, per user: `auto`, the default, lets the relay carry a screen's media only when no direct path works for that screen, both when a stream starts and when a direct stream fails in the middle, where the recovery continues by the relay at the same position; `on` allows the relay as the last path, the switch of 0.5 and 0.6; `off` never relays. On a screen `auto` and `on` choose alike, because the order puts the relay last either way; `on` keeps what instances that turned the switch on chose, and `auto` names the default.
- The Worker's `/m/*` passthrough ([`service/control/src/media.js`](../../../../service/control/src/media.js)) serves a token's user unless their mode is `off`, read from D1 per isolate for up to 30 seconds by the user the token names; with `off` it answers `403` with `X-Yolo-Error-Code: RELAY_OFF` without reaching the node. Which stream takes the relay is the screen's and the Hub's choice; the passthrough serves any valid token. It passes the node's responses through unchanged.
- The mode lives in the D1 table `media_settings` ([D1 data model](2026-10-07-d1-data-model.md)): `relay_mode` (`auto`, `on`, or `off`, migration `0008_relay_mode`) beside `relay`, which stays 1 unless the mode is `off`, so the previous release, which reads only `relay`, relays as the fallback too. A user without a row is `auto`, so a new instance relays from its first deploy. Migration 0008 makes `relay = 1` rows `on`; makes a `relay = 0` row `off` only after an explicit choice by the owner, which is a set `relay_accepted_at` (the relay was turned on through 0.5's warning, then off) or a user created before 0006 was written (2026-10-13 23:03:23 UTC), whom 0006 gave the relay on, so only the owner turned it off; and makes every other row `auto`, because 0.5 and 0.6 wrote `relay = 0` by default whenever the owner turned remote access on. `relay_accepted_at` alone misses the second case, since 0006 wrote no acceptance time, and `updated_at` cannot tell it apart, because turning remote access on writes such a row too. A row that the previous release writes after a rollback changes only `relay`: 0 reads as `off`, and 1 over a mode of `off` as `on`.
- The owner picks the mode in Settings › Media paths, behind the passkey session (`PATCH /v1/owner/media` with `relay: "auto" | "on" | "off"`; a boolean from a page before the modes means `on` or `off`), with no confirmation step. The card says once, in one line, that media goes through the owner's Cloudflare account when no direct path works, and shows how many streams took the relay in the last 7 days and the path each screen used last. Each change writes a `kind: "security"` log line (`event: "relay_mode"`, `from`, `to`) and sends every connected screen the media paths again, so it chooses at once ([v1 HTTP API](2026-10-07-v1-http-api.md)).
- `yolo doctor` reports `auto` and `on` as information, with the relay streams of the last 7 days, and fails only when the relay is `off` and no direct path works, with both fixes; `get_status` reports the mode.
- The relay keeps its low ceiling, `STREAM_MAX_VIDEO_BITRATE_KBPS` (4.8 Mbps), since it is the fallback and every byte crosses Cloudflare twice.

### Telemetry of the chosen path

- **Device events** ([device telemetry](../feature/2026-10-11-device-telemetry.md)): `media_probe` (`path`, `outcome`, `trigger`, `elapsedMs`, the LAN `permission`, `host`, and at the home's address `home` and `hairpin`) for each probe, `media_path` (`path`, `from`, `reason`, `probes`) for each change of path, `media_path_fallback` (`from`, `to`, the error's `code` and `message`, `position`) for each move down, and `stream_selected` with `network` (the path) and `mediaHost`.
- **The Hub** logs `event: "stream"` with the path asked for and the path the node served, and `event: "network"` with each report's path, probes, and `hairpin`. It keeps each screen's last stream and, per UTC day for 7 days, how many streams each path carried, where a rebuild counts only when it moved to another path; settings and `doctor` read them.
- **The node** logs one line per media answer on the remote listener, without the URL, and the router mapping's creation, removal, and failures; without a domain also each certificate for the home's address and each failed order (`kind: "edge"`, `event: "certificate"` or `"certificate_error"`).
- **The control plane** logs `kind: "edge"`, `path: "wan"`, with `event: "certificate"`, `"address_changed"`, `"cgnat"`, `"unreachable"`, `"off"`, or `"error"`, beside the LAN's `kind: "lan"` lines, and `kind: "security"` for each change of the relay's mode.
- **Settings** show each screen's path and what its probes found, and the owner's cards for the home network, remote direct play (its state in words, name, address, router port, and certificate), the relay's mode with the streams it carried this week, and the path each screen used last.

### What each owner sets up

| Step | Path | When it is needed |
|---|---|---|
| `MEDIA_DNS_TOKEN` as a Worker secret (Zone Read and DNS Edit on the zone), or a DNS provider plugin's name and secret | `lan`, `wan` | Once, for any direct path |
| Turn on remote access in settings | `wan` | Once |
| Nothing on the router: the node asks it by PCP, NAT-PMP, or UPnP IGD | `wan` | Where the router allows one of them, as most home routers do |
| A DHCP reservation for the node's machine, a forward of TCP `WAN_EXTERNAL_PORT` to the node's `WAN_PORT`, and `WAN_MAPPING=manual` | `wan` | Only on a router without those protocols |
| An IPv6 firewall rule for `WAN_PORT` and `WAN_IPV6=on` | `wan` | Only for IPv6 |
| Allow the node in the macOS firewall | `wan` | Only where the firewall is on |
| Nothing: the relay is `auto` | `relay` | Every instance, from its first deploy |
| Set the relay to `off` | `relay` | Only if the owner wants no media through Cloudflare |

The [`yolo-deploy`](../../../../skills/yolo-deploy/SKILL.md) skill lists these steps, with router-specific ones, and `yolo doctor` reports each path's state and the relay with the fix. At the end of a deploy, `npm run yolo -- deploy` reports which media path works, remote direct play as the Worker's check from outside found it or the relay through the tunnel, and gives the router step when remote direct play is not reachable, without failing the deploy. Without a domain no `MEDIA_DNS_TOKEN` is needed, and the router steps are those of [media without a domain](../feature/2026-10-13-no-domain-deployment.md#media-without-a-domain).

## Deferred

- **IPv6 inbound.** The node neither opens an IPv6 pinhole (PCP or UPnP's `WANIPv6FirewallControl`) nor checks IPv6 from outside: a Worker's `fetch()` cannot choose the address family. `WAN_IPV6` is the owner's statement that the router lets the port through.
- **A key derived for media tokens alone** (HKDF from `NODE_SECRET` with a purpose label and a version prefix), which needs both halves to change and accept old tokens for one release.
- **R2 staging**, an all-Cloudflare path that plays from storage for owners who cannot forward a port, after 1.0.
- **The car on LTE** is checked in the car ([in-car checks](../testing/2026-07-21-test-layers.md#in-car-checks)): its `media_probe` events show whether its carrier reaches the port and whether it has IPv6.

## Alternatives considered

**The relay off by default, as in 0.5 and 0.6.** A new instance then plays nothing until the owner sets up a direct path or finds the switch, and an owner whose router maps no port meets a refusal on the first play. With the relay as the fallback, every instance plays from its first deploy, and direct paths still carry every stream they can.

**The relay as the first path.** It needs no setup and works everywhere, but every stream would cross Cloudflare twice under a 4.8 Mbps ceiling even where the node reaches the screen directly at home or through the router.

**Only two modes, automatic and off.** On a screen `on` chooses as `auto` does; it is kept so that an instance which turned the switch on keeps a mode that says so, and the migration does not have to decide for it.

**Remove the relay.** An owner behind carrier-grade NAT, or whose router maps no port, would then have no path away from home at all until R2 staging exists.

**Tailscale.** A listener on the node's tailnet address, with a name in the owner's zone and a certificate, would serve phones and computers on the owner's tailnet. It was rejected: every device would need Tailscale installed and signed in, a cost most owners would not pay, and the Tesla browser, Yolo's core screen, cannot run it at all. Remote direct play reaches every device, the car included, with no install. Tailscale Funnel, which publishes a node without a port forward, is also out: its traffic "is subject to non-configurable bandwidth limits" ([Funnel](https://tailscale.com/kb/1223/funnel)), which sustained video does not fit.

**Only a manual port forward.** It sends the router nothing, but most owners would have to find their router's forwarding page; the router protocols Plex uses do it for them, renew it, and remove it, and the manual mode remains for routers without them.

**One certificate for both names.** One ACME order would cover both, but turning remote access on or off would reissue the LAN certificate, a failed order would hold back both renewals, and the public listener would show the LAN name to every client.

**A third-party service for the public address.** It would add a dependency and tell a third party when the node checks; the Worker already sees the address, behind the operator signature.

**R2 staging.** The node would upload pre-segmented HLS or fMP4 to the owner's R2 bucket and devices would play from R2, content hosted by Cloudflare. It needs an upload pipeline, a step that prepares a title before playback, and eviction; it spends the home uplink before playback starts, and a write-through cache would still proxy the first view. Storage costs $0.015 per GB-month, egress is free, and content stored on Cloudflare falls under the Developer Platform's content rules ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). It is deferred until after 1.0.

**Cloudflare Stream.** Stream re-encodes every upload, so Yolo loses control of renditions, and it costs $5 per 1,000 minutes stored per month plus $1 per 1,000 minutes delivered: a library of 500 films, about 60,000 minutes, would cost about $300 a month in storage alone ([Stream pricing](https://developers.cloudflare.com/stream/pricing/)).

**Cloudflare One Client or Mesh private routes.** They need a Zero Trust organization and enrolled devices, and the car cannot enroll.

**A small VPS as a relay, joined to the node by WireGuard.** Reachable by the car, but it adds a machine for every owner to rent and maintain.

**A tunnel public hostname for media.** It is the relay's path under a second hostname, and the [passthrough note](2026-10-07-same-origin-media-passthrough.md) already rejected a `media.` subdomain through the tunnel.

**Binding media tokens to the device's address.** The car's address changes on LTE and between networks, so a stream would break on every change.

## Consequences

Away from home, a device plays straight from the node through the router, with no media through Cloudflare, once remote direct play is `ok`; until then, and wherever no direct path answers, the relay carries it. Every instance plays from its first deploy, and a direct path that starts working carries the next stream. The router step is usually nothing, because the node asks the router itself.

The costs:

- The node faces the internet; the threat model above bounds what that exposes, and the owner's switch turns it off.
- Owners behind carrier-grade NAT, with a rented router that maps nothing and cannot forward, or with an ISP that blocks inbound ports have no remote path; away from home their screens play through the relay, at its 4.8 Mbps ceiling. The `edge` lines and the relay counts of the first instances show how common this is, and how soon R2 staging is needed.
- Relay streams cost the owner's Workers requests and cross Cloudflare twice; on Workers Free a household that plays mostly through the relay may reach a daily limit, which `doctor` reports.
- A changed public address breaks `wan` until the node's next check (5 minutes), the next cron run (5 minutes), and the record's 60-second TTL, or without a domain until the node's next check, one order, and the next cron run, after which the Hubs tell the connected screens; streams fall to the relay meanwhile unless it is off.
- A device at home whose LAN path fails and that reaches the `wan` name gets the home's public address, which works only where the router supports NAT loopback; the path order makes that rare. Without a domain it is the only direct path at home, and the screen's probe reports whether the router loops back ([media without a domain](../feature/2026-10-13-no-domain-deployment.md#media-without-a-domain)).
- Three media paths multiply what a playback bug can depend on; telemetry records the path of every stream.
- Workers VPC remains a beta dependency for control traffic and the relay, so its pricing after the beta matters.

## Testing

The node's tests run each router protocol against a fake router on loopback ([`portmap.test.js`](../../../../service/node/test/portmap.test.js)) and pin the remote listener's scope over real TLS ([`wan.test.js`](../../../../service/node/test/wan.test.js)): 421 for another `Host` or no TLS server name, no certificate for another server name, 403 for a forged token before any session work, no route outside `/m/*`, `OPTIONS`, and the probe, a peer cut off after 20 failures, the connection limits, no document type, the mapping made only once the listener serves and deleted when remote access goes off, and no remote stream behind carrier-grade NAT. The control plane's tests run the remote name's maintenance against stand-ins for Cloudflare's API, the ACME server, and the node ([`edge.test.js`](../../../../service/control/test/unit/edge.test.js)), the Hub's path choice in each relay mode, `auto`'s relay at the start and in a recovery, `media_unreachable` with its fixes, the `home` mark and the `media` message, the relay's modes in settings, and migration 0008's mapping ([`media-settings.test.js`](../../../../service/control/test/unit/media-settings.test.js)). The player's tests pin the path order, the fallback, the relay's modes, the probe outcomes, and the loopback report at the home's address ([`media-paths.test.js`](../../../../clients/player/test/unit/media-paths.test.js)), and [`test/e2e/media-paths.test.js`](../../../../test/e2e/media-paths.test.js) plays in Chromium from the LAN listener, then the remote listener, then the relay, each at the same position. [`wan-ip.test.js`](../../../../service/node/test/wan-ip.test.js) runs the listener without a domain against a stand-in ACME server ([media without a domain](../feature/2026-10-13-no-domain-deployment.md#media-without-a-domain)). Nothing sends a mapping request to a real router.
