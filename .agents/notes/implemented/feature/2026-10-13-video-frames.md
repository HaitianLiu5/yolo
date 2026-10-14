# Agent Note: Agents see frames of a video

Status: implemented

English | [中文](2026-10-13-video-frames.zh.md)

## Problem

An agent that plays and controls videos cannot see them. To answer "what is on the screen" or "what happens at 12:34", the owner photographed the car's screen and sent the photo to the agent. The agent needs the picture of a video at a moment, from Yolo, without the owner's hands, and a way to skim a whole video without asking for dozens of pictures one by one.

## Decision

The MCP tool `get_frame` and `GET /v1/frame` return one JPEG of a video at one moment, and `get_storyboard` and `GET /v1/storyboard` one JPEG grid of evenly spaced moments ([storyboards](#storyboards)). The media node reads them from the source, the way it would stream the item; no screen is asked, so they work while every screen is asleep, and for an item that is not playing.

### What the agent asks for

| Argument | Meaning |
|---|---|
| `time` | Seconds, `"mm:ss"`, or `"hh:mm:ss"`, with fractions (`parseTimestamp` in [`service/core/src/timestamp.js`](../../../../service/core/src/timestamp.js)). Without it, the Hub's position of the item playing now, extrapolated as the Hub does (`currentPosition`) and kept one second before the end |
| `item_id` | The item, a library item id or a URL; without it, the item the Hub holds now, playing or paused. Another item needs a `time` |
| `width` | The largest width, 160 to 1920 pixels, default 1280. The picture also fits a square of that size, keeps its aspect ratio, and is never enlarged |

The tool answers with an MCP image content block (`image/jpeg`) and a text block: the title, the time used (`h:mm:ss.mmm` and seconds, with the item's length), the source plugin and what the frame was read from, the picture's size, and whether the item is the one playing now. `/v1/frame?source=&time=&width=` answers with the JPEG and the headers `x-yolo-frame-time`, `x-yolo-frame-title` (URI-encoded), `x-yolo-frame-source`, and `x-yolo-frame-input`. Both need the `read` scope.

### How the node reads a frame

The Worker calls `POST /internal/v1/frame` through `nodeFetch()` with `{ source, time, width, sessionId }`; `sessionId` is set when the item is the one the Hub plays now. The node ([`service/node/src/media/frames.js`](../../../../service/node/src/media/frames.js)) reads in this order:

1. **The playing session's own bytes** (`frameSource` in [`pipeline.js`](../../../../service/node/src/media/pipeline.js)). When a split stream's video segment at `time` is in the disk cache, ffmpeg decodes it with the init segment the session kept from its probe, so the frame the screen shows now costs no upstream request. Otherwise ffmpeg reads the session's Input with the URLs the session uses now, after any `refresh()`. A transcoding source's session (`transcoder: true`) is skipped: its segments exist only near where the device plays.
2. **A fresh `prepare()`** with `reason: "frame"` ([source plugin API](../architecture/2026-10-11-source-plugin-api.md)): `startTime` is the frame's time, `network` is `"lan"` and `playable()` says `direct` for every file, because the node itself reads the item and ffmpeg decodes any container; `chooseTracks()` chooses no subtitle, and the capabilities ask for a picture about as tall as `width` needs. The source's `stop()` runs as soon as the frame is read, and also when `prepare()` finishes after the deadline.
3. **ffmpeg** seeks before it opens the input (`-ss` before `-i`, accurate to the frame), sends the Input's headers, decodes `-frames:v 1`, scales, converts to full-range YUV, and encodes JPEG. A `file` Input is read by its URL, a `split` Input by its video track, and an `hls` Input by its playlist; of a master playlist, the node picks the smallest variant at least `width` wide, else the largest. Of fMP4 HLS (a playlist with `EXT-X-MAP` and no encryption) the node fetches the init section and the one segment `time` falls in and pipes them to ffmpeg, which decodes from the segment's start to `time`, as from a cached segment: ffmpeg before 7, such as Ubuntu 24.04's 6.1, gives no frame when it seeks into fMP4 HLS. When that segment cannot be fetched or gives no frame, ffmpeg reads the playlist as above; a segment the source refuses (401, 403) or no longer serves (404) fails the frame at once, because ffmpeg would get the same answer.

The official Plex plugin answers `reason: "frame"` with the part's original file on the home network: no transcode starts, no subtitle is converted, and the part's track selection in Plex stays as the owner left it. The yt-dlp plugin skips its subtitle lookup and keeps the format it would choose. A plugin that does not know the reason treats it as a play, and its Input still works.

### Storyboards

`get_storyboard` lets an agent skim a video in one call ([`frames.js`](../../../../service/node/src/media/frames.js), [`storyboard-image.js`](../../../../service/node/src/media/storyboard-image.js)). It takes `item_id`, an item id or a URL (by default the item playing now), `from` and `to` (by default the whole item), `count` (2 to 30, default 12), and `width`, each tile's width (80 to 480, default 320). The tiles show the middles of `count` equal parts of the range, so neither the first black frame nor the very end appears, in a grid about 16:9, each labelled with its time in white on a darkened box. The labels are drawn by the node with a built-in 5×7 digit font, so no font file and no ffmpeg text filter is needed. The answer lists the tiles' times; a tile that could not be read stays dark and is listed as missing.

The tiles come from one of two places:

1. **The source's own storyboard images**, when its plugin implements `storyboard(source)` and answers with sheets ([source plugin API](../architecture/2026-10-11-source-plugin-api.md)): sprite images of `columns` × `rows` thumbnails, each sheet covering `duration` seconds from `start`, one tile every `interval` seconds. The node downloads each sheet it needs once (at most 4 MiB each), cuts the tile nearest each time, and labels it with that tile's own time. This costs no video reads. The yt-dlp plugin offers a site's storyboard sprites when yt-dlp lists them as formats, the largest set. A source's storyboard gets at most 10 seconds, and frames follow when it fails or gives no tile.
2. **Frames read by the node**, as for `get_frame` (the playing session's bytes, else `prepare()` with `reason: "frame"`), three at once, each at its exact time.

### Limits

| Limit | Value | Where |
|---|---|---|
| Time | 15 seconds on the node for `prepare()` and ffmpeg together, 30 for a storyboard; the Worker waits 18 and 36 | `FRAME_TIMEOUT_MS` and `STORYBOARD_TIMEOUT_MS` in `frames.js` and `services.js` |
| A stalled upstream read | 8 seconds (`-rw_timeout`) | `frames.js` |
| Image | At most 1.5 MiB, a storyboard 2 MiB: JPEG quality 3, encoded again at 9 when larger | `MAX_FRAME_BYTES`, `MAX_STORYBOARD_BYTES` |
| At once | 2 frame or storyboard requests on the node; a third gets `rate_limited` at once, not a queue. A storyboard reads 3 frames at once | `MAX_FRAME_REQUESTS`, `TILE_CONCURRENCY` |
| Per agent | 20 frames and 20 storyboards a minute, counted by the `FRAME_LIMIT` rate-limit binding per user and OAuth client, or per paired device; without the binding, per Worker isolate | `frameLimiter` in [`rate-limit.js`](../../../../service/control/src/rate-limit.js) |

### Errors

| Case | Code |
|---|---|
| Nothing playing and no item named | `invalid_request` |
| Another item without a `time`, or a `time` that is not seconds or a clock | `invalid_request` |
| A `time` past the end | `invalid_request`, naming the item's length |
| A storyboard of an item of unknown length without `to`, or with `to` before `from` | `invalid_request` |
| A live stream, which has no fixed frames | `invalid_request` |
| The node unreachable | `node_offline` |
| A node from a release without frames | `not_found`, asking to upgrade the node |
| The source refused, ffmpeg found no frame, or 15 seconds passed | `resolve_failed` |
| Over a limit | `rate_limited` |

### Privacy

- **Scope.** A frame is a read of the owner's own library and playback, like `search`, `list_tracks`, and `get_status`, so it needs `read`, which every existing grant has: agents get `get_frame` without consenting again. The consent page describes `read` as "What's playing, your library and history, and pictures from your videos" ([`auth/pages.js`](../../../../service/control/src/auth/pages.js)), and an owner who wants no agent to see pictures switches `read` off there.
- **Nothing is stored.** The JPEG passes through the node's and the Worker's memory and leaves with the answer, marked `no-store` on `/v1`. ffmpeg reads from the network or from a pipe and writes nothing to disk.
- **Logs say only that a frame was served.** The Worker writes `{ kind: "frame", event: "served", userId }` (`storyboard_served` for a storyboard) to Workers Logs, without the item, the time, or the agent ([device telemetry](2026-10-11-device-telemetry.md)). ffmpeg's error output can quote signed upstream URLs, so the node only classifies it and never logs or returns it.

## Alternatives considered

**Capture what a screen shows.** A screen is a browser page, which cannot capture the display without a permission prompt and a tap (`getDisplayMedia`). Capturing Yolo's own page needs either rendering the page's DOM into an image inside the car's browser, or sending a DOM snapshot to the node for a headless browser to render, plus a consent switch on each screen and an indicator during each capture. It works only while that screen is awake, and only for the moment it shows. A frame from the source answers both "what is on the screen" and "what happens at 12:34", with no screen and no screen-side consent. It loses the player's controls and subtitles, and anything the screen got wrong, such as a frozen picture.

**A new scope for frames.** A frame shows the owner's own videos, which `read` already lists, describes, and gives thumbnails of; a new scope would make every connected agent consent again for a read-only tool. The cost is that an owner cannot grant status reads without frames.

**Read through the node's own `/m/*` URLs.** Every frame would open a pipeline session, which reuses its cache and failover, but counts against the node's session limit, which retires the oldest session, possibly the playing one; a split Input's session also probes both files first. One ffmpeg process on the Input reads less, and the playing session's cached segment is still used.

**A source's own still images for single frames.** Some servers make thumbnails or index images at fixed intervals, but not every source has them, they are small, and they cannot show an exact time; the Input works for every source. A storyboard is different: its tiles are small and only need to be near their times, so a source's own images are preferred there, and frames remain the fallback.

**Storyboards always from frames.** Every tile would cost a seek into the video: the index and a keyframe interval, from the source's servers, for each of up to 30 tiles. A site's storyboard sprites cover the whole video in a few small images.

**Labels drawn by ffmpeg.** ffmpeg's `drawtext` filter needs a font file, whose path differs between systems, and a build with FreeType. The node's own digit font is a few lines and the same everywhere.

## Consequences

An agent can look at what plays, or at any moment of an item, in one call, skim a whole item in another, and the owner no longer photographs the screen. A storyboard from a source's own images shows the nearest tiles it has, which can be seconds away from the even spacing, and its times say so. The picture is the source's, not the screen's: it has no player controls or subtitles, and it does not show a stall or a decoding fault the screen had. A frame of an item that is not playing costs a `prepare()`, which takes some sources seconds, and the upstream reads of one keyframe interval. Every agent with `read` can see the owner's videos. The `FRAME_LIMIT` binding is in the Worker's template, so a Worker deploy brings it, and the node needs a restart to serve `/internal/v1/frame`.
