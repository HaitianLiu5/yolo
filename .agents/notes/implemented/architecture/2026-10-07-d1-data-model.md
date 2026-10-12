# Agent Note: The D1 data model

Status: implemented

English | [中文](2026-10-07-d1-data-model.zh.md)

## Problem

Yolo's durable state — devices, the queue, playlists, history, track preferences — moved from Drive-In's local SQLite database and JSON file into Cloudflare D1. Yolo serves one owner today, but households or other users may come later, and adding an owner column to every table after the fact means migrating every row. History also grew without bound in Drive-In, and the existing data had to come along.

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

OAuth clients, grants, and tokens are not in D1: `@cloudflare/workers-oauth-provider` keeps them in `OAUTH_KV` with token and secret hashes and encrypted `props`. Playback state lives in the Hub Durable Object's own storage. The owner pairing code lives only in the node's memory; migration `0002` dropped the old `init_codes_used` table. Migration `0003` rewrote 0.1's rows into plugin Sources (for example `url:<normalized URL>` keys became `ytdlp:<normalized URL>`).

### Importing Drive-In's data

[`scripts/drive-in-export`](../../../../scripts/drive-in-export/export.js) (`npm run export:drive-in`) exports Drive-In's SQLite database (opened read-only) and its history JSON as SQL in the plugin Source format, which `wrangler d1 execute` imports. The comments at the top of `export.js` give the three commands: look up the user id in D1, export on the home machine, import with `wrangler d1 execute yolo --remote --file …`. The import never loses Yolo's own data: history keeps the newer row by update time, Yolo's own track choices win, the queue and playlists keep Drive-In's ids, and importing twice adds no rows. Drive-In kept no position for Plex items (it left that to Plex), so after the import they resume at Plex's own `viewOffset`.

## Alternatives considered

**Design for a single user without `user_id`.** A column costs almost nothing now; adding it later is a data migration of every table.

**Keep unlimited history.** 500 entries are enough to find what was watched recently without growing forever.

## Consequences

Multi-user support later needs no schema migration, and history stays small. Every query must filter by `user_id`, and every schema change is a new migration applied with `wrangler d1 migrations apply` before the code that needs it is deployed. Splitting state between D1 (durable records), KV (OAuth), the Hub's storage (playback state), and the node's memory (pairing codes) keeps each kind of data where its lifetime and access pattern fit, at the cost of four places to look.
