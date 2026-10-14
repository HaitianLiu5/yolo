# Agent Note: The node's media pipeline and source Inputs

Status: implemented

English | [中文](2026-10-11-node-media-pipeline.zh.md)

## Problem

The earlier single-process server mixed provider logic with media delivery: Plex and yt-dlp code proxied byte ranges, rewrote HLS manifests, joined split audio and video, and cached segments, each in its own way. With sources moving into [plugins](2026-10-11-plugin-architecture.md), every plugin would otherwise reimplement HTTP serving, caching, expiry, and device handling, and each would need to see devices and media tokens.

## Decision

The media pipeline lives in the node's core ([`service/node/src/media/`](../../../../service/node/src/media/)) and serves everything under `/m/{token}/…`, through the control plane's [same-origin passthrough](2026-10-07-same-origin-media-passthrough.md) and on the node's LAN listener ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)). A source plugin only **describes its input**: `prepare(source, context)` says where and how to read, and never touches HTTP serving, the cache, or devices. `cache.js` is the disk segment cache, `hls.js` and `dash.js` the playlist transforms, `transcode.js` the ffmpeg fallback, `upstream.js` bounded upstream fetches, `hedge.js` hedged reads of one byte range across mirror URLs, `hosts.js` the node's memory of each upstream host, and `playable.js` the prepare context's `playable()`.

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
| `capabilities` | The playing device's [capabilities](2026-10-07-capability-negotiation.md): `maxHeight`, preferred `video`/`audio` codecs, `delivery`, `containers`, `subtitles`. Tesla is 720p with `avc1`/`mp4a` |
| `viewport` | The device's latest viewport, possibly `null` |
| `startTime` | Where to start; **`null` means Yolo has no position for this item**, so the source uses its own (Plex's `viewOffset`) or 0 |
| `reason` | `play`, `recovery`, `seek`, `quality`, `transfer`, `tracks`, or `frame`: no device plays, and the node reads one picture at `startTime` itself ([video frames](../feature/2026-10-13-video-frames.md)) |
| `limits` | `{ maxVideoKbps }`: the node's ceiling for the media path (`LAN_MAX_VIDEO_KBPS` on the LAN, default 200,000; `WAN_MAX_VIDEO_KBPS` on remote direct play, default 20,000; `STREAM_MAX_VIDEO_BITRATE_KBPS` on the relay, default 4800) or the device's lower [adaptive cap](../feature/2026-10-11-adaptive-quality.md), at least 200 kbps. The source chooses its format or transcode bitrate from it; when no format fits, it picks the smallest, not the best |
| `network` | `"lan"` when the device plays from the node's LAN listener, where the original file may play as it is; else `"tunnel"`, on every path that crosses the home uplink: remote direct play or the relay ([media off the Worker](2026-10-13-media-off-the-worker.md)) |
| `playable(media)` | Whether the device plays a file as it is: `{ decision: "direct" \| "remux" \| "audio" \| "transcode", reasons }` from a provider-neutral `{ container, video, audio, kbps }` ([LAN direct play](../feature/2026-10-12-lan-direct-play.md)) |
| `chooseTracks({ subtitles, audio })` | Applies the user's explicit choice, else the saved preference (this item's, or the latest), and returns `{ subtitles: [id…], audio: id \| null }`; `audio: null` is the source's default track |

