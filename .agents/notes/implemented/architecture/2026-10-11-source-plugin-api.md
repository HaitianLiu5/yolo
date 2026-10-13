# Agent Note: The source plugin API

Status: implemented

English | [中文](2026-10-11-source-plugin-api.zh.md)

## Problem

The [plugin architecture](2026-10-11-plugin-architecture.md) moves every provider out of the core, so the core needs a contract that a source plugin implements: how it is packaged and loaded, how it names content so that history and resume work, which capabilities it may offer, how it starts and stops, and how a control-plane entry adds tools. The contract must survive a plugin that fails, so one bad plugin cannot take the node down.

## Decision

The API is `@useyolo/plugin-api` ([`service/plugin-api/src/index.js`](../../../../service/plugin-api/src/index.js)); it is experimental before 1.0. The two official plugins, `plugins/source-plex` and `plugins/source-ytdlp`, are written against it, and `plugins/source-example`, which no config loads by default, is the starting point for a new one ([writing a source plugin](#writing-a-source-plugin)).

### Packages and entries

```json
{
  "name": "@someone/yolo-source-example",
  "type": "module",
  "yolo": { "node": "./src/node.js", "control": "./src/control.js" },
  "peerDependencies": { "@useyolo/plugin-api": "*" }
}
```

| Entry | Runs in | Loaded | Registers |
|---|---|---|---|
| `node` | The media node (Node.js) | When the node starts | Sources: `yolo.registerSource` |
| `control` | The control plane (Worker) | Bundled into the Worker at deploy time | MCP tools: `yolo.registerTool` |

Each entry is an ES module whose default export is a factory `(yolo) => void | Promise<void>`, called once with that side's API. Host packages go in `peerDependencies`: the node points a plugin's `import "@useyolo/plugin-api"` at its own copy, so a plugin loads from any directory and shares the node's `YoloError` class.

### The node entry

```js
import { YoloError } from "@useyolo/plugin-api";

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function (yolo) {
  yolo.registerSource("example", {
    claim: (url) => (new URL(url).hostname === "video.example" ? { id: new URL(url).pathname, url } : undefined),
    describe: async (source) => ({ title: `Video ${source.id}`, thumbnail: null, duration: 60 }),
  });
}
```

`yolo` offers `plugin` (`{ name, version }`), `options` (this plugin's config options, read-only, `{}` by default), `env` (the node's environment, `.env` included), `log` (`debug`/`info`/`warn`/`error`, prefixed with the plugin name), `cacheDir` (the plugin's own cache directory under the node's `.media-cache/plugins/`, ignored by Git, created on use, deletable by Yolo at any time, `null` in some tests), `registerSource(id, impl)` (an id of lowercase letters, digits, and `-`, starting with a letter, unique on the node), and `on("start" | "shutdown", fn)`, which returns an unsubscribe function.

### Source and sourceKey

An item is a **Source**: `{ plugin: "example", id: "/v/123", url: "https://video.example/v/123?ref=share" }`. Yolo fills `plugin` with the source's id; `id` is the item's identity in that source (numbers become strings); every other field belongs to the plugin, and Yolo stores it unchanged in the queue, playlists, and history without reading it. A Source's JSON is at most 4 KB. `<plugin>:<id>` is the item's **sourceKey**: history, resume positions, and track preferences are keyed by it, and it is the library item id. A plugin must therefore return the same `id` for the same content every time; the official yt-dlp plugin uses the normalized URL, so different spellings of one video share history. Before a plugin claims it, a URL is an unclaimed `{ url }`, which is how URLs queued while the node is offline are stored.

### Methods

Every method is optional; Yolo never calls a capability a source does not implement, and calls nothing before the plugin's `start` handlers finish.

| Method | Purpose | Returns |
|---|---|---|
| `claim(url)` | Claim an http(s) URL | A Source without `plugin`, or `undefined` to pass |
| `expand(url)` | Expand a playlist or collection URL (`playlist_import`) | `{ title, items: [{ source, title, thumbnail, duration }] }`, or `undefined` |
| `describe(source)` | Title, artwork, duration | `{ title, thumbnail?, artwork?, duration?, isLive? }` |
| `tracks(source)` | Subtitles and audio tracks | `{ subtitles: Track[], audio: Track[] }`; none if not implemented |
| `libraries()` | Libraries | `[{ id, title, type }]` |
| `items(libraryId, { offset, limit })` | Browse a library, paged | `{ total, offset, items: LibraryItem[] }` |
| `children(itemId)` | Seasons, episodes, and other children | `{ parent?, items: LibraryItem[] }` |
| `search(query, { type, limit })` | Search | `LibraryItem[]` |
| `artwork(itemId, variant)` | Artwork | An image `Response` |
| `prepare(source, context)` | Play: resolve the item to an Input the node's pipeline serves ([media pipeline](2026-10-11-node-media-pipeline.md)) | A stream descriptor |
| `health()` | State, shown in `/internal/v1/health` | Any object |

Rules:

- **Claims go in order.** The node calls `claim` in config load order, and within a plugin in registration order; the first Source wins. `expand` works the same way. The official yt-dlp plugin claims every http(s) URL, so a plugin that should see URLs first must be listed before it.
- **`claim` is fast and offline.** The control plane calls it before playing any URL; network work belongs in `describe`. A `claim` that throws returns its error to the caller instead of passing to the next source.
- **Library ids are local.** Ids that `libraries`, `items`, `children`, and `search` return and receive are the plugin's own; Yolo prefixes them with `<source id>:` outside. Playing an item plays the Source `{ plugin: <source id>, id }`.
- **Artwork** is either an http(s) `thumbnail` or a variant name in `artwork` (such as `"poster"`), which Yolo turns into `/v1/library/items/<id>/artwork?variant=…` served by the source's `artwork(itemId, variant)`. Screens get a `thumbnail` through the node, which fetches only public addresses ([node's internal API](2026-10-07-node-internal-api.md)), so a source whose images are on the home network uses `artwork`.
- **Errors** are `YoloError(code, message)` with the `/v1` codes, such as `not_found` or `resolve_failed`; anything else becomes `internal`.
- **Search spans sources.** `libraries` and `search` ask every source that implements them; if one succeeds, the result is returned, and failed sources are listed under `unavailable`.

