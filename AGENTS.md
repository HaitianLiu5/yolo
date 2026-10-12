# AGENTS.md

Yolo is a private, agent-driven media service: a Cloudflare control plane (MCP, `/v1`, OAuth, the Hub), a media node on the owner's home machine, source plugins, and clients. Its Tesla client is Drive-In, which decodes with Mediabunny and WebCodecs and draws frames to `<canvas>`, because Tesla can freeze a native `<video>` while the car moves. All project knowledge — decisions, contracts, and proposals — lives in the [Agent Notes](.agents/notes/README.md); read the owning notes before proposing an architecture change, and follow [the documentation standard](.agents/notes/AGENTS.md#the-documentation-standard).

## Repository layout

```
clients/tesla/         Drive-In (Tesla) and Yolo Web (browsers): one Vite app and Mediabunny engine, served at the site root
service/core/          shared logic: sources, track preferences, capabilities, errors, HMAC signing, heartbeat
service/plugin-api/    @useyolo/plugin-api (experimental) and ./host, how Yolo finds plugins
service/control/       control plane Worker: static assets, /mcp, /oauth/*, pairing, /v1/*, /m/* passthrough, D1, Hub
service/node/          media node: /internal/v1/* and the media pipeline behind /m/*, reached through Workers VPC
plugins/               official source plugins (source-plex, source-ytdlp); official.json is the default load list
scripts/               documentation gates and their tests; drive-in-export/ exports Drive-In data to D1 SQL
skills/drive-in/       shipped agent skill for using Yolo's MCP server
test/e2e/              end-to-end tests of the whole stack
.agents/notes/         Agent Notes (proposed/, implemented/, rejected/, archived/)
.agents/skills/        repository workflows for agents
```

## Code map

- `clients/tesla/src/main.js` owns pairing at startup, the realtime channel's messages, and routing; `profile.js` decides car or web; `realtime.js` is the realtime connection; `pairing.js` shows the QR code, approves a browser's own code with the owner's passkey, and polls the device grant; `api.js` holds the device credential and calls `/v1`; `owner.js` signs the owner in and calls `/v1/owner`.
- `clients/tesla/src/player.js` owns playback lifecycle, recovery, reports, and telemetry; `playback.js` and `stream-requests.js` ask Yolo for streams; `quality.js` is adaptive quality; `display-scale.js` the display size; `resume-decision.js` what a returning page plays.
- `clients/tesla/src/browse.js` owns the home screen, search, episodes, queue, history, and the subtitle and audio menus; `settings.js` the settings sheet; `remote.js` the now-playing bar and device picker; `play-target.js` where a tap plays; `clients/tesla/src/engine/` owns decoding, audio buffering, presentation timing, and HLS prefetch.
- `service/control/src/index.js` wires static assets, OAuthProvider, `/mcp`, `/v1`, `/v1/realtime`, `/m/*`, and the device grant; `auth/device.js` and `store/pairing.js` implement pairing; `auth/pages.js` renders the owner's sign-in, pairing, and consent pages; `services.js` is the one service layer behind MCP tools and `/v1`; `api/owner.js` serves the owner's settings under `/v1/owner` behind the passkey session; `mcp/tools.js` defines the tools.
- `service/control/src/hub/hub-core.js` owns playback state, commands, reports, progress, and resume; `hub.js` wraps it in the Durable Object; `node-client.js` (`nodeFetch()`) is the only way to the node; `media.js` passes `/m/*` through.
- `service/control/migrations/` holds the D1 schema; `src/plugins.js` runs plugins' control entries, bundled by `scripts/generate-plugins.js` into the ignored `src/plugins.generated.js`.
- `service/node/src/app.js` serves `/internal/v1/*` and `/m/*`; `media/pipeline.js` serves sessions under `/m/{token}/…`; `plugins.js` loads node plugins; `sources.js` is the source registry; `owner-code.js` and `local.js` issue the owner pairing code on a Unix socket.
- `plugins/source-ytdlp/src/formats.js` turns yt-dlp's JSON into an Input; `plugins/source-plex/src/playback.js` starts Plex transcodes and handles Plex subtitles.

## Commands

```bash
npm install
npm run check                  # doc-sync, build, then unit, integration, and e2e tests
npm run doc-sync               # documentation gates (scripts/run-gates.js)
npm run build                  # clients/tesla/dist, then a dry-run Worker build that bundles it
npm run dev                    # Vite dev server for the Tesla client, proxying Yolo routes to YOLO_CONTROL_URL
npm run dev:control            # control plane via wrangler dev (needs service/control/.dev.vars)
npm run dev:node               # media node on 127.0.0.1:9191 (needs NODE_SECRET)
npm run owner-code             # 6-digit code from the running node for the first passkey or a reset
npm run verify-translation-pairing -- --write <pair>   # re-record a confirmed bilingual pair
```

Node.js 22.12 or newer is required. The node needs `yt-dlp`, `ffmpeg`, and Deno; the e2e tests need ffmpeg and Chromium (or Google Chrome).

## Rules

