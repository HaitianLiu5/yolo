---
name: yolo-source-plugin
description: Use when writing, adding, reviewing, or changing a Yolo source plugin, whether an official one under plugins/ or a third-party npm package; walks the source plugin API contract, stable ids, the start and shutdown lifecycle, prepare() Inputs, configuration, registration, notices, and tests.
---

# Write a Yolo source plugin

A source plugin turns a provider (a site, a server, a folder) into Sources that Yolo can queue, resume, and play. The contract is experimental until 1.0 and may change incompatibly.

## Read the contract first

- [The source plugin API](../../notes/implemented/architecture/2026-10-11-source-plugin-api.md): packages and entries, the `yolo` API, Sources and sourceKeys, methods, lifecycle, and "A minimal plugin", a complete worked example.
- [The plugin architecture](../../notes/implemented/architecture/2026-10-11-plugin-architecture.md): config, load order, the trust model.
- [The node media pipeline](../../notes/implemented/architecture/2026-10-11-node-media-pipeline.md): the `file`, `hls`, and `split` Inputs that `prepare()` returns, and what the node does with them.
- `service/plugin-api/src/index.js`: the JSDoc typedefs (`SourceImpl`, `PrepareContext`, `Input`, `StreamDescriptor`).

## Checklist

1. **Package.** `"type": "module"`, a `"yolo": { "node": "./src/node.js" }` entry (a `control` entry only to add MCP tools), `"peerDependencies": { "@useyolo/plugin-api": "*" }`, and the `yolo-plugin` keyword. Import nothing from Yolo but `@useyolo/plugin-api`: never `@useyolo/core` or a path under `service/`.
2. **Source id.** Lowercase letters, digits, and `-`, starting with a letter, unique on the node, and never renamed: history, resume positions, and track choices are keyed by `<source id>:<item id>`. Return the same item id for the same content every time; normalize URLs before using them as ids.
3. **`claim(url)`** is fast and offline: no network, no subprocess. The control plane calls it before every play of a URL. Return `undefined` to pass; network work belongs in `describe`. If the plugin claims URLs that `source-ytdlp` would also claim, it must be listed before `source-ytdlp` in the config.
4. **Lifecycle.** The factory only registers. Processes, sockets, timers, and watchers start in an `on("start")` handler, which must settle within 30 seconds, and are released in an `on("shutdown")` handler that is safe to run twice and when nothing started.
5. **`prepare(source, context)`** returns a StreamDescriptor whose `input` is a `file`, `hls`, or `split` Input. The plugin never serves HTTP or caches segments: the node's pipeline does. Respect `context.capabilities`, `context.limits.maxVideoKbps`, and `context.startTime` (`null` means "where the source itself would resume"); on the LAN path (`context.network === "lan"`) use `context.playable()` before transcoding; give `refresh()` for URLs that expire.
6. **Errors** are `YoloError(code, message)` with the `/v1` codes (`not_found`, `resolve_failed`, `forbidden`, …); anything else becomes `internal`.
7. **Settings.** Read `yolo.options` first, then the plugin's own environment prefix (`<PROVIDER>_*`) from `yolo.env`. Put caches only in `yolo.cacheDir`, which Yolo may delete at any time. Never log tokens or signed URLs.
8. **Provider names stay out of the core.** `git grep -niE "<provider>" -- service/` stays empty, as the root `AGENTS.md` rule requires for Plex and yt-dlp.

## An official plugin in this repository

In addition to the checklist:

- Put it in `plugins/source-<provider>/` with `@useyolo/source-<provider>` as its package name, add it to the root `package.json` `workspaces`, and add `-w plugins/source-<provider>` to the root `test:unit` script.
- List it in `plugins/official.json` only if it should load by default, in the right claim order.
- Document every environment variable with its default in `.env.example`, and its options in `yolo.config.example.json`.
- Add any new external tool or runtime dependency to `THIRD_PARTY_NOTICES.md`.
- Add a row to "The official plugins" table in the source plugin API note, in both languages, and re-record the pair with `npm run verify-translation-pairing -- --write .agents/notes/implemented/architecture/2026-10-11-source-plugin-api.md`.

## Tests

- Unit tests live in the plugin's `test/` directory and run with `node --test`, against fakes: no network, no real provider. Pin the contract: `claim` is offline and returns the same id for different spellings of one item, `prepare` returns the right Input for each capability set, and expired URLs are refreshed.
- `service/node/test/plugins.test.js` shows how the node loads a plugin from outside the repository; copy its pattern when a test needs the real loader.
- Run `npm run check`. For a plugin that plays, also check its stream type in the car and in a browser, as the [in-car checks](../../notes/implemented/testing/2026-07-21-test-layers.md#in-car-checks) describe.
