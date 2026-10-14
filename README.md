# Yolo

English | [中文](README.zh.md)

**Yolo is a private, agent-driven media service.** Its player runs in a Tesla's browser or any other browser, your AI agents (ChatGPT, Claude, Codex) control playback over MCP, and the whole service runs on your own Cloudflare account and your own home machine, playing your own sources.

> In a car, use Yolo only while parked or as a passenger. Obey local laws, and play only media you are authorized to access. Yolo is not affiliated with Tesla or Plex.

## You own every piece

- **No Yolo servers.** The control plane is a Worker in your Cloudflare account, on your domain or, without one, on your account's free workers.dev address; the media node is a process on your home machine. Your instance calls no service run by the Yolo project.
- **No telemetry to us.** Yolo has no analytics and does not phone home. Your screens send playback diagnostics only to your own Workers Logs, with tokens removed first.
- **Passkey-only owner.** There is no password and no email reset. The first passkey, and any reset, need a 6-digit code that only your home machine can issue.
- **Media straight from your home.** Screens fetch video from the node over HTTPS: by its private address on your home network, and, once you turn on remote access, through one router port from anywhere else. Your Worker relays media only while you have the relay on, and a new instance starts with it off.
- **Open source.** Yolo is MIT-licensed, and you deploy it from a release tag of this repository, so you can read the code you run.

## How it works

<!-- Source: .github/readme/architecture.html. Re-render the images with: node scripts/render-readme-diagram.js -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/architecture-en-dark.png">
  <source media="(prefers-color-scheme: light)" srcset=".github/readme/architecture-en-light.png">
  <img alt="Yolo's architecture. Your screens (a Tesla's browser or any browser) and your AI agents (ChatGPT, Claude, and Codex over MCP) send control, such as sign-in, play, and status, to the Yolo control plane in your own Cloudflare account. It serves the player page, passkey sign-in, MCP with OAuth, and the /v1 API, and keeps state in the Hub, D1, and KV. By default it carries only control to and from your home machine, over Workers VPC through a tunnel that the home machine opens outbound, so control needs no inbound port. The home machine runs the media node: its internal API listens on 127.0.0.1 only, its source plugins fetch from Plex and web video sites, and its media listeners send media straight to your screens over HTTPS with session tokens, by LAN direct or remote direct play, not through Cloudflare; its TLS keys never leave it. A media relay through the control plane is off by default. Yolo runs no servers of its own, and nothing is sent to its authors." src=".github/readme/architecture-en-light.png" width="830">
</picture>

By default the Worker carries control only. It reaches the node's internal API through Workers VPC and a Cloudflare Tunnel that cloudflared opens outbound from your home. Media takes the first path that works for each screen:

1. **LAN direct.** On your home network, a screen where you turned on "Play over the home network" in settings fetches from the node's HTTPS listener at its private address, under a DNS-only name in your zone with a Let's Encrypt certificate whose private key never leaves the node.
2. **Remote direct.** Once you turn on remote access, a screen anywhere else, the car on LTE included, reaches the node's remote listener (port 9444 by default) through one router port. The node asks your router for that port by PCP, NAT-PMP, or UPnP IGD, renews it, and removes it when it stops; on a router that answers none of them, you forward the port by hand. The listener has its own DNS-only name for your home's public IP address and its own Let's Encrypt certificate, and your Worker checks from outside your home that the port answers before any screen uses it.
3. **Relay.** The Worker passes media through from the node, as the last path. A new instance starts with it off, because relaying video through your Worker is likely outside Cloudflare's terms on Free, Pro, and Business plans, and Cloudflare may then restrict video on your domain or act on your account; turning it on requires accepting that warning. An instance upgraded from a release before the switch keeps the relay on until you turn it off in Settings > Media paths, and `yolo doctor` warns while it is on.

The [Agent Notes](.agents/notes/README.md) explain every part and why it is built that way. Good starting points are the [overall split](.agents/notes/implemented/architecture/2026-10-07-control-plane-on-cloudflare-media-node-at-home.md), [node access through Workers VPC](.agents/notes/implemented/architecture/2026-10-08-workers-vpc-node-access.md), [LAN direct play](.agents/notes/implemented/feature/2026-10-12-lan-direct-play.md), and [media off the Worker](.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.md).

## What happens when you press play