- Use plain JavaScript ES modules and 2-space indentation. Do not add TypeScript or a transpiler.
- Keep `<canvas>` rendering; `<video>` breaks the core Tesla use case. Keep decoded video queues bounded, buffer network jitter as encoded segments, keep HLS prefetch single-flight, and preserve the position on quality or viewport changes ([canvas engine](.agents/notes/implemented/architecture/2026-04-04-canvas-playback-engine.md)).
- COOP/COEP are required for the SharedArrayBuffer audio clock; keep the client same-origin with `/m/*` and `/v1/realtime`, and list Yolo's own routes in `wrangler.jsonc` `assets.run_worker_first` ([same-origin passthrough](.agents/notes/implemented/architecture/2026-10-07-same-origin-media-passthrough.md)).
- `/m/*` URLs are authorized only by the media token in the path; device credentials are checked against D1 on every request ([device code pairing](.agents/notes/implemented/feature/2026-10-07-device-code-pairing.md)).
- Core, control, and node code must not know specific providers: `git grep -niE "plex|yt-?dlp|youtube" -- service/` may hit only the D1 migrations and the migration test that convert 0.1 rows. Plugins import only `@useyolo/plugin-api` from Yolo ([plugin architecture](.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.md)).
- A source plays by returning an Input from `prepare()`; it never serves HTTP or caches segments itself ([media pipeline](.agents/notes/implemented/architecture/2026-10-11-node-media-pipeline.md)).
- The control plane reaches the node only through `nodeFetch()` ([node access](.agents/notes/implemented/architecture/2026-10-08-workers-vpc-node-access.md)).
- Every D1 table has `user_id`; never edit an applied migration, add the next number ([D1 data model](.agents/notes/implemented/architecture/2026-10-07-d1-data-model.md)).
- The realtime client sends `HEARTBEAT_PING` exactly, never answers broadcasts, and backs off at least 30 seconds after rate limits ([Hub and realtime channel](.agents/notes/implemented/architecture/2026-10-07-hub-and-realtime-channel.md)).
- Text subtitles are rendered in the browser; image subtitles are burned in by the source ([capability negotiation](.agents/notes/implemented/architecture/2026-10-07-capability-negotiation.md)).
- Playback starts with sound when the browser allows it; otherwise it plays muted with a "Tap for sound" prompt until the first tap ([progress and resume](.agents/notes/implemented/feature/2026-10-11-yolo-owns-progress-and-resume.md)).
- Modules under `service/control/src` that tests import must not import `cloudflare:workers` (only `index.js` and `hub/hub.js` may) ([test layers](.agents/notes/implemented/testing/2026-07-21-test-layers.md)).
- Configuration belongs in environment variables documented by `.env.example`; which plugins load, in what order and with which options, belongs in `yolo.config.json`. Runtime state belongs in ignored paths (`.yolo-node.sock`, `.hls-cache/`, `.media-cache/`, `.segment-cache/`, `.logs/`, `.diag-reports/`, and Drive-In's `.drive-in.sqlite` and `.play-history.json` that the export reads). Never commit tokens, databases, logs, caches, diagnostic reports, `yolo.config.json`, or `clients/tesla/dist/`.
- Never run tests or a second node against the live node's runtime directory or port 9191.

## Agent Notes and documentation

- All project knowledge lives in Agent Notes; there is no `docs/` folder, and the classification gate rejects one ([rationale](.agents/notes/implemented/process/2026-10-12-agent-notes-hold-project-knowledge.md)). The root README, CONTRIBUTING, SECURITY, and CODE_OF_CONDUCT files are GitHub's entry points, not a second home for knowledge.
- **Create Agent Notes only for durable decision rationale;** mechanical/local edits are exempt, including local UI changes ([scope](.agents/notes/README.md#when-to-write-one)). Archived notes are frozen: never edit or treat them as current authority ([archive policy](.agents/notes/README.md#archiving-and-deletion)).
- Docs accompany every code change: update the implemented note that owns a changed path, default, or contract in the same change. Documents link notes by path; code comments cite `Agent Note <file stem>`; never cite a decision or section number.
- Bilingual pairs update together: change both languages, then re-record with `npm run verify-translation-pairing -- --write <pair>` ([contract](.agents/notes/implemented/process/2026-10-12-bilingual-documentation.md)).

## Verification

Run `npm run check` for every change. The e2e tests run the stack (node, `wrangler dev --local`, Chromium) on free ports with local D1 and KV; they never touch Cloudflare or a running node. For route or playback changes, also check the affected stream type in the car: `hls`, `direct`, `dash_split`, or `plex` ([in-car checks](.agents/notes/implemented/testing/2026-07-21-test-layers.md#in-car-checks)).

## Cloud sessions

Cloud agent sessions block `api.cloudflare.com` and `dash.cloudflare.com`, so `wrangler` and `cf` (Cloudflare's official CLI, npm package `cf`, reinstalled after every container rebuild) cannot reach Cloudflare there unless the environment's network access allows those domains. The Cloudflare connector for claude.ai is not affected and can call the Cloudflare API directly.

## Editing these instructions

`CLAUDE.md` is a symlink to `AGENTS.md`, here and in `.agents/notes/implemented/`; edit the real file. Keep each rule self-contained and link the note that owns its rationale.
