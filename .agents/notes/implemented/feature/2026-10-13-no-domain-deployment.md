# Agent Note: An instance without a domain runs its control plane on workers.dev and Workers Free

Status: implemented

English | [中文](2026-10-13-no-domain-deployment.zh.md)

## Problem

Yolo's control plane needed a custom domain on a Cloudflare zone before anything worked: the Worker was served only on a route, and passkeys, OAuth tokens, and the node's media names were bound to that hostname. An owner without a domain could not start, and buying one adds a payment, a registrar, and DNS setup to the first hour. Workers Free was expected to be enough but was not checked against Yolo's own use: every realtime connection wrote its ticket to KV, the cron run rewrote the media names' state, and Free allows 1,000 KV writes a day for the whole account.

## Decision

### Two tiers

An instance is served on one of two addresses, which `npm run yolo -- init` records in the instance file:

| | Zero cost | Domain |
|---|---|---|
| Address | `https://<worker>.<account subdomain>.workers.dev` | `https://<hostname>` on the owner's zone |
| Cost | Workers Free; nothing else | The domain, about $5–11 a year at Cloudflare Registrar |
| Sign-in, pairing, agents, the realtime channel | Yes | Yes |
| Direct play | Without a name: see below | LAN and remote direct play by name, in every browser |
| Who decides the address | Cloudflare may rename the account's workers.dev subdomain | The owner |

The owner of a zero-cost instance gets the whole control plane: the player at the site root, passkey sign-in with the 6-digit code, pairing screens, agents over MCP and OAuth, `/v1`, and the Hub. Media paths are owned by [media off the Worker](../architecture/2026-10-13-media-off-the-worker.md). Without a zone there are no LAN or remote names and no `MEDIA_DNS_TOKEN`, and the instance file records `media.wan.certificate: "ip"`: the node certifies its public address itself, and the cron run only passes it the owner's switch ([media without a domain](#media-without-a-domain)).

### The instance file

| Field | Meaning |
|---|---|
| `domain` | The custom domain, or `null` when the instance has no zone |
| `workersDev` | `true` when the Worker is served on workers.dev |
| `host` | The control plane's public host: the domain, or `<worker>.<account subdomain>.workers.dev` |
| `publicOrigin` | `https://<host>` unless set |
| `media.wan.certificate` | `"name"` with a domain, `"ip"` without one; may be set |

A file from before the tiers has `domain` and no `workersDev`, and is read as the domain tier without change; the file's version stays 1. [`ops/lib/instance.js`](../../../../ops/lib/instance.js) rejects a domain and `workersDev` together, a workers.dev host as a custom domain, a `host` that is not `<worker>.<subdomain>.workers.dev`, and a named certificate without a domain.

### init without a domain

`npm run yolo -- init` without `--domain` (or with `--workers-dev`) chooses workers.dev ([`ops/commands/init.js`](../../../../ops/commands/init.js)):

1. A new instance gets a Worker name of its own, `yolo-` and six random letters and digits, which says nothing about the owner; `--worker` chooses another before the first deploy.
2. With wrangler signed in, it reads the account's workers.dev subdomain (`GET /accounts/{id}/workers/subdomain`, with the API token of `npm run yolo -- auth`, or the one `wrangler auth token` returns). Reading changes nothing. An account without one stops for the owner's approval (exit 2) with a suggested neutral name, because the name is public for good and every Worker of the account is served under it; `--workers-subdomain <name>` registers it.
3. It warns when the subdomain looks made from the account's email or name, as Cloudflare names them on older accounts (`<email>-s-account`), because Certificate Transparency logs keep it.
4. It records `host`, and `.env` gets `PUBLIC_ORIGIN=https://<host>`.

Before the Cloudflare login (`npm run yolo -- auth`), init writes the instance file and `.env` and stops for the human step; run again, it fills the host. The rendered config of a workers.dev instance has `workers_dev: true`, no `routes`, and `PUBLIC_ORIGIN` set to the host; a domain instance has `workers_dev: false` and its custom-domain route ([`ops/lib/wrangler-config.js`](../../../../ops/lib/wrangler-config.js)). `preview_urls` is `false` in the template for both, so the Worker answers on exactly one origin.

