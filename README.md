# Yolo

Yolo is a private, agent-driven media service. ChatGPT, Claude and other agents search, play and control your videos through a remote MCP server; a media node on your home machine resolves and streams them; and Drive-In, Yolo's Tesla client, plays them in the car's browser. The design and roadmap are in [docs/yolo-roadmap.md](docs/yolo-roadmap.md) (Simplified Chinese).

Drive-In decodes media with Mediabunny and WebCodecs and renders frames to `<canvas>` instead of a native `<video>` element, because Tesla can freeze native video while the vehicle moves.

> Use Drive-In only while parked or as a passenger. Obey local laws and only play media you are authorized to access. This project is not affiliated with Tesla or Plex.

## Open Yolo in the car

1. In the Tesla browser, open your control plane's address (for the owner's instance, `https://yolo.haitian.site`). The player is the site's front page.
2. The first time, it shows a QR code and a short code. Scan the QR code with your phone, sign in with your passkey if asked, check that the device name, type and time are this car's, and press **Allow**. Codes last 10 minutes and work once; the screen fetches a new one by itself. Without a camera at hand, open `/device` on the phone and type the code.
3. The car connects and shows your queue, history and libraries. Ask your agent to play something ("play The Gentlemen in the car"), or tap a card. The first tap also unmutes the sound (browsers start muted).

To remove the car, ask your agent ("remove the car from Yolo") or call `DELETE /v1/devices/<id>`; it returns to the pairing screen.

## How it works

| Part | Where | What it does |
|---|---|---|
| Control plane | Cloudflare Worker (`service/control`) | Serves the Tesla client, MCP, the `/v1` API, OAuth and device pairing; the Hub Durable Object knows what plays where; D1 keeps queue, playlists, history and preferences |
| Media node | Home machine (`service/node`) | Source plugins resolve items (`plugins/source-plex`, `plugins/source-ytdlp`); the media pipeline serves them under `/m/*`: byte-range proxy with a disk cache, rewritten HLS, separate audio/video joined into fMP4 HLS, an ffmpeg fallback, WebVTT subtitles |
| Tesla client | `clients/tesla` | Pairs once, connects to the Hub's realtime channel, and plays what Yolo loads |

Media flows from the node through the Worker on the same origin as the player (signed path tokens, no cookies). The player page is cross-origin isolated (COOP/COEP) for its SharedArrayBuffer audio clock.

| Source | Delivery path |
|---|---|
| HLS | Rewritten same-origin manifest and segment proxy |
| MP4 / WebM | Range-capable stream proxy |
| Split video/audio | Generated fMP4 HLS over source byte ranges, or an ffmpeg transcode |
| Plex | Proxied fixed 720p HLS transcode |

## Requirements

- A Cloudflare account for the control plane
- On the home machine: Node.js 22.12 or newer, [yt-dlp](https://github.com/yt-dlp/yt-dlp), [FFmpeg](https://ffmpeg.org/), [Deno](https://deno.com/) for current YouTube extraction, and cloudflared

On macOS:

```bash
brew install yt-dlp ffmpeg deno cloudflared
```

Keep yt-dlp current. For YouTube, use **2026.08.19 or newer**: older `ANDROID_VR` URLs can read the beginning of a video but return 403 when seeking further in. See the [upstream fix](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19).

## Deploy and run

The steps (secrets, D1 migrations, deploying the Worker with the client's static assets, starting the node, the first passkey) are in [docs/yolo-v1.md §12](docs/yolo-v1.md) (Simplified Chinese). In short:

```bash
npm install
npm run build                  # the Tesla client, then a dry-run Worker build
cp .env.example .env           # NODE_SECRET, Plex settings, …
npm run dev:node               # the media node on 127.0.0.1:9191
npm run owner-code             # the 6-digit code for your first passkey at /login
```

For development, `npm run dev:control` runs the Worker with wrangler, and `npm run dev` serves the Tesla client with Vite, proxying Yolo's routes to it.

## Plex

Plex is an optional source plugin. Set `PLEX_URL` and `PLEX_TOKEN` in `.env` (on macOS the plugin can read the local server's token). Plex transcodes video once at 720p and does not change bitrate during playback, which keeps the player's 210-second buffer intact. Plex also burns in image subtitles; text subtitles are converted to WebVTT and rendered in the browser.

Yolo keeps its own watch history and resume positions. For an item Yolo has not played yet, playback resumes at Plex's own position.

## Configuration

Copy [`.env.example`](.env.example) and edit the values you need. Which plugins load, and their options, can be set in `yolo.config.json` (see [`yolo.config.example.json`](yolo.config.example.json) and [docs/yolo-plugins.md](docs/yolo-plugins.md)).

yt-dlp runs anonymously by default. If a source needs login or browser cookies, set `YTDLP_COOKIES_FROM_BROWSER=chrome` (or another yt-dlp browser/profile specification), or set `YTDLP_COOKIES_FILE` to a Netscape-format cookies file. Keep cookies outside Git and protect them like passwords.

## Diagnostics

- `/diag.html` checks the browser capabilities the player needs.
- `GET /v1/me` reports whether the media node is online; the node's `/internal/v1/health` reports its plugins, sources and media sessions.

## Coming from Drive-In

Yolo replaces the old Drive-In server and its `drivein` CLI. Agents use the MCP server instead; [skills/drive-in/SKILL.md](skills/drive-in/SKILL.md) is the agent skill for it. The old server's queue, playlists, history and subtitle choices can be imported once with `npm run export:drive-in` (see [docs/yolo-v1.md §9](docs/yolo-v1.md), Simplified Chinese).

## Development

Run `npm run check` before submitting changes; it builds the client and the Worker and runs unit, integration and end-to-end tests (see [test/README.md](test/README.md)). See [CONTRIBUTING.md](CONTRIBUTING.md) for the short contribution guide.

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
