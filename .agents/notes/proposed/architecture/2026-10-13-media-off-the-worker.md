# Agent Note: Media leaves the Worker

Status: proposed

English | [中文](2026-10-13-media-off-the-worker.zh.md)

## Problem

Away from home, every media byte Yolo plays travels from the node through the cloudflared tunnel and Workers VPC to the Worker, which serves it under `/m/*` on the owner's public custom domain ([same-origin passthrough](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.md), [Workers VPC](../../implemented/architecture/2026-10-08-workers-vpc-node-access.md)). Only a device at home avoids it, through [LAN direct play](../../implemented/feature/2026-10-12-lan-direct-play.md).

Cloudflare's terms restrict exactly that. The Service-Specific Terms for Application Services, section "Content Delivery Network (Free, Pro, or Business)", last updated 2026-09-28, say ([terms](https://www.cloudflare.com/service-specific-terms-application-services/)):

> "Unless you are an Enterprise customer, Cloudflare offers specific Paid Services (e.g., the Developer Platform, Images, and Stream) that you must use in order to serve video and other large files via the CDN. Cloudflare reserves the right to disable or limit your access to or use of the CDN, or to limit your End Users' access to certain of your resources through the CDN, if you use or are suspected of using the CDN without such Paid Services to serve video or a disproportionate percentage of pictures, audio files, or other large files."

