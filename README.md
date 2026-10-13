# Yolo

English | [中文](README.zh.md)

**Yolo is a private media service that your AI agents drive.** Ask ChatGPT or Claude to "play The Gentlemen in the car", and it searches your library, starts the video on the right screen, and picks up where you left off. Yolo runs on your own Cloudflare account and a media node on your home machine. Its player is built first for the Tesla browser and plays in any other browser too.

> In a car, use Yolo only while parked or as a passenger. Obey local laws, and play only media you are authorized to access. Yolo is not affiliated with Tesla or Plex.

## Highlights

- **Agent-first.** A remote MCP server with OAuth: give an agent one URL, approve it once with a passkey, and it can search, play, pause, seek, switch subtitles, and manage the queue.
- **Plays in the Tesla browser.** In the car, the player decodes with WebCodecs and draws to a `<canvas>`, because Tesla can freeze a normal `<video>` element while the car is moving.
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
   (at home, screens can also fetch /m/* from the node over the LAN)
```

The control plane serves the player, the MCP server, and the `/v1` API, and its Hub decides what plays on which screen. The media node resolves sources and streams them back through the Worker on the player's own origin; a screen on the home network can instead fetch them straight from the node's own HTTPS address on the LAN ([LAN direct play](.agents/notes/implemented/feature/2026-10-12-lan-direct-play.md)). The [Agent Notes](.agents/notes/README.md) explain every part and why it is built that way; good starting points are the [overall split](.agents/notes/implemented/architecture/2026-10-07-control-plane-on-cloudflare-media-node-at-home.md), the [two playback engines](.agents/notes/implemented/architecture/2026-10-12-two-playback-engines.md), and the [plugin architecture](.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.md).

## Status

Yolo is at 0.4 and runs its owner's own instance. It is pre-1.0: the protocol and the plugin API may still change incompatibly. Next come folder and NAS libraries, a Jellyfin-compatible protocol for Apple devices, and installers for other owners; see [the path to 1.0](.agents/notes/proposed/feature/2026-10-11-yolo-1-0.md).

## Deploy your own

Yolo is set up by an agent working for you. Open a coding agent such as Claude Code or Codex in a clone of this repository, on the computer at home that will run the media node, and ask it to deploy Yolo: it follows [the deploy skill](skills/yolo-deploy/SKILL.md) and stops whenever it needs you.

You need a Cloudflare account (the free plan is expected to be enough) with a domain on it, and a Mac or Linux computer with Node.js 22.12 or newer, [yt-dlp](https://github.com/yt-dlp/yt-dlp), [FFmpeg](https://ffmpeg.org/), [Deno](https://deno.com/), and cloudflared. On macOS:

```bash
brew install node yt-dlp ffmpeg deno cloudflared
```

What you do yourself: choose the address (it is permanent: passkeys are bound to it), approve the Cloudflare login, create the tunnel in the Cloudflare dashboard and hand over its token, approve the plan, create your passkey with the 6-digit code the agent gives you, pair each screen by scanning its QR code, and approve each AI app that connects. Plex is found by itself when it runs on the same Mac; playing straight from the home machine at home needs a Cloudflare DNS token that you create ([LAN direct play](.agents/notes/implemented/feature/2026-10-12-lan-direct-play.md)).

The agent works through `npm run yolo -- <command>`: `init`, `provision`, `migrate`, `deploy`, `service install`, and `doctor`, the one command that checks everything. Your instance's address and Cloudflare ids live in `yolo.instance.json`, outside version control; keep a copy of it and of `.env`. How it fits together: [agent deployment](.agents/notes/implemented/feature/2026-10-13-agent-deployment.md).

## Upgrade

Releases are tags (`vX.Y.Z`) described in [CHANGELOG.md](CHANGELOG.md). Ask your agent to upgrade Yolo: following [the upgrade skill](skills/yolo-upgrade/SKILL.md), it shows you what the release changes and waits for your approval, then backs up the database, migrates it, restarts the node, deploys the Worker, and checks the result. If something goes wrong, `npm run yolo -- rollback` returns to the previous release, again after your approval.

## Connect your AI apps

Give your app `https://<your-domain>/mcp` and approve it once with your passkey. [The connect skill](skills/yolo-connect-agent/SKILL.md) has the steps for Claude Code, claude.ai, ChatGPT, and Codex.

## Documentation

All project knowledge lives in the [Agent Notes](.agents/notes/README.md), in English and Chinese: decisions with their rationale, the protocol, the plugin API, telemetry, and proposals for future work. Agents working on the code start from [AGENTS.md](AGENTS.md); agents using Yolo through MCP can load the [Yolo skill](skills/yolo/SKILL.md).

## Development

`npm run check` runs the documentation gates, builds the client and the Worker, and runs the unit, integration, and end-to-end tests ([test layers](.agents/notes/implemented/testing/2026-07-21-test-layers.md)). See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
