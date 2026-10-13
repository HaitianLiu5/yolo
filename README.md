# Yolo

English | [中文](README.zh.md)

**Yolo is a private media service that your AI agents drive.** Ask ChatGPT or Claude to "play The Gentlemen in the car", and it searches your library, starts the video on the right screen, and picks up where you left off. Yolo runs on your own Cloudflare account and a media node on your home machine, and its first screen is Drive-In, a player built for the Tesla browser.

> Use Drive-In only while parked or as a passenger. Obey local laws, and play only media you are authorized to access. Yolo is not affiliated with Tesla or Plex.

## Highlights

- **Agent-first.** A remote MCP server with OAuth: give an agent one URL, approve it once with a passkey, and it can search, play, pause, seek, switch subtitles, and manage the queue.
- **Plays in the Tesla browser.** Drive-In decodes with WebCodecs and draws to a `<canvas>`, because Tesla can freeze a normal `<video>` element while the car is moving.
- **Every browser is a screen and a remote.** Yolo Web, the same app in a computer's or phone's browser (iPhone included), browses and searches your library, plays there through the browser's own `<video>` with Picture-in-Picture and lock-screen controls, and controls whichever screen is playing, as Spotify Connect does; its settings manage devices, connected agents, and passkeys ([Yolo Web](.agents/notes/implemented/feature/2026-10-11-yolo-web-client.md)).
- **Your library, your progress.** Plex libraries and web video links (through yt-dlp) are plugins; Yolo keeps one watch history, so every screen resumes where you stopped.
- **Private by design.** The control plane runs in your Cloudflare account; your home machine opens no public port, and you sign in with a passkey only.
- **Extensible.** Sources are npm plugins with an experimental API, so new sources do not touch the core.

## How it works

```
 ChatGPT / Claude / Codex          Tesla browser, other screens
          │ MCP + OAuth                    │ HTTPS + WebSocket
          ▼                                ▼
 ┌──────────── Control plane (Cloudflare Worker) ─────────────┐
 │ MCP · /v1 API · OAuth & passkeys · Hub (what plays where)   │
 │ D1: devices, queue, playlists, history                       │
 └──────────────┬──────────────────────────────────────────────┘
                │ Workers VPC (no public address at home)
                ▼
 Media node (your home machine)
   source plugins (Plex, yt-dlp) → media pipeline → /m/* streams
```

The control plane serves the Tesla player, the MCP server, and the `/v1` API, and its Hub decides what plays on which screen. The media node resolves sources and streams them back through the Worker on the player's own origin. The [Agent Notes](.agents/notes/README.md) explain every part and why it is built that way; good starting points are the [overall split](.agents/notes/implemented/architecture/2026-10-07-control-plane-on-cloudflare-media-node-at-home.md), the [two playback engines](.agents/notes/implemented/architecture/2026-10-12-two-playback-engines.md), and the [plugin architecture](.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.md).

## Status

Yolo is at 0.4 and runs its owner's own instance. It is pre-1.0: the protocol and the plugin API may still change incompatibly. Next come folder and NAS libraries, a Jellyfin-compatible protocol for Apple devices, and installers for other owners; see [the path to 1.0](.agents/notes/proposed/feature/2026-10-11-yolo-1-0.md).

## Quick start

This is the high-level path for running your own instance; [the deployment section](.agents/notes/implemented/architecture/2026-10-07-control-plane-on-cloudflare-media-node-at-home.md#deployment) has the exact steps.

You need a Cloudflare account and a domain on it, and a home machine with Node.js 22.12 or newer, [yt-dlp](https://github.com/yt-dlp/yt-dlp), [FFmpeg](https://ffmpeg.org/), [Deno](https://deno.com/), and cloudflared. On macOS:

```bash
brew install yt-dlp ffmpeg deno cloudflared
```

1. Clone the repository, then run `npm install` and `npm run build`.
2. Copy `.env.example` to `.env` and set `NODE_SECRET`; set the same value as the Worker secret `NODE_SECRET`.
3. In `service/control`, point `wrangler.jsonc` at your domain, D1 database, KV namespace, and Workers VPC service, apply the D1 migrations, and deploy the Worker.
4. Start the media node with `npm run dev:node` (or as a service).
5. Run `npm run owner-code` and enter the 6-digit code at `/login` to create your passkey ([owner sign-in](.agents/notes/implemented/architecture/2026-10-08-passkey-owner-sign-in.md)).
6. Open your address in the Tesla browser and scan the QR code with your phone to pair the car ([pairing](.agents/notes/implemented/feature/2026-10-07-device-code-pairing.md)).
7. Add the MCP server to your agent, for example `claude mcp add --transport http yolo https://<your-domain>/mcp`, and approve it.

Plex is optional: set `PLEX_URL` and `PLEX_TOKEN` in `.env`. Which plugins load, and their options, can be set in `yolo.config.json` (see `yolo.config.example.json`). `.env.example` documents every setting.

## Documentation

All project knowledge lives in the [Agent Notes](.agents/notes/README.md), in English and Chinese: decisions with their rationale, the protocol, the plugin API, telemetry, and proposals for future work. Agents working on the code start from [AGENTS.md](AGENTS.md); agents using Yolo through MCP can load the [Yolo skill](skills/drive-in/SKILL.md).

## Development

`npm run check` runs the documentation gates, builds the client and the Worker, and runs the unit, integration, and end-to-end tests ([test layers](.agents/notes/implemented/testing/2026-07-21-test-layers.md)). See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