### Lifecycle

1. **Load:** the node imports each plugin's `node` entry in config order and calls the factory. A factory only registers; it starts no process, socket, timer, or file watcher.
2. **`start`:** after every factory has run, the node runs the `start` handlers in load order. Long-lived resources are created here; a handler that takes more than 30 seconds fails.
3. **`shutdown`:** on SIGTERM or SIGINT the node runs the `shutdown` handlers in load order and waits at most 5 seconds. Handlers must be safe to run more than once and when nothing was started.

| Failure | Result |
|---|---|
| The entry is missing, fails to import, or the factory throws | The plugin is `failed`, everything it registered is dropped, and the other plugins load normally |
| A `start` handler throws or times out | The plugin is `failed`, its sources are removed, and its `shutdown` handlers run to release what it started |
| A `shutdown` handler throws | It is logged; the other handlers still run |

The node keeps running in every case. `/internal/v1/health` lists each plugin's state (`started`, `failed`, `disabled`, `stopped`) and error, and the node prints them at startup.

### The control entry

```js
/** @param {import("@useyolo/plugin-api").YoloControlAPI} yolo */
export default function (yolo) {
  const { z } = yolo;
  yolo.registerTool({
    name: "queue_length",
    title: "Queue length",
    description: "How many items are waiting in the queue.",
    scope: "read",
    annotations: { readOnlyHint: true },
    input: z.object({}),
    run: async (args, { services }) => ({ queued: (await services.listQueue()).length }),
  });
}
```

