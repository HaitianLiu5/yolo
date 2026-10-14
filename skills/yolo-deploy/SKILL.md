---
name: yolo-deploy
description: Deploy a new Yolo instance for its owner from a clone of the repository, end to end - with a domain or at zero cost on workers.dev, Cloudflare login, D1, KV, tunnel and cloudflared, Workers VPC, secrets, migrations with a backup, the Worker, the node as a service, the owner's passkey through the 6-digit code, the first paired screen, a connected agent, and optionally Plex, LAN direct play, and the media DNS token. Also use it to diagnose an instance with yolo doctor, or to move a workers.dev instance to a domain.
---

# Deploy Yolo for its owner

You are setting up Yolo on the owner's home machine, the one that will run the media node. Yolo has two halves: the control plane, a Cloudflare Worker with D1, KV, and a Durable Object, served on the owner's domain or, without one, on the account's workers.dev address; and the media node on this machine, which the Worker reaches through a Cloudflare Tunnel and a Workers VPC service. The [agent deployment note](../../.agents/notes/implemented/feature/2026-10-13-agent-deployment.md) explains every piece.

Work from the repository root. Every step is `npm run yolo -- <command>`; add `--json` to parse the result. Each command can be run again: it checks what exists and does only what is missing. Exit code 0 means done, 1 failed (read `fix`), **2 means stop and get the owner's approval**, **3 means stop: a human must act**. Never do a step marked HUMAN or APPROVAL yourself, and never show the owner's secrets (`NODE_SECRET`, the tunnel token, `MEDIA_DNS_TOKEN`) in your messages.

## First question: do you have a domain?

Ask the owner before anything else, and pick the tier with them ([no-domain deployment](../../.agents/notes/implemented/feature/2026-10-13-no-domain-deployment.md)):

| | (a) Zero cost | (b) A cheap domain |
|---|---|---|
| What they need | A Cloudflare account on Workers Free | Also a domain whose DNS is on Cloudflare, about $5–11 a year at Cloudflare Registrar |
| Address | `https://<worker>.<account subdomain>.workers.dev` | `https://<hostname>`, for example `yolo.example.com` |
| Control: sign-in, screens, agents | Everything | Everything |
| Media | No LAN direct play by name; away from home the node's remote listener uses a certificate for the home's public IP ([media off the Worker](../../.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.md)) | LAN direct play in every browser and remote direct play by name: the full experience |
| Risk | Cloudflare may rename workers.dev subdomains; then the owner registers the passkey again with the 6-digit code, reconnects agents, and pairs screens again | The address is the owner's |

With no domain and no wish to buy one, take (a); it can move to (b) later ("Move to a domain" below). Take (b) when they have a domain on Cloudflare or will buy one.

## Human checkpoints

Tell the owner about these at the start, so nothing surprises them.

| # | Checkpoint | Why it needs the owner |
|---|---|---|
| H1 | **Cloudflare account and plan** | Sign-up and terms are theirs. Workers Free covers every binding Yolo uses (Workers, SQLite Durable Objects, D1, KV, rate limits, one cron trigger, Workers Logs; Workers VPC is free while in beta), and one household fits its daily limits, which `doctor` reports (`cloudflare.limits`). Workers Paid ($5 a month) is the advice only if they turn the relay on or connect many agents. |
| H2 | **Domain**, tier (b) only (paid) | A domain whose DNS is on Cloudflare, bought or moved by the owner. Pick the hostname now, for example `yolo.example.com`: passkeys and agent authorizations are bound to it, so moving later means registering them again. Tier (a) instead approves registering the account's workers.dev subdomain, if it has none (exit 2 from `init`). |
| H3 | **Cloudflare login** | `npx wrangler login` opens a browser page the owner approves. |
| H4 | **Tunnel token** | Created in the dashboard: wrangler's login has no tunnel permission. |
| H5 | **APPROVAL: the deploy plan** | Creates resources in their account, and on tier (b) a DNS record for the hostname. |
| H6 | **macOS prompts** | Local Network and firewall prompts for the node and the browser. |
| H7 | **The owner's passkey** | Face ID, Touch ID, or a phone, with the 6-digit code you give them. |
| H8 | **Pairing a screen** | Scanning a QR code and pressing Allow. |
| H9 | **Connecting an agent** | Approving the agent with the passkey; claude.ai and ChatGPT connectors are added in their apps. |
| H10 | Optional: **Plex token, media DNS token, remote access, the relay** | Their Plex account; on tier (b), one browser consent that lets `cf` create a token that can edit the zone's DNS records; exposing one port of the home to the internet; accepting the relay's risk under Cloudflare's terms. |

