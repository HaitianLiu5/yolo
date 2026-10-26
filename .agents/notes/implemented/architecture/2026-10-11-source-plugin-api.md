# Agent Note: The source plugin API

Status: implemented

English | [中文](2026-10-11-source-plugin-api.zh.md)

## Problem

The [plugin architecture](2026-10-11-plugin-architecture.md) moves every provider out of the core, so the core needs a contract that a source plugin implements: how it is packaged and loaded, how it names content so that history and resume work, which capabilities it may offer, how it starts and stops, and how a control-plane entry adds tools. The contract must survive a plugin that fails, so one bad plugin cannot take the node down.

## Decision

The API is `@useyolo/plugin-api` ([`service/plugin-api/src/index.js`](../../../../service/plugin-api/src/index.js)); it is experimental before 1.0. The two official source plugins, `plugins/source-plex` and `plugins/source-ytdlp`, are written against it, as is the official DNS provider plugin `plugins/dns-desec` ([DNS provider plugins](2026-10-14-dns-provider-plugins.md)), and `plugins/source-example`, which no config loads by default, is the starting point for a new one ([writing a source plugin](#writing-a-source-plugin)).

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
| `control` | The control plane (Worker) | Bundled into the Worker at deploy time | MCP tools: `yolo.registerTool`; DNS providers: `yolo.registerDnsProvider` |

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

An item is a **Source**: `{ plugin: "example", id: "/v/123", url: "https://video.example/v/123?ref=share" }`. Yolo fills `plugin` with the source's id; `id` is the item's identity in that source (numbers become strings); every other field belongs to the plugin, and Yolo stores it unchanged in the queue, playlists, and history without reading it. A Source's JSON is at most 4 KB. `<plugin>:<id>` is the item's **sourceKey**: history, resume positions, and track preferences are keyed by it, and it is the library item id. A plugin must therefore return the same `id` for the same content every time; the official yt-dlp plugin uses the normalized URL, so different spellings of one video share history. When a source stops knowing a library item's id anyway, as after a library rescan, and `prepare` answers `not_found`, the Hub finds the item again by its title and `duration` among the source's `search` results and moves its history and track preference to the new id ([moved library items](../feature/2026-10-21-moved-library-items.md)). Before a plugin claims it, a URL is an unclaimed `{ url }`, which is how URLs queued while the node is offline are stored.

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
| `sequence(source)` | The run the item belongs to, in playing order: a show's episodes across its seasons, a multi-part video's parts, the playlist its URL names. Yolo plays the next one when the item ends and the queue is empty; called in the background for each item played directly ([what plays next](../feature/2026-10-23-up-next.md)) | `{ title?, items, index }`, items as a Collection's, a title the source does not know left out, and an optional `label`, the item's short place in the run ("S1 · E3", "P3"); or null |
| `search(query, { type, limit })` | Search | `LibraryItem[]` |
| `artwork(itemId, variant)` | Artwork | An image `Response` |
| `prepare(source, context)` | Play: resolve the item to an Input the node's pipeline serves ([media pipeline](2026-10-11-node-media-pipeline.md)); with `reason: "frame"`, an Input the node reads one picture from, where the original file suits best and the source changes none of its own state ([video frames](../feature/2026-10-13-video-frames.md)) | A stream descriptor |
| `health()` | State, shown in `/internal/v1/health` | Any object |
| `subtitle(source, trackId)` | WebVTT text of one of `tracks()`' text subtitles while the item is not playing, or the whole text of a growing track while it plays, for transcripts | A string, or `{ pending: true, retryAfter? }`; throws `rate_limited` with `details.retryAfter` (seconds) while the site limits it |
| `chapters(source)` | Chapters, and intro and credits markers | `Chapter[]` (`{ start, end?, kind?, title? }`, seconds), or `{ chapters, duration? }` |
| `details(source)` | What an agent may want to know: description, people, date, genres, tags, ratings, series | `Details` |
| `storyboard(source)` | Storyboard images the source already has, such as a site's thumbnail sprites, for an agent's contact sheet; offered only when cheaper than reading frames ([video frames](../feature/2026-10-13-video-frames.md#storyboards)) | `{ title?, duration?, sheets: [{ url, headers?, start, duration, columns, rows, tileWidth, tileHeight, interval? }] }`, or `null` |
| `comments(source, { start, end })` | Timed comments that screens draw over the picture (danmaku) and agents read ([danmaku](../feature/2026-10-13-danmaku.md)) | `{ comments: [{ t, text, mode?, color?, size?, weight? }], start?, end? }`: the comments of the span the answer covers completely, at least from `start`, such as one segment or the whole item (`end: null`), each with the provider's rank of it (`weight`, 0 to 10) when it has one; `null` for an item without any |
| `warm(source, context)` | Resolve ahead for a device whose home screen offers the item first, with the `capabilities`, `viewport`, `limits`, and `network` its `prepare` context would hold, so a `prepare` soon after needs less time; it starts no session and nothing the source must stop. The node runs one at a time, in the background, and ignores failures ([node's internal API](2026-10-07-node-internal-api.md)) | Nothing |

Rules:

- **Claims go in order.** The node calls `claim` in config load order, and within a plugin in registration order; the first Source wins. `expand` works the same way. The official yt-dlp plugin claims every http(s) URL, so a plugin that should see URLs first must be listed before it.
- **`claim` is fast and offline.** The control plane calls it before playing any URL; network work belongs in `describe`. A `claim` that throws returns its error to the caller instead of passing to the next source.
- **Library ids are local.** Ids that `libraries`, `items`, `children`, and `search` return and receive are the plugin's own; Yolo prefixes them with `<source id>:` outside. Playing an item plays the Source `{ plugin: <source id>, id }`. A library item, and `prepare()`'s result, may name `parents`: the local ids of the items it belongs to, outermost first, at most two (an episode's show, then its season; a season's show), by which Yolo counts a show's and a season's episodes watched in Yolo ([progress and resume](../feature/2026-10-11-yolo-owns-progress-and-resume.md)).
- **Artwork** is either an http(s) `thumbnail` or a variant name in `artwork` (such as `"poster"`), which Yolo turns into `/v1/library/items/<id>/artwork?variant=…` served by the source's `artwork(itemId, variant)`. Screens get a `thumbnail` through the node, which fetches only public addresses ([node's internal API](2026-10-07-node-internal-api.md)), so a source whose images are on the home network uses `artwork`.
- **Errors** are `YoloError(code, message)` with the `/v1` codes, such as `not_found` or `resolve_failed`; anything else becomes `internal`.
- **Search spans sources.** `libraries` and `search` ask every source that implements them; if one succeeds, the result is returned, and failed sources are listed under `unavailable`.
- **What agents read has fallbacks.** `subtitle`, `chapters`, and `details` let the owner's agent read an item through the node's `/internal/v1/transcript`, `/chapters`, and `/details` ([node's internal API](2026-10-07-node-internal-api.md)). While an item plays, its transcript comes from the stream descriptor's `subtitle(trackId)`, except a growing track's, whose descriptor answers only what the source has made so far; so `subtitle(source, trackId)` is needed for items that are not playing and for growing tracks. Without `chapters` an item has none; without `details` an agent gets what `describe` returns; without `storyboard`, or when it fails, takes over 10 seconds, or gives no tile, the node reads frames of the video for `/internal/v1/storyboard` ([video frames](../feature/2026-10-13-video-frames.md#storyboards)). Yolo normalizes both: a chapter's `kind` is `chapter` (the default), `intro`, or `credits`, and an entry with another kind or an end at or before its start is dropped; details keep only the fields of the `Details` type in [`service/plugin-api/src/index.js`](../../../../service/plugin-api/src/index.js), with at most 20 people, 10 genres, 15 tags, and 1,500 characters of description. Fill people's `role` (`cast`, `director`, `writer`, `channel`, …) and put the most important first.
- **Comments are kept by the node.** The node asks `comments` one 6-minute window at a time, keeps the answers per item (bounded, least recently used first), and serves them to the playing screen at `/m/{token}/comments` and to agents at `/internal/v1/comments`; a source does not cache them itself. `t` is in seconds, `mode` is `scroll` (the default), `top`, or `bottom`, `color` is `#rrggbb`, and `size` is relative to the normal one (0.5 to 2); Yolo drops comments without a time or text, cuts text to 100 characters, and keeps at most 20,000 per answer. Without `comments`, an item has none.

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

`yolo` offers `plugin`, `options`, `log`, `z` (the host's zod), `registerTool`, and `registerDnsProvider`, whose contract is in [DNS provider plugins](2026-10-14-dns-provider-plugins.md). Tool names are `lower_snake_case` and may not collide with Yolo's own tools or another plugin's. `scope` is the one OAuth scope a call needs; `annotations` default to "not read-only, not destructive"; `input` is a `z.object({...})`; `run(args, { services })` returns JSON for the agent, and a thrown `YoloError` becomes an `isError` result with its code. `services` is the service layer that MCP and `/v1` share. The factory runs on the first MCP request or the first run of the media names, not at the Worker's global scope.

### The official plugins

| Plugin | Source id | Source | What it does |
|---|---|---|---|
| `@useyolo/source-plex` (`plugins/source-plex`) | `plex` | `{ plugin: "plex", id: <ratingKey> }` | Library browsing and search (an episode or season naming its show and season as `parents`), details (with Plex's own progress, `resumeAt`), tracks, and artwork; claims no URL. It plays the car a 720p transcode (`videoBitrateKbps` or `PLEX_VIDEO_BITRATE_KBPS`, 4000–4800); under a lower `limits.maxVideoKbps`, its other checked rung, 480p at 1500 kbps, however low the cap ([adaptive quality](../feature/2026-10-11-adaptive-quality.md)). A `<video>` device gets Plex's direct stream at its own picture size where `limits.maxVideoKbps` carries more than 720p (1080p from 8 Mbps, 1440p from 12 Mbps, 2160p from 20 Mbps: on the LAN, and on remote direct play by default), with that limit as Plex's `maxVideoBitrate`, and the car's rungs under 8 Mbps, as on the relay ([capability negotiation](2026-10-07-capability-negotiation.md)). On the LAN path it plays the original part through the node when `playable()` says `direct`, nothing is burned in, and the chosen audio is the file's default ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)). It burns in image subtitles, and a subtitle file it cannot convert, but never a text subtitle it can read: text subtitles go as WebVTT, cached under the file they come from (a sidecar file's path, size, and modification time; for a track inside the media file, the file's path and size as Plex reports them and the track's index), so a library rescan that gives the item new ids keeps them. A track inside the file that is not extracted yet is a growing track: ffmpeg reads the 30-second chunks of the screen's window from the file, by its path or, when the node cannot read that path, through Plex's part URL, while the whole track is extracted in the background, one at a time ([capability negotiation](2026-10-07-capability-negotiation.md)). It starts at Plex's `viewOffset` when `startTime` is `null`, checks Plex's transcode list in `health()`, writes progress back to Plex, and stops the transcode in `stop()`. For `reason: "frame"` it gives the original part without a transcode or a track change ([video frames](../feature/2026-10-13-video-frames.md)). For agents it gives the same WebVTT outside playback (`subtitle`), Plex's intro and credits markers and the file's chapters (`chapters`), and Plex's summary, cast and crew (an episode with few of its own gets its show's), dates, genres, ratings, and watch record (`details`). Reads `options.url`/`token` in `start`, else `PLEX_URL`/`PLEX_TOKEN`, and on macOS finally the token from Plex Media Server's own preferences |
| `@useyolo/source-ytdlp` (`plugins/source-ytdlp`) | `ytdlp` | `{ plugin: "ytdlp", id: <normalized URL>, url: <original URL> }` | Claims every http(s) URL, takes metadata and subtitles from yt-dlp, and expands playlists. Plays by choosing a format up to the device's `maxHeight` (fast motion at most 1440p) under `limits.maxVideoKbps`, H.264 first in each height band and then the device's other announced codecs as byte-range MP4 in SDR, so a 1440p screen in Chrome gets YouTube's AV1 ([capability negotiation](2026-10-07-capability-negotiation.md)); returns HLS, a single file, or separate audio and video with the request headers and cache keys the CDN needs; re-resolves expired links; gives YouTube live streams a DVR index; downloads subtitles on demand into `cacheDir`, a whole WebVTT file before a segmented subtitle rendition; asks a site that refused a subtitle with 429 (YouTube does for its machine translations long before it limits its other captions) for it again only after the site's Retry-After, else after a minute, doubling with each refusal in a row to at most 15 minutes, and throws `rate_limited` meanwhile, since asking again at once lengthens the limit until it refuses every caption; offers a site's storyboard sprites, when yt-dlp lists them as formats, through `storyboard()`. For Bilibili it gives the danmaku through `comments()`: the comment XML yt-dlp names, or a segment of Bilibili's protobuf API when the XML fails, with the cookies file's cookies ([danmaku](../feature/2026-10-13-danmaku.md)). Bilibili's subtitles come from the same yt-dlp run, which asks for subtitles (`--write-subs`), since `-j` alone lists none of them; it starts alongside the formats, so a stream does not wait for it, and an `ai-<lang>` subtitle is a machine-made one in that language. Bilibili gives its subtitles only to a signed-in account: without its cookies (`cookiesFile` or `YTDLP_COOKIES_FILE`) there are none, and the node's log says so. Links that point straight at a media file (`.mp4`, `.webm`, `.m3u8`, …) skip yt-dlp. yt-dlp reads a Vimeo page (`vimeo.com/<id>`, an unlisted `vimeo.com/<id>/<hash>`, a video in a channel or showcase) only with a signed-in Vimeo account; when it answers that its web client needs a login, the plugin asks again for the embed player, `player.vimeo.com/video/<id>?h=<hash>`, which plays the same video anonymously, and asks the player directly for that page for an hour. The page stays the item's `id` and `url`, and with Vimeo cookies the page itself answers. When yt-dlp drops formats as DRM-protected, the plugin reads the master and first media playlist of the HLS it kept and refuses a stream that needs a DRM key (`resolve_failed`, not retryable), since no Yolo player can decrypt it. For Bilibili's upos links it races the mirrors where playback starts, hands the rest over as `alternates`, and starts on a smaller format when the fastest mirror is too slow for the selected one ([media pipeline](2026-10-11-node-media-pipeline.md)). For agents it gives the description, channel, dates, categories, tags, and counts (`details`), the uploader's chapters (`chapters`), and subtitle text outside playback (`subtitle`); these metadata calls and `describe` and `tracks` share one yt-dlp run per video for 10 minutes (16 videos). What it resolves for playing, a device's formats and YouTube's caption list, is reused while its links are at least 10 minutes from the expiry they carry (`expire`, `expires`, `deadline`), else for 10 minutes, for 8 resolutions, so a replay from history, a retry, or a recovery runs no yt-dlp; `refresh()` always resolves again, and `warm()` resolves a device's formats ahead without racing the mirrors. Options `binary`, `cookiesFile`, `cookiesFromBrowser`, else `YTDLP_COOKIES_FILE` and `YTDLP_COOKIES_FROM_BROWSER`; it runs anonymously when neither is set. Each call starts a short-lived yt-dlp process, so it needs no `start` |

Neither has a `control` entry; their tests are in each plugin's `test/` directory. For YouTube, yt-dlp must be 2026.08.19 or newer: older `ANDROID_VR` URLs play the start of a video but answer 403 when seeking further in.

### Writing a source plugin

[`plugins/source-example`](../../../../plugins/source-example/) is the reference plugin: one library of video links from its `options`, with `claim`, `libraries`, `items`, `search`, `describe`, `tracks`, and `prepare`, the optional `details`, `chapters`, `subtitle`, and `comments` from each item's `description`, `chapters`, `subtitles` (WebVTT files), and `comments`, and unit tests that call the factory with a fake `yolo` and need no node. A new source starts as a copy of it:

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
