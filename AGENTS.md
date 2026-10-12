# AGENTS.md

## Project

Yolo is a private, agent-driven media service: a Cloudflare control plane (MCP, `/v1`, OAuth, the Hub), a media node on the home machine, source plugins, and clients. Its Tesla client is Drive-In, a media player for Tesla browsers. It uses Mediabunny and WebCodecs to decode media, then renders frames to `<canvas>` because Tesla can freeze native `<video>` rendering while the vehicle is moving.

This is an npm workspaces repository:

- `clients/tesla/` — the Tesla client (Drive-In): Vite app and Mediabunny playback engine, served by the control plane at the site root
- `service/core/` — shared Yolo logic: sources, track preferences, capabilities, errors, HMAC signing, the realtime heartbeat
- `service/plugin-api/` — `@useyolo/plugin-api`, the experimental plugin API, and (`./host`) how Yolo finds plugins
- `service/control/` — Yolo control plane, a Cloudflare Worker: the Tesla client as static assets, `/mcp`, `/oauth/*`, device pairing, `/v1/*`, `/m/*` passthrough, D1, Hub Durable Object
- `service/node/` — Yolo media node on the home machine: `/internal/v1/*` and the media pipeline behind `/m/*`, reached through Workers VPC
- `plugins/source-plex/`, `plugins/source-ytdlp/` — the official source plugins; `plugins/official.json` lists what the node loads without a config
- `scripts/drive-in-export/` — one-time export of the old Drive-In server's saved data to D1 SQL
- `skills/drive-in/` — the agent skill for controlling playback through Yolo's MCP server

## Direction and status

Read `docs/yolo-decisions.md` for the decisions and open questions, `docs/yolo-v1.md` for the protocol, `docs/yolo-roadmap.md` for the plugin architecture and the path to 1.0, and `docs/yolo-plugins.md` for writing plugins, before proposing architecture changes.

Implemented (0.3): the remote MCP server with all v1 tools, OAuth with passkey owner sign-in, device pairing with the RFC 8628 device code flow, the `/v1` API, the Hub with realtime devices, D1 storage, `nodeFetch()`, the plugin framework, and the media pipeline in the node core (`/m/*`): sources describe streams through `prepare()`, the node serves them. The Tesla client speaks v1 and is served at the site root. The old Drive-In server, its CLI, and the node's bridge to it (`node:legacy`) have been removed; the Hub still supports node renderers, but none ship.

## Commands

```bash
npm install
npm run check                  # builds the client and the Worker, then all tests (unit, integration, e2e)
npm run build                  # clients/tesla/dist, then a dry-run Worker build that bundles it
npm run dev                    # Vite dev server for the Tesla client (:5173), proxying Yolo routes to YOLO_CONTROL_URL
npm run dev:control            # control plane via wrangler dev (needs service/control/.dev.vars)
npm run dev:node               # media node on 127.0.0.1:9191 (needs NODE_SECRET)
npm run owner-code             # 6-digit code from the running node for the first passkey or a reset
npm run export:drive-in -- --user usr_… --db …/.drive-in.sqlite --history …/.play-history.json
cp yolo.config.example.json yolo.config.json   # choose plugins; without it the node loads plugins/official.json
```

Node.js 22.12 or newer is required. The node needs `yt-dlp`, `ffmpeg`, and Deno. The e2e tests need ffmpeg and Chromium (or Google Chrome).

## Code map