1. You open your site on a screen, and your Worker serves the player page.
2. The screen authenticates with its device credential, which it received once, when you approved its pairing with your passkey, and connects to the Hub. The Hub lists the media paths that are ready, and the screen probes them all at once and keeps the first that answers, in the order LAN direct, remote direct, then the relay if it is on.
3. You tap play, or an agent calls `play` over MCP. The Worker passes the request to the Hub, which asks the node through Workers VPC to prepare a session for that screen's path. A source plugin (Plex, yt-dlp, …) tells the node where to read the media, and the node returns a media token for this session and the origin of the path it serves. If the screen has no working path and the relay is off, the Hub refuses with `media_unreachable` before the node does any work, and says what each path needs.
4. If a stream fails on its path, the screen continues on the next path at the same position, and a later stream takes the best path again.
5. Media bytes flow from the node to the screen. On both direct paths, TLS ends on the node itself.
6. The screen reports its position, and the Hub saves your progress to D1, so any screen or agent can resume where you stopped.

## Who can see what

| Party | What it can see |
|---|---|
| The Yolo project and its authors | Nothing from your instance: Yolo runs no servers and sends nothing home. |
| Your Cloudflare account | Control data (your devices, agents, history, queue, playlists, playback state, and each screen's latest playback measurements) and your own Workers Logs. No media bytes while the relay is off. |
| The agents you connect | What Yolo's tools return when they call them, within the scopes you granted: status, devices, libraries, search results, the queue, playlists, history, an item's details, chapters, and subtitle text, and how well a screen is playing (its stream, buffer, stalls, and media path). With `read` they can also fetch frames and storyboards of your videos when asked, which your node reads from the source, never from a screen. Covers reach them as image links on your own origin that open without signing in, so they keep working in old chats: anyone who holds a link, such as someone you share a chat with, sees that one cover and so learns that the title is in your library, until you reset image links in settings. |
| Source sites and Plex | The node's requests for what you play and for its thumbnails, from your home's IP address. |
| Third parties, from your screens | Nothing: screens talk only to your Worker and your node, and the player's fonts and every image come from your own origin. |
| The public internet | Your hostname and the node's names, which are in DNS and in Certificate Transparency logs. With LAN direct, the node's private address in DNS. With remote direct, your home's public IP address in DNS and one HTTPS port that serves only token-authorized media and a reachability probe. |

Remote direct publishes your home's public IP address, as Plex's remote access does, and scanners find its port soon after its name reaches Certificate Transparency logs. If you would rather not, leave remote access off: screens at home still play directly, and away from home they can play only through the relay, if you turn it on.

## Security model

Yolo's security rests on small, explicit boundaries and on code you can read:

- **Passkeys.** The owner signs in only with passkeys. The code that registers the first one, or resets them all, comes from the node on a local Unix socket that neither the Worker nor the internet can reach; it expires in 15 minutes, works once, and is voided by five wrong tries ([owner sign-in](.agents/notes/implemented/architecture/2026-10-08-passkey-owner-sign-in.md)).
- **Device pairing with your approval.** A screen shows a QR code; you scan it, sign in, check the screen's code and name, and press Allow. A pairing code works once and expires after 10 minutes ([device pairing](.agents/notes/implemented/feature/2026-10-07-device-code-pairing.md)).
- **Hashed, scoped credentials.** D1 stores only hashes of device credentials and checks them on every request, so removing a device cuts it off at once. Agents get OAuth tokens limited to the `read`, `control`, and `manage` scopes you allow; access tokens last an hour, and KV stores only token hashes ([OAuth](.agents/notes/implemented/architecture/2026-10-07-oauth-authorization-server.md)).
- **Per-session media tokens.** Every media URL carries an HMAC-signed token for one playback session, valid only while that session lives and for 12 hours at most; media requests use no cookies ([media tokens](.agents/notes/implemented/architecture/2026-10-07-same-origin-media-passthrough.md)).
- **The internal API stays on 127.0.0.1.** The node serves it on the loopback address only. The Worker reaches it through Workers VPC and your outbound-only tunnel, and signs every request with a secret that only the Worker and the node hold ([Workers VPC](.agents/notes/implemented/architecture/2026-10-08-workers-vpc-node-access.md)).
- **TLS keys on the node.** The node generates a private key for each of its names and sends out only certificate requests; your Worker obtains a Let's Encrypt certificate for exactly each name ([LAN direct play](.agents/notes/implemented/feature/2026-10-12-lan-direct-play.md)).
- **A narrow internet-facing port.** The remote listener serves only token-authorized media and a probe, answers only its own name in HTTP and in TLS, checks the token's signature and expiry before any session work, requires TLS 1.2 or newer, and logs no URL. Turning remote access off removes its DNS records, closes it, and deletes the router mapping ([threat model](.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.md#the-threat-model-of-the-remote-listener)).
- **Rate limits.** Sign-in, pairing, and OAuth routes are limited per address, and an address that keeps presenting refused media tokens to the Worker is blocked for a minute. The node's remote listener refuses an address for 10 minutes after 20 failed requests in a minute, and caps connections at 32 per address and 256 in all.
- **Secrets stay out of logs.** Workers Logs keep no per-request lines, and device telemetry removes tokens and credentials on both ends ([device telemetry](.agents/notes/implemented/feature/2026-10-11-device-telemetry.md)).

Limits to know:

- Whoever controls your Cloudflare account or your home machine controls your instance.
- Plugins run with the full rights of the node or the Worker; review a plugin before you install it.
- A leaked media URL plays until its session ends.
- Every device on your home network can reach the node's LAN listener, which serves only token-authorized media.
- While remote access is on, a flaw in Node.js's TLS or HTTP code, or in the media handler, is reachable from the whole internet, and the per-address limits do not bound many addresses acting together.
- Remote direct needs a router port that the internet can reach. Behind carrier-grade NAT, which Yolo detects and reports, or with an ISP that blocks inbound ports, screens away from home have only the relay.
- Control traffic depends on Workers VPC, a Cloudflare beta.

Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes.

## Performance and bandwidth

- **No relay hop.** On the direct paths, media goes from the node to the screen and nowhere else: at home it stays on your network, and away from home it crosses your home upload once, with no detour through Cloudflare.
- **A picture for each screen.** A browser asks for the resolution of its own screen, 720p up to 2160p, and the codecs it decodes, so a 1440p monitor in Chrome gets YouTube's 1440p AV1 and Plex transcodes to the screen's size where the media path carries it. The car's profile stays 720p H.264 ([capability negotiation](.agents/notes/implemented/architecture/2026-10-07-capability-negotiation.md)).
- **Original quality at home.** On LAN direct, the node's bitrate ceiling is 200 Mbps (`LAN_MAX_VIDEO_KBPS`). The Plex plugin plays a Plex original as it is, with no transcode, whenever the browser decodes it; otherwise Plex's direct stream copies the video that fits and converts only the rest. Web video can use higher-bitrate formats.
- **A cap for each path away from home.** Remote direct crosses your home upload once, and the node caps it at 20 Mbps by default (`WAN_MAX_VIDEO_KBPS`); the relay stays at 4.8 Mbps (`STREAM_MAX_VIDEO_BITRATE_KBPS`). Lower the remote cap if your upload is slower.
- **Adaptive quality.** Each screen measures its throughput and asks for a lower or higher bitrate cap when its connection changes ([adaptive quality](.agents/notes/implemented/feature/2026-10-11-adaptive-quality.md)).
- **Hedged mirror reads for web video.** When a source offers several URLs for the same bytes, such as a CDN's mirror hosts, the node reads each byte range from the best one and starts a second read on another mirror when the first stalls or falls behind; the first to finish wins ([media pipeline](.agents/notes/implemented/architecture/2026-10-11-node-media-pipeline.md)).
- **Read-ahead and a disk cache.** In the car, the player buffers up to 210 seconds of an HLS stream ahead, and the node keeps fetched segments in a disk cache (20 GB by default), so rewinding does not download them again.

## Deploy it with your agent

An agent working for you sets Yolo up. Open a coding agent such as Claude Code or Codex in a clone of this repository, on the Mac or Linux computer at home that will run the node, and ask it to deploy Yolo. It follows the [`yolo-deploy`](skills/yolo-deploy/SKILL.md) skill, runs every step through `npm run yolo -- <command>`, and stops whenever only you can act. `npm run yolo -- doctor` checks the whole instance and prints the fix for each failing check.

### What you need

- **A computer at home** for the node: a Mac or Linux machine with Node.js 22.12 or newer, yt-dlp, FFmpeg, Deno, cloudflared, and Cloudflare's `cf` CLI.
- **A Cloudflare account.** Workers Free covers every part of Yolo, and one household stays well inside its daily limits, which `doctor` reports.
- **A domain, or none.** The agent asks first, and you choose:

| | Zero cost | A cheap domain |
|---|---|---|
| You pay | Nothing | About $5–11 a year for a domain on Cloudflare Registrar |
| Your address | `https://<worker>.<your-subdomain>.workers.dev` | `https://yolo.example.com` |
| Sign-in, screens, agents | Everything | Everything |
| At home | No LAN direct play by name | LAN direct play in every browser, at original quality |
| Away from home | Remote direct play to your home's public IP address ([media off the Worker](.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.md)) | Remote direct play by name |
| The address | Cloudflare may rename workers.dev subdomains; you would then register your passkey again and reconnect agents and screens | Yours to keep |

You can start at zero cost and add a domain later: the skill has the steps, and you register your passkey again with the 6-digit code ([no-domain deployment](.agents/notes/implemented/feature/2026-10-13-no-domain-deployment.md)).

### What stays with you

- the Cloudflare account; with a domain, the domain and the hostname, which is permanent because passkeys are bound to it;
- approving one Cloudflare sign-in page, on any device, a phone included: the agent sends you a link with the code filled in, and Cloudflare's `cf` then creates the API token the agent deploys with, so you create neither the tunnel nor a token in the dashboard;
- without a domain, approving the workers.dev subdomain if your account has none yet, since its name is public;
- with a domain, the DNS token (`MEDIA_DNS_TOKEN`) that both direct paths by name need: `cf` creates it under the same sign-in and puts it straight into a Worker secret, or you create it yourself from a pre-filled dashboard page;
- approving the plan before anything is created in your account;
- your passkey, created with the 6-digit code the agent gives you;
- pairing each screen and approving each agent;
- turning on remote access in Settings > Media paths, and, only if your router answers none of PCP, NAT-PMP, and UPnP IGD, forwarding TCP 9444 to the node and setting `WAN_MAPPING=manual`.

To connect an AI app, follow [`yolo-connect-agent`](skills/yolo-connect-agent/SKILL.md): give the app `https://<your-address>/mcp` and approve it once with your passkey. To upgrade, ask your agent: following [`yolo-upgrade`](skills/yolo-upgrade/SKILL.md), it shows you what a release changes and waits for your approval, then backs up D1, migrates, restarts the node, deploys the Worker, and runs `doctor`; `npm run yolo -- rollback` returns to the previous release. Releases are described in [CHANGELOG.md](CHANGELOG.md). Your instance's address and Cloudflare ids live in the ignored `yolo.instance.json`; keep a copy of it and of `.env`.

## Features

- **Agent-first.** A remote MCP server with OAuth: give an agent one URL, approve it once, and it can search, play, pause, seek, switch subtitles and audio tracks, manage the queue and playlists, and read your history.
- **Plays in the Tesla browser.** In the car, the player decodes with WebCodecs and draws to a `<canvas>`, because Tesla can freeze a normal `<video>` element while the car moves.
- **Every browser is a screen and a remote.** In a computer's or phone's browser, iPhone included, the player plays through the browser's own `<video>` with Picture-in-Picture and lock-screen controls, and controls whichever screen is playing ([Yolo Web](.agents/notes/implemented/feature/2026-10-11-yolo-web-client.md)).
- **Danmaku.** Bilibili videos play with their viewers' timed comments moving over the picture, in the car and on the web, clear of subtitles. Each screen sets their density, area, opacity, and size, and an agent can read what viewers say at a moment ([danmaku](.agents/notes/implemented/feature/2026-10-13-danmaku.md)).
- **One history.** Every screen and agent shares one watch history with resume, one queue, and your playlists.
- **Sources are plugins.** Plex libraries and web video (through yt-dlp) are plugins on an experimental API, and [`plugins/source-example`](plugins/source-example/) is the starting point for a new one. Web video means a link from YouTube, Bilibili, Vimeo, or any other site yt-dlp reads; Vimeo plays without a Vimeo account, unlisted links and showcases included, except DRM-protected videos, which Yolo cannot play.

## Roadmap

Yolo is pre-1.0: its internal protocol and plugin API may still change incompatibly between releases. [Yolo 1.0](.agents/notes/proposed/feature/2026-10-11-yolo-1-0.md) defines the target and the path to it, including sources without Plex or yt-dlp, local and NAS libraries, plugin API 1.0, and packages for other owners.

## Contributing

All project knowledge lives in the [Agent Notes](.agents/notes/README.md), in English and Chinese. Agents working on the code start from [AGENTS.md](AGENTS.md), and `npm run check` runs the documentation gates, the build, and every test layer. See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
