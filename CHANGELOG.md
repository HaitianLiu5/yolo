# Changelog

Each release of Yolo has one section here, newest first. The prose says what changed for an owner; the `yolo-upgrade` block is what `npm run yolo -- upgrade` reads before it asks the owner for approval: the internal protocol, the D1 migrations the release adds, new Worker secrets and node settings, new Cloudflare resources, whether the node restarts, whether a rollback needs the database restored, and the actions only a person can take. The format and the release procedure are in [versions and releases](.agents/notes/implemented/process/2026-10-13-versions-and-releases.md).

## v0.5.0 (2026-10-13)

Media leaves the Worker. Relaying video through the Cloudflare Worker is most likely outside Cloudflare's terms on Free, Pro, and Business zones, so screens now play straight from the media node, at home over the LAN and away through a router port, and the Worker relays media only while the owner has the relay on ([media off the Worker](.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.md)). The player also stops loading anything from other hosts.

### For the owner

- **Remote direct play.** With remote access on in Settings > Media paths, a screen anywhere, the car on LTE included, plays from the node through one port of the home router, under its own DNS-only name with its own certificate. The node asks the router for that port by PCP, NAT-PMP, or UPnP IGD, renews it, and removes it when it stops or remote access goes off; a router without those protocols needs a port forward and `WAN_MAPPING=manual`. The node detects carrier-grade NAT, where remote direct play cannot work, and the Worker checks from outside the home that the port answers.
- **Each screen picks its path:** the home network, then remote direct play, then the relay if it is on. A stream that fails on its path continues on the next one at the same position. Settings show each screen's path and why the others failed, and device telemetry records it (`media_probe`, `media_path`, `media_path_fallback`).
- **The relay is off on a new instance.** Turning it on in Settings > Media paths shows a warning about Cloudflare's terms that the owner must accept. With no path and the relay off, playing says what each path needs (`media_unreachable`), to agents too.
- **The relay stays on after this upgrade** for an existing instance, so a car that plays away from home through the relay keeps working until remote direct play works. Turn it off in Settings > Media paths once Remote direct play says "Ready"; `yolo doctor` warns while it is on.
- The remote listener faces the internet with nothing in front: it serves only token-authorized media and its probe under its own name, limits each address, and logs no URL. Turning remote access off closes it.
- **Nothing loads from another host.** The Japanese and Korean subtitle fonts come from Yolo's own origin instead of Google Fonts, and web-video thumbnails come through `/v1/thumbnail` and the node instead of the source's image server. The node fetches only public http(s) addresses, checked again on each redirect, and only raster images of at most 4 MiB, so a thumbnail on a private address shows a placeholder; a source whose images are on the home network needs artwork variants.

### For the operator

- Upgrade in the usual order, which `npm run yolo -- upgrade` follows: back up D1, apply migration 0006, restart the node, deploy the Worker, then run `doctor`.
- The internal protocol stays 1: each half keeps working with the other half's previous release, so neither refuses the other during the upgrade or a rollback. A 0.4 Worker with a 0.5 node plays as before, but the node no longer answers `/internal/v1/renderers`, so the old Worker logs `renderers_failed` and, while no screen is online, refuses with `node_offline` instead of `device_offline`. A 0.5 Worker with a 0.4 node plays over the LAN and the relay; thumbnails show placeholders and remote direct play cannot start until the node restarts.
- The zone token is now the Worker secret `MEDIA_DNS_TOKEN`. `LAN_DNS_TOKEN` keeps working until the next release; to move, store the same token under the new name and delete the old one.
- New node settings, all optional: `WAN_PORT` (9444; 0 turns remote direct play off on the node), `WAN_MAPPING` (`auto` or `manual`), `WAN_EXTERNAL_PORT`, `WAN_GATEWAY`, `WAN_ADDRESS`, and `WAN_IPV6`.
- `doctor` reports the remote listener, its router port, carrier-grade NAT, the check from outside, and whether the relay is on; `get_status` reports the relay and remote access.

### For contributors

- The README is new: it leads with what the owner controls and who sees what.
- The end-to-end suite keeps only the journeys that unit tests cannot prove (23 tests in about 280 s, from 32 in 579 s), and the LAN fallback test no longer flakes. A new test fails when the player's build or an owner page references another host.

