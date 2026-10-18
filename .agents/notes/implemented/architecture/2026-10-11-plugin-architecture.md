# Agent Note: Plugins carry sources and every provider

Status: implemented

English | [中文](2026-10-11-plugin-architecture.zh.md)

## Problem

Plex and yt-dlp code was spread through the core, the control plane, and the node; every new source or client would add more of it, and the core would keep growing. yt-dlp changes often and carries most of the risk of app-store review and YouTube's terms, while some owners want neither it nor Plex. Workers cannot load code at runtime, and Yolo runs in two environments (the control plane and the node) that both need to be extended.

## Decision

Sources, metadata, protocols, devices, agents, speech services, and DNS providers are **plugins**; the core keeps only the library model (catalogs, items, tracks, and subtitles), devices and sessions (the Hub, with its single queue and playback state), playlists, history and progress, identity and authorization (OAuth, passkeys, pairing), media signing with transcoding and HLS packaging, and the MCP server, which plugins can extend but not turn off. The design follows the extension model of pi (`badlogic/pi-mono`, `packages/coding-agent/docs/extensions.md` and `packages.md`).

| Plugin type | Role | Examples | Status |
|---|---|---|---|
| Source | Brings content in: lists or scans items, claims URLs, resolves a playable stream | folder, WebDAV, Plex, yt-dlp | Plex and yt-dlp ship ([source plugin API](2026-10-11-source-plugin-api.md)) |
| Metadata | Adds posters, synopses, and credits | TMDB; community Douban or AniDB | No interface yet |
| Protocol | Exposes Yolo to third-party clients | a Jellyfin-compatible API; community Emby or DLNA | No interface yet |
| Device | Makes a third-party player a controllable device | Jellyfin sessions, Apple TV (pyatv), Chromecast, Kodi | No interface yet; Yolo's own realtime channel stays in core ([Hub](2026-10-07-hub-and-realtime-channel.md)) |
| Agent | Answers a screen's request in words with an agent the owner already runs, through its own MCP connection to Yolo | Claude Code; community Codex | Claude Code ships ([screens ask the owner's own agent](../feature/2026-10-18-agent-from-the-screen.md)) |
| Transcriber, translator | Turn an item's sound into timed text, and that text into the owner's language, for AI subtitles; optional, off until configured | any server with OpenAI's transcription and chat interfaces, such as Whisper and a local model on the owner's Mac | One plugin ships both, not loaded by default ([AI subtitles](../feature/2026-10-18-ai-subtitles.md)) |
| DNS provider | Keeps the node's media names, their address records, and their DNS-01 challenges in a zone of its own | deSEC; community DuckDNS or Route 53 | deSEC ships; Cloudflare's zone is built in ([DNS provider plugins](2026-10-14-dns-provider-plugins.md)) |

- **A plugin is an npm package that exports a factory function.** Its manifest is the `yolo` field of `package.json`, with a `node` entry (loaded when the node starts) and a `control` entry (bundled into the Worker at deploy time); a plugin may have either or both. A DNS provider plugin may also name a `setup` entry, a module that the operator's command line imports on the owner's machine. Host packages (`@useyolo/plugin-api`) are `peerDependencies`. The interface is experimental until 1.0 and may change incompatibly.
- **yt-dlp is a plugin too.** The core knows no `url` source type: when it receives a URL, it asks the source plugins in load order to claim it.
- **Provider code lives only in `plugins/`.** No tracked file under `service/` names a provider, except the D1 migrations and the migration test that convert 0.1 rows, and plugins import only `@useyolo/plugin-api` from Yolo, never `@useyolo/core` or service internals. [`scripts/provider-names.test.js`](../../../../scripts/provider-names.test.js) enforces the first rule in `npm run check`. It takes the names from the plugins, so a new official plugin is checked without a change to the test: each `plugins/<kind>-<provider>` directory gives its provider (`source-plex` gives `plex`), [`scripts/provider-names.js`](../../../../scripts/provider-names.js) lists the other names a provider goes by (`youtube` for `ytdlp`), a name spelled whole counts anywhere (`plexToken`) and one with a hyphen or underscore between its letters counts as a whole word (`yt-dlp`, `YT_DLP_PATH`, but not the `DE_SEC` inside `NODE_SECRET`), and the `source-example` template gives none.
- **Control entries are bundled at build time.** `wrangler.jsonc`'s build command runs `service/control/scripts/generate-plugins.js`, which reads the same plugin config as the node and writes the ignored `service/control/src/plugins.generated.js` with a static import of each enabled `control` entry; a configured plugin that cannot be found fails the build. A control entry may add MCP tools with Yolo's scopes, and DNS providers that the instance's `media.dns` chooses ([`service/control/src/plugins.js`](../../../../service/control/src/plugins.js)). A control plugin's `options` are bundled into the Worker's code, so secrets go into Worker secrets instead.
- **Configuration before code.** Adding a WebDAV address is an option of the WebDAV plugin, not a new plugin.

### Configuration

| Situation | What loads |
|---|---|
| `YOLO_CONFIG` is set | That file (absolute, or relative to the repository; it may be set in `.env`) |
| `yolo.config.json` exists at the repository root | That file (ignored by Git; copy `yolo.config.example.json`) |
| Neither | `plugins/official.json`: the two official source plugins and the official agent plugin, with options from environment variables |

The config is `{ "plugins": [ { "source", "enabled"?, "options"? } ] }`. `source` is a path relative to the config file (starting with `.` or `/`) or an npm package name resolved from the config file's directory; a bare string is shorthand for `{ "source": … }`. The list is complete and ordered: a plugin that is not listed, including an official one, does not load, and `"enabled": false` turns one off. `options` reach the plugin unchanged. After a config change, restart the node, and redeploy the control plane if a `control` entry is involved.

### Trust model

Plugins have no permission system before 1.0, as in pi. A node plugin runs inside the node process with all of its rights: it can read `.env` and `NODE_SECRET`, the file system, and the home network. A control plugin runs in the Worker with every binding, including D1 and the OAuth data. Review a plugin's code and pin its version before installing it.

## Alternatives considered

**Support each source and client inside the core.** Every new provider would add to the core; plugins keep that cost inside the plugin, and protocols such as Emby or DLNA can be left to the community.

**A runtime plugin marketplace.** Workers cannot load code at runtime, and every owner deploys their own instance, so bundling at deploy time is enough.

**An out-of-process plugin protocol, like Stremio's HTTP add-ons.** Rejected with the marketplace: every owner deploys their own instance, so packages loaded in process (on the node) or bundled at deploy time (in the Worker) are enough, and an in-process plugin shares the host's `@useyolo/plugin-api`, including its `YoloError` class.

**A permission system in 1.0.** pi uses the same trust model; reviewing code before installing is the safeguard until the plugin ecosystem justifies more.

**yt-dlp in the core.** As a plugin it can be released on its own schedule as yt-dlp changes, and an owner who does not want it can turn it off; the risk of app review and YouTube's terms stays with that one plugin.

## Consequences

Adding a source is a package, not a change to the service, and the core stays provider-neutral. Two plugins shaped the interface, so it may not fit later plugins; it stays experimental, and the plugins planned for 0.5 and 0.6 will test it ([1.0 roadmap](../../proposed/feature/2026-10-11-yolo-1-0.md)). Changing the control plane's plugins requires a redeploy, there is no `yolo install` command yet, and a malicious plugin has the full rights of the process it runs in.
