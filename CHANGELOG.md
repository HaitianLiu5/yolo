# Changelog

Each release of Yolo has one section here, newest first. The prose says what changed for an owner; the `yolo-upgrade` block is what `npm run yolo -- upgrade` reads before it asks the owner for approval: the internal protocol, the D1 migrations the release adds, new Worker secrets and node settings, new Cloudflare resources, whether the node restarts, whether a rollback needs the database restored, and the actions only a person can take. The format and the release procedure are in [versions and releases](.agents/notes/implemented/process/2026-10-13-versions-and-releases.md).

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