Paid actions: the domain on tier (b) (H2), and a ChatGPT plan with custom connectors if they want ChatGPT (H9). Nothing else here is expected to cost money; if a Cloudflare page asks for payment, stop and ask.

## 1. Prerequisites

macOS: `brew install node git ffmpeg yt-dlp deno cloudflared` (Node.js 22.12 or newer). Linux: the same tools from the distribution, with Node.js from nodejs.org or a version manager.

## 2. The deploy checkout

Clone the repository at its newest release; this clone is the instance's **deploy checkout**: the node runs from it, upgrades move it between release tags, and nobody develops in it.

```sh
git clone https://github.com/HaitianLiu5/yolo.git ~/yolo && cd ~/yolo
tag=$(git tag -l 'v*' --sort=-v:refname | head -1); [ -n "$tag" ] && git checkout --detach "$tag"
npm ci
```

## 3. Sign wrangler in (H3)

Run `npx wrangler login` and ask the owner to approve the page it opens. Check with `npx wrangler whoami`. If they have several accounts, ask which one holds Yolo; step 4 takes it as `--account-id <id>`.

A headless agent can use an account API token instead (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment). It needs Workers Scripts, Workers KV Storage, and D1 edit permissions; on tier (b), Workers Routes and DNS edit on the zone (for the custom domain); Cloudflare Tunnel edit; and access to Workers VPC services (the Connectivity Directory roles). When a command fails with an authorization error, wrangler names the missing permission; ask the owner to add it.

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

Add `--account-id <id>` when wrangler sees several accounts. Either way, `init` writes `yolo.instance.json` (the address now, the Cloudflare ids later) and `.env` with a new `NODE_SECRET`. Both are ignored by git and are the instance's identity: ask the owner to keep a copy of both outside this machine, for example in their password manager.

## 5. APPROVAL: the plan (H5)

Show the owner what the next steps create, and wait for a yes:

- a D1 database `yolo`, a KV namespace `<worker>-oauth`, a tunnel `yolo`, and a Workers VPC service `yolo-node` for `127.0.0.1:9191`;
- the Worker (`yolo-control`, or the name `init` chose) on `https://<hostname>`, which adds a DNS record for the hostname, or on tier (a) on its workers.dev address;
- two login services on this machine, `app.useyolo.node` and `app.useyolo.cloudflared`.

## 6. Cloudflare resources (H4)

```sh
npm run yolo -- provision
```

It finds or creates D1 and KV, then stops at the tunnel (exit 3) with this human step: in the Cloudflare dashboard, **Workers VPC > Tunnels > Create**, name it `yolo`, skip the install commands, and copy only the token (the long text after `--token`) into a file. Then:

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

On a new instance the Worker relays no media: screens play straight from the node, at home over the LAN and away through a router port, and otherwise not at all until the owner turns the relay on ([media off the Worker](../../.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.md), [LAN direct play](../../.agents/notes/implemented/feature/2026-10-12-lan-direct-play.md)). On tier (a) there is no zone, so there are no media names and no token: skip to **Away from home**, where the node gets a certificate for the home's public address itself ([media without a domain](../../.agents/notes/implemented/feature/2026-10-13-no-domain-deployment.md#media-without-a-domain)).

**The media DNS token, tier (b) only.** Both direct paths by name need `MEDIA_DNS_TOKEN`. Tell the owner plainly: **this token can change every DNS record in the zone**. `provision media-dns` creates it with Cloudflare's CLI, `cf`, as an account token with DNS Write and Zone Read on that zone only, and stores it as a Worker secret without showing it to anyone. Run it after the first deploy:

```sh
npm run yolo -- provision media-dns
```

- **Exit 3, asking for `cf auth create yolo --scopes account-api-tokens.write dns.write zone.read`:** HUMAN. The owner runs it and approves the one browser page it opens. It signs in a separate `cf` profile, `yolo`, with only those scopes, and leaves the owner's own `cf` login as it is. Then run the step again.
- **Exit 3 because `cf` is not installed:** `npm install -g cf` and run the step again, or use the fallback it prints: a dashboard page pre-filled with DNS edit and Zone read on their account and zone. The owner creates the token there and runs `npm run wrangler -- secret put MEDIA_DNS_TOKEN` to paste it themselves, so it never passes through you.
- Run again, the step keeps the secret that exists; `--rotate` gives the token a new value.

Within 5 minutes the Worker names the node and gets its certificate; then they turn on "Play over the home network" in each screen's settings and allow the browser's Local Network prompt.