- **Where the video is hosted decides it.** Cloudflare's explanation of the clause says customers may serve video "so long as that content is hosted by a Cloudflare service like Stream, Images, or R2", and that "video and large files hosted outside of Cloudflare will still be restricted on our CDN" ([blog, 2023-05-16](https://blog.cloudflare.com/updated-tos/)). Yolo's video is hosted on the owner's node.
- **A public hostname is restricted; a private route is not.** Since 2026-08-25 Cloudflare's documentation says that Tunnel public hostname routes "proxy traffic through Cloudflare" and fall under the restriction on Free, Pro, and Business plans, and that "the restriction does not apply to private network routes" ([delivering videos](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/), [Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/), [docs PR 32886](https://github.com/cloudflare/cloudflare-docs/pull/32886)). Workers VPC keeps the node-to-Worker leg private, but the Worker's custom domain is a public hostname.
- **Workers Paid is arguable; Workers Free is not.** The clause names the Developer Platform as a Paid Service, and Cloudflare once called a paying Workers customer's uncached passthrough of large files from outside storage permitted ([tardis.dev, 2023-02](https://blog.cloudflare.com/how-cloudflare-erroneously-throttled-a-customers-web-traffic/)); those files were not video, and no official statement applies the reading to video. Workers Free is not a "Paid Service" under the Self-Serve Subscription Agreement §4.1, so the reading cannot cover it.
- **The account is at stake, not only the video.** The agreement forbids using the services in a way that "violates or is intended to circumvent" their restrictions (§2.2.1(c)), and a breach of §2.2 lets Cloudflare "immediately Suspend or terminate all or part of your use of the Services" (§8) ([agreement](https://www.cloudflare.com/terms/)).
- **Distribution multiplies the risk.** Every owner runs the same Worker and `/m/{token}/` pattern on their own account, likely on Workers Free, and Jellyfin's community standards already treat recommending video behind a normal Cloudflare tunnel as a violation ([Jellyfin](https://jellyfin.org/docs/general/community-standards/)).

No Cloudflare statement addresses an uncached Worker passthrough of self-hosted video. The reading Yolo plans around is that the relay is not compliant on Free, Pro, and Business zones.

## Proposal

The Worker keeps control only: sign-in, the catalog, tokens, the Hub, and MCP. Media goes from the node to the device by the first path that works for that device; the Worker relay serves media only when the owner has turned it on.

| Path | `network` | Origin | Reaches | Devices |
|---|---|---|---|---|
| LAN direct | `lan` | `https://yolo-lan-<id>.<zone>:9443`, a DNS-only record of the node's private address | Devices on the home network | Every device |
| Remote direct | `wan` | `https://yolo-wan-<id>.<zone>:<port>`, a DNS-only record of the home's public address, forwarded by the router | Any device on the internet, the car on LTE included | Every device |
| Tailscale | `tailnet` | `https://yolo-ts-<id>.<zone>:9445`, a DNS-only record of the node's tailnet address | Devices signed in to the owner's tailnet | Phones and computers; never the car, whose browser cannot run Tailscale |
| Relay | `relay` | `PUBLIC_ORIGIN`, through the tunnel and the Worker | Anywhere | Only while the owner has turned the relay on |

Every path serves the same `/m/{token}/…` URLs, authorized by the media token in the path alone, so a stream works on any origin without a change to the token or the node's sessions.

### Path selection per device

- **Order.** A screen in the car profile tries `lan`, `wan`, then `relay`; a screen in the web profile tries `lan`, `wan`, `tailnet`, then `relay`. A path the screen cannot use is skipped: `relay` while it is off, and `tailnet` in the car.
- **Discovery.** The Hub's `welcome` carries `media: { paths: [{ path, origin, notAfter }], relay }`, listing only the paths whose listener served with a valid certificate at the last check ([Hub and realtime channel](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md)). For one release it also carries today's `lan` field, for player tabs that have not reloaded.
- **Switches per screen.** "Play over the home network" keeps governing `lan`, and a new "Use Tailscale" switch governs `tailnet`. Both addresses are local under Local Network Access, which classifies `100.64.0.0/10` as local like the RFC 1918 ranges ([LNA](https://wicg.github.io/local-network-access/)), so Chrome and Firefox ask the owner first. `wan` resolves to a public address, needs no permission, and is probed without a switch.
- **Probes.** Every listener answers `GET /edge/probe` with `{ ok, name, path }`; the LAN listener keeps `/lan/probe` for one release. A screen probes all its candidate paths at once, on the welcome, on the browser's `online` event, when a switch changes, and 30 seconds after a path failed, with a 2-second timeout for `lan` and `tailnet` and 5 seconds for `wan`. It takes the first path in order whose probe succeeded, waiting for a higher path only until that probe's timeout. Plex Web tests its direct connections the same way, in parallel, with the relay last.
- **Reports.** The screen sends `{ v: 1, type: "network", path, reason, probes }` when its choice changes and once after each welcome, and its play requests carry `network: <path>`. The Hub keeps the latest value per device, as it keeps `lan` or `tunnel` today, and reads `tunnel` as `relay` for one release.
- **The stream.** The Hub passes `network` to `prepare`, and the node returns the chosen listener's origin in the stream descriptor. `lan` keeps its ceiling of `LAN_MAX_VIDEO_KBPS`; `wan`, `tailnet`, and `relay` use `STREAM_MAX_VIDEO_BITRATE_KBPS`, because the home uplink carries them; the device's [adaptive cap](../../implemented/feature/2026-10-11-adaptive-quality.md) lowers either. A source plugin keeps seeing `lan` for LAN direct play and `tunnel` for every other path, so the Plex plugin's remote branch serves them unchanged.
- **No path.** When a device's last report found no path and the relay is off, the Hub refuses to prepare a stream with `media_unreachable`. Its message names the paths that were tried and the setup each one needs, and an agent's `play` call returns the same message.

### Fallback

A stream fails on its path once the engine's bounded retries give up (the canvas engine's endless segment retry is a 1.0 blocker fixed before this work). The recovery then moves the screen to the next path in order, sends `network`, records `media_path_fallback`, and rebuilds the stream at the same position, as a failed LAN stream moves to the tunnel today. Thirty seconds later the screen probes the higher paths again; a stream that is playing never moves up, and the next stream takes the best path. A car that leaves home Wi-Fi in the middle of a LAN stream continues on `wan`.

### Remote direct

#### Name, record, and certificate

The machinery of LAN direct play names the node a second time. The Worker's cron run, with the same `LAN_DNS_TOKEN` (Zone Read and DNS Edit), names the node `yolo-wan-<8 hex digits>.<zone>` once, keeps a DNS-only A record from it to the home's public IPv4 address with a TTL of 60 seconds, and obtains a certificate for exactly that name by ACME DNS-01 ([`acme.js`](../../../../service/control/src/edge/acme.js)). The node keeps the private key, sends a certificate request, and swaps in each new chain without a restart; renewal starts at two thirds of the lifetime. Cloudflare's own documentation names a grey-clouded (DNS-only) subdomain as a remedy for restricted video.

**The public address.** The node asks the Worker's `GET /.well-known/yolo` with its operator signature over IPv4, and the signed answer includes the address the request came from (`CF-Connecting-IP`). The cron run reads that address from the node through `nodeFetch()` and moves the record when it changes. No third-party address service is involved. When the owner turns IPv6 on, the node asks again over IPv6 and the cron run keeps an AAAA record of the node's global address, which reaches devices with IPv6 even behind an IPv4 carrier-grade NAT.

#### The node's remote listener

A third listener, built from the LAN listener's code ([`lan.js`](../../../../service/node/src/lan.js)), runs once the control plane has named it, on `WAN_PORT` (9444; 0 turns it off). It binds the private IPv4 address the router forwards to, and the node's global IPv6 address when IPv6 is on. The owner forwards an external port of the router to it; the control plane's origin for the path carries that external port, 443 unless the owner gives another.

Exposing it to the internet is the cost of this path, so the listener narrows what the internet can reach:

- **Media only.** It serves `GET` and `HEAD` under `/m/{token}/…`, `OPTIONS` preflights, and `GET /edge/probe`, and nothing else. The internal API stays on `127.0.0.1`, and owner pairing codes stay on the Unix socket.
- **Its own name only.** A request whose `Host` is not the listener's name gets `421`, so a scanner that connects by address reaches no handler.
- **The token before any work.** The listener checks the media token's format, signature, expiry, and live session before it touches a session, calls a source, or fetches upstream. A forged token gets `403` and an ended session `410`, with no detail in the body. Media tokens are signed with a key derived from `NODE_SECRET` for that purpose alone (HKDF with a purpose label) and carry a version prefix, so the internet-facing check never verifies a signature that also authorizes internal API calls or the owner socket.
- **Rate limits per peer address.** Starting values: a peer that fails token verification 20 times in a minute is refused for 10 minutes; at most 32 open connections per peer and 256 in all; at most 20 new TLS connections per second in all. Node's `headersTimeout`, `requestTimeout`, and header size limits are set, and idle keep-alive connections close after 5 seconds.
- **The LAN listener's response policy.** `Access-Control-Allow-Origin` set to `PUBLIC_ORIGIN`, `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and never an HTML or XML content type.
- **TLS 1.2 or newer**, with the certificate for the listener's name.
- **Logs without tokens.** One structured line per completed media response, and a `kind: "edge"` line for each refused peer.
- **Off at any time.** When the owner turns remote access off in settings, the cron run deletes the record and tells the node to close the listener.

#### CGNAT detection and fallback

- **The router's view.** The node asks its default gateway for the external address with PCP or NAT-PMP, then UPnP IGD, where the router answers; it never creates a port mapping. When that address is in `100.64.0.0/10` or an RFC 1918 range, or differs from the public address the Worker saw, the home is behind carrier-grade or double NAT, and the path's state is `cgnat`.
- **The outside view.** The cron run fetches `https://<name>:<port>/edge/probe` from the Worker, outside the home network. No answer means `unreachable`: the forward is missing, the ISP blocks the port, or a firewall drops it. Whether a Worker subrequest reaches an arbitrary port on a DNS-only host is checked first; if it does not, the probe of the owner's devices is the only outside check.
- **States.** `off`, `pending` (named, not yet reached from outside), `ok`, `cgnat`, `unreachable`, `certificate` (no valid certificate), and `error`. The welcome lists `wan` only while it is `ok`, and settings say in words what each state needs from the owner.
- **Fallback.** Without `wan`, phones and computers use `tailnet`; the car uses the relay while the owner has it on, and otherwise gets `media_unreachable` away from home. IPv6 can still give the car a path when its network has IPv6, which telemetry shows.

A device at home that fails `lan` and reaches the `wan` name gets the home's public address, which works only where the router supports NAT loopback; the path order makes that rare.

### Tailscale

The node's machine and the owner's phones and computers join one tailnet. The node finds its tailnet address on its interfaces, or takes `TAILNET_ADDRESS`, and runs a fourth listener on it on `TAILNET_PORT` (9445; 0 turns it off), with the remote listener's policy except that it accepts only peers in the tailnet's ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). The cron run names it `yolo-ts-<8 hex digits>.<zone>`, keeps a DNS-only A record of the tailnet address, and obtains its certificate the same way. The record publishes an address that only members of the tailnet can reach. Yolo calls no Tailscale API and holds no Tailscale key: it binds an address. When Tailscale cannot connect two devices directly, it carries the traffic through its DERP relays, which are slower.

### The relay, opt-in

- The Worker's `/m/*` passthrough stays, but answers `403` with `X-Yolo-Error-Code: RELAY_OFF` while the relay is off, and the welcome lists the relay only while it is on. Even on, it is the last path.
- The owner turns it on in settings, behind the passkey session, after confirming this warning: "Relaying video through your Cloudflare Worker is likely outside Cloudflare's terms on Free, Pro, and Business zones, and Workers Free is clearly not covered. Cloudflare may restrict video on your domain or act on your account. Turn this on only if you accept that risk." The switch and the time the owner accepted the warning live in KV, `yolo doctor` and `get_status` report it, and each change writes a security log line.
- A new instance starts with the relay off. The release that ships this turns it off on upgrade too, and its changelog's upgrade block lists the human step: set up remote direct play or Tailscale, or turn the relay on ([versions and releases](../../implemented/process/2026-10-13-versions-and-releases.md)).
- The relay never changes content types or reshapes responses to look like other traffic: hiding that it serves video would read as circumventing the restriction, which puts the whole account at risk.
- Owners use a zone for Yolo alone, so a zone-level restriction on video cannot reach their other sites, and each owner creates and owns their Cloudflare account, which the agreement requires (§2.2.1(a)).
- The owner may ask Cloudflare support for a written answer about the relay: "Workers Paid, a Custom Domain, uncached passthrough of self-hosted HLS through Workers VPC, one household". An answer updates the warning and this note.

### Telemetry of the chosen path

- **Device events** ([device telemetry](../../implemented/feature/2026-10-11-device-telemetry.md)): `media_probe` replaces `lan_probe` and adds `path`; `media_path` records each change of the chosen path with `path`, `reason`, and every probe's outcome; `media_path_fallback` replaces `lan_fallback` and adds `from` and `to`; `stream_selected` carries `network` (now the path) and the media host.
- **The Hub** logs `event: "stream"` with the path the node served, as it logs `network` today, and counts streams per path for each day.
- **The node** logs one line per completed media response with the path, status, bytes, duration, and cache hit, and no token.
- **The control plane** logs `kind: "edge"` with `path` and `event: "certificate"`, `"address_changed"`, `"cgnat"`, `"unreachable"`, or `"error"`, which replaces `kind: "lan"`.
- **Settings** show each screen's last path and why, a card per path with its state, name, address, certificate dates, and last error, and the number of relay streams in the last 7 days.

### What each owner sets up

| Step | Path | When it is needed |
|---|---|---|
| `LAN_DNS_TOKEN` as a Worker secret, as for LAN direct play | `lan`, `wan`, `tailnet` | Once, for any direct path |
| A DHCP reservation for the node's machine | `wan` | Once: the router's forward points at an address |
| A router port forward from an external TCP port to the node's `WAN_PORT` | `wan` | Once |
| Turn on remote access in settings, with the external port | `wan` | Once |
| An IPv6 firewall rule for the node's `WAN_PORT` | `wan` | Only for IPv6 |
| Allow the node in the macOS firewall | `wan`, `tailnet` | Only where the firewall is on |
| Tailscale on the node's machine and on each phone or computer, in one tailnet, and "Use Tailscale" on each screen | `tailnet` | Once per device |
| Turn the relay on and accept the warning | `relay` | Only if the owner wants it |
| Ask Cloudflare support for a written answer | `relay` | Optional |

The [`yolo-deploy`](../../../../skills/yolo-deploy/SKILL.md) skill lists the router steps as human checkpoints, and `yolo doctor` reports each path's state with the fix ([agent deployment](../../implemented/feature/2026-10-13-agent-deployment.md)).

### Parts and complexity

| Part | Complexity | Why |
|---|---|---|
| Ordered paths, parallel probes, fallback, and the per-screen switches in the player | Medium | Both engines and four paths; old player tabs during the release that changes the welcome |
| Paths in the Hub, the welcome, and `media_unreachable` | Low | The Hub already keeps a network per device |
| Names, records, and certificates for `wan` and `tailnet` | Low | The LAN code generalized to a list of names |
| The public address and the CGNAT checks | Medium | Router protocols vary, and the outside check depends on what a Worker can reach |
| The remote listener with its rate limits and timeouts | Medium | The first part of Yolo that faces the internet without Cloudflare in front |
| A purpose-derived key for media tokens | Low | Both halves derive it; the version prefix covers tokens issued before the change |
| The Tailscale listener | Low | An address and a peer range |
| The relay switch, its warning, and the upgrade step | Low | A KV value, an owner route, and a changelog entry |
| Telemetry and settings | Low | New fields on existing events and one card per path |
| The four stream types in the car on LTE, and a phone on Tailscale | Medium | Real networks, carrier NAT, and the car's browser |

Overall: medium-high.

## Alternatives considered

**Keep the relay as the default.** It needs no setup and works everywhere, but it is most likely outside Cloudflare's terms on Free, Pro, and Business zones and clearly outside them on Workers Free, and each owner would carry that risk on their own account, possibly with other sites on it.

**Remove the relay.** An owner behind carrier-grade NAT whose car needs media away from home would then have no path at all until R2 staging exists. Kept opt-in, it leaves that choice to each owner, with the warning in front of it.

**R2 staging.** The node uploads pre-segmented HLS or fMP4 to the owner's R2 bucket and devices play from R2, which is content "hosted by" Cloudflare and so compliant. It needs an upload pipeline, a step that prepares a title before playback, and eviction; it spends the home uplink before playback starts, and a write-through cache would still proxy the first view. Storage costs $0.015 per GB-month, egress is free, and content stored on Cloudflare falls under the Developer Platform's content rules ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). It is the compliant all-Cloudflare path for owners who cannot forward a port, and it is deferred until after 1.0.

**Cloudflare Stream.** Compliant, but Stream re-encodes every upload, so Yolo loses control of renditions, and it costs $5 per 1,000 minutes stored per month plus $1 per 1,000 minutes delivered: a library of 500 films, about 60,000 minutes, would cost about $300 a month in storage alone ([Stream pricing](https://developers.cloudflare.com/stream/pricing/)).

**Tailscale Funnel.** It publishes the node at a public `*.ts.net` address without a port forward, which the car's browser could use. But "traffic sent over a Funnel is subject to non-configurable bandwidth limits" ([Funnel](https://tailscale.com/kb/1223/funnel)), only ports 443, 8443, and 10000 are offered, and a Tailscale employee described it as "a funnel, not a hose" for media ([HN](https://news.ycombinator.com/item?id=35375794)), so sustained video at 8 Mbps is not assured. It may return as an experimental path for a car behind carrier-grade NAT if measurements show it holds.

**Tailscale Serve with a `ts.net` certificate.** It works, but needs the tailnet's HTTPS certificate feature and a `tailscale serve` configuration outside Yolo, and Yolo would learn the name from the owner. One mechanism of names, records, and certificates in the owner's zone serves every direct path.

**Cloudflare One Client or Mesh private routes.** Cloudflare exempts private routes, so this stays inside the owner's Cloudflare account, but it needs a Zero Trust organization and enrolled devices, and the car cannot enroll. Tailscale is simpler for an owner to set up; a private-route path could come later as a plugin.

**A small VPS as a relay, joined to the node by WireGuard.** Compliant for Cloudflare and reachable by the car, but it adds a machine for every owner to rent and maintain.

**A tunnel public hostname for media.** Cloudflare's documentation puts Tunnel public hostname routes under the same restriction, and the [passthrough note](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.md) already rejected a `media.` subdomain through the tunnel.

**Creating the port mapping by UPnP, NAT-PMP, or PCP.** It would save the manual forward, but many routers have these protocols off, and software that opens router ports by itself surprises owners. The node only reads the external address.

**Binding media tokens to the device's address.** The car's address changes on LTE and between networks, so a stream would break on every change.

## Acceptance criteria

- On a new instance the relay is off, the Worker's `/m/*` answers `403 RELAY_OFF`, and turning the relay on requires the warning's confirmation.
- With a port forward, the car on LTE plays all four stream types (`hls`, `direct`, `dash_split`, `plex`) through `wan`; a car that leaves home Wi-Fi during a LAN stream continues on `wan` at the same position.
- Away from home, a phone with Tailscale plays through `tailnet` in Safari, and a computer in Chrome.
- Behind carrier-grade NAT (reproduced with a test router), settings show `cgnat`, phones use `tailnet`, and the car gets `media_unreachable` with the setup it needs unless the relay is on.
- Tests pin the remote listener's scope: `421` for another `Host`, `403` for a forged token before any session work, a refused peer after repeated failures, no route outside `/m/*`, `OPTIONS`, and the probe, and no HTML content type. A security review of the listener is recorded.
- Every stream's path appears in the device events, the Hub's `stream` log, and the node's media lines, and settings show each screen's last path and the relay's count.
- When this ships, the [passthrough](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.md), [LAN direct play](../../implemented/feature/2026-10-12-lan-direct-play.md), [Workers VPC](../../implemented/architecture/2026-10-08-workers-vpc-node-access.md), and [device telemetry](../../implemented/feature/2026-10-11-device-telemetry.md) notes describe it, the README states the relay's warning, and `yolo doctor` checks each path.

## Risks

- **Many owners cannot forward a port:** carrier-grade NAT, a rented router, or an ISP that blocks inbound ports. Their phones use Tailscale, and their cars have only the relay; the `edge` events of the first instances show how common this is, and how soon R2 staging is needed.
- **The node faces the internet.** Scanners find the port within minutes of the certificate reaching Certificate Transparency logs; a flaw in the media handler or in Node's TLS and HTTP code becomes reachable from anywhere; abusive traffic can fill the home uplink. The listener's narrow scope, its limits, a current Node.js (which `yolo doctor` checks), and the owner's switch bound this.
- **The home's public address is published** in DNS, which reveals the owner's ISP and rough location.
- **A changed public address** breaks `wan` until the node's next check, the next 5-minute cron run, and the record's 60-second TTL; streams fall back meanwhile.
- **The car's network is unknown:** whether its LTE carrier allows outbound connections to arbitrary ports, and whether it has IPv6. The car's `media_probe` events answer both.
- **Router DNS rebinding protection** may drop the private answer for the Tailscale name, as it can for the LAN name; the owner allowlists the zone.
- **The relay stays in the code.** An owner who turns it on carries the risk on their own account. Cloudflare's terms can change, so the warning and this note are checked whenever Cloudflare updates them.
- **Workers VPC remains a beta dependency** for control traffic; once media leaves the Worker, its unannounced pricing after the beta matters far less.
- **Four media paths** multiply what a playback bug can depend on; telemetry records the path of every stream.