### Passkeys, sessions, and isolation on workers.dev

`workers.dev` is on the Public Suffix List, so `<account subdomain>.workers.dev` is a site of its own. The passkey relying party ID is `PUBLIC_ORIGIN`'s full host, which no other account can claim, and the session and challenge cookies are `__Host-` cookies, which no other host can set or read. Another Worker in the same account is same-site with Yolo: `SameSite=Lax` does not separate them, but Yolo's state-changing routes check `Origin` or `Sec-Fetch-Site` against the exact origin. An account that holds only Yolo removes that exposure.

The player's COOP and COEP headers come from its `_headers` file in the static-assets layer, which serves them on any host, and the workers.dev host is HTTPS, which cross-origin isolation needs. `doctor` loads `/` and checks both headers (`worker.isolation`) on either tier.

### Moving the address

The address moves when the owner adds a domain, renames the Worker, or renames the account's subdomain, and when Cloudflare renames workers.dev subdomains, which its Developer Platform terms allow "for any or no reason". `init` refuses each move without `--change-domain` (exit 2) and says what it costs. After the move and a deploy:

- **Passkeys** are bound to the old host as their relying party ID. The owner registers a new one with `npm run owner-code` and the 6-digit code, which replaces every passkey and signs out every session ([owner sign-in](../architecture/2026-10-08-passkey-owner-sign-in.md)).
- **Agents** hold tokens whose issuer and audience are the old origin; each one connects again.
- **Screens** keep their device credential in the old origin's storage; each one pairs again.

A move to a domain keeps the Worker and its data: `init --domain <host> --change-domain` sets the route and turns workers.dev off in the rendered config, and the D1 history, queue, and playlists stay.

### Workers Free

Every binding Yolo uses deploys on Workers Free: Durable Objects on the SQLite backend, D1, KV, the cron trigger, Workers Logs, the rate-limit bindings (no plan restriction is documented, and [`rate-limit.js`](../../../../service/control/src/rate-limit.js) limits nothing when a binding is missing), and Workers VPC, which is free on every plan while in beta. No binding needs a fallback. What Free limits is daily use per account, reset at 00:00 UTC:

| Counter | Free limit a day | Past it |
|---|---|---|
| Worker requests | 100,000 (static assets do not count) | Error 1027 on workers.dev until midnight; no fail-open setting without a route |
| KV writes, deletes | 1,000 each | Writes fail: new OAuth grants and refreshes, sign-ins |
| D1 rows written, read | 100,000 and 5,000,000 | Queries fail |
| Durable Object requests | 100,000 | Hub calls fail |

`doctor` reads the account's analytics for yesterday and today (UTC) and reports the busier day against these limits (`cloudflare.limits`), warning from half a limit ([`ops/lib/plan.js`](../../../../ops/lib/plan.js)). The API that wrangler signs in with cannot read the account's plan, so the levels are Free's, and the fix says to ignore them on Workers Paid.

### KV writes

