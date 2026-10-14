---
name: yolo-add-official-plugin
description: Use when adding, changing, or reviewing an official Yolo source plugin under plugins/ in this repository; covers the workspace, test, default-list, configuration, notice, and note changes an official plugin needs, and the contract points a review checks. Writing a plugin itself starts from plugins/source-example.
---

# Add an official source plugin

An official plugin lives in this repository under `plugins/`, ships with every checkout, and may load by default. Writing the plugin is the same as for any source: follow "Writing a source plugin" in [the source plugin API](../../notes/implemented/architecture/2026-10-11-source-plugin-api.md), which starts from [`plugins/source-example`](../../../plugins/source-example/). An owner who adds a source to their own instance, outside the checkout, uses the shipped [`yolo-add-source-plugin`](../../../skills/yolo-add-source-plugin/SKILL.md) skill instead.

## Repository changes

1. Put the plugin in `plugins/source-<provider>/`, named `@useyolo/source-<provider>`, with the `yolo-plugin` keyword, `@useyolo/plugin-api` as its only peer dependency, and the same version as every other workspace.
2. Add it to the root `package.json` `workspaces` and add `-w plugins/source-<provider>` to the root `test:unit` script.
3. List it in `plugins/official.json` only if it should load by default. Order matters: a plugin that claims URLs goes before `source-ytdlp`, which claims every http(s) URL.
4. Document every environment variable it reads, with its default, in `.env.example` (under the plugin's own prefix, `<PROVIDER>_*`), and its options in `yolo.config.example.json`.
5. Add every new external tool or bundled dependency to `THIRD_PARTY_NOTICES.md`.
6. Add a row to "The official plugins" in the source plugin API note, in both languages, and re-record the pair: `npm run verify-translation-pairing -- --write .agents/notes/implemented/architecture/2026-10-11-source-plugin-api.md`.
7. Keep provider names out of the core, as the rule in [AGENTS.md](../../../AGENTS.md) requires. [`scripts/provider-names.test.js`](../../../scripts/provider-names.test.js) checks `service/` for `<provider>` from the directory name on its own; if the provider also goes by a name the directory does not spell, as yt-dlp goes by YouTube, add that name to `ALIASES` in [`scripts/provider-names.js`](../../../scripts/provider-names.js).

## Review checklist

- The source id never changes, and the same content always gets the same item id: history, resume positions, and track choices are keyed by `<source id>:<item id>`.
- `claim()` is fast and offline; network work is in `describe()`.
- The factory only registers. Processes, sockets, timers, and watchers start in a `start` handler that settles within 30 seconds and are released by an idempotent `shutdown` handler.
- `prepare()` returns a `file`, `hls`, or `split` Input and honours `capabilities`, `limits.maxVideoKbps`, and `startTime` (`null` means where the source itself would resume); on the LAN path it asks `playable()` before transcoding; it never serves HTTP or caches segments.
- `details()`, `chapters()`, and `subtitle()` are optional, but a plugin that knows an item's description, people, chapters, or subtitle text offers them for the owner's agent; `chapters()` gives `kind` only as `chapter`, `intro`, or `credits`, and `subtitle()` returns WebVTT for the same track ids as `tracks()`.
- `comments()` is optional: a provider with timed viewer comments (danmaku) answers the span it covers from `start`, or `null` for an item without any, and caches nothing itself; the node keeps the answers ([danmaku](../../notes/implemented/feature/2026-10-13-danmaku.md)).
- Errors are `YoloError` with the `/v1` codes; tokens and signed URLs never reach a log.
- Unit tests in the plugin's `test/` run against fakes, with no network and no real provider, and pin the contract: stable ids, an offline `claim`, the Input for each capability set, and the refresh of expired URLs.

Then run `npm run check`, and for a plugin that plays, check its stream type in the car and in a browser, as the [in-car checks](../../notes/implemented/testing/2026-07-21-test-layers.md#in-car-checks) describe.
