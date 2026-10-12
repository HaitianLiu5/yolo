# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thank you for your interest in Yolo. It is a personal project at an early stage, so please open an issue to discuss a change before sending a large pull request.

## Setup

Yolo needs Node.js 22.12 or newer; the media node also needs yt-dlp, FFmpeg, and Deno, and the end-to-end tests need FFmpeg and Chromium (or Google Chrome).

```bash
git clone https://github.com/HaitianLiu5/yolo.git
cd yolo
cp .env.example .env
npm install
npm run build
```

`npm run dev:control` runs the control plane with wrangler, `npm run dev:node` the media node, and `npm run dev` the Tesla client with Vite. [AGENTS.md](AGENTS.md) has the repository layout and code map.

## Making changes

- Use plain JavaScript ES modules with 2-space indentation; Yolo has no TypeScript and no transpiler.
- Keep provider-specific code in `plugins/`; `service/` stays provider-neutral ([plugin architecture](.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.md)).
- Do not commit `.env`, runtime databases, logs, caches, diagnostic reports, `yolo.config.json`, or `clients/tesla/dist/`.
- Record lasting decisions in the [Agent Notes](.agents/notes/README.md), in English and Chinese; Yolo keeps no other documentation folder.
- Explain behavior changes and compatibility impact in the pull request.

Run the full check before submitting:

```bash
npm run check
```

It runs the documentation gates, builds the client and the Worker, and runs the unit, integration, and end-to-end tests. Playback and proxy changes also need a manual check with the affected stream type (`hls`, `direct`, `dash_split`, or `plex`), as described in the [test layers](.agents/notes/implemented/testing/2026-07-21-test-layers.md).

## Bug reports

Include the steps to reproduce, the affected URL or stream type, your operating system and Node.js version, `yt-dlp --version` and `ffmpeg -version`, the relevant browser and media node logs, and whether running yt-dlp directly shows the same failure.

Report security issues privately, as described in [SECURITY.md](SECURITY.md), not in a public issue.

## License

Contributions are licensed under the repository's [MIT License](LICENSE).
