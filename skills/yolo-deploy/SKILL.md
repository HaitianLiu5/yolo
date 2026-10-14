---
name: yolo-deploy
description: Deploy a new Yolo instance for its owner from a clone of the repository, end to end - with a domain or at zero cost on workers.dev, Cloudflare login from any device (cf's device flow), D1, KV, tunnel and cloudflared, Workers VPC, secrets, migrations with a backup, the Worker, the node as a service, the owner's passkey through the 6-digit code, the first paired screen, a connected agent, and optionally Plex, LAN direct play, the media DNS token, or a free deSEC name for direct play without a domain. Also use it to diagnose an instance with yolo doctor, or to move a workers.dev instance to a domain.
---

# Deploy Yolo for its owner

You are setting up Yolo on the owner's home machine, the one that will run the media node. Yolo has two halves: the control plane, a Cloudflare Worker with D1, KV, and a Durable Object, served on the owner's domain or, without one, on the account's workers.dev address; and the media node on this machine, which the Worker reaches through a Cloudflare Tunnel and a Workers VPC service. The [agent deployment note](../../.agents/notes/implemented/feature/2026-10-13-agent-deployment.md) explains every piece.

Work from the repository root. Every step is `npm run yolo -- <command>`; add `--json` to parse the result. Each command can be run again: it checks what exists and does only what is missing. Exit code 0 means done, 1 failed (read `fix`), **2 means stop and get the owner's approval**, **3 means stop: a human must act**. Never do a step marked HUMAN or APPROVAL yourself, and never show the owner's secrets (`NODE_SECRET`, the tunnel token, the Cloudflare API token, `MEDIA_DNS_TOKEN`, `DESEC_TOKEN`) in your messages.

## First question: do you have a domain?

Ask the owner before anything else, and pick the tier with them ([no-domain deployment](../../.agents/notes/implemented/feature/2026-10-13-no-domain-deployment.md)):

| | (a) Zero cost | (b) A cheap domain |
|---|---|---|
| What they need | A Cloudflare account on Workers Free | Also a domain whose DNS is on Cloudflare, about $5–11 a year at Cloudflare Registrar |
| Address | `https://<worker>.<account subdomain>.workers.dev` | `https://<hostname>`, for example `yolo.example.com` |
| Control: sign-in, screens, agents | Everything | Everything |
| Media | No LAN direct play by name; away from home the node's remote listener uses a certificate for the home's public IP ([media off the Worker](../../.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.md)). Optionally, a free deSEC name brings both direct paths by name back (step 13) | LAN direct play in every browser and remote direct play by name: the full experience |
| Risk | Cloudflare may rename workers.dev subdomains; then the owner registers the passkey again with the 6-digit code, reconnects agents, and pairs screens again | The address is the owner's |

With no domain and no wish to buy one, take (a); it can move to (b) later ("Move to a domain" below). Take (b) when they have a domain on Cloudflare or will buy one.

## Human checkpoints

Tell the owner about these at the start, so nothing surprises them.

| # | Checkpoint | Why it needs the owner |
|---|---|---|
| H1 | **Cloudflare account and plan** | Sign-up and terms are theirs. Workers Free covers every binding Yolo uses (Workers, SQLite Durable Objects, D1, KV, rate limits, one cron trigger, Workers Logs; Workers VPC is free while in beta), and one household fits its daily limits, which `doctor` reports (`cloudflare.limits`). Workers Paid ($5 a month) is the advice only if their screens play mostly through the relay or they connect many agents. |
| H2 | **Domain**, tier (b) only (paid) | A domain whose DNS is on Cloudflare, bought or moved by the owner. Pick the hostname now, for example `yolo.example.com`: passkeys and agent authorizations are bound to it, so moving later means registering them again. Tier (a) instead approves registering the account's workers.dev subdomain, if it has none (exit 2 from `init`). |
| H3 | **Cloudflare login** | One page the owner approves on any device, a phone included: `npm run yolo -- auth` gives you the link with the code filled in. |
| H4 | **Tunnel token**, fallback login only | With the token from `auth`, `provision` creates the tunnel itself. Only with wrangler's own login does the owner create it in the dashboard. |
| H5 | **APPROVAL: the deploy plan** | Creates resources in their account, and on tier (b) a DNS record for the hostname. |
| H6 | **macOS prompts** | Local Network and firewall prompts for the node and the browser. |
| H7 | **The owner's passkey** | Face ID, Touch ID, or a phone, with the 6-digit code you give them. |
| H8 | **Pairing a screen** | Scanning a QR code and pressing Allow. |
| H9 | **Connecting an agent** | Approving the agent with the passkey; claude.ai and ChatGPT connectors are added in their apps. |
| H10 | Optional: **Plex token, media DNS token, a deSEC name, remote access, router steps** | Their Plex account; on tier (b), agreeing that `cf` creates a token that can edit the zone's DNS records (after `auth`, no new page); on tier (a), a free deSEC account, name, and token, which only they can create and paste; exposing one port of the home to the internet; a change on their router when it maps no port by itself. |

Paid actions: the domain on tier (b) (H2), and a ChatGPT plan with custom connectors if they want ChatGPT (H9). Nothing else here is expected to cost money; if a Cloudflare page asks for payment, stop and ask.

## 1. Prerequisites

macOS: `brew install node git ffmpeg yt-dlp deno cloudflared` (Node.js 22.12 or newer). Linux: the same tools from the distribution, with Node.js from nodejs.org or a version manager. Then Cloudflare's CLI, which signs in from any device: `npm install -g cf`.

## 2. The deploy checkout

Clone the repository at its newest release; this clone is the instance's **deploy checkout**: the node runs from it, upgrades move it between release tags, and nobody develops in it.

```sh
git clone https://github.com/HaitianLiu5/yolo.git ~/yolo && cd ~/yolo
tag=$(git tag -l 'v*' --sort=-v:refname | head -1); [ -n "$tag" ] && git checkout --detach "$tag"
npm ci
```

## 3. Sign in to Cloudflare (H3)

```sh
npm run yolo -- auth
```

It signs in with `cf`'s device flow, which needs no browser on this machine, and returns at once:

- **Exit 3 with `link` and `code`:** send the owner both, unchanged. The link already carries the code (`https://dash.cloudflare.com/oauth2/device/verify?user_code=<code>`); the code beside it lets them check the page. Tell them it works on any device, a phone included, and expires in 5 minutes: they open it, sign in to Cloudflare, and approve, which lets `cf` create one API token for Yolo in their account. Wait for their answer, then run `npm run yolo -- auth` again. A run before they approve returns the same link; after 5 minutes it makes a new one.
- **Exit 3, several accounts:** ask which one holds Yolo, then `npm run yolo -- auth --account-id <id>`.
- **Exit 1, `cf` is not installed:** `npm install -g cf`, then run it again.
- **Exit 0:** wrangler now uses the account API token "Yolo operator" from `.yolo/cloudflare-token.json` (mode 600) for every later step, and no step needs `wrangler login`. The token holds only what the commands do, on the owner's account and, on tier (b), on the domain's zone; the [agent deployment note](../../.agents/notes/implemented/feature/2026-10-13-agent-deployment.md#signing-in-to-cloudflare) lists each permission and why.

Only if `cf` cannot run here: `npx wrangler login --device` prints a page and a code the same way. Run it in the background, send the owner the page with `?user_code=<code>` added and the code beside it, and wait until it finishes. `npx wrangler login` without `--device` works only when the owner's browser is on this machine. With wrangler's own login, step 6 stops for the tunnel (H4). An owner who prefers a token of their own sets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` with the same permissions; it wins over the stored token.

## 4. The instance file (H1, H2)

Tier (b), with the hostname the owner chose:

```sh
npm run yolo -- init --domain yolo.example.com
```

Tier (a), no domain:

```sh
npm run yolo -- init
```

Without `--domain`, `init` reads the account's workers.dev subdomain and gives the Worker a name that says nothing about the owner (`yolo-` and six random characters). The address is `https://<worker>.<subdomain>.workers.dev`, and `init` prints it. Then:

- **Exit 2, no subdomain yet:** registering one is an APPROVAL. The name is public for good and every Worker in the account is served under it. Suggest the neutral name `init` offers, or one the owner picks that names no person, and after their yes run the `approve` command (`npm run yolo -- init --workers-subdomain <name>`).
- **A warning that the subdomain looks made from their email or name:** tell the owner. Before the first deploy they may rename it in the dashboard (Workers & Pages, the account's subdomain) and run `init` again; after the first deploy a rename moves the address.

`init` uses the account that `auth` chose. On tier (b), run `npm run yolo -- auth` once more after `init`: it adds the domain's zone to the same token, with no new page for the owner. Either way, `init` writes `yolo.instance.json` (the address now, the Cloudflare ids later) and `.env` with a new `NODE_SECRET`. Both are ignored by git and are the instance's identity: ask the owner to keep a copy of both outside this machine, for example in their password manager.

## 5. APPROVAL: the plan (H5)

Show the owner what the next steps create, and wait for a yes:

- a D1 database `yolo`, a KV namespace `<worker>-oauth`, a tunnel `yolo`, and a Workers VPC service `yolo-node` for `127.0.0.1:9191`;
- the Worker (`yolo-control`, or the name `init` chose) on `https://<hostname>`, which adds a DNS record for the hostname, or on tier (a) on its workers.dev address;
- two login services on this machine, `app.useyolo.node` and `app.useyolo.cloudflared`.

## 6. Cloudflare resources (H4)

```sh
npm run yolo -- provision
```

It finds or creates D1, KV, the tunnel (its token goes to `.yolo/tunnel-token`, mode 600), and the Workers VPC service. Only with wrangler's own login, the fallback in step 3, does it stop at the tunnel (exit 3) with this human step: in the Cloudflare dashboard, **Workers VPC > Tunnels > Create**, name it `yolo`, skip the install commands, and copy only the token (the long text after `--token`) into a file. Then:

```sh
npm run yolo -- provision tunnel --token-file <file>    # stores it in .yolo/tunnel-token, mode 600
rm <file>
npm run yolo -- provision                               # the VPC service
```

## 7. Start cloudflared and the node (H6)

```sh
npm run yolo -- service install          # both, as login services; idempotent
npm run yolo -- doctor --offline
```

On macOS, tell the owner to allow any Local Network or firewall prompt. `doctor` must show the node healthy and cloudflared connected; Workers VPC needs outbound UDP port 7844. Services start when the owner logs in; for a Mac that should serve Yolo without anyone logged in, see "LaunchDaemon" in the [agent deployment note](../../.agents/notes/implemented/feature/2026-10-13-agent-deployment.md#the-node-and-cloudflared-as-services). On Linux, `loginctl enable-linger $USER` (run by the owner) keeps the user services running after logout.

## 8. Migrate and deploy

```sh
npm run yolo -- migrate     # backs up D1 first (nothing to back up on a new database)
npm run yolo -- deploy      # builds, uploads NODE_SECRET from .env, waits for the Worker
npm run yolo -- doctor
```

A new custom domain can take a few minutes to get its certificate, and a Worker's first workers.dev address a few minutes to answer: rerun `doctor` until the Worker answers. Then every check should be `ok` except the owner's passkey, and on tier (a) `config.workersdev`, which always warns about renames.

`deploy` ends with a `media` step that names the media paths that work: remote direct play, as the Worker's check from outside found it, and the relay through the tunnel, which is automatic. Tell the owner which one their screens will use. When remote direct play is not reachable yet (on a new instance it is off until step 13), the step's `fix` is the router step; give it to the owner with step 13's router notes, and carry on: it never blocks the deploy, because the relay carries every screen's media until a direct path works.

## 9. The owner's passkey (H7)

```sh
npm run owner-code
```

It prints a 6-digit code and the sign-in address. Give both to the owner: they open `https://<address>/login` within 15 minutes, enter the code, and create a passkey. If passkeys already exist, a code **replaces all of them**: ask before running it on an instance that is in use. `doctor` then shows the passkey as registered.

## 10. Pair the first screen (H8)

The owner opens `https://<address>` on the screen (the Tesla browser, or any browser). It shows a QR code and a short code; they scan it with their phone, sign in with the passkey, check the name and type, and press Allow. The screen appears in `list_devices` over MCP.

## 11. Connect an agent (H9)

Follow [`skills/yolo-connect-agent`](../yolo-connect-agent/SKILL.md).

## 12. Optional: Plex (H10)

- Plex Media Server on this Mac: nothing to do; the node reads the server's token from its preferences.
- Elsewhere: set `PLEX_URL` and `PLEX_TOKEN` in `.env`. The owner finds the token in Plex Web: open any item, **Get Info > View XML**, and copy the `X-Plex-Token` value from the address bar. Then `npm run yolo -- service restart node`.

## 13. Optional: direct play at home and away (H10)

Screens play straight from the node where a direct path works, at home over the LAN and away through a router port, and through the relay in the owner's own Cloudflare account wherever none does, so every screen plays from the first deploy. Direct paths are worth setting up: they are faster, carry up to the home upload's rate instead of the relay's 4.8 Mbps, and spend no Cloudflare bandwidth ([media off the Worker](../../.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.md), [LAN direct play](../../.agents/notes/implemented/feature/2026-10-12-lan-direct-play.md)). On tier (a) there is no zone, so there are no media names and no token: skip to **Away from home**, where the node gets a certificate for the home's public address itself ([media without a domain](../../.agents/notes/implemented/feature/2026-10-13-no-domain-deployment.md#media-without-a-domain)), unless the owner wants the free deSEC name below.

**The media DNS token, tier (b) only.** Both direct paths by name need `MEDIA_DNS_TOKEN`. Tell the owner plainly: **this token can change every DNS record in the zone**. `provision media-dns` creates it with Cloudflare's CLI, `cf`, as an account token with DNS Write and Zone Read on that zone only, and stores it as a Worker secret without showing it to anyone. Run it after the first deploy:

```sh
npm run yolo -- provision media-dns
```

- **Exit 3, `cf`'s `yolo` profile is not signed in or lacks a scope:** run `npm run yolo -- auth` and handle it as in step 3, then run the step again. After step 3 this does not happen: the same login covers this token.
- **Exit 3 because `cf` is not installed:** `npm install -g cf` and run the step again, or use the fallback it prints: a dashboard page pre-filled with DNS edit and Zone read on their account and zone. The owner creates the token there and runs `npm run wrangler -- secret put MEDIA_DNS_TOKEN` to paste it themselves, so it never passes through you.
- Run again, the step keeps the secret that exists; `--rotate` gives the token a new value.

Within 5 minutes the Worker names the node and gets its certificate; then they turn on "Play over the home network" in each screen's settings and allow the browser's Local Network prompt.

**A free name instead of a domain, tier (a) only (optional).** A free `<name>.dedyn.io` from deSEC (desec.io) gives a tier (a) instance the media names a domain gives: LAN direct play in every browser, and remote direct play by name with no port 80 on the router ([DNS provider plugins](../../.agents/notes/implemented/architecture/2026-10-14-dns-provider-plugins.md)). The control plane stays on workers.dev. Tell the owner plainly before they choose it: **deSEC becomes a service their direct play depends on** (each certificate renewal and each new home address goes through deSEC's API); **the deSEC token can change every record in their deSEC account**; the name's records publish the node's private address and the home's public address; and a domain at Cloudflare stays the recommended path. With their yes, after the first deploy:

```sh
npm run yolo -- provision media-dns --provider desec --zone <name>.dedyn.io
```

- The step records `media.dns` in `yolo.instance.json` and, on an instance that loads the official plugin list, writes `yolo.config.json` with the official plugins and `./plugins/dns-desec` (the node loads the same plugins as before). With an owner's own `yolo.config.json` it stops and names the entry to add there.
- **Exit 3 with three numbered steps:** relay them to the owner as printed. HUMAN: they sign up at desec.io with a free `dedyn.io` name, create a token in deSEC's Token Management, and run `npm run yolo -- provision media-dns --token-stdin` **in their own terminal**, pasting the token there (nothing is shown as they type). Never ask them to paste the token into the conversation, and never run the `--token-stdin` command yourself. If they have not picked a name yet, run the step with `--provider desec` alone: it prints the same steps, and you rerun it with `--zone` once they tell you the name, which is not a secret.
- **Their run ends with "deSEC accepts the token":** the token is now the Worker secret `DESEC_TOKEN`. Run `npm run yolo -- deploy`, which bundles the deSEC plugin and passes the name to the Worker, then `npm run yolo -- doctor`: `config.media-dns`, `cloudflare.media-dns`, `dns.delegation`, and, after the next cron run, `worker.media-dns` should be `ok`. Only the Worker's cron run orders a deSEC certificate, one per run and about 4 minutes each, because the Worker gives deSEC's nameservers time to agree before Let's Encrypt checks: the LAN name gets its certificate within about 10 minutes of the deploy and the remote name 5 minutes later. Until then "Check now" in settings shows the name or the certificate as pending, because only the cron run names the node and orders its certificates; that is expected.
- **Exit 1 "rejected the token" or "has no domain":** the owner copies the token again or checks the name, and runs their command again. `--rotate --token-stdin` replaces a stored token.
- Then everything about LAN direct play above applies, and **Away from home** below works as on tier (b): the remote name, not the address, and no port 80. Owners whose router filters private answers (DNS rebinding protection) allowlist `<name>.dedyn.io`. To keep the remote listener on the home's address instead, set `"media": { "wan": { "certificate": "ip" } }` in `yolo.instance.json` and deploy.

**Away from home (remote direct play).** Explain first: the node then accepts connections from the internet on one port, which serves only token-authorized media, and a DNS record publishes the home's public address. With the owner's yes, they turn on **Remote direct play** in Settings > Media paths. The node asks the router for the port mapping itself (PCP, NAT-PMP, or UPnP IGD; never do this yourself on their router), and within a minute or so the card says "Ready: reachable from outside the home". If it says the router made no port mapping, the owner either turns on UPnP in the router's settings (the node then maps the port by itself within 5 minutes), or reserves the node's address in the router's DHCP settings, forwards TCP port 9444 to it, and sets `WAN_MAPPING=manual` in `.env` (then `npm run yolo -- service restart node`). The card, `doctor`, and a screen that cannot play name the port, the node's address, and the router's address. If it says carrier-grade NAT, remote direct play cannot work on that internet connection, and the relay carries those screens.

Router notes:

- **Xfinity (Comcast) gateways** answer neither PCP nor NAT-PMP, and ship with UPnP off. Either turn UPnP on in the gateway's admin tool at `http://10.0.0.1` (sign in, then Advanced > Device Discovery), or add the forward in the Xfinity app (WiFi > View WiFi equipment > Advanced settings > Port forwarding: choose the node's computer, TCP port 9444) and set `WAN_MAPPING=manual`. The node's computer appears there by name once it has a reserved address.
- A router behind another router (an ISP gateway in front of the owner's own router) is double NAT: forward the port on both, or put the ISP gateway in bridge mode.

On tier (a) without a deSEC name no DNS record is made: the origin is `https://<public address>:9444`, and Certificate Transparency logs publish the address. For each certificate, about twice a week, the node also asks the router for its port 80 while the CA checks it. If the card says the router would not map port 80, the owner makes one forward, either TCP port 80 to the node's port 9480 with `WAN_CHALLENGE_MAPPING=manual`, or, where the router maps nothing at all, TCP port 443 to the node's port 9444 with `WAN_EXTERNAL_PORT=443` and `WAN_MAPPING=manual`, which then carries the check and the media (then `npm run yolo -- service restart node`). At home, a screen plays from that address only if the router loops back to it; each screen's settings say whether it does, and otherwise it uses the relay.

**The relay.** It is automatic on every instance: a screen uses it only when no direct path works for it, and the next stream takes a direct path once one works. Settings > Media paths sets it to Automatic, On, or Off and shows the path each screen used last. With Off, a screen that no direct path reaches cannot play; it then shows why, with a button that sets the relay back to Automatic, and `doctor` fails `worker.relay` when no direct path works at all.

**Check a media path before you finish.** Run `npm run yolo -- doctor` once more and tell the owner which media path works: `worker.remote` `ok` means remote direct play is reachable from outside the home; otherwise `worker.relay` shows the relay carrying screens away from home, and the router notes above are the owner's next step whenever they want direct play. Neither blocks the deploy.

## Diagnose

`npm run yolo -- doctor --json` lists every check with its `fix`. Work through the failures from the top: later checks often fail because of an earlier one.

| Failing check | Usual cause |
|---|---|
| `node.health` | The node is stopped or crashed: `npm run yolo -- service logs node` |
| `tunnel.connected` | cloudflared is stopped, or UDP 7844 is blocked |
| `cloudflare.auth` | Wrangler has no credential or cannot see the account: step 3 |
| `cloudflare.credential` | Which credential wrangler acts with: the token from `auth`, an exported `CLOUDFLARE_API_TOKEN`, or wrangler's own login (info; `auth` replaces it) |
| `cloudflare.can.*` | Whether that credential can do each operation; a failure names what is missing, and `npm run yolo -- auth` usually fixes it with no new page |
| `cloudflare.vpc` | The VPC service points at another tunnel or port; the fix prints the update command, which changes a live path: ask first |
| `worker.reachable` | Not deployed yet, or the certificate is still being issued |
| `worker.secret` | The Worker's `NODE_SECRET` differs from `.env`: `npm run yolo -- deploy` |
| `worker.node` | The Worker cannot reach the node: check the three above |
| `node.wan`, `worker.remote` | Remote direct play: no router mapping (forward the port, `WAN_MAPPING=manual`), carrier-grade NAT, or the port is not reachable from outside |
| `worker.relay` | Information while the relay is automatic or on, with the relay streams of the last 7 days. It fails only when the relay is off and no direct path works: the owner sets it to Automatic in Settings > Media paths, or makes remote direct play reachable (the router step in its `fix`) |
| `versions.*` | The Worker and the node run different releases: `skills/yolo-upgrade` |
| `config.workersdev` (warn) | Expected on tier (a): Cloudflare may rename workers.dev subdomains. A domain removes the risk ("Move to a domain") |
| `cloudflare.workersdev` | The account's workers.dev subdomain was renamed, so the address moved: "Move to a domain" below, or the same steps with `npm run yolo -- init --change-domain` to stay on workers.dev |
| `cloudflare.media-dns` (info) | Tier (b) without the DNS token: `npm run yolo -- provision media-dns`. With a deSEC name (warn): the Worker has no `DESEC_TOKEN`; the owner runs `npm run yolo -- provision media-dns --token-stdin` in their own terminal |
| `config.media-dns` | `media.dns.provider` names a provider no plugin in the plugin config provides: `npm run yolo -- provision media-dns --provider desec` lists it, or, with the owner's own `yolo.config.json`, add `{ "source": "./plugins/dns-desec" }` there; then deploy |
| `dns.delegation` | Public DNS has no deSEC nameservers for the name: a typo in `media.dns.zone`, or a name not registered at deSEC |
| `worker.media-dns` | The Worker's view of the deSEC name: deployed before `media.dns` was set (deploy), or deSEC's error, such as a rejected token (`--rotate --token-stdin`) or its rate limit, which the next run retries |
| `cloudflare.limits` | The account's busiest day against Workers Free's daily limits. On Workers Paid, ignore it; on Free, a warning means the owner may want Paid ($5 a month), or a look at what writes so much |
| `worker.isolation` | The player page lacks COOP or COEP, and the car's player cannot start: `npm run yolo -- deploy` |

## Move to a domain

A tier (a) instance moves to a domain, or follows a renamed workers.dev subdomain, with the owner's approval, because the move costs them the steps below ([moving the address](../../.agents/notes/implemented/feature/2026-10-13-no-domain-deployment.md#moving-the-address)):

1. The owner buys a domain on Cloudflare Registrar, or moves one's DNS to Cloudflare in the instance's account (H2).
2. APPROVAL: `npm run yolo -- init --domain <hostname>` stops with exit 2; after their yes, run the `approve` command (`… --change-domain`). The Worker, D1, and KV stay.
3. `npm run yolo -- deploy`, then `npm run yolo -- doctor` until the new address answers. The rendered config turns workers.dev off.
4. The owner's passkey is bound to the old host: `npm run owner-code`, and they register a new one at `https://<hostname>/login` (H7). A code registration replaces every passkey.
5. Each agent connects again with the new address (`skills/yolo-connect-agent`), and each screen opens the new address and pairs again (H8, H9).
6. Optionally, step 13's media DNS token. An instance with a deSEC name moves its media names to the domain's zone with `npm run yolo -- provision media-dns --provider cloudflare`, then the token and a deploy; the records at deSEC stay until the owner deletes them there.

## Never

- Never edit `service/control/wrangler.jsonc` for an instance: its values go in `yolo.instance.json`.
- Never move the address (the domain, the Worker's name, or the workers.dev subdomain), register a workers.dev subdomain, reset passkeys, or change an existing VPC service without the owner's approval.
- Never commit, print, or paste `.env`, `yolo.instance.json`, or `.yolo/`.