### Migrations

D1 `0006_media_settings`: the owner's media path switches. It gives the users that exist when it runs the relay on. Rolling back needs no D1 restore.

### New secrets and settings

- `MEDIA_DNS_TOKEN`, optional: replaces `LAN_DNS_TOKEN` for LAN and remote direct play.
- `WAN_*` in `.env`, optional: see `.env.example`.

### Human actions

- To play away from home without the relay: turn on Remote direct play in Settings > Media paths; forward TCP 9444 to the node only if the card says the router made no mapping.
- Once Remote direct play says "Ready", turn the relay off in Settings > Media paths.

### Removed names

- The names renamed in v0.4.0: the node no longer reads the `X-Drive-In-Prefetch` header or writes `#EXT-X-DRIVE-IN-*` tags, and nothing reads `DRIVEIN_ENV_FILE`. A car tab still running a player from before v0.4.0 must reload.
- Node renderers, which never shipped: the node's `/internal/v1/renderers` and `/internal/v1/sessions/:id/control`, the prepare body's `renderer`, and the `nodeOnline` and `via` fields of device lists (`list_devices`, `/v1/devices`, settings). `get_status` still reports the node.

### Renamed names, accepted until the next release

- `LAN_DNS_TOKEN` → `MEDIA_DNS_TOKEN`
- The welcome's `lan` → `media.paths`; `/lan/probe` → `/edge/probe`; the path name `tunnel` → `relay`; `/v1/owner/lan` → `/v1/owner/media`

```yolo-upgrade
{
  "protocol": 1,
  "migrations": ["0006_media_settings"],
  "secrets": [
    { "name": "MEDIA_DNS_TOKEN", "required": false, "how": "Only for LAN or remote direct play. An instance with LAN_DNS_TOKEN keeps working until the next release removes that name; before then the owner stores the same token with npm run wrangler -- secret put MEDIA_DNS_TOKEN and deletes the old one with npm run wrangler -- secret delete LAN_DNS_TOKEN. Otherwise the owner creates a Cloudflare API token with Zone Read and DNS Edit on the hostname's zone and stores it the same way (skills/yolo-deploy)." }
  ],
  "settings": [
    { "name": "WAN_MAPPING", "required": false, "how": "Only on a router without PCP, NAT-PMP, or UPnP IGD: the owner forwards TCP 9444 to the node and sets WAN_MAPPING=manual in .env (.env.example lists WAN_PORT, WAN_EXTERNAL_PORT, WAN_GATEWAY, WAN_ADDRESS, and WAN_IPV6)." }
  ],
  "resources": [],
  "node": "restart",
  "rollback": "code",
  "human": [
    "Remote direct play, to play away from home without the relay: the owner turns it on in Settings > Media paths (it exposes one port of the home that serves only token-authorized media); the node maps the router port itself, and a router without PCP, NAT-PMP, or UPnP IGD needs a forward of TCP 9444 and WAN_MAPPING=manual.",
    "The relay stays on for this existing instance after the upgrade: once Settings > Media paths says Remote direct play is Ready, the owner turns the relay off there, because relaying video through the Worker is likely outside Cloudflare's terms."
  ]
}
```

## v0.4.0 (2026-10-13)

The first tagged release. It covers everything since the project became Yolo, and an owner's agent can now deploy, upgrade, and roll back an instance from release tags.

### For the owner

- One player at the site root. The player (car profile) decodes to a `<canvas>` in the Tesla browser; in any other browser, iPhone included, the web profile plays through the browser's `<video>` with Picture-in-Picture and lock-screen controls and is a remote for whichever screen is playing.
- Agents search, play, and control playback over MCP once the owner approves them with a passkey. Screens pair by scanning a QR code.
- Yolo keeps one history with resume, a queue, and playlists for every screen, and resumes after a wake with sound when the browser allows it.
- Plex and web video (yt-dlp) are source plugins. At home, screens can play straight from the node (LAN direct play), where Plex originals play as they are. Quality adapts to the connection.
- Security: a passkey sign-in returns only to a path on Yolo's own origin; media tokens, tickets, and pairing codes stay out of Workers Logs; unauthenticated routes are rate-limited per address; and the canvas engine no longer retries a failing segment forever.

