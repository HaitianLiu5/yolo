# Agent Note: DNS provider plugins name the media listeners, deSEC first

Status: implemented

English | [中文](2026-10-14-dns-provider-plugins.zh.md)

## Problem

LAN direct play needs a public name for the node's private address and a certificate for that name, and remote direct play by name needs the same for the home's public address ([LAN direct play](../feature/2026-10-12-lan-direct-play.md), [media off the Worker](2026-10-13-media-off-the-worker.md)). Both took their names from the Cloudflare zone of the instance's domain. An instance without a domain runs on workers.dev and has no zone ([no-domain deployment](../feature/2026-10-13-no-domain-deployment.md)): a screen at home plays from the home's public address only where the router loops back to it, and otherwise through the Worker's relay; Safari and Firefox at home never get LAN direct play; and each certificate of the remote listener needs the router's port 80 while the CA checks. Free dynamic DNS services give a name and a DNS API without a purchase, but each has its own API, and the core, the control plane, and the node stay free of provider-specific code ([plugin architecture](2026-10-11-plugin-architecture.md)).

## Decision

The node's media names come from a **DNS provider**: Cloudflare's zone, built in, or a provider that a plugin's control entry registers. The instance chooses one in `media.dns`. deSEC (desec.io), whose free `dedyn.io` names come with a REST API for records and suit DNS-01, is the first plugin, [`plugins/dns-desec`](../../../../plugins/dns-desec/). It is opt-in: a domain at Cloudflare stays the recommended path, and an instance that sets nothing behaves as before.

Yolo is one household's private service. A third party in the media names' renewals and address updates is a trade an owner can take knowingly to get LAN direct play without a domain. It is not made for every owner, and the control plane never moves onto such a name.

### The provider interface

[`service/control/src/edge/dns.js`](../../../../service/control/src/edge/dns.js) chooses the provider and defines what `edge/` calls; `@useyolo/plugin-api` types it as `DnsProvider`.

| Member | Contract |
|---|---|
| `zone(pageHost)` | The zone the names go under, `{ id, name, … }`, called once and kept in the media state; the provider may update its own fields, such as a TTL, and the state keeps them. Cloudflare's is the most specific zone that holds the control plane's host |
| `setAddress(zone, name, type, address)` | Creates or moves the name's one A or AAAA record: DNS-only, with a short TTL |
| `clearAddress(zone, name, type)` | Deletes it; succeeds when there is none |
| `setTxt(zone, name, value)` | Sets the DNS-01 value at `_acme-challenge.<name>` and returns a handle; with one order at a time it may replace any value there |
| `clearTxt(zone, name, value, handle)` | Removes that value, or the name's TXT values with it |
| `settleMs` | How long the CA waits after a public resolver answers the new value; 0 by default, at most 5 minutes |

- **Registration.** A control entry calls `yolo.registerDnsProvider(id, { title, secret, create })` ([`service/control/src/plugins.js`](../../../../service/control/src/plugins.js)). `id` is lowercase letters, digits, and dashes, and not `cloudflare`. `secret` names the Worker secret that holds the provider's credential: it starts with the id in upper case (`desec` → `DESEC_TOKEN`), is none of the names Yolo's Worker reads (its secrets such as `NODE_SECRET` and `MEDIA_DNS_TOKEN`, its vars, and its bindings such as `OAUTH_KV`, `DB`, `HUB`, and `NODE`), and is no other provider's. On each run the control plane calls `create({ token, zone, fetch, sleep })` with that secret's value and the instance's zone, and only when the value is a string, so a binding of that name is never handed over.
- **The choice.** `media.dns` in the instance file renders the vars `MEDIA_DNS_PROVIDER` and `MEDIA_DNS_ZONE`. `cloudflare`, the default, is the domain's zone with `MEDIA_DNS_TOKEN`, unchanged. Any other id is that plugin's provider with that plugin's secret. A chosen provider whose plugin is not bundled, or whose secret is missing, is an error in the media state, which settings and `doctor` show. The control plane never falls back to another provider, because that would hand one provider's token to another.
- **Moving between providers.** The media state records a provider other than Cloudflare, with its zone, as `dns` in `yolo:lan` and `yolo:wan`, so a state from before providers reads as Cloudflare's and keeps its names. When the provider or the zone changes, each name is chosen again in the new zone, its records are written there, and its certificate is ordered for the new name. The previous provider's records stay where they are.
- **Without a domain.** A plugin's provider gives a workers.dev instance names, so `media.wan.certificate` defaults to `"name"` there, as with a domain: LAN direct play, and remote direct play by name with DNS-01 and the Worker's check from outside. `"ip"` keeps the remote listener on the home's address. The welcome stops saying `domain: false`, and each screen's settings show the LAN switch again.
- **Where the token lives.** DNS-01 runs in the Worker for a plugin's provider as for Cloudflare, so the token is a Worker secret and never reaches the home machine, where every node plugin can read `.env` ([plugin architecture](2026-10-11-plugin-architecture.md)).
- **The setup entry.** A DNS provider plugin's `package.json` may name `yolo.setup`, a module the operator's command line imports on the owner's machine: the provider's id, title, and secret, the owner's steps, a check of the name and of the token, and the provider's nameservers. `provision media-dns` and `doctor` find it through the plugin config that the Worker's build reads ([`ops/lib/media-dns.js`](../../../../ops/lib/media-dns.js)), so the command line carries no provider's API.