| Descriptor field | Meaning |
|---|---|
| `input` | Where to read (required); see below |
| `title`, `duration` (seconds), `isLive`, `thumbnail` or `artwork` | As in `describe` |
| `startTime` | Where the device actually starts, default 0 |
| `profile` | `{ width, height, fps, videoKbps, audioKbps, split }`, which the device uses to judge bandwidth |
| `maxVideoKbps` | A cap below `limits.maxVideoKbps` that the source chose its formats under, for example because its upstream measured slow; the stream then reports `limits.capped: true` at this cap, so the device's [adaptive quality](../feature/2026-10-11-adaptive-quality.md) can step up from it |
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
| `hls` | `url`, `headers?`, `cacheKey?`, `cache?`, `manifest?`, `maxBandwidth?`, `trimToStart?`, `transcoder?`, `live?` | `{ type: "hls", url }` | Rewrites every URI in the manifest and proxies segments. `manifest` is a master playlist the source already fetched (fetching again could start another transcode); `maxBandwidth` (bit/s) drops larger variants, and so does the device's `maxHeight` for taller ones (a `RESOLUTION` above it), because a player takes the best variant it is given and the canvas engine always does; the smallest stays if all exceed them; `trimToStart` drops placeholder segments before `EXT-X-START`; `transcoder` means upstream segments may not exist yet, so Yolo retries briefly and asks `health()`; `cache: false` skips the disk cache; `live.parse(body)` turns a live DVR playlist into a sequence-addressed index for a bounded live window: around the play cursor with a runway of segments not yet published for the canvas engine, and ending at the newest segment, 5 minutes deep, for any other player |
| `split` | `video` and `audio`, each with `url`, `headers?`, `cacheKey?`, `codec?`, `width?`, `height?`, `fps?`, `kbps?`, `alternates?`; `transcode?` | `{ type: "hls", url }` as fMP4 HLS whose segments are byte ranges of the originals; `{ type: "split-mp4", videoUrl, audioUrl }` without a `sidx` for the canvas engine, and ffmpeg-made HLS then for any other player; ffmpeg-made HLS when transcoding | Probes the MP4 structure of both files at once, builds playlists, reads each segment as described under [Segment reads](#segment-reads) and streams it to the device as its bytes arrive, checks segment integrity, and prefetches; uses ffmpeg when `transcode: true` or the node sets `DASH_TRANSCODE=1` |

`headers` go with every upstream request of the input, including HLS child playlists and segments. `cacheKey(url)` names the content behind an upstream URL, so CDN links with different signatures for the same file share the node's disk cache; when unsure it returns `null` and Yolo uses the URL itself, and Yolo appends the byte range to the key. A cache entry appears whole or not at all: its bytes go to a temporary file that is renamed into place before its description is written, and a body that fails, is abandoned, or ends with a different length than its `Content-Length` is not kept. One request at a time writes an entry; another request for the same entry meanwhile reads upstream without writing.

`alternates` (on `file` and on each side of `split`) are other URLs for the same bytes, such as the same signed link on other CDN mirror hosts, in the order to try them when the node knows nothing better. The node ranks them by what it has seen of each host lately, across sessions and resources (`hosts.js`): a fault (an error, a reset, a short body, or an attempt that stalled or was too slow and lost to a hedge) demotes the host, and faults halve every 3 minutes, so one fault demotes it for about 3 minutes and repeated faults for longer; among hosts with equal faults the one measured faster for the same file goes first, because an edge cache can be fast for one file and cold for the next (within 25% counts as equal; a host not yet measured for the file counts as fast as the best, so a new file follows the order given). No host is preferred by name, because a mirror's quality changes by the hour and by byte range. A split segment and the split probe are read with hedged attempts across the ranked URLs ([Segment reads](#segment-reads)); a `file` request moves to the next URL **within the same device request** when one fails or gives no headers within 6 seconds. Only when every URL has refused a request does the node fall back to `refresh()`.

The official yt-dlp plugin uses `alternates` for Bilibili's upos links. The candidates are yt-dlp's URL, the same path and query on `upos-sz-mirrorcosov`, `upos-sz-mirrorali`, and `upos-sz-mirrorhw`, and yt-dlp's backup URLs. A URL signed for an Akamai host (`upos-*.akamaized.net`) is served by those mirrors too, but Akamai refuses a URL signed for a bilivideo host, so Akamai is never added. `prepare` probes the candidates in parallel with 512 KB range requests where playback starts in the file (at most 3 seconds; once the fastest finishes, the rest get half that time again, at least 300 ms), ranks them by throughput over the whole probe, and returns the fastest as `url` and the rest as `alternates`. When the fastest one's probe rate, its first-byte wait included, is below the selected video and audio bitrate, a play, recovery, seek, transfer, or track change starts on the best smaller video format of the same codec that fits, or the smallest, and says so with the descriptor's `maxVideoKbps`; a device's own step up (`reason: "quality"`) and `refresh()` keep the format.

### Segment reads

`hedge.js` reads one byte range from the ranked URLs and hands every byte to its readers as it arrives, so the device's time to first byte is the upstream's, not the whole segment's. One read per segment is shared by the device's request, its retries, and the node's read-ahead, and the finished segment goes to the disk cache. An attempt reads from the first byte not yet received; a new attempt on the next URL starts from that offset and races the running one, and whichever reaches the end first completes the segment while the other is cancelled.

The thresholds are derived from the canvas engine's segment timeout: it abandons a request after 12 seconds without network progress, the wait for headers included (`DEFAULT_INACTIVITY_TIMEOUT_MS` in [`hls-segment-prefetcher.js`](../../../../clients/player/src/engine/hls-segment-prefetcher.js), `DEVICE_SEGMENT_TIMEOUT_MS` in [`hedge.js`](../../../../service/node/src/media/hedge.js)), and every node threshold below ends inside it, with 2 seconds left for the passthrough and the car's connection.

| Threshold | Value | What happens |
|---|---|---|
| No first byte | 1.5 s | A hedge starts on the next URL |
| No new byte | 2 s | A hedge starts on the next URL from the byte offset reached |
| Too slow | over 5 s for the rest at the leading attempt's rate | A hedge starts on the next URL from the byte offset reached |
| Failed attempt | at once | A new attempt replaces it; a URL that already failed waits 250 ms, doubling, at most 2 s |
| No progress at all | 10 s (12 s − 2 s) | The read fails: the device gets a `504` with code `UPSTREAM_TIMEOUT` before any byte, or an aborted body after some, and retries |
| Bounds | 2 attempts at once, 6 in all | A segment never costs more than twice its remaining bytes at once |

Three mirrors each get their first-byte chance within 4.5 seconds, well before the read gives up.

Subtitles marked `vtt` are served at `/m/{token}/sub/{n}.vtt` from the plugin's `subtitle(id)`; `burn` subtitles are drawn by the source.

A session of an item whose source implements `comments` also serves the item's timed comments as JSON at `/m/{token}/comments?start=&end=`, from the node's comment store, which the internal API's `/internal/v1/comments` shares; a live stream has none ([danmaku](../feature/2026-10-13-danmaku.md)).

Agents' frames and storyboards are read from the same Inputs by [`frames.js`](../../../../service/node/src/media/frames.js), outside any session: ffmpeg reads a `file` Input's URL, a `split` Input's video track, or one variant of an `hls` Input's playlist, with the Input's headers. A frame of the playing item first uses the session's own bytes: `frameSource()` gives the Input with the URLs the session reads now, and a split stream's video segment from the disk cache together with the init segment the session kept from its probe ([video frames](../feature/2026-10-13-video-frames.md)).

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
  trimToStart,                      // an hls Input with trimToStart: the stream may begin at startTime, not at 0
  limits: { maxVideoKbps, ceilingKbps, capped },  // the cap used; capped: the device's or the source's cap is below the node's
  network: "tunnel" | "lan",        // "lan": serve from the node's LAN listener
  origin: "https://yolo-lan-….example:9443" | null,  // the LAN origin, or null for the page's own
  tracks: {
    subtitles: [Track & { delivery: "vtt" | "burn", url? }],
    audio: [Track & { detail? }],
    selected: { subtitles: [id…], audio: id | null },
  },
  comments: "/m/{token}/comments" | null,  // the item's timed comments, when its source can have them
}
```

## Alternatives considered

**Each source serves its own HTTP and caches its own segments**, as the earlier single-process server did per provider. Every plugin would reimplement range proxying, manifest rewriting, caching, and expiry, and would need to see devices and media tokens; with the pipeline in the core, a plugin only describes an Input and gets all of it.

**Recover a stalled request with `refresh()` instead of `alternates`.** `refresh()` re-resolves the item (several seconds with yt-dlp), runs at most once per 30 seconds, and replaces links only by role, so it cannot rescue a single stalled segment in time.

**Fail over only after a stall, and keep the switch per resource.** A 6-second stall or header timeout, a full re-download from the next mirror, and retries add up to more than the device's 12-second timeout, so the device gave up while the node was still failing over. The switch was also forgotten by the other track, the next session, and a refresh, which moved back to the probe's choice.

**Buffer each segment whole before answering.** The device's time to first byte was then the whole upstream download, and a slow but progressing mirror tripped the device's header timeout.

**Prefer a mirror host by name.** Measured from the home node, the same host gave 172 kbps one day and up to 70 Mbps the next, and on one day it was fast for a file's head and stalled deep in the file; only live measurement and recent experience rank hosts correctly.

## Consequences

Every source gets the same byte-range proxy, disk cache, HLS rewriting, split-to-HLS joining, ffmpeg fallback, WebVTT delivery, and typed expiry, and plugins stay small and provider-specific. The node now carries the heaviest code in Yolo, and the Input shapes are a contract that plugins depend on, so they change only with the plugin API's experimental status in mind. While a hedge runs, a segment's remaining bytes may come from two mirrors at once. A segment that fails after its first bytes reaches the device as an aborted body, not an error status. The node's memory of hosts lives in the process and starts empty after a restart. A device sees one delivery whatever the provider, on its own origin or on the node's LAN origin, which is what lets the player stay provider-neutral.