### For the operator

- `service/control/wrangler.jsonc` is a template. An instance's domain, D1 and KV ids, and Workers VPC service live in the ignored `yolo.instance.json`, and deploys use the rendered `service/control/wrangler.instance.jsonc`.
- `npm run yolo -- <command>` sets up (`init`, `provision`, `migrate`, `deploy`, `service`), checks (`doctor`), upgrades, and rolls back an instance; the skills in [`skills/`](skills/) walk an agent through each task.
- Every package is 0.4.0. The Worker reports its version, internal protocol, and migration level at `/.well-known/yolo`, and the node accepts the control plane's protocol and the one before.
- `npm run owner-code` works from checkouts with long paths, and the node explains a missing `NODE_SECRET`.
- An instance deployed before v0.4.0 kept its values in `service/control/wrangler.jsonc`. Before upgrading, write them to `yolo.instance.json` with `npm run yolo -- init --import-wrangler <a copy of the old wrangler.jsonc>` ([`skills/yolo-upgrade`](skills/yolo-upgrade/SKILL.md)).

### Migrations

D1 `0001_init` through `0005_device_kind_other`. Rolling back needs no D1 restore.

### New secrets

- `NODE_SECRET`, required: shared by the Worker and the node. `npm run yolo -- init` writes it to `.env`, and `npm run yolo -- deploy` uploads it to the Worker.
- `LAN_DNS_TOKEN`, optional: turns on LAN direct play. The owner creates a Cloudflare API token that can edit the zone's DNS and stores it with `npm run wrangler -- secret put LAN_DNS_TOKEN`.

### Human actions

- Approve the Cloudflare login (`npx wrangler login`).
- On a new instance, create the tunnel in the Cloudflare dashboard and hand over only its token.
- On a new instance, or to reset passkeys, create the owner's passkey with the 6-digit code from `npm run owner-code`; the code replaces every existing passkey.
- On the Workers Paid plan, set a budget alert in the Cloudflare dashboard.

### Renamed names, accepted until the next release

v0.4.0 uses the new names and still accepts the old ones; 0.5 removes the old ones.

- `X-Drive-In-Prefetch` → `?prefetch=1`
- `#EXT-X-DRIVE-IN-*` → `#EXT-X-YOLO-*`
- `DRIVEIN_ENV_FILE` → `YOLO_ENV_FILE`

The node no longer reads `DRIVEIN_RUNTIME_DIR`; set `YOLO_RUNTIME_DIR` instead.

```yolo-upgrade
{
  "protocol": 1,
  "migrations": ["0001_init", "0002_drop_init_codes_used", "0003_plugin_sources", "0004_device_pairing", "0005_device_kind_other"],
  "secrets": [
    { "name": "NODE_SECRET", "required": true, "how": "npm run yolo -- init writes it to .env; npm run yolo -- deploy uploads the same value to the Worker." },
    { "name": "LAN_DNS_TOKEN", "required": false, "how": "Only for LAN direct play: the owner creates a Cloudflare API token with Zone Read and DNS Edit on the hostname's zone and runs npm run wrangler -- secret put LAN_DNS_TOKEN (skills/yolo-deploy)." }
  ],
  "settings": [],
  "resources": [
    "A D1 database, a KV namespace, a tunnel, and a Workers VPC service, which npm run yolo -- provision creates; the Hub Durable Object, a 5-minute cron trigger, and two Workers rate-limit bindings, which npm run yolo -- deploy creates from the config."
  ],
  "node": "restart",
  "rollback": "code",
  "human": [
    "Cloudflare login: the owner approves `npx wrangler login`, or gives the agent an API token (skills/yolo-deploy).",
    "Tunnel, only on a new instance: the owner creates it in the Cloudflare dashboard (Workers VPC > Tunnels > Create) and hands over only its token for `npm run yolo -- provision tunnel --token-file <file>`.",
    "Passkey, only on a new instance or for a reset the owner asks for: the owner creates it at /login with the 6-digit code from `npm run owner-code`, which replaces every existing passkey.",
    "Budget alert, only on the Workers Paid plan: the owner sets one in the Cloudflare dashboard (Manage Account > Billing > Billable Usage > Set Budget Alert)."
  ]
}
```
