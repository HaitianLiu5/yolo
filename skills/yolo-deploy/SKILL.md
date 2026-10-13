---
name: yolo-deploy
description: Deploy a new Yolo instance for its owner from a clone of the repository, end to end - Cloudflare login, D1, KV, tunnel and cloudflared, Workers VPC, secrets, migrations with a backup, the Worker, the node as a service, the owner's passkey through the 6-digit code, the first paired screen, a connected agent, and optionally Plex and LAN direct play. Also use it to diagnose an instance with yolo doctor.
---

# Deploy Yolo for its owner

You are setting up Yolo on the owner's home machine, the one that will run the media node. Yolo has two halves: a Cloudflare Worker on the owner's domain (the control plane, with D1, KV, and a Durable Object) and the media node on this machine, which the Worker reaches through a Cloudflare Tunnel and a Workers VPC service. The [agent deployment note](../../.agents/notes/implemented/feature/2026-10-13-agent-deployment.md) explains every piece.

Work from the repository root. Every step is `npm run yolo -- <command>`; add `--json` to parse the result. Each command can be run again: it checks what exists and does only what is missing. Exit code 0 means done, 1 failed (read `fix`), **2 means stop and get the owner's approval**, **3 means stop: a human must act**. Never do a step marked HUMAN or APPROVAL yourself, and never show the owner's secrets (`NODE_SECRET`, the tunnel token, `LAN_DNS_TOKEN`) in your messages.

## Human checkpoints

Tell the owner about these at the start, so nothing surprises them.

| # | Checkpoint | Why it needs the owner |
|---|---|---|
| H1 | **Cloudflare account and plan** | Sign-up and terms are theirs. The free Workers plan is expected to cover Yolo (Workers, SQLite Durable Objects, D1, KV, one cron trigger, Workers Logs; Workers VPC is free while in beta); confirm in the dashboard if they are on another plan. |
| H2 | **Domain** (paid) | A domain whose DNS is on Cloudflare, bought or moved by the owner. Pick the hostname now, for example `yolo.example.com`: passkeys and agent authorizations are bound to it, so moving later means registering them again. |
| H3 | **Cloudflare login** | `npx wrangler login` opens a browser page the owner approves. |
| H4 | **Tunnel token** | Created in the dashboard: wrangler's login has no tunnel permission. |
| H5 | **APPROVAL: the deploy plan** | Creates resources in their account and a DNS record for the hostname. |
| H6 | **macOS prompts** | Local Network and firewall prompts for the node and the browser. |
| H7 | **The owner's passkey** | Face ID, Touch ID, or a phone, with the 6-digit code you give them. |
| H8 | **Pairing a screen** | Scanning a QR code and pressing Allow. |
| H9 | **Connecting an agent** | Approving the agent with the passkey; claude.ai and ChatGPT connectors are added in their apps. |
| H10 | Optional: **Plex token, LAN DNS token** | Their Plex account; a Cloudflare token that can edit every DNS record of the zone. |

Paid actions: the domain (H2), and a ChatGPT plan with custom connectors if they want ChatGPT (H9). Nothing else here is expected to cost money; if a Cloudflare page asks for payment, stop and ask.

## 1. Prerequisites

macOS: `brew install node git ffmpeg yt-dlp deno cloudflared` (Node.js 22.12 or newer). Linux: the same tools from the distribution, with Node.js from nodejs.org or a version manager.

## 2. The deploy checkout

Clone the repository at its newest release; this clone is the instance's **deploy checkout**: the node runs from it, upgrades move it between release tags, and nobody develops in it.

```sh
git clone https://github.com/HaitianLiu5/yolo.git ~/yolo && cd ~/yolo
tag=$(git tag -l 'v*' --sort=-v:refname | head -1); [ -n "$tag" ] && git checkout --detach "$tag"
npm ci
```

## 3. The instance file (H1, H2)

Ask the owner for the hostname, then:

```sh
npm run yolo -- init --domain yolo.example.com
```

This writes `yolo.instance.json` (the domain now, the Cloudflare ids later) and `.env` with a new `NODE_SECRET`. Both are ignored by git and are the instance's identity: ask the owner to keep a copy of both outside this machine, for example in their password manager.

## 4. Sign wrangler in (H3)

Run `npx wrangler login` and ask the owner to approve the page it opens. Check with `npx wrangler whoami`. If they have several accounts, ask which one holds Yolo and run `npm run yolo -- init --account-id <id>`.

A headless agent can use an account API token instead (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment). It needs Workers Scripts, Workers KV Storage, and D1 edit permissions; Workers Routes and DNS edit on the zone (for the custom domain); Cloudflare Tunnel edit; and access to Workers VPC services (the Connectivity Directory roles). When a command fails with an authorization error, wrangler names the missing permission; ask the owner to add it.

## 5. APPROVAL: the plan (H5)

Show the owner what the next steps create, and wait for a yes:

- a D1 database `yolo`, a KV namespace `yolo-control-oauth`, a tunnel `yolo`, and a Workers VPC service `yolo-node` for `127.0.0.1:9191`;
- the Worker `yolo-control` on `https://<hostname>`, which adds a DNS record for the hostname;
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

A new custom domain can take a few minutes to get its certificate: rerun `doctor` until the Worker answers. Then every check should be `ok` except the owner's passkey.

## 9. The owner's passkey (H7)

```sh
npm run owner-code
```

It prints a 6-digit code and the sign-in address. Give both to the owner: they open `https://<hostname>/login` within 15 minutes, enter the code, and create a passkey. If passkeys already exist, a code **replaces all of them**: ask before running it on an instance that is in use. `doctor` then shows the passkey as registered.

## 10. Pair the first screen (H8)

The owner opens `https://<hostname>` on the screen (the Tesla browser, or any browser). It shows a QR code and a short code; they scan it with their phone, sign in with the passkey, check the name and type, and press Allow. The screen appears in `list_devices` over MCP.

## 11. Connect an agent (H9)

Follow [`skills/yolo-connect-agent`](../yolo-connect-agent/SKILL.md).

## 12. Optional: Plex (H10)

- Plex Media Server on this Mac: nothing to do; the node reads the server's token from its preferences.
- Elsewhere: set `PLEX_URL` and `PLEX_TOKEN` in `.env`. The owner finds the token in Plex Web: open any item, **Get Info > View XML**, and copy the `X-Plex-Token` value from the address bar. Then `npm run yolo -- service restart node`.

## 13. Optional: LAN direct play at home (H10)

At home, screens can fetch media straight from the node instead of through Cloudflare ([LAN direct play](../../.agents/notes/implemented/feature/2026-10-12-lan-direct-play.md)). The owner creates a token in the dashboard (**My Profile > API Tokens > Create Custom Token**: Zone > Zone > Read and Zone > DNS > Edit, for the zone of the hostname). Tell them plainly: **this token can change every DNS record in that zone**, and it is stored only as a Worker secret. The owner stores it themselves, so it never passes through you:

```sh
npm run wrangler -- secret put LAN_DNS_TOKEN
```

Within 5 minutes the Worker names the node and gets its certificate; then they turn on "Play over the home network" in each screen's settings and allow the browser's Local Network prompt.

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
| `versions.*` | The Worker and the node run different releases: `skills/yolo-upgrade` |

## Never

- Never edit `service/control/wrangler.jsonc` for an instance: its values go in `yolo.instance.json`.
- Never move the domain, reset passkeys, or change an existing VPC service without the owner's approval.
- Never commit, print, or paste `.env`, `yolo.instance.json`, or `.yolo/`.