Two of Yolo's KV writes recurred without bound. The realtime ticket was written to KV on every connection; it now lives in the user's Hub Durable Object, whose storage allows 100,000 row writes a day ([OAuth](../architecture/2026-10-07-oauth-authorization-server.md#realtime-tickets)). The media names' state was rewritten on every 5-minute cron run while the remote path worked, because it records when the outside check last reached the node, and while any error persisted, because the error records when it happened; the state is now written when something else changes, or once an hour. OAuth keeps its own use of KV.

KV writes a day:

| | Before | After |
|---|---|---|
| Measured, one household's instance, 11–13 October 2026 | 24–45 (and 10–19 deletes) | |
| Estimate, busy household: 2 screens, 6 hours of play, 3 agents, 50 reconnects | ≈ 520: tickets 50, OAuth refreshes up to 144, sign-ins about 10, remote state 288, LAN state 24 | ≈ 200: OAuth up to 144, sign-ins about 10, the two states 24 each plus changes |
| …and a car reconnecting every 30 seconds for 2 hours | ≈ 760 | ≈ 200 |
| …and a LAN name failing all day | ≈ 1,020: over the limit | ≈ 200 |
| Without a domain | | ≈ 180: no LAN name; while remote access is on, the remote path's state by address, 24 plus changes |

### Media without a domain

Without a zone the node's listeners have no names. What remains is Let's Encrypt's certificates for IP addresses, issued since 15 January 2026 ([general availability](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)):

- only under the `shortlived` profile, for 160 hours ([profiles](https://letsencrypt.org/docs/profiles/));
- validated only by HTTP-01, which "can only be done on port 80", or by TLS-ALPN-01 on port 443; DNS-01 does not apply "because the DNS is not involved" ([challenge types](https://letsencrypt.org/docs/challenge-types/), [IP certificates](https://letsencrypt.org/2025/01/16/6-day-and-ip-certs));
- with a TLS-ALPN-01 check whose server name is the address's reverse name, because TLS forbids an address in the server name ([RFC 8738](https://datatracker.ietf.org/doc/html/rfc8738)).

No public CA certifies a private address: "CAs SHALL NOT issue Certificates containing Internal Names or Reserved IP Addresses" ([BR §4.2.2](https://github.com/cabforum/servercert/blob/main/docs/BR.md)). Many routers refuse to map ports below 1024 automatically: a NAT-PMP gateway may refuse port 80 ([RFC 6886](https://datatracker.ietf.org/doc/html/rfc6886)), and miniupnpd, the daemon behind many routers' UPnP, advises allowing only ports from 1024 up ([miniupnpd.conf](https://raw.githubusercontent.com/miniupnp/miniupnp/master/miniupnpd/miniupnpd.conf)).

With `media.wan.certificate` `"ip"`, which the Worker reads as the var `WAN_CERTIFICATE`, screens play as follows:

| Where the screen is | How it plays |
|---|---|
| Away from home, the car on LTE included | Remote direct play from `https://<public IPv4 address>:<port>`, with a Let's Encrypt certificate for that address |
| At home | The same address, which works only where the router loops back to its own public address (NAT loopback, "hairpin"); otherwise the relay, unless the owner turned it off |
| Behind carrier-grade or double NAT | The relay, unless it is off, as with a domain |

LAN direct play needs a domain: no public certificate can name the node's private address, and plain HTTP to that address stays rejected ([LAN direct play](2026-10-12-lan-direct-play.md)). The path order stays LAN, remote, relay; without a domain the LAN path never appears.

#### Where ACME runs

The node runs the ACME order for its address itself, with the client the Worker uses for DNS-01 ([`service/core/src/acme.js`](../../../../service/core/src/acme.js)). The listener's private key stays on the node in both modes.

- **No credential reaches the node.** ACME runs in the Worker for named media because DNS-01 needs the zone token, which edits every record in the zone and which every node plugin could read on the home machine ([plugin trust model](../architecture/2026-10-11-plugin-architecture.md)). HTTP-01 and TLS-ALPN-01 need no credential. The node's ACME account key can obtain a certificate only for an address whose port 80 or 443 reaches the node, which a node plugin, running with the node's rights, could do anyway.
- **The control plane still reaches the node only through `nodeFetch()`.** It sends `PUT /internal/v1/wan` with `certificate: "ip"`, the page origin, the owner's switch, and the ACME directory, and reads the node's answer ([node internal API](../architecture/2026-10-07-node-internal-api.md)). The node's requests to the CA go out from the home, as its requests to sources do.
- **The answers and the check are on one machine.** The node must answer exactly while the CA validates, from several vantage points and with retries. From the Worker, each order would need further `nodeFetch()` calls to open and close the node's answers within one cron run, with the Worker guessing when the CA has finished.
- **The node sees a new address first.** It reads the home's address every 5 minutes and from the router at every mapping renewal, so it orders without waiting for a cron run.
- **A Worker cannot fetch an IP address** ([known issues](https://developers.cloudflare.com/workers/platform/known-issues/)), so it could not check the result from outside either.

#### The challenge and its ports

The node's side is [`service/node/src/wan.js`](../../../../service/node/src/wan.js) and [`acme-challenge.js`](../../../../service/node/src/acme-challenge.js):

- **HTTP-01, the default.** The CA asks for `http://<address>/.well-known/acme-challenge/<token>` on port 80. The node answers on `WAN_CHALLENGE_PORT` (9480): a plain-HTTP listener on the address the router forwards to, which exists only while an order runs and serves only that order's tokens. In `auto` mode (`WAN_CHALLENGE_MAPPING`, by default `WAN_MAPPING`'s value) the node asks the router for its port 80 by PCP, NAT-PMP, or UPnP IGD for that order, with a 10-minute lifetime, and deletes the mapping when the order ends. A router that grants another external port has refused, because the CA checks only port 80.
- **TLS-ALPN-01, when the remote listener's router port is 443** (`WAN_EXTERNAL_PORT=443`). The remote listener answers `acme-tls/1` handshakes for the address's reverse name with a self-signed certificate that carries the `acmeIdentifier` extension, and listens for that before it has a certificate. No second port is mapped, the origin is `https://<address>`, and the CA's check proves that the media port itself is reachable.
- **A router that refuses.** The node places no order, so it spends no failed authorization. Its status, `yolo doctor`, and settings name the one forward: TCP port 80 to `<node address>:9480` with `WAN_CHALLENGE_MAPPING=manual`, or TCP port 443 to `<node address>:9444` with `WAN_EXTERNAL_PORT=443` and `WAN_MAPPING=manual`, which serves media through that one port. The remote listener's own port is mapped as with a domain, so on a router that maps only ports from 1024 the forward of port 80 is the one router step.
- **IPv6.** While `WAN_IPV6` gives the listener a global IPv6 address, the certificate covers it too, checked by HTTP-01 on `[address]:80`, where the node listens directly because IPv6 has no NAT. When the node cannot listen there or the CA cannot reach it, the node orders for IPv4 alone and leaves IPv6 out for a day. Screens use the IPv4 origin.

#### Renewal and a new address

- The node certifies the home's public IPv4 address as the control plane's `/.well-known/yolo?address=1` sees it, else as the router reports it, only while remote access is on and the home is not behind carrier-grade or double NAT, and always under the `shortlived` profile.
- It orders when it has no certificate for the current address; two thirds into the 160-hour lifetime, about every 107 hours, which stays under Let's Encrypt's 5 certificates per set of identifiers a week; and at once when the address changes. On a change it first renews the router mapping, so that the router's previous answer does not read as another NAT. Until the new certificate is installed the listener serves no stream under the old address.
- A failure at the CA waits 30 minutes, doubling up to 6 hours, which stays under 5 failed authorizations per identifier an hour ([rate limits](https://letsencrypt.org/docs/rate-limits/)); a refused port is tried again every 30 minutes; a change of the owner's switch, the page origin, or the directory tries at once.
- The state, with the ACME account's private key, is `<runtime>/.lan/wan/ip.json`, readable by the owner alone.

#### The control plane

Without a domain [`edge/wan.js`](../../../../service/control/src/edge/wan.js) names nothing, writes no DNS record, needs no `MEDIA_DNS_TOKEN`, and runs no ACME order. On each cron run and when the owner asks, it sends the node `certificate: "ip"`, the page origin, the owner's switch, and `LAN_ACME_DIRECTORY`, and keeps the node's answer in `yolo:wan`. The state is `ok` once the node serves under the current address with a valid certificate: the CA reached the node from outside when it validated the address, which replaces the Worker's probe. The welcome then lists `wan` with that origin; when the origin changes, every Hub sends its connected screens `media`, so they probe the new address without reconnecting.

#### At home: the router's loopback

A screen at home reaches the home's public address only where the router loops back to it, which RFC 4787 and RFC 5382 require of a NAT and many home routers still lack; Yolo measures it per home rather than assuming it.

- **The mark.** The Hub compares the address of each screen's realtime connection (`CF-Connecting-IP`) with the home's public address the last cron run recorded, and marks `wan` `home: true` in that screen's welcome and `media` messages ([`edge/paths.js`](../../../../service/control/src/edge/paths.js)). The home's address itself stays with the Hub. A screen that reaches Cloudflare over IPv6 while the home is seen over IPv4 gets no mark, and its probe is not read as a loopback test.
- **The test.** The marked screen's `wan` probe answers it: `hairpin: "ok"` when the probe answered and `"failed"` when it got none, in the screen's `media_probe` events and its `network` reports, which the Hub logs ([`media-paths.js`](../../../../clients/player/src/media-paths.js)).
- **Without loopback** the screen takes the relay, the fallback, and has no path only when the owner turned the relay off; then `media_unreachable` says the home network needs a domain.

#### In settings

The owner's "Media paths" in settings opens with a "Without a domain" card: away from home every screen, the car included, plays straight from the node at the home's address once remote access is on; the node asks the router for its ports itself, and a refusal names the one port to forward; at home a screen uses the same address only where the router loops back, else the relay unless it is off; a domain, from about $5 a year, adds direct play on the home network in every browser. The home network card says it needs a domain; the remote direct play card shows the origin by address, the router port the CA's check uses, and the certificate's validity. On each screen, the LAN switch gives way to "Needs a domain", and the path row says whether the router loops back ([`settings.js`](../../../../clients/player/src/settings.js)).

#### A listener known by address

Without a name the Host check filters nothing: a scanner that connects by address sends exactly the right `Host`, and browsers send no TLS server name to an address. The listener therefore:

- answers the probe only to a request whose `Origin` is the page's, sends CORS headers only to that origin, and answers every refusal (404, 405, 421, 429) with an empty body, so a scanner learns neither that it reached Yolo nor the control plane's origin;
- refuses every TLS server name except the CA's check while an order runs;
- keeps the remote listener's other rules: the token checked before any work, a peer refused for 10 minutes after 20 failures in a minute (each 404 to a scanner counts), and the connection limits ([threat model](../architecture/2026-10-13-media-off-the-worker.md#the-threat-model-of-the-remote-listener)).

The address, and the fact that a TLS service runs there, enter Certificate Transparency logs with every certificate, about twice a week. The narrow surface and the limits protect the listener; hiding it from scanners only spares it their attention.

#### Owner setup without a domain

| Step | When it is needed |
|---|---|
| Turn on remote access in settings | Once |
| Nothing on the router | Where the router maps its port 80 and the remote listener's port |
| Forward TCP port 80 to the node's `WAN_CHALLENGE_PORT` (9480) and set `WAN_CHALLENGE_MAPPING=manual` | Where the router maps only ports from 1024 up |
| Or forward TCP port 443 to the node's `WAN_PORT` (9444) and set `WAN_EXTERNAL_PORT=443` and `WAN_MAPPING=manual` | Where the router maps nothing: one forward serves the check and the media |
| Nothing for the relay: it is automatic and carries what no direct path reaches | Every instance |

### The media DNS token, on the domain tier only

LAN and remote direct play by name need `MEDIA_DNS_TOKEN`, a token that can edit the zone's DNS records, and `wrangler login` cannot ask for DNS edit. `npm run yolo -- provision media-dns` ([`ops/lib/media-dns.js`](../../../../ops/lib/media-dns.js)) creates it with Cloudflare's CLI, `cf`, under a profile of its own, `yolo`, so the owner's own `cf` login is untouched. Of that profile the step needs only `account_api_tokens:create`, `dns.write`, and `zone.read`; `npm run yolo -- auth` signs it in once, with the owner's approval on any device ([signing in to Cloudflare](2026-10-13-agent-deployment.md#signing-in-to-cloudflare)). It creates an account-owned token named "Yolo media DNS" with DNS Write and Zone Read on the instance's zone only, and passes its value from `cf`'s output to `wrangler secret put MEDIA_DNS_TOKEN` on stdin: the value is never printed or written to disk. Run again, it keeps a Worker secret that exists, including one the owner stored by hand; `--rotate` rolls the named token, pointing it at the zone first when it covers another, and stores the new value. Without `cf`, or without the owner's consent, the step prints a dashboard page pre-filled with DNS edit and Zone read on the instance's account and zone, and `npm run wrangler -- secret put MEDIA_DNS_TOKEN` to paste the token. `doctor` names the step while a domain instance's Worker has neither `MEDIA_DNS_TOKEN` nor `LAN_DNS_TOKEN` (`cloudflare.media-dns`). A workers.dev instance needs no token, and the step says so.

### What doctor says on workers.dev

- `config.workersdev` warns, on every run, that a rename moves the address and what the owner then redoes, and that a domain removes the risk.
- `cloudflare.workersdev` compares the account's subdomain with the instance's host and fails after a rename, with the fix: `init --change-domain`, deploy, a new passkey, agents, and screens.

## Deferred

- **An IPv6 origin for screens.** A screen at home with IPv6 would reach the node's global address with no loopback. The certificate already covers that address, but a screen's stream takes its origin from the node, which serves one remote origin; the screen would have to name the origin it reached.
- **The LAN ceiling for a screen at the home's address.** A stream through the router's loopback does not use the uplink, so it could have `LAN_MAX_VIDEO_KBPS` rather than the uplink's ceiling.
- **ACME Renewal Information**, whose renewals Let's Encrypt exempts from its rate limits.

## Alternatives considered

**Requiring a domain.** It keeps one tier, but it puts a payment, a registrar, and DNS setup before an owner can see Yolo work, while the control plane needs nothing a zone provides. A domain stays the advice for LAN direct play and a stable address.

**A free dynamic-DNS name, such as deSEC or DuckDNS, for the control plane.** Cloudflare can host a zone only for an apex one level below a public suffix, and subdomain zones are an Enterprise feature, so the Worker cannot have a custom domain on such a name; it would also tie every sign-in to a third party's uptime.

**WebAuthn Related Origin Requests to carry passkeys across a move.** They would make the workers.dev host, which Cloudflare may rename, a permanent part of the passkeys' relying party. The 6-digit code already recovers the owner from the home machine.

**Serving on workers.dev and the domain at once.** Passkeys and tokens are bound to one origin, so the second origin would offer a sign-in page that cannot work.

**Requiring Workers Paid.** One household fits Free once a connection costs no KV write. Paid, $5 a month, stays the advice for an owner whose screens play mostly through the relay or who connects many agents, and it removes the daily limits that `doctor` reports.

**Stateless signed tickets.** A ticket signed with `NODE_SECRET` needs no store, but working once still needs a record of the tickets already used; the Hub that the connection goes to holds that record anyway.

**The owner pastes the DNS token to the agent.** The token would pass through the conversation. With `cf`, the only human step is one browser consent, and the value goes from Cloudflare to the Worker secret without being shown.

**ACME in the Worker, with the node answering the challenges.** It would keep one ACME account per instance in KV, as for the named paths. But it moves no credential away from the node, because HTTP-01 and TLS-ALPN-01 need none; it adds `nodeFetch()` calls to open and close the node's answers around a validation whose timing only the CA knows; it delays every address change by a cron run; and the Worker still could not check the result, because it cannot fetch an address.

**A permanent mapping of port 80, or a challenge listener that always listens.** Renewals would not depend on the router granting the mapping each time. But port 80 would face the internet between orders for nothing, and a router that refuses the mapping refuses it either way.

**DNS-01 for the media listeners through a free dynamic DNS service such as DuckDNS or deSEC.** A name would bring LAN direct play and the Host check back. It makes every owner's renewals and stream starts depend on a third party, puts its token on the home machine, and a cheap domain at Cloudflare's registrar gives the same with no third party.

**Plain HTTP to the node's private address at home.** Chromium exempts a private IP literal from mixed-content blocking behind its Local Network Access prompt, which would give LAN direct play without a domain. Safari and Firefox have no such exemption, the media token would cross the LAN in clear, and whether Tesla's browser grants the permission is unknown; it stays rejected as in [LAN direct play](2026-10-12-lan-direct-play.md).

**The media port on 443 by default.** The origin would carry no port and one port would serve the check and the media. But routers that refuse port 80 refuse 443 for the same reason, and an owner may already use 443 at home; it stays the owner's choice, and the refusal names it.

## Consequences

An owner with only a Cloudflare account deploys Yolo at no cost and gets the whole control plane. What the zero-cost tier gives up:

- **The address can move.** A rename by Cloudflare, or by the owner, means a new passkey with the 6-digit code, reconnecting every agent, and pairing every screen again; `doctor` warns on every run and detects the rename.
- **No LAN direct play by name**, so Safari and Firefox at home play only over the remote path or the relay, as the media notes describe.
- **workers.dev is a shared suffix.** Cloudflare calls it a home for personal or hobby projects. Some school, corporate, and DNS filters block or flag workers.dev hosts, and its account subdomain stays public in Certificate Transparency logs. The Cache API does nothing there (Yolo does not use it), and requests over the daily limit get Error 1027 with no fail-open option.
- **Another Worker in the same account is same-site** with Yolo; a dedicated account removes that.

On Workers Free, a household's KV writes no longer grow with reconnects. The remaining Free risks are the 10 ms of CPU per request (warm MCP requests measured 1–2.4 ms in Node; a cold isolate's first request can exceed 10 ms, which Cloudflare allows occasionally; watch `exceededCpu` in Workers Logs), a playlist reorder of more than 50 items against the 50 queries per invocation, and Workers VPC, whose price after the beta is not announced. A ticket issued by the previous Worker version during a deploy fails once, and the client asks for a new one.

For media, an owner with no domain and no money plays away from home, the car on LTE included, with nothing on the router where it maps port 80 and the media port, and one port forward otherwise; Cloudflare carries no media. Behind carrier-grade NAT nothing changes: there is no remote path.

What media without a domain costs:

- Renewal every four and a half days depends on the router mapping port 80 at that moment; a failed renewal still leaves about 53 hours of validity, and the backoff keeps trying.
- A new address breaks `wan` for the node's next check (up to 5 minutes), one order (about a minute), and the next cron run (up to 5 minutes), after which every Hub tells the connected screens.
- At home, direct play depends on the router's loopback, which many routers lack; the screens' reports show it for each home, and a domain removes the dependency.
- The home's address enters Certificate Transparency logs, linked to a TLS service, about twice a week.
- The node makes requests to the CA and holds an ACME account key.
- A node from before this answers `certificate: "ip"` with an error, so the node is upgraded before the Worker, as every release does ([versions and releases](../process/2026-10-13-versions-and-releases.md)); only an instance without a domain sends it, so `NODE_PROTOCOL` stays.

## Testing

[`wan-ip.test.js`](../../../../service/node/test/wan-ip.test.js) runs the node against a stand-in ACME server on loopback that checks every JWS signature, the `shortlived` profile, and `ip` identifiers, and validates by connecting to the node's ports as the CA would through the router: HTTP-01 through a port 80 mapping made for the order and removed after it, TLS-ALPN-01 on the remote listener with its router port on 443, a refused port 80 that leaves the forward to make and places no order, a new address certified at once after the router is asked again, renewal at two thirds of the lifetime, and a scanner by address that gets empty 404s and no control origin. [`edge.test.js`](../../../../service/control/test/unit/edge.test.js) runs the control plane's side with no DNS token: no DNS, ACME, or probe from the Worker, the state and the welcome, the screens told when the origin changes, and the node's instruction in the error. [`hub-core.test.js`](../../../../service/control/test/unit/hub-core.test.js) pins the `home` mark, which only a screen at the home's address gets, the `hairpin` report, the refusal that names a domain, and the `media` message; [`media-paths.test.js`](../../../../clients/player/test/unit/media-paths.test.js) pins the loopback report with and without loopback and the new origin probed on `media`. Nothing calls Let's Encrypt or a real router.
