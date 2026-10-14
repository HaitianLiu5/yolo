# Agent Note: Agents deploy and upgrade an instance for its owner

Status: implemented

English | [中文](2026-10-13-agent-deployment.zh.md)

## Problem

Yolo was deployed by hand for one owner. The tracked `service/control/wrangler.jsonc` was that owner's instance (domain, D1, KV, and VPC ids), so anyone else had to edit a tracked file that changed in most commits. Nothing said how to create the tunnel or run the node at boot, nothing reported the state of a deployment in one place, and there was no upgrade or rollback procedure. Owners are expected to have an agent do this work, for example a friend's agent in a fresh clone, so the repository has to carry the scripts, the skills, and the stopping points for the owner.

## Decision

### The instance file

An instance's identity is an ignored `yolo.instance.json` at the checkout root (or the file `YOLO_INSTANCE` names), plus `NODE_SECRET` in the node's `.env`. [`yolo.instance.example.json`](../../../../yolo.instance.example.json) shows every field:

| Field | Meaning |
|---|---|
| `domain`, `workersDev`, `host` | Where Yolo is served: a custom domain, or with `workersDev` and a `null` domain the account's workers.dev host ([no-domain deployment](2026-10-13-no-domain-deployment.md)); `PUBLIC_ORIGIN` is `https://<host>` unless `publicOrigin` says otherwise |
| `accountId`, `worker` | The Cloudflare account and the Worker's name (`yolo-control`) |
| `d1`, `kv` | The D1 database (`name`, `id`) and the OAuth KV namespace (`title`, `id`) |
| `tunnel`, `vpc` | The tunnel (`name`, `id`, cloudflared's `metrics` address) and the Workers VPC service (`name`, `serviceId`) |
| `node.port`, `transport` | The node's port (9191) and the control plane's path to it (`vpc`, or `tunnel` with `nodePublicOrigin`) |
| `services` | The service labels: `app.useyolo.node` and `app.useyolo.cloudflared` unless set |
| `media.wan.certificate` | How the node's remote listener is certified: `name` with a domain, `ip` without one |

`service/control/wrangler.jsonc` is the template every instance shares: no route, workers.dev and preview URLs off, an empty `PUBLIC_ORIGIN`, placeholder D1 and KV ids, and no VPC binding, which is enough for `npm run build`, `npm run dev:control`, and the local D1. [`ops/lib/wrangler-config.js`](../../../../ops/lib/wrangler-config.js) renders the template plus the instance into the ignored `service/control/wrangler.instance.jsonc`. `npm run wrangler -- …` runs wrangler with that file, the control plane's build uses it once the instance is complete, and every deploy uses it. The end-to-end tests render their local config from the same template. Next to the instance file, the ignored `.yolo/` holds `deployments.jsonl` (each deploy, migration, upgrade, and rollback), D1 backups, the tunnel token, and the Cloudflare API token of `auth` (both mode 600).

### The operator's command line

`npm run yolo -- <command>` ([`ops/yolo.js`](../../../../ops/yolo.js)) sets up, checks, and changes one instance from its checkout. Every command prints one result, as JSON with `--json`, whose `steps` or `checks` each carry a `status`, a `message`, and a `fix`. Exit code 0 means done, 1 failed, 2 that the owner must approve (`approve` holds the command to run after), 3 that a human must act. Commands are idempotent: run again, they verify what exists and do only what is missing.

| Command | What it does |
|---|---|
| `auth [--account-id <id>] [--rotate] [--wait]` | Signs in to Cloudflare from any device and gives wrangler an account API token ([signing in to Cloudflare](#signing-in-to-cloudflare)). Without `--wait` it returns the approval link at once (exit 3); run again after the approval, it creates the token, or updates the stored one to what the instance needs; `--rotate` rolls its value |
| `init [--domain <host>]` | Writes the instance file and `.env` with a new `NODE_SECRET`; never replaces a secret. Without `--domain` the instance is served on the account's workers.dev subdomain, which `init` reads (registering one needs the owner's approval and `--workers-subdomain`). Moving the address, to another domain, to or from workers.dev, or after a rename, needs `--change-domain`. `--import-wrangler` reads an older wrangler config |
| `provision [d1\|kv\|tunnel\|vpc\|media-dns]` | Verifies a recorded id, reuses a resource with the instance's name, or creates it, and records the id. `media-dns`, run only when named, creates the DNS token for direct play by name with `cf` and stores it as the Worker secret `MEDIA_DNS_TOKEN` ([no-domain deployment](2026-10-13-no-domain-deployment.md#the-media-dns-token-on-the-domain-tier-only)). An existing VPC service is never changed, only reported with the `wrangler vpc service update` command, which replaces the whole service (name, type, tunnel, address, and port) and so can also move it to another tunnel |
| `service install\|restart\|status\|logs\|uninstall` | The node and cloudflared as services |
| `migrate` | Exports D1 and records a Time Travel bookmark, then applies the pending migrations |
| `deploy` | Refuses to run ahead of D1's migrations, builds, deploys with `NODE_SECRET` from `.env` as a secrets file and the release as the version tag, and waits for the Worker to report the version |
| `doctor [--offline]` | The single status, below |
| `upgrade`, `rollback` | [Versions and releases](../process/2026-10-13-versions-and-releases.md) |
| `image-links reset` | Moves every user's image links to the next key version in D1, as **Reset image links** in settings does, so every cover link agents were given stops working ([cover images](2026-10-07-remote-mcp-server.md#cover-images)) |
| `config render\|show`, `version`, `release` | The rendered config, the checkout's version and protocol, and the maintainer's release commands |

Commands that change Cloudflare first check wrangler's credential and account.

### Signing in to Cloudflare

`wrangler login` sends the browser back to a callback on `localhost:8976`, so the browser that approves must run on the machine where wrangler runs. An owner whose agent runs on another machine, and who has only a phone at hand, cannot finish it. Its OAuth scopes also include neither tunnels nor DNS edit.

`npm run yolo -- auth` ([`ops/commands/auth.js`](../../../../ops/commands/auth.js)) signs in with Cloudflare's CLI, `cf`, instead. `cf` uses the OAuth device authorization grant: it prints `https://dash.cloudflare.com/oauth2/device/verify` and a code, and the approval can come from any device. The command gives the owner the page with the code filled in, `https://dash.cloudflare.com/oauth2/device/verify?user_code=<code>`, and the code beside it; the code is valid for 5 minutes. The login belongs to a `cf` profile of Yolo's own, `yolo`, so the owner's other `cf` logins stay as they are. It runs in the background: the command returns the link at once (exit 3), the agent passes it on, and the next run, after the approval, continues. A run while the login still waits returns the same link. `--wait` waits for the approval instead, for a person at a terminal.

With the profile signed in, `cf` creates one account-owned API token, "Yolo operator", that holds what the operator's commands do and nothing else ([`ops/lib/operator-token.js`](../../../../ops/lib/operator-token.js)):

| Permission group | On | For |
|---|---|---|
| Account Settings Read | the account | `wrangler whoami`, and the account's name and id |
| Workers Scripts Write | the account | `deploy`, Worker secrets, versions, `rollback`, the cron trigger and the Durable Object, and the workers.dev subdomain |
| Workers KV Storage Write | the account | `provision kv` |
| D1 Write | the account | `provision d1`, `migrate`, backups and Time Travel, `image-links reset` |
| Cloudflare Tunnel Write | the account | `provision tunnel`, which creates the tunnel and reads its token |
| Connectivity Directory Admin | the account | `provision vpc` and the Worker's VPC binding |
| Account Analytics Read | the account | `doctor`'s daily usage against Workers Free's limits |
| Zone Read, Workers Routes Write, DNS Write | the instance's zone, with a domain only | finding the zone, and the custom domain with its DNS record on `deploy` |

The profile asks for `account_api_tokens:create`, `account:read`, and `zone:read`, and for the delegable scope of each group (`workers-scripts.write`, `dns.write`, and so on), because Cloudflare refuses a token with a group that the creating login may not delegate. One approval therefore covers both tiers and `provision media-dns`, which uses the same profile. An instance that gets its domain after the token was made runs `auth` again, which adds the zone to the same token without a new approval.

The token is stored in `.yolo/cloudflare-token.json` (mode 600) with its id, name, account, zone, and groups; its value is never printed. Every wrangler that the operator's commands start, and `npm run wrangler`, gets it as `CLOUDFLARE_API_TOKEN` ([`ops/lib/credentials.js`](../../../../ops/lib/credentials.js)). A `CLOUDFLARE_API_TOKEN` that the owner exported wins over the file; without either, wrangler uses its own login. `cf` always runs without these variables, because with one of them set it ignores its profile. Run again, `auth` keeps a token whose groups and zone match, updates one that differs while its value stays, and creates a new one only when the file is gone; `--rotate` rolls the value. Each run ends with two reads that change nothing: the token's own status, then `wrangler whoami` with the token.

No step needs wrangler's own login. It stays the fallback where `cf` cannot run: `npx wrangler login --device` prints a page and a code the same way, and `npx wrangler login` works when the browser is on the same machine. With either, the tunnel is created in the dashboard (Workers VPC, Tunnels) and its token handed to `provision tunnel --token-file`.

### One status: doctor and /.well-known/yolo

`doctor` checks, in order: the prerequisites (Node.js, git, ffmpeg, yt-dlp, Deno, cloudflared); the instance file (on workers.dev, with a warning that a rename moves the address), `.env`, and the owner-command socket; the node's signed health on this machine, with each plugin's state, the LAN listener, and the remote listener with its router port and carrier-grade NAT; the two services; cloudflared's connections, from `/ready` at its metrics address (JSON that cloudflared sends as `text/plain`); wrangler's account, which credential wrangler acts with (the stored token, an exported one, or its own login) and, for each operation of the commands above, whether the credential grants it, from the token's groups or the login's scopes and a read in that area that changes nothing; the Worker's `NODE_SECRET`, D1's applied migrations, and where the VPC service points; the account's workers.dev subdomain against the instance's host, the DNS token on a domain instance, and the account's busiest day of yesterday and today against Workers Free's daily limits; the deployed Worker, whether its page at `/` is cross-origin isolated, the remote path's state from outside, and whether the media relay is on; and whether the checkout, the Worker, and the node run one release with compatible protocols. `--offline` skips Cloudflare and the network.

The Worker answers `GET /.well-known/yolo` with its version, commit, internal protocol, and the newest D1 migration its code needs and the database has, none of it secret ([`service/control/src/well-known.js`](../../../../service/control/src/well-known.js)). A request signed with `NODE_SECRET` under the operator headers also learns whether the Worker reaches the node through the tunnel, the node's version and protocol, whether an owner passkey exists, the bundled control plugins, and the media paths' states ([media off the Worker](../architecture/2026-10-13-media-off-the-worker.md)); that is how `doctor` checks the tunnel and the VPC service end to end. With `?address=1` the signed request gets only `operator.address`, the address it came from, which the node asks over IPv4 to learn the home's public address. `/healthz` and `/health` answer `{ ok, version }` from the Worker instead of the player's HTML.

### The node and cloudflared as services

`service install` writes a launchd LaunchAgent on macOS (`~/Library/LaunchAgents/<label>.plist`) and a systemd user unit on Linux (`~/.config/systemd/user/<label>.service`), with `KeepAlive` or `Restart=always`, a `PATH` that finds the media tools, and logs in the runtime directory's `.logs/` or `.yolo/logs/`. The node runs `service/node/src/main.js` from the checkout; cloudflared runs `tunnel --metrics <address> run --token-file .yolo/tunnel-token`. A LaunchAgent runs while the owner is logged in and may show the Local Network prompt once. `--daemon` stages a LaunchDaemon with `UserName` instead, for a Mac that serves without anyone logged in (launchd daemons are also outside local network privacy, Apple TN3179); installing it needs an administrator, so the command prints the `sudo` steps. On Linux, `loginctl enable-linger` keeps user units running after logout.

### The deploy checkout

The live node runs from a clone used for nothing else, detached at a release tag, with the instance's ignored files in it. `upgrade` moves that clone between tags and refuses a checkout that is on a branch or has edits, so a development checkout is never moved under a running node. [`skills/yolo-upgrade`](../../../../skills/yolo-upgrade/SKILL.md) gives the layout and how an instance whose node runs from a development checkout moves onto one.

### Skills

Shipped skills in [`skills/`](../../../../skills/) take an agent through each task and mark every human checkpoint: `yolo-deploy` (from an empty Cloudflare account to a paired screen and a connected agent), `yolo-upgrade`, `yolo-connect-agent` (Claude Code, claude.ai, ChatGPT, Codex), `yolo-add-source-plugin` (with [`plugins/source-example`](../../../../plugins/source-example/)), and `yolo` (using the MCP server). `.claude/skills/` links every shipped and repository skill so Claude Code finds them; `ops/test/skills.test.js` keeps the links complete. No shipped skill carries an instance's address.

## Alternatives considered

**Instance values in `yolo.config.json`.** That file chooses plugins, and its presence switches the node from the official plugin list to the file's own list, so adding an instance's ids to it would force every owner to maintain a plugin list. The two also have different readers: the plugin config is read by the node and the Worker's build, the instance file only by the operator's commands.

**Keeping the owner's values in the tracked config and telling others to fork and edit.** Every other instance would carry a modified tracked file in the fastest-changing deployment file of the repository, and every upgrade would be a merge.

**Wrangler's automatic resource provisioning.** Omitting the D1 and KV ids lets `wrangler deploy` create them, but it writes the ids back into the config file, which here is the tracked template, and the route and the VPC service would still need instance values.

**Wrangler's redirected configuration (`.wrangler/deploy/config.json`).** It sends every wrangler command in the directory to the rendered config, including `wrangler dev`, which must stay on the local template.

**Release directories behind a `current` link.** Preparing each release in its own directory and switching a link would make upgrades and rollbacks instant, at the cost of a full `node_modules` per release and a service path that changes. The in-place checkout costs about a minute without the node per upgrade; the commands can move to release directories later without changing their interface.

**A setup wizard or installer first.** A wizard can wrap these commands later; agents need the commands and their results to be machine-readable now.

**`wrangler login --device` as the main path.** It works from a phone too, but wrangler's OAuth scopes include neither tunnels nor DNS edit, so the tunnel would stay a dashboard step and `MEDIA_DNS_TOKEN` would still need `cf`.

**The owner creates a token in the dashboard and gives it to the agent.** The value would pass through the conversation, and the token form is hard to fill in on a phone.

**`cf`'s default login, which asks for every scope, or a token with broad permissions.** A copy of `.yolo/` would then reach every product in the account. The token holds only the groups above, and the zone groups only on the instance's zone.

**Waiting for the approval inside the command.** An agent sees a command's output when the command returns, so a command that waits up to five minutes holds the link back from the owner.

**A LaunchDaemon by default.** It needs an administrator for every install and change, and a home Mac where the owner stays logged in runs a LaunchAgent fine.

## Consequences

An agent in a fresh clone can deploy, check, upgrade, and roll back an instance, stopping only at the listed human checkpoints: the Cloudflare account and plan, the domain if the owner wants one, the login (one page, approved on any device), the plan approval, macOS prompts, the passkey, pairing, and connecting agents. The tracked repository carries no instance's values, so upgrades never conflict with an owner's configuration, and the owner's own instance uses the same path. The commands parse wrangler's text output where it has no JSON (the VPC service list and details), so a wrangler upgrade can break them; `doctor` and the e2e test of `doctor` show it. When wrangler rejects its arguments it prints its usage instead of running, and the commands count that as a failure whatever the exit code. The tunnel needs the dashboard only on the fallback login, and an in-place upgrade stops playback while the node restarts.

Whoever can read `.yolo/cloudflare-token.json` can deploy, change D1, KV, and the tunnel, and with a domain the zone's DNS records, as whoever can read `.yolo/tunnel-token` and `.env` can reach the node; the owner revokes the token in the dashboard (Manage Account, Account API Tokens). The permission groups are Cloudflare's account-level ones, which its newer Workers roles replace without a deprecation date; moving to the roles changes `operator-token.js` and the scopes the profile asks for. Cloudflare may rename a group or a scope: `auth` then fails with the name it did not find, and the fallback login still works.
