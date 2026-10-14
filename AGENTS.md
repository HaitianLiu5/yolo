# AGENTS.md

Yolo is a private, agent-driven media service: a Cloudflare control plane (MCP, `/v1`, OAuth, the Hub), a media node on the owner's home machine, source plugins, and the player, one browser app served at the site root. In the car profile the player decodes with Mediabunny and WebCodecs and draws frames to `<canvas>`, because Tesla can freeze a native `<video>` while the car moves; in the web profile it plays through the browser's own `<video>`. All project knowledge — decisions, contracts, and proposals — lives in the [Agent Notes](.agents/notes/README.md); read the owning notes before proposing an architecture change, and follow [the documentation standard](.agents/notes/AGENTS.md#the-documentation-standard).

## Repository layout

```
clients/player/        the player: one Vite app with a car and a web profile over two engines, served at the site root
service/core/          shared logic: sources, track preferences, capabilities, errors, HMAC signing, heartbeat, the ACME client
service/plugin-api/    @useyolo/plugin-api (experimental) and ./host, how Yolo finds plugins
service/control/       control plane Worker: static assets, /mcp, /oauth/*, pairing, /v1/*, /m/* passthrough, D1, Hub
service/node/          media node: /internal/v1/* and the media pipeline behind /m/*, reached through Workers VPC
plugins/               official source plugins (source-plex, source-ytdlp) and source-example; official.json is the default load list
ops/                   the operator's command line (npm run yolo): instance config, doctor, provisioning, deploy, services, upgrade, rollback
scripts/               documentation gates and their tests, and the renderer of the README's architecture diagram
skills/                shipped skills: deploy, upgrade, connect an agent, add a source plugin, and use Yolo's MCP server (yolo/)
test/e2e/              end-to-end tests of the whole stack
.agents/notes/         Agent Notes (proposed/, implemented/, rejected/, archived/)
.agents/skills/        repository workflows for agents
.claude/skills/        links to every skill above, for Claude Code
```

## Code map

- `clients/player/src/main.js` owns pairing at startup, the realtime channel's messages, and routing; `profile.js` decides car or web; `realtime.js` is the realtime connection; `pairing.js` shows the QR code, approves a browser's own code with the owner's passkey, and polls the device grant; `api.js` holds the device credential and calls `/v1`; `owner.js` signs the owner in and calls `/v1/owner`.
- `clients/player/src/player.js` owns playback lifecycle, recovery, reports, and telemetry over either engine; `playback.js` and `stream-requests.js` ask Yolo for streams; `media-paths.js` probes the node's media origins and decides this screen's media path (LAN, remote, or the relay); `quality.js` is adaptive quality; `display-scale.js` the display size; `resume-decision.js` what a returning page plays.
- `clients/player/src/browse.js` owns the home screen, search, episodes, queue, history, and the subtitle and audio menus; `settings.js` the settings sheet; `remote.js` the now-playing bar and device picker; `play-target.js` where a tap plays; `picture-controls.js` Picture-in-Picture, fullscreen, and AirPlay. `clients/player/src/engine/` holds the canvas engine (`mediabunny-player.js`: decoding, audio buffering, presentation timing, HLS prefetch), the `<video>` engine (`native-video-player.js`), and the engine choice (`native-support.js`).
- `service/control/src/index.js` wires static assets, OAuthProvider, `/mcp`, `/v1`, `/v1/realtime`, `/m/*`, and the device grant; `auth/device.js` and `store/pairing.js` implement pairing; `auth/pages.js` renders the owner's sign-in, pairing, and consent pages; `services.js` is the one service layer behind MCP tools and `/v1`; `api/owner.js` serves the owner's settings under `/v1/owner` behind the passkey session; `mcp/tools.js` defines the tools.
- `service/control/src/hub/hub-core.js` owns playback state, commands, reports, progress, and resume; `hub.js` wraps it in the Durable Object; `node-client.js` (`nodeFetch()`) is the only way to the node; `media.js` relays `/m/*` while the owner has the relay on; `edge/` keeps the node's LAN and remote names, DNS records, and certificates and the remote path's check from outside (the cron trigger, ACME DNS-01), and `edge/paths.js` the media paths a welcome lists.
- `service/control/migrations/` holds the D1 schema; `src/plugins.js` runs plugins' control entries, bundled by `scripts/generate-plugins.js` into the ignored `src/plugins.generated.js`; `src/well-known.js` serves `/.well-known/yolo` and `/healthz` from `scripts/generate-build-info.js`'s ignored `src/build-info.generated.js`.
- `ops/yolo.js` dispatches `npm run yolo -- <command>` to `ops/commands/`; `ops/lib/instance.js` reads the instance file and `wrangler-config.js` renders the deploy config from the template; `media-dns.js` creates the DNS token with `cf`, and `plan.js` checks Workers Free's limits; `ops/wrangler.js` is `npm run wrangler`.
- `service/node/src/app.js` serves `/internal/v1/*` and `/m/*`; `edge.js` is the media listeners' HTTPS server that serves only `/m/*` and a probe, `lan.js` the one on the private LAN address, `wan.js` the one the internet reaches through a router port (with per-address limits), which without a domain certifies the home's public address itself (`acme-challenge.js` answers the CA), and `portmap/` maps that port by PCP, NAT-PMP, or UPnP IGD; `media/pipeline.js` serves sessions under `/m/{token}/…`, `media/playable.js` judges whether a device plays a file as it is, and `media/frames.js` reads agents' frames and storyboards with ffmpeg; `plugins.js` loads node plugins; `sources.js` is the source registry; `owner-code.js` and `local.js` issue the owner pairing code on a Unix socket.
- `plugins/source-ytdlp/src/formats.js` turns yt-dlp's JSON into an Input; `plugins/source-plex/src/playback.js` starts Plex transcodes, plays Plex originals on the LAN, and handles Plex subtitles.

## Commands

```bash
npm install
npm run check                  # doc-sync, build, then unit, integration, and e2e tests
npm run doc-sync               # documentation gates (scripts/run-gates.js)
npm run build                  # clients/player/dist, then a dry-run Worker build that bundles it
npm run dev                    # Vite dev server for the player, proxying Yolo routes to YOLO_CONTROL_URL
npm run dev:control            # control plane via wrangler dev (needs service/control/.dev.vars, see .dev.vars.example)
npm run dev:node               # media node on 127.0.0.1:9191 (needs NODE_SECRET)
npm run owner-code             # 6-digit code from the running node for the first passkey or a reset
npm run yolo -- doctor         # one instance's status, every check with its fix (--json; --offline)
npm run yolo -- help           # the other operator commands: init, provision, migrate, deploy, service, upgrade, rollback
npm run wrangler -- <args>     # wrangler in service/control with the instance's rendered config
npm run verify-translation-pairing -- --write <pair>   # re-record a confirmed bilingual pair
node scripts/render-readme-diagram.js                  # re-render the README's diagram PNGs from .github/readme/architecture.html
```

Node.js 22.12 or newer is required. The node needs `yt-dlp`, `ffmpeg`, and Deno; the e2e tests need ffmpeg and Chromium (or Google Chrome), and `YOLO_E2E_WEBKIT=1` adds Playwright's WebKit.

## Rules

- Use plain JavaScript ES modules and 2-space indentation. Do not add TypeScript or a transpiler.
- A Tesla plays with the canvas engine: the car profile, and any page the Tesla fingerprint recognizes, whatever device type the owner chose; `<video>` breaks the core Tesla use case. Keep decoded video queues bounded, buffer network jitter as encoded segments, and keep HLS prefetch single-flight ([canvas engine](.agents/notes/implemented/architecture/2026-04-04-canvas-playback-engine.md)).
- The web profile plays through the browser's `<video>` element; both engines stay behind `player.js`'s one engine interface and keep the position on quality or viewport changes, and `engine/native-support.js` chooses from the profile and the Tesla fingerprint ([two engines](.agents/notes/implemented/architecture/2026-10-12-two-playback-engines.md)).
- COOP/COEP are required for the canvas engine's SharedArrayBuffer audio clock and stay on every page, since a page learns its profile only after it loads; keep the client same-origin with `/m/*` and `/v1/realtime`, and list Yolo's own routes in `wrangler.jsonc` `assets.run_worker_first` ([same-origin passthrough](.agents/notes/implemented/architecture/2026-10-07-same-origin-media-passthrough.md)). The exceptions are the node's media origins, LAN and remote, which answer only `/m/*` and the probe with CORS and CORP for the page; every media URL of a stream resolves against the stream's `origin` ([LAN direct play](.agents/notes/implemented/feature/2026-10-12-lan-direct-play.md)).
- `/m/*` URLs are authorized only by the media token in the path; device credentials are checked against D1 on every request ([device code pairing](.agents/notes/implemented/feature/2026-10-07-device-code-pairing.md)).
- The Worker carries control only: media goes from the node to the device by LAN direct play or remote direct play, and through the Worker's `/m/*` relay only while the owner has it on, because relaying video is most likely outside Cloudflare's terms; never make the relay a default or reshape its responses ([media off the Worker](.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.md)).
- Core, control, and node code must not know specific providers: `git grep -niE "plex|yt-?dlp|youtube" -- service/` may hit only the D1 migrations and the migration test that convert 0.1 rows. Plugins import only `@useyolo/plugin-api` from Yolo, and an official one follows the [`yolo-add-official-plugin`](.agents/skills/yolo-add-official-plugin/SKILL.md) workflow ([plugin architecture](.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.md)).
- A source plays by returning an Input from `prepare()`; it never serves HTTP or caches segments itself ([media pipeline](.agents/notes/implemented/architecture/2026-10-11-node-media-pipeline.md)).
- The control plane reaches the node only through `nodeFetch()` ([node access](.agents/notes/implemented/architecture/2026-10-08-workers-vpc-node-access.md)).
- Every D1 table has `user_id`; never edit an applied migration, add the next number, and write it to work with the previous release's code ([D1 data model](.agents/notes/implemented/architecture/2026-10-07-d1-data-model.md)).
- Yolo has one version, the root `package.json`'s, on every package; a change to `/internal/v1` that the previous release's other side cannot follow raises `NODE_PROTOCOL`; every release has a `CHANGELOG.md` entry with its `yolo-upgrade` block ([versions and releases](.agents/notes/implemented/process/2026-10-13-versions-and-releases.md)).
- The realtime client sends `HEARTBEAT_PING` exactly, never answers broadcasts, and backs off at least 30 seconds after rate limits ([Hub and realtime channel](.agents/notes/implemented/architecture/2026-10-07-hub-and-realtime-channel.md)).
- Text subtitles are rendered in the browser; image subtitles are burned in by the source ([capability negotiation](.agents/notes/implemented/architecture/2026-10-07-capability-negotiation.md)).
- Playback starts with sound when the browser allows it; otherwise it plays muted with a "Tap for sound" prompt until the first tap ([progress and resume](.agents/notes/implemented/feature/2026-10-11-yolo-owns-progress-and-resume.md)).
- Modules under `service/control/src` that tests import must not import `cloudflare:workers` (only `index.js` and `hub/hub.js` may) ([test layers](.agents/notes/implemented/testing/2026-07-21-test-layers.md)).
- Configuration belongs in environment variables documented by `.env.example`; which plugins load, in what order and with which options, belongs in `yolo.config.json`; an instance's address (its domain, or its workers.dev host without one) and Cloudflare ids belong in the ignored `yolo.instance.json`, never in `service/control/wrangler.jsonc`, which stays a template ([agent deployment](.agents/notes/implemented/feature/2026-10-13-agent-deployment.md)). Runtime state belongs in ignored paths (`.yolo/` with deployment records, D1 backups, and the tunnel token, `.yolo-node.sock`, `.lan/` with the node's LAN and remote keys and certificates, `.hls-cache/`, `.media-cache/`, `.segment-cache/`, and `.logs/`). Never commit tokens, databases, logs, caches, `yolo.config.json`, `yolo.instance.json`, `service/control/wrangler.instance.jsonc`, or `clients/player/dist/`.
- Never run tests or a second node against the live node's runtime directory or port 9191.
- Name branches `<kind>/<topic>` and write commit messages as [CONTRIBUTING.md](CONTRIBUTING.md#branches-and-commits) describes.

## Agent Notes and documentation

- All project knowledge lives in Agent Notes; there is no `docs/` folder, and the classification gate rejects one ([rationale](.agents/notes/implemented/process/2026-10-12-agent-notes-hold-project-knowledge.md)). The root README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, and CHANGELOG files are GitHub's entry points, not a second home for knowledge. Deploying, upgrading, or diagnosing an instance follows the skills in `skills/` (`yolo-deploy`, `yolo-upgrade`).
- **Create Agent Notes only for durable decision rationale;** mechanical/local edits are exempt, including local UI changes ([scope](.agents/notes/README.md#when-to-write-one)). Archived notes are frozen: never edit or treat them as current authority ([archive policy](.agents/notes/README.md#archiving-and-deletion)).
- Docs accompany every code change: update the implemented note that owns a changed path, default, or contract in the same change. Documents link notes by path; code comments cite `Agent Note <file stem>`; never cite a decision or section number.
- Bilingual pairs update together: change both languages, then re-record with `npm run verify-translation-pairing -- --write <pair>` ([contract](.agents/notes/implemented/process/2026-10-12-bilingual-documentation.md)).

## Verification

Run `npm run check` for every change. The e2e tests run the stack (node, `wrangler dev --local`, Chromium) on free ports with local D1 and KV; they never touch Cloudflare or a running node. For route or playback changes, also check the affected stream type in the car: `hls`, `direct`, `dash_split`, or `plex` ([in-car checks](.agents/notes/implemented/testing/2026-07-21-test-layers.md#in-car-checks)). For `<video>`-engine changes, also run the e2e tests with `YOLO_E2E_WEBKIT=1` or check in Safari.

## Cloud sessions

Cloud agent sessions block `api.cloudflare.com` and `dash.cloudflare.com`, so `wrangler` and `cf` (Cloudflare's official CLI, npm package `cf`, reinstalled after every container rebuild) cannot reach Cloudflare there unless the environment's network access allows those domains. The Cloudflare connector for claude.ai is not affected and can call the Cloudflare API directly.

## Editing these instructions

`CLAUDE.md` is a symlink to `AGENTS.md`, here and in `.agents/notes/implemented/`; edit the real file. Keep each rule self-contained and link the note that owns its rationale.
