# Agent Note: Media leaves the Worker

Status: implemented

English | [中文](2026-10-13-media-off-the-worker.zh.md)

## Problem

Away from home, every media byte Yolo played travelled from the node through the cloudflared tunnel and Workers VPC to the Worker, which served it under `/m/*` on the owner's public custom domain ([same-origin passthrough](2026-10-07-same-origin-media-passthrough.md), [Workers VPC](2026-10-08-workers-vpc-node-access.md)). Only a device at home avoided it, through [LAN direct play](../feature/2026-10-12-lan-direct-play.md).

Cloudflare's terms restrict exactly that. The Service-Specific Terms for Application Services, section "Content Delivery Network (Free, Pro, or Business)", last updated 2026-09-28, say ([terms](https://www.cloudflare.com/service-specific-terms-application-services/)):

> "Unless you are an Enterprise customer, Cloudflare offers specific Paid Services (e.g., the Developer Platform, Images, and Stream) that you must use in order to serve video and other large files via the CDN. Cloudflare reserves the right to disable or limit your access to or use of the CDN, or to limit your End Users' access to certain of your resources through the CDN, if you use or are suspected of using the CDN without such Paid Services to serve video or a disproportionate percentage of pictures, audio files, or other large files."

- **Where the video is hosted decides it.** Cloudflare's explanation of the clause says customers may serve video "so long as that content is hosted by a Cloudflare service like Stream, Images, or R2", and that "video and large files hosted outside of Cloudflare will still be restricted on our CDN" ([blog, 2023-05-16](https://blog.cloudflare.com/updated-tos/)). Yolo's video is hosted on the owner's node.
- **A public hostname is restricted; a private route is not.** Since 2026-08-25 Cloudflare's documentation says that Tunnel public hostname routes "proxy traffic through Cloudflare" and fall under the restriction on Free, Pro, and Business plans, and that "the restriction does not apply to private network routes" ([delivering videos](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/), [Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/), [docs PR 32886](https://github.com/cloudflare/cloudflare-docs/pull/32886)). Workers VPC keeps the node-to-Worker leg private, but the Worker's custom domain is a public hostname.
- **Workers Paid is arguable; Workers Free is not.** The clause names the Developer Platform as a Paid Service, and Cloudflare once called a paying Workers customer's uncached passthrough of large files from outside storage permitted ([tardis.dev, 2023-02](https://blog.cloudflare.com/how-cloudflare-erroneously-throttled-a-customers-web-traffic/)); those files were not video, and no official statement applies the reading to video. Workers Free is not a "Paid Service" under the Self-Serve Subscription Agreement §4.1, so the reading cannot cover it.
- **The account is at stake, not only the video.** The agreement forbids using the services in a way that "violates or is intended to circumvent" their restrictions (§2.2.1(c)), and a breach of §2.2 lets Cloudflare "immediately Suspend or terminate all or part of your use of the Services" (§8) ([agreement](https://www.cloudflare.com/terms/)).
- **Distribution multiplies the risk.** Every owner runs the same Worker and `/m/{token}/` pattern on their own account, likely on Workers Free, and Jellyfin's community standards already treat recommending video behind a normal Cloudflare tunnel as a violation ([Jellyfin](https://jellyfin.org/docs/general/community-standards/)).

No Cloudflare statement addresses an uncached Worker passthrough of self-hosted video. The reading Yolo plans around is that the relay is not compliant on Free, Pro, and Business zones.

## Decision

The Worker carries control only: sign-in, the catalog, tokens, the Hub, and MCP. Media goes from the node to the device by the first path that works for that device; the Worker relays media only for an owner who turned the relay on.

| Path | `network` | Origin | Reaches |
|---|---|---|---|
| LAN direct | `lan` | `https://yolo-lan-<id>.<zone>:9443`, a DNS-only record of the node's private address | Devices on the home network |
| Remote direct | `wan` | `https://yolo-wan-<id>.<zone>:<port>`, a DNS-only record of the home's public address, through a router port | Any device on the internet, the car on LTE included |
| Relay | `relay` | `PUBLIC_ORIGIN`, through the tunnel and the Worker | Anywhere, only while the owner has the relay on |

Every path serves the same `/m/{token}/…` URLs, authorized by the media token in the path alone, so a stream works on any origin without a change to the token or the node's sessions.

### Path selection on a device

[`clients/player/src/media-paths.js`](../../../../clients/player/src/media-paths.js) chooses this screen's path; both engines play whatever origin the stream names ([two engines](2026-10-12-two-playback-engines.md)).

- **Discovery.** The Hub's `welcome` carries `media: { paths: [{ path, origin, notAfter }], relay }` ([`service/control/src/edge/paths.js`](../../../../service/control/src/edge/paths.js)): `lan` while the last LAN check found the listener serving with a valid certificate, `wan` while remote access is on and the last check from outside reached the listener, and whether the relay is on for this user. It also carries `lan`, the LAN origin alone, for players from before 0.5 ([Hub and realtime channel](2026-10-07-hub-and-realtime-channel.md)).
- **Order.** `lan`, then `wan`, then `relay`. "Play over the home network" in settings keeps governing `lan` per screen ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)); `wan` resolves to a public address, needs no browser permission, and has no switch; `relay` is a candidate only while it is on.
- **Probes.** Every listener answers `GET /edge/probe` with `{ ok, name, path }`; the LAN listener also keeps `/lan/probe` for players from before 0.5. A screen probes its candidates at once, on the welcome, on the browser's `online` event, when the LAN switch changes, and 30 seconds after a stream failed, with a timeout of 2 seconds for `lan` and 5 for `wan`, and takes the first path in order whose probe answered, waiting for a higher path only until its probe finishes. Plex Web tests its direct connections the same way, in parallel, with the relay last. A screen's first play request after a welcome waits for that round.
- **Reports.** The screen sends `{ v: 1, type: "network", path, reason, probes }` when its choice changes and once after each welcome, with each probe's outcome (`ok`, `timeout`, `failed`, `off`, `certificate`, the LAN's permission and rebinding outcomes, or `http_<status>`); `path` is null when nothing works. Its own play requests carry `network: <path>`. The Hub keeps the latest path and probes per device, as it kept `lan` or `tunnel`, and reads `tunnel` as `relay` and a report with only `lan` as `lan` or `relay`, for one release.
- **The stream.** The Hub passes the path to `prepare`. The node serves `lan` or `wan` only while that listener serves, and the relay otherwise, and returns the path it served with the listener's origin in the stream descriptor. `lan` keeps its ceiling of `LAN_MAX_VIDEO_KBPS`; `wan` and `relay` use `STREAM_MAX_VIDEO_BITRATE_KBPS`, because the home uplink carries them; the device's [adaptive cap](../feature/2026-10-11-adaptive-quality.md) lowers either. A source plugin sees `network` `lan` for LAN direct play and `tunnel` for every other path, so the Plex plugin's remote branch serves them unchanged ([media pipeline](2026-10-11-node-media-pipeline.md)).
- **No path.** When the device's path is none, or the relay while it is off, the Hub refuses before the node does any work with `media_unreachable`, whose message names each path, what the device's probes found, and the setup it needs; an agent's `play` returns the same message. When the node had to fall back to the relay because a listener stopped serving and the relay is off, the Hub stops that session and refuses the same way.