- `clients/tesla/src/main.js` owns pairing at startup, the realtime channel's messages, and routing.
- `clients/tesla/src/realtime.js` is the v1 realtime connection (tickets, hello, heartbeat, backoff, acks).
- `clients/tesla/src/pairing.js` shows the QR code and polls the device grant; `api.js` holds the device credential and calls `/v1`.
- `clients/tesla/src/player.js` owns playback lifecycle, recovery, reports, and telemetry; `playback.js` asks Yolo to play or rebuild a stream.
- `clients/tesla/src/browse.js` owns the home screen, episodes, queue, history, and the subtitle and audio menus; `artwork.js` loads library artwork with the credential.
- `clients/tesla/src/engine/` owns decoding, audio buffering, presentation timing, and HLS prefetch.
- `clients/tesla/public/_headers` sets COOP/COEP for the static assets; `vite.config.js` copies the caption fonts into the build.
- `service/control/src/index.js` wires static assets, OAuthProvider (with device credentials as external tokens), `/mcp`, `/v1`, `/v1/realtime`, `/m/*`, and the device grant on `/oauth/token`.
- `service/control/src/auth/device.js` implements device pairing (RFC 8628) and the `/device` pages; `store/pairing.js` keeps codes and device credentials.
- `service/control/src/services.js` is the one service layer behind both MCP tools and `/v1` routes.
- `service/control/src/mcp/tools.js` defines the MCP tools, their scopes, and annotations.
- `service/control/src/hub/hub-core.js` owns playback state, device commands, reports, progress, and resume; `hub.js` wraps it in the Durable Object.
- `service/control/src/node-client.js` is the only way the control plane reaches the node (`nodeFetch()`); `media.js` passes `/m/*` through.
- `service/control/migrations/` holds the D1 schema; every table has `user_id`. Never edit an applied migration; add the next number.
- `service/control/src/plugins.js` runs plugins' control entries (MCP tools); `scripts/generate-plugins.js` writes the gitignored `src/plugins.generated.js` that wrangler bundles, as `wrangler.jsonc`'s build command.
- `service/node/src/app.js` serves `/internal/v1/*` and `/m/*` on top of the source registry and the media pipeline.
- `service/node/src/media/pipeline.js` serves sessions under `/m/{token}/…` (token check, file/HLS/split delivery, subtitles); `cache.js` is the disk segment cache, `hls.js` and `dash.js` the playlist transforms, `transcode.js` the ffmpeg fallback, `upstream.js` bounded upstream fetches.
- `service/node/src/plugins.js` loads node plugins (factory, `start`, `shutdown`, `cacheDir`); `sources.js` is the source registry (claim order, namespaced library ids, `prepare`); `plugin-hooks.js` gives plugins the host's `@useyolo/plugin-api`.
- `service/node/src/owner-code.js` holds the owner pairing code in memory; `local.js` serves issuing it on a Unix socket the control plane cannot reach.
- `plugins/source-ytdlp/src/formats.js` turns yt-dlp's JSON into an Input; `plugins/source-plex/src/playback.js` starts Plex transcodes and handles Plex subtitles.

## Implementation constraints

- Use plain JavaScript ES modules and 2-space indentation. Do not add TypeScript or a transpiler.
- Modules under `service/control/src` that tests import must not import `cloudflare:workers` (only `index.js` and `hub/hub.js` may), so they stay testable in plain Node.
- Core, control and node code must not know specific providers: provider code lives in `plugins/`. `git grep -niE "plex|yt-?dlp|youtube" -- service/` may only hit the D1 migrations and the migration test that convert 0.1 rows.
- Plugins import only `@useyolo/plugin-api` from Yolo (as a peer dependency), never `@useyolo/core` or service internals. A source plays by returning an Input from `prepare()`; it never serves HTTP or caches segments itself.
- Keep `<canvas>` rendering. Replacing it with `<video>` breaks the core Tesla use case.
- COOP/COEP headers are required for the SharedArrayBuffer audio ring buffer; keep the client same-origin with `/m/*` and `/v1/realtime` (decision 9).
- Production serves `clients/tesla/dist/` as Workers Static Assets; Yolo's own routes are listed in `wrangler.jsonc` `assets.run_worker_first`.
- Playback resumes with sound when the browser allows it; when its autoplay policy blocks audio, the video plays muted with a "Tap for sound" prompt until the first tap.
- Keep decoded video queues memory-bounded. Network jitter belongs in encoded segment buffering, not a large canvas queue.
- HLS prefetch is single-flight so background buffering does not compete with foreground playback.
- Viewport quality changes must preserve playback position.
- Text subtitles are rendered in the browser; image subtitles are burned in by the source.
- The realtime client sends the heartbeat string exactly (`HEARTBEAT_PING`), never answers broadcasts, and backs off at least 30 seconds after rate limits.
- `/m/*` URLs are authorized only by the media token in the path; device credentials are checked against D1 on every request so revocation is immediate.
- Runtime state belongs in ignored paths: `.yolo-node.sock`, `.hls-cache/`, `.media-cache/`, `.segment-cache/`, `.logs/`, `.diag-reports/`, and the old Drive-In server's `.drive-in.sqlite` and `.play-history.json` that the export reads.

Configuration belongs in environment variables documented by `.env.example`; which plugins load, in what order and with which options, belongs in `yolo.config.json` (see `yolo.config.example.json`). Do not commit local tokens, databases, logs, caches, diagnostic reports, `yolo.config.json`, or built `clients/tesla/dist/` files.

## Verification

Run `npm run check` for every code change. The e2e tests run the new stack (node + `wrangler dev --local` + Chromium) on free ports with local D1 and KV; they never touch Cloudflare or a running node. For route or playback changes, also verify the relevant stream type in the car: `hls`, `direct`, `dash_split`, or `plex`.

Never run tests or a second node against the live node's runtime directory or port (9191).