### Runs, orders, and their limits

A provider with a settle time makes an order long, and the Worker runs on Workers Free: the cron fires every 5 minutes, a cron run may last 15, and an invocation may make 50 subrequests. A deSEC order takes about 4 minutes: at most 4 questions to a public resolver, 15 seconds apart, then the 150-second wait, then the ACME exchange; with two rate-limit retries and a 5-minute settle time it can take about 13. Unbounded, two first orders in one run take about 7 minutes and, with a resolver that keeps answering NXDOMAIN, up to about 80 subrequests, and a run that starts meanwhile names the remote listener again, so the first run's certificate is refused and a record is left behind. [`edge/maintain.js`](../../../../service/control/src/edge/maintain.js) and [`edge/lease.js`](../../../../service/control/src/edge/lease.js) bound both:

- **One order per run.** The LAN and remote maintenance share one run, which orders at most one certificate; the other name keeps its name and record and gets its certificate in the next run, 5 minutes later. This holds for Cloudflare's zone too.
- **A lease for naming and ordering.** A run writes a lease to KV (`yolo:edge:lease`) when its order starts, and deletes it when the run ends if the lease is still its own; it expires by itself after 15 minutes, a cron run's wall-time limit. While another run holds it, a run chooses no name for the node and orders nothing, and does everything else: the remote-access switch closes or opens the listener at once, and an existing name's records stay current. The lease is written only for an order, so a 5-minute cron stays far inside Workers Free's 1,000 KV writes and deletes a day, and KV's consistency within about a minute is far shorter than the 5 minutes between cron runs.
- **Saved before the order.** The zone, the name, and its records are written to the media state before the order starts, so no later run names the node again.
- **The owner's check waits for nothing slow and names nothing.** "Check" on the home network card and the remote-access switch in settings run inside an HTTP request, which a closed page cancels, and can be served from a location whose KV does not yet show the cron run's lease or saved name. With a provider that has a settle time they never choose a name or order a certificate: a name that does not exist yet is left to the cron run, and the card shows it as pending. An existing name's records, the switch, and the listeners are handled at once.
- **Records left behind.** When remote access goes off, the node's listener closes first; the records are then removed at best effort, and while that fails a later run tries again after the certificate backoff, 30 minutes doubling up to a day.
- **The challenge's RRset.** With one order at a time, deSEC's `setTxt` sets the RRset to the new value alone and `clearTxt` deletes it: two requests an order, no reads, and a value a failed removal left behind goes with the next order.

A run that orders both names' first certificates in turn now makes at most about 25 subrequests with a resolver that never answers, measured against stand-ins.

### The deSEC plugin

`@useyolo/dns-desec` is an official plugin but not in `plugins/official.json`: an instance loads it only once it chooses deSEC. On an instance that loads the official list, `provision media-dns --provider desec` writes a `yolo.config.json` with the official plugins, unchanged, and then `./plugins/dns-desec`; an owner's own plugin config is never changed, and `provision` and `doctor` name the entry to add to it. The plugin has only a control entry, so the node loads the same plugins as before. It reads the secret `DESEC_TOKEN` and names the node under the instance's deSEC name with the labels [`edge/names.js`](../../../../service/control/src/edge/names.js) gives in any zone, for example `yolo-lan-3f9a01c2.home.dedyn.io` and `yolo-wan-0badcafe.home.dedyn.io`.

What the plugin relies on, from deSEC's documentation and source as of 2026-10-14:

| Fact | Source | What the plugin does |
|---|---|---|
| Requests authenticate with `Authorization: Token <secret>` | [tokens](https://desec.readthedocs.io/en/latest/auth/tokens.html) | Sends it with every request and never puts it in an error |
| A bulk `PUT` to `domains/{name}/rrsets/` creates or replaces the RRsets it lists, and one with empty `records` is deleted; `DELETE` of one RRset answers 204 whether or not it existed; the apex is `@` in a URL; TXT content is quoted | [RRsets](https://desec.readthedocs.io/en/latest/dns/rrsets.html) | One write per change; a challenge value joins the TXT values at its name and leaves alone |
| An RRset's TTL is at least the domain's `minimum_ttl`, which deSEC sets: 60 seconds for a name directly under dedyn.io, an hour for other domains unless deSEC lowers it | [domains](https://desec.readthedocs.io/en/latest/dns/domains.html), [deSEC, 2020](https://talk.desec.io/t/dyndns-and-lets-encrypt-using-custom-domain/17) | Reads `minimum_ttl` with the zone and writes every record at it, at least 60 seconds |
| One name under dedyn.io per account | [domains](https://desec.readthedocs.io/en/latest/dns/domains.html) | The node's two names are labels under that one name |
| RRset writes are limited per domain to 2 a second, 15 a minute, 100 an hour, and 300 a day; reads to 10 a second and 50 a minute; a 429 carries `Retry-After` | [rate limits](https://desec.readthedocs.io/en/latest/rate-limits.html) | Waits for `Retry-After` up to a minute, or 1 and then 2 seconds without it, and retries twice; a longer wait fails as `rate_limited`, and the next run, or the certificate backoff, tries again |
| Under dedyn.io an A record is refused only inside a blocked subnet, and the blocklist never takes a private subnet | desec-stack's [`records.py`](https://github.com/desec-io/desec-stack/blob/main/api/desecapi/serializers/records.py) and [`stop-abuse.py`](https://github.com/desec-io/desec-stack/blob/main/api/desecapi/management/commands/stop-abuse.py), [deSEC, 2023](https://talk.desec.io/t/unable-to-add-azure-ip/593) | Publishes the node's RFC 1918 address for the LAN name |
| A write is published at once, but deSEC's anycast nameservers catch up at different times: usually within seconds, sometimes about a minute later, and single servers up to about 170 seconds behind in measurements from July 2026; certbot-dns-desec waits 80 seconds | [deSEC, 2021](https://talk.desec.io/t/global-record-propagation-issues/332), [DNS-01 propagation, 2026](https://talk.desec.io/t/inconsistent-propagation-between-authoritative-nameservers-during-acme-dns-01-challenge/1790), [certbot-dns-desec](https://github.com/desec-io/certbot-dns-desec) | `settleMs` is 150 seconds: the control plane waits until a public resolver answers the challenge, then 150 seconds more, before the CA checks |
| `dedyn.io` is on the Public Suffix List | [the list](https://publicsuffix.org/list/public_suffix_list.dat) | Let's Encrypt's limit of 50 certificates a week counts against the owner's own name, not all of dedyn.io |

A certificate costs two writes per name, the challenge value added and removed, about every 60 days with 90-day certificates; a new address costs one. Both stay far inside deSEC's limits.

### Owner setup

| Step | Who |
|---|---|
| Sign up at desec.io with a free `<name>.dedyn.io`, and confirm the email | The owner |
| `npm run yolo -- provision media-dns --provider desec --zone <name>.dedyn.io`, which records `media.dns`, lists the plugin, and prints the owner's steps | The agent |
| Create a token in deSEC's Token Management; an account made without a password first sets one through "Forgot password" | The owner |
| `npm run yolo -- provision media-dns --token-stdin` in their own terminal: the token is read without echo, checked with one read of the domain at deSEC, and stored as `DESEC_TOKEN` with `wrangler secret put` on stdin; it is never printed or written to disk | The owner |
| `npm run yolo -- deploy`, which bundles the plugin and sets the vars, then `npm run yolo -- doctor` | The agent |
| As with a domain: the browser's Local Network prompt, and `<name>.dedyn.io` in the router's DNS rebinding allowlist where it filters | The owner |

`doctor` checks that the plugin is in the plugin config (`config.media-dns`), that the Worker has the secret (`cloudflare.media-dns`), that public DNS delegates the name to deSEC's nameservers (`dns.delegation`), and the Worker's LAN state: a Worker deployed before `media.dns`, or deSEC's error (`worker.media-dns`). The [`yolo-deploy`](../../../../skills/yolo-deploy/SKILL.md) skill walks an agent through the setup.

## Alternatives considered

**A free dynamic DNS name for every instance without a domain, by default.** Every owner's renewals and address updates would depend on a third party they did not choose. As an opt-in, the trade is the owner's, and the default stays as [no-domain deployment](../feature/2026-10-13-no-domain-deployment.md) describes.

**The control plane on a dynamic DNS name.** It stays rejected for the reasons [no-domain deployment](../feature/2026-10-13-no-domain-deployment.md) gives: the Worker cannot have a custom domain on such a name, and every sign-in would depend on the third party. Only the media names move.

**DuckDNS first.** A DuckDNS name has one address of each type and one TXT value, which every name below it shares, set through one update URL that carries the token in its query; the node's two names cannot be labels under one DuckDNS name. deSEC has a records API with RRsets per name, token auth in a header, and documented limits.

**One secret name, `MEDIA_DNS_TOKEN`, for every provider.** It would keep `doctor` and settings simpler, but between a change of `media.dns` and the next secret, the Worker would send one provider's token to the other's API. A secret per provider cannot cross.

**ACME on the node with the provider's token.** As for Cloudflare's token, the token would sit where every node plugin can read it ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)).

**A lease written by every run.** It would also cover runs that order nothing, but a 5-minute cron would spend 288 KV writes and 288 deletes a day on it, against Workers Free's 1,000 each; only an order needs it.

**Polling deSEC's nameservers instead of a fixed wait.** `ns1.desec.io` and `ns2.desec.org` are anycast groups of several servers each: a query from the Worker reaches the servers nearest Cloudflare, not those the CA's vantage points reach, so an answer proves little, and a Worker has no DNS client but DNS over HTTPS. A public resolver's answer and a fixed wait cover the measured lag.

**deSEC's API in the operator's command line.** It would serve deSEC alone; the setup entry keeps a provider's API and its owner's steps in its plugin, so another provider's plugin brings its own.

**The deSEC plugin in `plugins/official.json`.** Every instance would bundle it, inert until chosen, and no instance would need a `yolo.config.json` for it. But the official list is what the node loads and starts, and every entry there is a source the node serves; a plugin with only a control entry belongs in the list of the instances that chose it.

## Consequences

What it gives:

- An owner without a domain can have LAN direct play in every browser and remote direct play by name, with no purchase and no port 80 on the router.
- Every other instance is unchanged: Cloudflare's provider is the same code behind the interface, and its media state keeps its names.

What it costs:

- **deSEC is a dependency of the owner's direct play.** A renewal or an address update fails while deSEC's API or nameservers fail. A certificate keeps serving until it expires, a third of its lifetime after its renewal fell due, and the relay carries screens that no direct path reaches.
- **The token's reach.** The setup creates an unrestricted token, which can change every record of the owner's deSEC account. deSEC's token policies could narrow it to the node's names and their `_acme-challenge` records.
- **Time.** A certificate for a deSEC name takes about 4 minutes instead of seconds, because of the wait, and only the cron run orders it: the first setup gives the LAN name its certificate in one run and the remote name in the next, and "Check now" in settings shows the certificate as pending until then.
- **What becomes public.** The node's private address, the home's public address, and the names enter public DNS and Certificate Transparency logs under the owner's name, as under a domain.
- **A move leaves records behind.** After a change of provider or name, the previous provider's records stay until the owner deletes them there.
- **A plugin config of the instance's own.** An instance that chose deSEC on the official list loads its plugins from `yolo.config.json` from then on, so an official plugin that a later release adds to `plugins/official.json` reaches it only once it is listed there too.
- **TTL.** On a custom domain at deSEC the minimum TTL is an hour, so a new address can take that long to reach screens; on a dedyn.io name it takes 60 seconds.
- **Not documented by deSEC:** whether it ever limits requests from Cloudflare Workers' addresses.

## Testing

[`plugins/dns-desec/test/`](../../../../plugins/dns-desec/test/) runs the provider against a stand-in for deSEC's API: the exact requests (the domain read, one bulk write per record at the zone's TTL with the apex as `""`, the quoted challenge value, and its deletion after the order), a TTL that deSEC raised read again, a name outside the zone refused before any request, a 429 with `Retry-After` and backoff, a wait too long for a run, and the token in no message. [`plugins.test.js`](../../../../service/control/test/unit/plugins.test.js) pins the registration rules, the secret's name and owner included. [`edge.test.js`](../../../../service/control/test/unit/edge.test.js) runs the cron's runs with a stand-in provider: one order a run, a run that starts during another's order and orders nothing, and a lease of 15 minutes that a run deletes only while it is its own. [`media-dns-plugin.test.js`](../../../../ops/test/media-dns-plugin.test.js) pins the variables the Worker gets, the plugin found only through the plugin config, its token checked with one read and stored only as the Worker's secret, and the built-in token scoped to the zone. Nothing calls deSEC, Let's Encrypt, or Cloudflare.