### Fallback

A stream fails on its path once the engine's bounded retries give up. When the screen has a path below the stream's own, the recovery first moves the screen there (`failed()`), sends `network`, records `media_path_fallback`, and rebuilds the stream at the same position by that path, as a failed LAN stream moved to the tunnel before. Thirty seconds later the screen probes again; a stream that plays never moves up, and the next stream takes the best path. A car that leaves home Wi-Fi in the middle of a LAN stream continues on `wan`, and on the relay only if the owner has it on.

### Remote direct play

#### Name, records, and certificate

With remote access on in settings, the Worker's cron run (every 5 minutes, and when the owner asks) runs [`service/control/src/edge/wan.js`](../../../../service/control/src/edge/wan.js) after the LAN maintenance, with the same zone token, now `MEDIA_DNS_TOKEN` (Zone Read and DNS Edit; `LAN_DNS_TOKEN`, its name before 0.5, is read for one release):

1. It names the node `yolo-wan-<8 hex digits>.<zone>` once, outside the passkey relying party, as for the LAN name ([`edge/names.js`](../../../../service/control/src/edge/names.js)).
2. Through `nodeFetch()` it sends `PUT /internal/v1/wan` with the name, `PUBLIC_ORIGIN`, and `enabled: true`. The node answers the home's public address, its router mapping, its IPv6 address when it listens there, whether it is behind carrier-grade or double NAT, the certificate's validity, and a certificate request ([node internal API](2026-10-07-node-internal-api.md)).
3. It keeps DNS-only records from the name: A to the public IPv4 address, and AAAA to the node's global IPv6 address while the node listens on it, with a TTL of 60 seconds, moved when an address changes. Cloudflare's own documentation names a grey-clouded (DNS-only) subdomain as a remedy for restricted video.
4. It obtains a certificate for exactly that name by ACME DNS-01 with the LAN code, renewed two thirds into its lifetime, with the same backoff, and sends the chain to `PUT /internal/v1/wan/certificate`.
5. It checks from outside: the Worker fetches `https://<name>:<port>/edge/probe` with a 5-second timeout. With the `allow_custom_ports` compatibility flag, on by default since compatibility date 2024-09-02 (Yolo's is 2026-10-01), a Worker's `fetch()` uses the port in the URL for a host that is not proxied ([compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)), and `global_fetch_strictly_public` sends it over the public internet, so an answer proves that the router forwards the port from outside the home.

The remote name has its own key and certificate rather than sharing the LAN one: turning remote access on or off never reissues the LAN certificate, a failed or delayed issuance for one name never holds back the other's renewal, and a client that completes a handshake with the public listener sees only the remote name. It costs a second ACME order per renewal period, far inside Let's Encrypt's limits.

The states, in KV under `yolo:wan`: `off`, `pending` (named, not serving yet), `ok`, `cgnat`, `unreachable` (the outside check got no answer: the router does not forward the port, or the ISP or a firewall blocks it), `certificate`, and `error` with the failing step (`zone`, `node`, `address`, `dns`, `certificate`, `install`, `listener`, `router`). The welcome lists `wan` only while it is `ok`. Behind carrier-grade NAT the records are removed. When the owner turns remote access off, the run deletes the records and sends `enabled: false`, and the node closes the listener and deletes its router mapping.

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
- **Its own name, in HTTP and in TLS.** A TLS client that names another server gets no certificate; a request whose `Host` or TLS server name is not the listener's name, a client that sends no server name included, gets 421. A scanner that connects by address and a DNS rebinding page reach no handler.
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

### The relay, opt-in

- The Worker's `/m/*` passthrough stays ([`service/control/src/media.js`](../../../../service/control/src/media.js)), but serves only for a user whose relay is on, read from D1 per isolate for up to 30 seconds by the user the token names; otherwise it answers `403` with `X-Yolo-Error-Code: RELAY_OFF` without reaching the node. The welcome lists the relay only while it is on, and it is always the last path.
- The switch lives in the D1 table `media_settings` (`relay`, `relay_accepted_at`, `remote`), one row per user ([D1 data model](2026-10-07-d1-data-model.md)). A user without a row has both off, so a new instance starts with the relay off. Migration `0006_media_settings` gives the users of an instance from before it the relay on, because its cars played away from home only through the relay; the owner turns it off once remote direct play is `ok`.
- The owner turns it on in settings, behind the passkey session (`PATCH /v1/owner/media` with `relay: true` and `acceptRelayWarning: true`), after confirming this warning: "Relaying video through your Cloudflare Worker is likely outside Cloudflare's terms on Free, Pro, and Business zones, and Workers Free is clearly not covered. Cloudflare may restrict video on your domain or act on your account. Turn this on only if you accept that risk." The time of the confirmation is stored, each change writes a `kind: "security"` log line, and `yolo doctor` and `get_status` report the switch ([v1 HTTP API](2026-10-07-v1-http-api.md)).
- The relay never changes content types or reshapes responses to look like other traffic: hiding that it serves video would read as circumventing the restriction, which puts the whole account at risk.
- Owners use a zone for Yolo alone, so a zone-level restriction on video cannot reach their other sites, and each owner creates and owns their Cloudflare account, which the agreement requires (§2.2.1(a)).
- The owner may ask Cloudflare support for a written answer about the relay: "Workers Paid, a Custom Domain, uncached passthrough of self-hosted HLS through Workers VPC, one household". An answer updates the warning and this note.

### Telemetry of the chosen path

- **Device events** ([device telemetry](../feature/2026-10-11-device-telemetry.md)): `media_probe` (`path`, `outcome`, `trigger`, `elapsedMs`, the LAN `permission`, `host`) for each probe, `media_path` (`path`, `from`, `reason`, `probes`) for each change of path, `media_path_fallback` (`from`, `to`, the error's `code` and `message`, `position`) for each move down, and `stream_selected` with `network` (the path) and `mediaHost`.
- **The Hub** logs `event: "stream"` with the path asked for and the path the node served, and `event: "network"` with each report's path and probes.
- **The node** logs one line per media answer on the remote listener, without the URL, and the router mapping's creation, removal, and failures.
- **The control plane** logs `kind: "edge"`, `path: "wan"`, with `event: "certificate"`, `"address_changed"`, `"cgnat"`, `"unreachable"`, `"off"`, or `"error"`, beside the LAN's `kind: "lan"` lines, and `kind: "security"` for each change of the relay.
- **Settings** show each screen's path and what its probes found, and the owner's cards for the home network, remote direct play (its state in words, name, address, router port, and certificate), and the relay with its warning.

### What each owner sets up

| Step | Path | When it is needed |
|---|---|---|
| `MEDIA_DNS_TOKEN` as a Worker secret (Zone Read and DNS Edit on the zone) | `lan`, `wan` | Once, for any direct path |
| Turn on remote access in settings | `wan` | Once |
| Nothing on the router: the node asks it by PCP, NAT-PMP, or UPnP IGD | `wan` | Where the router allows one of them, as most home routers do |
| A DHCP reservation for the node's machine, a forward of TCP `WAN_EXTERNAL_PORT` to the node's `WAN_PORT`, and `WAN_MAPPING=manual` | `wan` | Only on a router without those protocols |
| An IPv6 firewall rule for `WAN_PORT` and `WAN_IPV6=on` | `wan` | Only for IPv6 |
| Allow the node in the macOS firewall | `wan` | Only where the firewall is on |
| Turn the relay off once remote direct play is `ok` | `relay` | On an instance from before 0.5 |
| Turn the relay on and accept the warning | `relay` | Only if the owner wants it |

The [`yolo-deploy`](../../../../skills/yolo-deploy/SKILL.md) skill lists these steps, and `yolo doctor` reports each path's state and the relay with the fix.

## Deferred

- **IPv6 inbound.** The node neither opens an IPv6 pinhole (PCP or UPnP's `WANIPv6FirewallControl`) nor checks IPv6 from outside: a Worker's `fetch()` cannot choose the address family. `WAN_IPV6` is the owner's statement that the router lets the port through.
- **A key derived for media tokens alone** (HKDF from `NODE_SECRET` with a purpose label and a version prefix), which needs both halves to change and accept old tokens for one release.
- **The number of relay streams** over the last 7 days in settings; Workers Logs' `event: "stream"` lines answer it meanwhile.
- **R2 staging**, the compliant all-Cloudflare path for owners who cannot forward a port, after 1.0.
- **The car on LTE** is checked in the car ([in-car checks](../testing/2026-07-21-test-layers.md#in-car-checks)): its `media_probe` events show whether its carrier reaches the port and whether it has IPv6.

## Alternatives considered

**Keep the relay as the default.** It needs no setup and works everywhere, but it is most likely outside Cloudflare's terms on Free, Pro, and Business zones and clearly outside them on Workers Free, and each owner would carry that risk on their own account, possibly with other sites on it.

**Turn the relay off on upgrade too.** An owner whose car played away from home only through the relay would lose that until remote direct play works; keeping it on for existing users until the owner turns it off avoids the gap, and `yolo doctor` warns while it is on.

**Remove the relay.** An owner behind carrier-grade NAT whose car needs media away from home would then have no path at all until R2 staging exists. Kept opt-in, it leaves that choice to each owner, with the warning in front of it.

**Tailscale.** A listener on the node's tailnet address, with a name in the owner's zone and a certificate, would serve phones and computers on the owner's tailnet. It was rejected: every device would need Tailscale installed and signed in, a cost most owners would not pay, and the Tesla browser, Yolo's core screen, cannot run it at all. Remote direct play reaches every device, the car included, with no install. Tailscale Funnel, which publishes a node without a port forward, is also out: its traffic "is subject to non-configurable bandwidth limits" ([Funnel](https://tailscale.com/kb/1223/funnel)), which sustained video does not fit.

**Only a manual port forward.** It sends the router nothing, but most owners would have to find their router's forwarding page; the router protocols Plex uses do it for them, renew it, and remove it, and the manual mode remains for routers without them.

**One certificate for both names.** One ACME order would cover both, but turning remote access on or off would reissue the LAN certificate, a failed order would hold back both renewals, and the public listener would show the LAN name to every client.

**A third-party service for the public address.** It would add a dependency and tell a third party when the node checks; the Worker already sees the address, behind the operator signature.

**R2 staging.** The node would upload pre-segmented HLS or fMP4 to the owner's R2 bucket and devices would play from R2, which is content "hosted by" Cloudflare and so compliant. It needs an upload pipeline, a step that prepares a title before playback, and eviction; it spends the home uplink before playback starts, and a write-through cache would still proxy the first view. Storage costs $0.015 per GB-month, egress is free, and content stored on Cloudflare falls under the Developer Platform's content rules ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). It is deferred until after 1.0.

**Cloudflare Stream.** Compliant, but Stream re-encodes every upload, so Yolo loses control of renditions, and it costs $5 per 1,000 minutes stored per month plus $1 per 1,000 minutes delivered: a library of 500 films, about 60,000 minutes, would cost about $300 a month in storage alone ([Stream pricing](https://developers.cloudflare.com/stream/pricing/)).

**Cloudflare One Client or Mesh private routes.** Cloudflare exempts private routes, but they need a Zero Trust organization and enrolled devices, and the car cannot enroll.

**A small VPS as a relay, joined to the node by WireGuard.** Compliant for Cloudflare and reachable by the car, but it adds a machine for every owner to rent and maintain.

**A tunnel public hostname for media.** Cloudflare's documentation puts Tunnel public hostname routes under the same restriction, and the [passthrough note](2026-10-07-same-origin-media-passthrough.md) already rejected a `media.` subdomain through the tunnel.

**Binding media tokens to the device's address.** The car's address changes on LTE and between networks, so a stream would break on every change.

## Consequences

Away from home, a device plays straight from the node through the router, with no media through Cloudflare, and the car on LTE keeps working without the relay once remote direct play is `ok`. A new instance is inside Cloudflare's terms from its first deploy; an existing one stays as it was until the owner turns the relay off. The router step is usually nothing, because the node asks the router itself.

The costs:

- The node faces the internet; the threat model above bounds what that exposes, and the owner's switch turns it off.
- Owners behind carrier-grade NAT, with a rented router that maps nothing and cannot forward, or with an ISP that blocks inbound ports have no remote path; their screens use the relay only by their own choice. The `edge` lines of the first instances show how common this is, and how soon R2 staging is needed.
- A changed public address breaks `wan` until the node's next check (5 minutes), the next cron run (5 minutes), and the record's 60-second TTL; streams fall to the relay meanwhile only where it is on.
- A device at home whose LAN path fails and that reaches the `wan` name gets the home's public address, which works only where the router supports NAT loopback; the path order makes that rare.
- Three media paths multiply what a playback bug can depend on; telemetry records the path of every stream.
- Workers VPC remains a beta dependency for control traffic only, so its pricing after the beta matters far less.
- Cloudflare's terms can change, so the warning and this note are checked whenever Cloudflare updates them.

## Testing

The node's tests run each router protocol against a fake router on loopback ([`portmap.test.js`](../../../../service/node/test/portmap.test.js)) and pin the remote listener's scope over real TLS ([`wan.test.js`](../../../../service/node/test/wan.test.js)): 421 for another `Host` or no TLS server name, no certificate for another server name, 403 for a forged token before any session work, no route outside `/m/*`, `OPTIONS`, and the probe, a peer cut off after 20 failures, the connection limits, no document type, the mapping made only once the listener serves and deleted when remote access goes off, and no remote stream behind carrier-grade NAT. The control plane's tests run the remote name's maintenance against stand-ins for Cloudflare's API, the ACME server, and the node ([`edge.test.js`](../../../../service/control/test/unit/edge.test.js)), the Hub's path choice and `media_unreachable`, and the relay switch. The player's tests pin the path order, the fallback, and the probe outcomes ([`media-paths.test.js`](../../../../clients/player/test/unit/media-paths.test.js)), and [`test/e2e/media-paths.test.js`](../../../../test/e2e/media-paths.test.js) plays in Chromium from the LAN listener, then the remote listener, then the relay, each at the same position. Nothing sends a mapping request to a real router.
