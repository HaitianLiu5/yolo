# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thank you for your interest in Yolo. It is a personal project at an early stage, so please open an issue to discuss a change before sending a large pull request.

## Setup

Yolo needs Node.js 22.12 or newer; the media node also needs yt-dlp, FFmpeg, and Deno, and the end-to-end tests need FFmpeg and Chromium (or Google Chrome).

```bash
git clone https://github.com/HaitianLiu5/yolo.git
cd yolo
npm install
npm run build
```

`npm install` also installs the [Git hooks](#git-hooks). [AGENTS.md](AGENTS.md) has the repository layout and code map.

## Run it locally

This is a tutorial for running the whole stack on one machine without a Cloudflare account.

The quickest way to see everything work is `npm run test:e2e`: it starts a media node and the control plane under `wrangler dev --local` on free ports, with local D1 and KV and nothing sent to Cloudflare, and plays every stream type in Chromium ([test layers](.agents/notes/implemented/testing/2026-07-21-test-layers.md)).

To run the pieces yourself:

1. Copy `.env.example` to `.env` and set `NODE_SECRET` to the output of `openssl rand -base64 32`. If another Yolo node already runs on this machine, also set `NODE_PORT`, `NODE_LOCAL_SOCKET`, and `YOLO_RUNTIME_DIR` so the two never share a port or a directory, and use that port in `NODE_PUBLIC_ORIGIN` below. `NODE_LOCAL_SOCKET` must be an absolute path shorter than 104 bytes, or `npm run owner-code` cannot reach the node.
2. Copy `service/control/.dev.vars.example` to `service/control/.dev.vars` (ignored by Git) and set its `NODE_SECRET` to the same value. In `wrangler dev` these values replace the Worker's vars and secrets; `NODE_TRANSPORT=tunnel` makes the control plane call the node over plain HTTP at `NODE_PUBLIC_ORIGIN`, because Workers VPC has no local simulator.
3. Create the local D1 database with `npm run db:migrate:local -w service/control`.
4. Start the media node with `npm run dev:node` and the control plane with `npm run dev:control`, each in its own terminal. The control plane runs the template `wrangler.jsonc`, which holds no instance's bindings, with local D1 and KV.
5. Run `npm run owner-code`, open `http://localhost:8787/login` (`localhost`, not `127.0.0.1`: a passkey cannot be bound to an IP address), and enter the code to create the owner's passkey ([owner sign-in](.agents/notes/implemented/architecture/2026-10-08-passkey-owner-sign-in.md)).
6. Open `http://localhost:8787` and pair the page with that passkey. The site serves the player that `npm run build` built; rebuild after changing it, or run `npm run dev` for Vite with hot reload, which sends Yolo's routes to `YOLO_CONTROL_URL` (default `http://127.0.0.1:8787`).

## Making changes

- Use plain JavaScript ES modules with 2-space indentation; Yolo has no TypeScript and no transpiler.
- Keep provider-specific code in `plugins/`; `service/` stays provider-neutral ([plugin architecture](.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.md)).
- Do not commit `.env`, `.dev.vars`, runtime databases, logs, caches, `yolo.config.json`, or `clients/player/dist/`.
- Record lasting decisions in the [Agent Notes](.agents/notes/README.md), in English and Chinese; Yolo keeps no other documentation folder. A change to a path, default, or contract updates the note that owns it in the same commit, and `npm run verify-translation-pairing -- --write <note>.md` re-records the pair.
- Explain behavior changes and compatibility impact in the pull request.

Run the full check before submitting:

```bash
npm run check
```

It runs the documentation gates, builds the client and the Worker, and runs the unit, integration, and end-to-end tests. Playback and proxy changes also need a manual check with the affected stream type (`hls`, `direct`, `dash_split`, or `plex`), as described in the [test layers](.agents/notes/implemented/testing/2026-07-21-test-layers.md).

## Branches and commits

- Branch from `main` and name the branch `<kind>/<topic>`, with a short kebab-case topic. The kinds follow the Agent Note classes: `feature/`, `fix/` (for a bug fix), `simplification/`, `architecture/`, `process/`, and `testing/`, plus `chore/` for maintenance that records no decision. Examples: `fix/av-sync`, `feature/lan-direct-play`.
- Write the commit subject in the imperative and in sentence case, without a type prefix or a final period, in about 72 characters at most: "Play Plex originals as they are on the home network". The body, wrapped at 72 columns, says why and what the change gives up; trailers such as `Co-Authored-By:` come last.
- Each commit holds one change that passes `npm run check` on its own, together with the notes it updates; a pull request may hold several commits.

## Git hooks

`npm install` installs the [lefthook](https://lefthook.dev) hooks defined in `lefthook.yml`; `npx lefthook install` reinstalls them, and `npm install --ignore-scripts` skips them.

| Hook | What it runs |
|---|---|
| pre-commit | `verify-translation-pairing --cached` on staged `.i18n.yaml` records; `verify-archived-agent-notes` when archived notes are staged; `git diff --cached --check` |
| pre-merge-commit | The same pairing and archive checks |
| pre-push | `npm run doc-sync` |

The hooks are quick local checks. CI runs `npm run check:core` on Node 22 and 24 on every push to `main` and every pull request, and the end-to-end tests unless the change touches only Markdown, translation records, or the Apple clients.

## Writing a source plugin

A source is an npm package that implements the [source plugin API](.agents/notes/implemented/architecture/2026-10-11-source-plugin-api.md). Its [guide to writing one](.agents/notes/implemented/architecture/2026-10-11-source-plugin-api.md#writing-a-source-plugin) starts from [`plugins/source-example`](plugins/source-example/), and the [plugin architecture](.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.md) explains how plugins are configured, ordered, and trusted. The API is experimental until 1.0.

A plugin for your own instance stays outside the checkout, as the [`yolo-add-source-plugin`](skills/yolo-add-source-plugin/SKILL.md) skill describes. An official plugin under `plugins/` also follows the [`yolo-add-official-plugin`](.agents/skills/yolo-add-official-plugin/SKILL.md) checklist.

## Bug reports

Include the steps to reproduce; the affected URL or stream type; where it played (the car profile with the canvas engine, or a browser with the `<video>` engine); your operating system and Node.js version; `yt-dlp --version` and `ffmpeg -version`; the relevant browser and media node logs, with tokens and signed URLs removed; and whether running yt-dlp directly shows the same failure.

Report security issues privately, as described in [SECURITY.md](SECURITY.md), not in a public issue.

## License

Contributions are licensed under the repository's [MIT License](LICENSE).
