# Contributing

## Setup

Yolo requires Node.js 22.12 or newer; the media node also needs yt-dlp, FFmpeg, and Deno.

```bash
git clone https://github.com/HaitianLiu5/yolo.git
cd yolo
cp .env.example .env
npm install
npm run build
```

`npm run dev:control` runs the control plane with wrangler, `npm run dev:node` the media node, and `npm run dev` the Tesla client with Vite (proxying Yolo's routes to `YOLO_CONTROL_URL`). See AGENTS.md for the layout.

## Making changes

- Use plain JavaScript ES modules and 2-space indentation.
- Keep dependencies and abstractions minimal.
- Keep provider-specific code in `plugins/`; `service/` stays provider-neutral.
- Do not commit `.env`, runtime databases, logs, caches, diagnostic reports, or `clients/tesla/dist/`.
- Explain behavior changes and compatibility impact in the pull request.

Run the full automated check:

```bash
npm run check
```

Playback and proxy changes also need a manual test against the affected source type: `hls`, `direct`, `dash_split`, or `plex`. Confirm that the node starts, the player loads and pairs, seeking works, and audio/video remain synchronized.

## Bug reports

Include:

- Reproduction steps and the affected URL or source type
- Operating system and Node.js version
- `yt-dlp --version` and `ffmpeg -version`
- Relevant browser and media node logs
- Whether the failure also occurs when running yt-dlp directly

Report security issues privately through [GitHub Security Advisories](https://github.com/HaitianLiu5/yolo/security/advisories/new), not a public issue.

## License

Contributions are licensed under the repository's [MIT License](LICENSE).