**Away from home (remote direct play).** Explain first: the node then accepts connections from the internet on one port, which serves only token-authorized media, and a DNS record publishes the home's public address. With the owner's yes, they turn on **Remote direct play** in Settings > Media paths. The node asks the router for the port mapping itself (PCP, NAT-PMP, or UPnP IGD; never do this yourself on their router), and within a minute or so the card says "Ready: reachable from outside the home". If it says the router made no port mapping, the owner reserves the node's address in the router's DHCP settings, forwards TCP port 9444 to it, and sets `WAN_MAPPING=manual` in `.env` (then `npm run yolo -- service restart node`). If it says carrier-grade NAT, remote direct play cannot work on that internet connection.

On tier (a) no DNS record is made: the origin is `https://<public address>:9444`, and Certificate Transparency logs publish the address. For each certificate, about twice a week, the node also asks the router for its port 80 while the CA checks it. If the card says the router would not map port 80, the owner makes one forward, either TCP port 80 to the node's port 9480 with `WAN_CHALLENGE_MAPPING=manual`, or, where the router maps nothing at all, TCP port 443 to the node's port 9444 with `WAN_EXTERNAL_PORT=443` and `WAN_MAPPING=manual`, which then carries the check and the media (then `npm run yolo -- service restart node`). At home, a screen plays from that address only if the router loops back to it; each screen's settings say whether it does, and otherwise it uses the relay if the owner turns it on.

**The relay.** Only if the owner asks for it after reading the warning in Settings > Media paths: they turn it on there themselves. It is likely outside Cloudflare's terms on Free, Pro, and Business zones.

## Diagnose

`npm run yolo -- doctor --json` lists every check with its `fix`. Work through the failures from the top: later checks often fail because of an earlier one.

| Failing check | Usual cause |
|---|---|
| `node.health` | The node is stopped or crashed: `npm run yolo -- service logs node` |
| `tunnel.connected` | cloudflared is stopped, or UDP 7844 is blocked |
| `cloudflare.vpc` | The VPC service points at another tunnel or port; the fix prints the update command, which changes a live path: ask first |
| `worker.reachable` | Not deployed yet, or the certificate is still being issued |
| `worker.secret` | The Worker's `NODE_SECRET` differs from `.env`: `npm run yolo -- deploy` |
| `worker.node` | The Worker cannot reach the node: check the three above |
| `node.wan`, `worker.remote` | Remote direct play: no router mapping (forward the port, `WAN_MAPPING=manual`), carrier-grade NAT, or the port is not reachable from outside |
| `worker.relay` (warn) | The media relay is on; once `worker.remote` is ok, the owner turns it off in Settings > Media paths |
| `versions.*` | The Worker and the node run different releases: `skills/yolo-upgrade` |
| `config.workersdev` (warn) | Expected on tier (a): Cloudflare may rename workers.dev subdomains. A domain removes the risk ("Move to a domain") |
| `cloudflare.workersdev` | The account's workers.dev subdomain was renamed, so the address moved: "Move to a domain" below, or the same steps with `npm run yolo -- init --change-domain` to stay on workers.dev |
| `cloudflare.media-dns` (info) | Tier (b) without the DNS token: `npm run yolo -- provision media-dns` |
| `cloudflare.limits` | The account's busiest day against Workers Free's daily limits. On Workers Paid, ignore it; on Free, a warning means the owner may want Paid ($5 a month), or a look at what writes so much |
| `worker.isolation` | The player page lacks COOP or COEP, and the car's player cannot start: `npm run yolo -- deploy` |

## Move to a domain

A tier (a) instance moves to a domain, or follows a renamed workers.dev subdomain, with the owner's approval, because the move costs them the steps below ([moving the address](../../.agents/notes/implemented/feature/2026-10-13-no-domain-deployment.md#moving-the-address)):

1. The owner buys a domain on Cloudflare Registrar, or moves one's DNS to Cloudflare in the instance's account (H2).
2. APPROVAL: `npm run yolo -- init --domain <hostname>` stops with exit 2; after their yes, run the `approve` command (`… --change-domain`). The Worker, D1, and KV stay.
3. `npm run yolo -- deploy`, then `npm run yolo -- doctor` until the new address answers. The rendered config turns workers.dev off.
4. The owner's passkey is bound to the old host: `npm run owner-code`, and they register a new one at `https://<hostname>/login` (H7). A code registration replaces every passkey.
5. Each agent connects again with the new address (`skills/yolo-connect-agent`), and each screen opens the new address and pairs again (H8, H9).
6. Optionally, step 13's media DNS token.

## Never

- Never edit `service/control/wrangler.jsonc` for an instance: its values go in `yolo.instance.json`.
- Never move the address (the domain, the Worker's name, or the workers.dev subdomain), register a workers.dev subdomain, reset passkeys, or change an existing VPC service without the owner's approval.
- Never commit, print, or paste `.env`, `yolo.instance.json`, or `.yolo/`.
