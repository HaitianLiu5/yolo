# Agent Note: The node's media pipeline and source Inputs

Status: implemented

English | [中文](2026-10-11-node-media-pipeline.zh.md)

## Problem

Drive-In's server mixed provider logic with media delivery: Plex and yt-dlp code proxied byte ranges, rewrote HLS manifests, joined split audio and video, and cached segments, each in its own way. With sources moving into [plugins](2026-10-11-plugin-architecture.md), every plugin would otherwise reimplement HTTP serving, caching, expiry, and device handling, and each would need to see devices and media tokens.

## Decision

The media pipeline lives in the node's core ([`service/node/src/media/`](../../../../service/node/src/media/)) and serves everything under the same-origin `/m/{token}/…` ([same-origin passthrough](2026-10-07-same-origin-media-passthrough.md)). A source plugin only **describes its input**: `prepare(source, context)` says where and how to read, and never touches HTTP serving, the cache, or devices. `cache.js` is the disk segment cache, `hls.js` and `dash.js` the playlist transforms, `transcode.js` the ffmpeg fallback, and `upstream.js` bounded upstream fetches.

### prepare

```js
yolo.registerSource("example", {
  claim: (url) => ({ id: url, url }),
  async prepare(source, { capabilities, startTime, limits, chooseTracks }) {
    const media = await lookUp(source.url, { maxHeight: capabilities.maxHeight, maxKbps: limits.maxVideoKbps });
    const subtitles = media.captions.map((caption) => ({
      id: `sub_${caption.lang}`, kind: "subtitle", language: caption.lang, name: caption.label, format: "text", delivery: "vtt",
    }));
    const selected = chooseTracks({ subtitles, audio: [] });
    return {
      title: media.title,
      duration: media.seconds,
      startTime: startTime ?? 0,              // null: Yolo has no position; the source decides
      input: { type: "hls", url: media.playlistUrl, headers: { Referer: "https://video.example/" } },
      tracks: { subtitles, audio: [], selected },
      subtitle: async (id) => fetchVtt(media, id),     // WebVTT text
      refresh: async () => ({ type: "hls", url: (await lookUp(source.url)).playlistUrl }),
    };
  },
});
```

| Context field | Meaning |
|---|---|
| `capabilities` | The playing device's [capabilities](2026-10-07-capability-negotiation.md): `maxHeight`, preferred `video`/`audio` codecs, `delivery`, `subtitles`. Tesla is 720p with `avc1`/`mp4a` |
| `viewport` | The device's latest viewport, possibly `null` |
| `startTime` | Where to start; **`null` means Yolo has no position for this item**, so the source uses its own (Plex's `viewOffset`) or 0 |
| `reason` | `play`, `recovery`, `seek`, `quality`, `transfer`, `tracks` |
| `limits` | `{ maxVideoKbps }`: the node's cap (`STREAM_MAX_VIDEO_BITRATE_KBPS`, default 4800) or the device's lower [adaptive cap](../feature/2026-10-11-adaptive-quality.md), at least 200 kbps. The source chooses its format or transcode bitrate from it; when no format fits, it picks the smallest, not the best |
| `chooseTracks({ subtitles, audio })` | Applies the user's explicit choice, else the saved preference (this item's, or the latest), and returns `{ subtitles: [id…], audio: id \| null }`; `audio: null` is the source's default track |

| Descriptor field | Meaning |
|---|---|
| `input` | Where to read (required); see below |
| `title`, `duration` (seconds), `isLive`, `thumbnail` or `artwork` | As in `describe` |
| `startTime` | Where the device actually starts, default 0 |
| `profile` | `{ width, height, fps, videoKbps, audioKbps, split }`, which the device uses to judge bandwidth |
| `tracks` | `{ subtitles, audio, selected }`; each subtitle's `delivery` is `vtt` (sent to the device, several at once possible) or `burn` (drawn into the picture by the source; choosing it rebuilds the session) |
| `subtitle(trackId)` | WebVTT text of a `vtt` subtitle, or `{ pending: true, retryAfter }` while it is being prepared |
| `refresh()` | A new `input` when upstream links expire (near their `expire` parameter, or after a 403); Yolo replaces links by role, at most once per 30 seconds |
| `health()` | Whether the upstream session lives: `alive`, `expired`, or `unknown`. For an `input.transcoder`, a missing segment asks it; `expired` makes Yolo answer `410 SESSION_EXPIRED`, and the device rebuilds the session |
| `progress({ position, duration, status })` | Playback progress about every 30 seconds and on each status change, which the source may write back |
| `stop()` | Releases upstream resources (for example stops a transcode) when the session ends; may run more than once |

`prepare` may be slow (yt-dlp plus probing can take tens of seconds) but must be repeatable: recovery, seeking before the stream's start, and track changes call it again. A plugin never learns which device plays, and never sees the media token.