`yolo` offers `plugin`, `options`, `log`, `z` (the host's zod), and `registerTool`. Tool names are `lower_snake_case` and may not collide with Yolo's own tools or another plugin's. `scope` is the one OAuth scope a call needs; `annotations` default to "not read-only, not destructive"; `input` is a `z.object({...})`; `run(args, { services })` returns JSON for the agent, and a thrown `YoloError` becomes an `isError` result with its code. `services` is the service layer that MCP and `/v1` share. The factory runs on the first MCP request, not at the Worker's global scope.

### The official plugins

| Plugin | Source id | Source | What it does |
|---|---|---|---|
| `@useyolo/source-plex` (`plugins/source-plex`) | `plex` | `{ plugin: "plex", id: <ratingKey> }` | Library browsing, search, details (with Plex's own progress, `resumeAt`), tracks, and artwork; claims no URL. Through the tunnel it plays a fixed 720p transcode (`videoBitrateKbps` or `PLEX_VIDEO_BITRATE_KBPS`, 4000–4800; a lower `limits.maxVideoKbps` lowers it, and the picture drops to 480p, 360p, or 240p). On the LAN path it plays the original part through the node when `playable()` says `direct`, nothing is burned in, and the chosen audio is the file's default, and otherwise gives a `<video>` device Plex's direct stream at the device's picture size ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)). It burns in image subtitles, converts text subtitles to WebVTT (embedded ones are burned in first and extracted in the background), starts at Plex's `viewOffset` when `startTime` is `null`, checks Plex's transcode list in `health()`, writes progress back to Plex, and stops the transcode in `stop()`. Reads `options.url`/`token` in `start`, else `PLEX_URL`/`PLEX_TOKEN`, and on macOS finally the token from Plex Media Server's own preferences |
| `@useyolo/source-ytdlp` (`plugins/source-ytdlp`) | `ytdlp` | `{ plugin: "ytdlp", id: <normalized URL>, url: <original URL> }` | Claims every http(s) URL, takes metadata and subtitles from yt-dlp, and expands playlists. Plays by choosing a format from the device's `maxHeight`, preferred codecs, and `limits.maxVideoKbps`; returns HLS, a single file, or separate audio and video with the request headers and cache keys the CDN needs; re-resolves expired links; gives YouTube live streams a DVR index; downloads subtitles on demand into `cacheDir`. Links that point straight at a media file (`.mp4`, `.webm`, `.m3u8`, …) skip yt-dlp. For Bilibili's upos links it races the mirrors where playback starts, hands the rest over as `alternates`, and starts on a smaller format when the fastest mirror is too slow for the selected one ([media pipeline](2026-10-11-node-media-pipeline.md)). Options `binary`, `cookiesFile`, `cookiesFromBrowser`, else `YTDLP_COOKIES_FILE` and `YTDLP_COOKIES_FROM_BROWSER`; it runs anonymously when neither is set. Each call starts a short-lived yt-dlp process, so it needs no `start` |

Neither has a `control` entry; their tests are in each plugin's `test/` directory. For YouTube, yt-dlp must be 2026.08.19 or newer: older `ANDROID_VR` URLs play the start of a video but answer 403 when seeking further in.

### Writing a source plugin

[`plugins/source-example`](../../../../plugins/source-example/) is the reference plugin: one library of video links from its `options`, with `claim`, `libraries`, `items`, `search`, `describe`, and `prepare`, and unit tests that call the factory with a fake `yolo` and need no node. A new source starts as a copy of it:

1. Rename the package and the source id. Keep `@useyolo/plugin-api` as the only peer dependency and the only import from Yolo.
2. Implement only the [methods](#methods) the provider can serve. The same content always gets the same `id`, and `claim` stays fast and offline.
3. Play by returning an Input from `prepare`, which the node's pipeline serves; start and release long-lived resources in the `start` and `shutdown` handlers ([lifecycle](#lifecycle)).
4. Test the factory and the source object directly with `node --test`, as `source-example` does.
5. List the plugin in the config, before `source-ytdlp` if it claims URLs, restart the node, and check that `/internal/v1/health` (or `npm run yolo -- doctor`) shows it `started`.

The shipped [`yolo-add-source-plugin`](../../../../skills/yolo-add-source-plugin/SKILL.md) skill walks an owner's agent through installing or writing a plugin outside the checkout; [`yolo-add-official-plugin`](../../../skills/yolo-add-official-plugin/SKILL.md) lists what an official plugin in this repository adds.

### Limits

A source without `prepare` can be browsed, searched, and queued, but not played. There is no `yolo install` command, so a config change means restarting the node and redeploying the control plane by hand. Metadata, protocol, and device plugins have no interface yet.

## Alternatives considered

The packaging, loading, and trust choices and their alternatives are recorded in the [plugin architecture](2026-10-11-plugin-architecture.md); why a source returns an Input instead of serving media itself is recorded in the [media pipeline](2026-10-11-node-media-pipeline.md).

## Consequences

A source plugin is a small object of optional methods, and a failing plugin degrades to `failed` without stopping the node. History and resume depend on each plugin's id being stable, which the core cannot check. The contract is experimental and may change incompatibly before 1.0, so a third-party plugin can break on a Yolo upgrade.
