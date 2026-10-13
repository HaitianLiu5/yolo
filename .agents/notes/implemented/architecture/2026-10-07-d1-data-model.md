# Agent Note: The D1 data model

Status: implemented

English | [中文](2026-10-07-d1-data-model.zh.md)

## Problem

Yolo's durable state — devices, the queue, playlists, history, track preferences — moved from the earlier single-process server's local SQLite database and JSON file into Cloudflare D1. Yolo serves one owner today, but households or other users may come later, and adding an owner column to every table after the fact means migrating every row. History also grew without bound in the earlier server.

## Decision

The control plane's D1 database (`yolo`, binding `DB`) holds Yolo's durable state, and **every table carries `user_id`** even though v1 has a single user. The schema lives in [`service/control/migrations/`](../../../../service/control/migrations/); a migration that has been applied is never edited, and a change adds the next numbered file.

| Table | Contents |
|---|---|
| `users`, `passkeys` | User id and display name; passkey credentials (credential id, public key, signature counter) |
| `devices` | Id, `user_id`, name, type (`car`, `browser`, `phone`, `tv`, `other`; migration `0005` added `other`), capabilities, last seen |
| `device_codes` | Pending pairing codes (only the device code's hash), the short code, the device's name and type, status (`pending`, `approved`, `denied`, `consumed`), request and expiry times (migration `0004`) |
| `device_tokens` | Paired devices' credentials (hash only), their device, created and last-used times; deleted with the device (migration `0004`) |
| `nodes` | Id, `user_id`, address, secret hash, version |
| `queue_items` | Queue entries with their `source` as JSON |
| `playlists`, `playlist_items` | Playlists and their entries, `source` as JSON |
| `history` | Source key, title, position, duration, play count, update time; only the most recent 500 entries are kept |
| `track_preferences` | Source key and the chosen tracks; a `default` row records the latest choice |

OAuth clients, grants, and tokens are not in D1: `@cloudflare/workers-oauth-provider` keeps them in `OAUTH_KV` with token and secret hashes and encrypted `props`. Playback state lives in the Hub Durable Object's own storage. LAN direct play's state (the node's name and address record, its certificate's dates, and the ACME account key) is one KV value, `yolo:lan` ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)). The owner pairing code lives only in the node's memory; migration `0002` dropped the old `init_codes_used` table. Migration `0003` rewrote 0.1's rows into plugin Sources (for example `url:<normalized URL>` keys became `ytdlp:<normalized URL>`).

### Migrations across releases

**Every migration works with the previous release's code.** A migration adds tables, columns with defaults, or indexes; a step that drops or rewrites something the previous release still reads ships one release after the code stopped reading it. An upgrade therefore applies migrations before it restarts the node and deploys the Worker, the old Worker runs on the new schema in between, and a rollback returns to the previous release's code without touching D1. A release whose migration cannot meet the rule says `rollback: restore` in its changelog entry, and rolling it back restores D1 from the backup taken before the upgrade, with the owner's approval ([versions and releases](../process/2026-10-13-versions-and-releases.md)). `npm run yolo -- migrate` exports the database to `.yolo/backups/` and records a Time Travel bookmark before it applies anything.

## Alternatives considered

**Design for a single user without `user_id`.** A column costs almost nothing now; adding it later is a data migration of every table.

**Keep unlimited history.** 500 entries are enough to find what was watched recently without growing forever.

## Consequences

Multi-user support later needs no schema migration, and history stays small. Every query must filter by `user_id`, and every schema change is a new migration, written to work with the previous release's code and applied with `npm run yolo -- migrate` before the code that needs it is deployed. Splitting state between D1 (durable records), KV (OAuth), the Hub's storage (playback state), and the node's memory (pairing codes) keeps each kind of data where its lifetime and access pattern fit, at the cost of four places to look.
