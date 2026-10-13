# Changelog

Each release of Yolo has one section here, newest first. The prose says what changed for an owner; the `yolo-upgrade` block is what `npm run yolo -- upgrade` reads before it asks the owner for approval: the internal protocol, the D1 migrations the release adds, new Worker secrets and node settings, new Cloudflare resources, whether the node restarts, whether a rollback needs the database restored, and the actions only a person can take. The format and the release procedure are in [versions and releases](.agents/notes/implemented/process/2026-10-13-versions-and-releases.md).

## v0.4.0 (2026-10-13)

The first tagged release. Yolo runs the Tesla player and Yolo Web in any browser, LAN direct play at home, Plex and web video as plugins, and agents over MCP. This release makes an instance deployable and upgradable by an agent on behalf of its owner:

- The tracked `service/control/wrangler.jsonc` is a template. An instance's domain, D1 and KV ids, and Workers VPC service live in the ignored `yolo.instance.json`, and deploys use the rendered `service/control/wrangler.instance.jsonc`.
- `npm run yolo -- <command>` sets up, checks, deploys, upgrades, and rolls back an instance; `doctor` is the single status command. The skills in [`skills/`](skills/) walk an agent through each task.
- Every package is 0.4.0; the Worker reports its version, internal protocol, and migration level at `/.well-known/yolo`; the node accepts the control plane's protocol and the one before.
- `npm run owner-code` works from checkouts with long paths, and the node explains a missing `NODE_SECRET`.

```yolo-upgrade
{
  "protocol": 1,
  "migrations": ["0001_init", "0002_drop_init_codes_used", "0003_plugin_sources", "0004_device_pairing", "0005_device_kind_other"],
  "secrets": [],
  "settings": [],
  "resources": [],
  "node": "restart",
  "rollback": "code",
  "human": [
    "An instance deployed before v0.4.0 kept its values in service/control/wrangler.jsonc: before upgrading, write them to yolo.instance.json with `npm run yolo -- init --import-wrangler <a copy of the old wrangler.jsonc>` (skills/yolo-upgrade)."
  ]
}
```
