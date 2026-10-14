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

The owner of a zero-cost instance gets the whole control plane: the player at the site root, passkey sign-in with the 6-digit code, pairing screens, agents over MCP and OAuth, `/v1`, and the Hub. Media paths are owned by [media off the Worker](../architecture/2026-10-13-media-off-the-worker.md). Without a zone there are no LAN or remote names and no `MEDIA_DNS_TOKEN`, so the cron run has nothing to maintain, and the instance file records `media.wan.certificate: "ip"`: the node's remote listener is certified for its public address instead of a name, as the media notes describe.

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
2. With wrangler signed in, it reads the account's workers.dev subdomain (`GET /accounts/{id}/workers/subdomain`, with the token `wrangler auth token` returns). Reading changes nothing. An account without one stops for the owner's approval (exit 2) with a suggested neutral name, because the name is public for good and every Worker of the account is served under it; `--workers-subdomain <name>` registers it.
3. It warns when the subdomain looks made from the account's email or name, as Cloudflare names them on older accounts (`<email>-s-account`), because Certificate Transparency logs keep it.
4. It records `host`, and `.env` gets `PUBLIC_ORIGIN=https://<host>`.

Before `wrangler login`, init writes the instance file and `.env` and stops for the human step; run again, it fills the host. The rendered config of a workers.dev instance has `workers_dev: true`, no `routes`, and `PUBLIC_ORIGIN` set to the host; a domain instance has `workers_dev: false` and its custom-domain route ([`ops/lib/wrangler-config.js`](../../../../ops/lib/wrangler-config.js)). `preview_urls` is `false` in the template for both, so the Worker answers on exactly one origin.

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
| Without a domain | | ≈ 155: no media-name state |

### The media DNS token, on the domain tier only

LAN and remote direct play by name need `MEDIA_DNS_TOKEN`, a token that can edit the zone's DNS records, and `wrangler login` cannot ask for DNS edit. `npm run yolo -- provision media-dns` ([`ops/lib/media-dns.js`](../../../../ops/lib/media-dns.js)) creates it with Cloudflare's CLI, `cf`, under a profile of its own, `yolo`, which the owner signs in once with only `account-api-tokens.write`, `dns.write`, and `zone.read` (`cf auth create yolo --scopes …`), so the owner's own `cf` login is untouched. It creates an account-owned token named "Yolo media DNS" with DNS Write and Zone Read on the instance's zone only, and passes its value from `cf`'s output to `wrangler secret put MEDIA_DNS_TOKEN` on stdin: the value is never printed or written to disk. Run again, it keeps a Worker secret that exists, including one the owner stored by hand; `--rotate` rolls the named token, pointing it at the zone first when it covers another, and stores the new value. Without `cf`, or without the owner's consent, the step prints a dashboard page pre-filled with DNS edit and Zone read on the instance's account and zone, and `npm run wrangler -- secret put MEDIA_DNS_TOKEN` to paste the token. `doctor` names the step while a domain instance's Worker has neither `MEDIA_DNS_TOKEN` nor `LAN_DNS_TOKEN` (`cloudflare.media-dns`). A workers.dev instance needs no token, and the step says so.

### What doctor says on workers.dev

- `config.workersdev` warns, on every run, that a rename moves the address and what the owner then redoes, and that a domain removes the risk.
- `cloudflare.workersdev` compares the account's subdomain with the instance's host and fails after a rename, with the fix: `init --change-domain`, deploy, a new passkey, agents, and screens.

## Alternatives considered

**Requiring a domain.** It keeps one tier, but it puts a payment, a registrar, and DNS setup before an owner can see Yolo work, while the control plane needs nothing a zone provides. A domain stays the advice for LAN direct play and a stable address.

**A free dynamic-DNS name, such as deSEC or DuckDNS, for the control plane.** Cloudflare can host a zone only for an apex one level below a public suffix, and subdomain zones are an Enterprise feature, so the Worker cannot have a custom domain on such a name; it would also tie every sign-in to a third party's uptime.

**WebAuthn Related Origin Requests to carry passkeys across a move.** They would make the workers.dev host, which Cloudflare may rename, a permanent part of the passkeys' relying party. The 6-digit code already recovers the owner from the home machine.

**Serving on workers.dev and the domain at once.** Passkeys and tokens are bound to one origin, so the second origin would offer a sign-in page that cannot work.

**Requiring Workers Paid.** One household fits Free once a connection costs no KV write. Paid, $5 a month, stays the advice for an owner who turns the relay on or connects many agents, and it removes the daily limits that `doctor` reports.

**Stateless signed tickets.** A ticket signed with `NODE_SECRET` needs no store, but working once still needs a record of the tickets already used; the Hub that the connection goes to holds that record anyway.

**The owner pastes the DNS token to the agent.** The token would pass through the conversation. With `cf`, the only human step is one browser consent, and the value goes from Cloudflare to the Worker secret without being shown.

## Consequences

An owner with only a Cloudflare account deploys Yolo at no cost and gets the whole control plane. What the zero-cost tier gives up:

- **The address can move.** A rename by Cloudflare, or by the owner, means a new passkey with the 6-digit code, reconnecting every agent, and pairing every screen again; `doctor` warns on every run and detects the rename.
- **No LAN direct play by name**, so Safari and Firefox at home play only over the remote path or the relay, as the media notes describe.
- **workers.dev is a shared suffix.** Cloudflare calls it a home for personal or hobby projects. Some school, corporate, and DNS filters block or flag workers.dev hosts, and its account subdomain stays public in Certificate Transparency logs. The Cache API does nothing there (Yolo does not use it), and requests over the daily limit get Error 1027 with no fail-open option.
- **Another Worker in the same account is same-site** with Yolo; a dedicated account removes that.

On Workers Free, a household's KV writes no longer grow with reconnects. The remaining Free risks are the 10 ms of CPU per request (warm MCP requests measured 1–2.4 ms in Node; a cold isolate's first request can exceed 10 ms, which Cloudflare allows occasionally; watch `exceededCpu` in Workers Logs), a playlist reorder of more than 50 items against the 50 queries per invocation, and Workers VPC, whose price after the beta is not announced. A ticket issued by the previous Worker version during a deploy fails once, and the client asks for a new one.