### Inputs and deliveries

| Input | Fields | Delivery to the device | What the node does |
|---|---|---|---|
| `file` | `url`, `headers?`, `cacheKey?`, `cache?`, `alternates?` | `{ type: "mp4", url }` | Proxies a progressive file (MP4, WebM) by byte range into the disk cache |
| `hls` | `url`, `headers?`, `cacheKey?`, `cache?`, `manifest?`, `maxBandwidth?`, `trimToStart?`, `transcoder?`, `live?` | `{ type: "hls", url }` | Rewrites every URI in the manifest and proxies segments. `manifest` is a master playlist the source already fetched (fetching again could start another transcode); `maxBandwidth` (bit/s) drops larger variants, keeping the smallest if all exceed it; `trimToStart` drops placeholder segments before `EXT-X-START`; `transcoder` means upstream segments may not exist yet, so Yolo retries briefly and asks `health()`; `cache: false` skips the disk cache; `live.parse(body)` turns a live DVR playlist into a sequence-addressed index for a bounded live window |
| `split` | `video` and `audio`, each with `url`, `headers?`, `cacheKey?`, `codec?`, `width?`, `height?`, `fps?`, `kbps?`, `alternates?`; `transcode?` | `{ type: "hls", url }` as fMP4 HLS whose segments are byte ranges of the originals; `{ type: "split-mp4", videoUrl, audioUrl }` without a `sidx`; ffmpeg-made HLS when transcoding | Probes the MP4 structure, builds playlists, checks segment integrity, and prefetches; uses ffmpeg when `transcode: true` or the node sets `DASH_TRANSCODE=1` |

`headers` go with every upstream request of the input, including HLS child playlists and segments. `cacheKey(url)` names the content behind an upstream URL, so CDN links with different signatures for the same file share the node's disk cache; when unsure it returns `null` and Yolo uses the URL itself, and Yolo appends the byte range to the key.

`alternates` (on `file` and on each side of `split`) are other URLs for the same bytes, in order of preference, such as the same signed link on other CDN mirror hosts. When a request stalls (6 seconds without new bytes), times out, or fails (5xx, 403, 404, 429), the node switches to the next URL **within the same device request** instead of retrying in place, and keeps using it for that side afterwards; only when every URL has failed does it fall back to `refresh()` and backoff. The official yt-dlp plugin uses this for Bilibili's upos links (`upos-*.bilivideo.com`): the candidates are yt-dlp's host, `upos-sz-mirrorali`, `upos-sz-mirrorhw`, and yt-dlp's backup URLs (except Akamai's, whose signatures are bound to the host); `prepare` probes them in parallel with 512 KB range requests (at most 3 seconds; once the fastest finishes, the rest get half that time again), ranks them by sustained throughput, and returns the fastest as `url` and the rest as `alternates`.

Subtitles marked `vtt` are served at `/m/{token}/sub/{n}.vtt` from the plugin's `subtitle(id)`; `burn` subtitles are drawn by the source.

### The stream descriptor sent to devices

The node's `prepare` answer is the `stream` of the realtime `load` message:

```js
{
  sessionId: "ses_…",
  delivery: { type: "hls" | "mp4" | "split-mp4", url: "/m/{token}/…" },  // split-mp4 has videoUrl + audioUrl
  profile: { width, height, fps, videoKbps, audioKbps, split } | null,
  title, duration, isLive,
  liveDvr: { available: true, defaultLatencySeconds: 30 } | null,
  thumbnail,
  startTime,                        // the real start (the source may change it, e.g. Plex's viewOffset)
  limits: { maxVideoKbps, ceilingKbps, capped },  // the cap used; capped: the device's cap is below the node's
  tracks: {
    subtitles: [Track & { delivery: "vtt" | "burn", url? }],
    audio: [Track & { detail? }],
    selected: { subtitles: [id…], audio: id | null },
  },
}
```

## Alternatives considered

**Each source serves its own HTTP and caches its own segments**, as Drive-In's server did per provider. Every plugin would reimplement range proxying, manifest rewriting, caching, and expiry, and would need to see devices and media tokens; with the pipeline in the core, a plugin only describes an Input and gets all of it.

**Recover a stalled request with `refresh()` instead of `alternates`.** `refresh()` re-resolves the item (several seconds with yt-dlp), runs at most once per 30 seconds, and replaces links only by role, so it cannot rescue a single stalled segment in time.

## Consequences

Every source gets the same byte-range proxy, disk cache, HLS rewriting, split-to-HLS joining, ffmpeg fallback, WebVTT delivery, and typed expiry, and plugins stay small and provider-specific. The node now carries the heaviest code in Yolo, and the Input shapes are a contract that plugins depend on, so they change only with the plugin API's experimental status in mind. A device sees one same-origin delivery whatever the provider, which is what lets the Tesla client stay provider-neutral.
