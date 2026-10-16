# Agent Note: A refused read-ahead is not the end of a stream

Status: implemented

English | [中文](2026-10-16-refused-read-ahead.zh.md)

## Problem

A Tesla showed the error panel, "This video can't play right now.", 8 seconds before the end of a 30-minute YouTube video, instead of ending it. Eleven seconds before the end, [adaptive quality](../feature/2026-10-11-adaptive-quality.md) had asked for a stream at a lower bitrate (`why: "draining"`), and that new session started on links from the yt-dlp plugin's resolution cache; YouTube's CDN refused them, and the node refreshed them ([media pipeline](../architecture/2026-10-11-node-media-pipeline.md)). The car's canvas engine reads up to 210 seconds ahead, so it asked for every remaining segment within seconds of that refresh. Two defects let one refusal at that time end the stream:

- **The node gave up on links it had already replaced.** A range that began with the old links and was refused after the refresh had finished asked for a refresh again. Within the refresh's 30-second cooldown the answer was no, and the node answered `403 UPSTREAM_ACCESS_DENIED`, though the session had fresh links.
- **The car took a read-ahead's refusal as final.** The HLS prefetcher marked the segment and its whole playlist as denied ([`hls-segment-prefetcher.js`](../../../../clients/player/src/engine/hls-segment-prefetcher.js)), and nothing asked for that track again. When playback reached the first segment it lacked, the stored error became the engine's, and the player does not recover from `UPSTREAM_ACCESS_DENIED`. Yolo never heard `ended`, and the item stayed in history 8 seconds short of its end.

### What the logs show

Workers Logs of 2026-10-16 (UTC) for the car, which played through the relay with the canvas engine. The item is 1835 seconds long, HLS with separate audio and video.

- **The old session, at 1080p.** Between 03:26:02 and 03:26:12 the owner seeked six times, last from 1551 to 1646 and then from 1647 to 1548. The two read-ahead requests cancelled then (video segments 348 and 349) were those seeks' own cancels.
- **From 03:27:12 to 03:30:42 the read-ahead fetched nothing.** The buffer ahead fell from 210 to 128, 68, 38, and 7.9 seconds while its end stayed at about 1825.6 seconds, the start of the last audio segment (182, of about 10.03 seconds each), which was never requested. 295 segments were cached, 133,823,214 bytes or 99.7% of the 128 MiB cap, and nothing was pending, downloading, or failed.
- **At 03:30:48, at 1823.68 seconds,** `quality_change_requested` asked for a lower bitrate with `why: "draining"`, on a throughput estimate of 408 kbps that no download had renewed for 3.5 minutes, against 1151 kbps of media, with nothing buffered ahead. That started the new session 11 seconds before the end. Its segments were refused during the node's link refresh, by the two defects above, and the car showed the error panel.

The downgrade is fixed in adaptive quality: no quality change on an estimate that no download renewed for 30 seconds while nothing downloads, and none in the last 20 seconds of an item. Why the read-ahead stopped is not yet reproduced. On the code the car ran, two setups ruled out three causes, each with the cache at its cap: real Mediabunny reading through the prefetcher on a fixture shaped like this item, and the car's canvas engine in Chromium. The ruled-out causes:

- Eviction stopping at the byte cap: it could always evict all but each playlist's next six segments, and a job it blocked would have been logged as queued.
- The read-ahead window staying shut after the +95/−99-second seek pair: in every run, audio 182 was asked for once audio 161 was read.
- Mediabunny reading segments it still held without asking the prefetcher: that delays the window only until the first segment it does not hold.

By the prefetcher's code, a buffer that drains below 210 seconds with no job in any state means the missing segment lay outside the playlist the prefetcher parsed, or the reads that move its window never reached it. Each health heartbeat now logs every playlist's position, length, window end, and jobs by state ([device telemetry](../feature/2026-10-11-device-telemetry.md)), which tells those apart the next time.

## Decision

- **The node asks again with the links a refresh put in place.** `refresh(session, { since })` in [`pipeline.js`](../../../../service/node/src/media/pipeline.js) answers yes when a refresh finished after the refused request began, so the request is asked again with the session's current links, also within the cooldown. A refusal of those links within the cooldown is final, as before. This holds for split ranges (whose hedged attempts keep the links they began with), files, and HLS playlists.
- **In the car, only playback's own refusal is final.** A 401 or 403 to a read-ahead request (`?prefetch=1`) leaves the segment in its retry cycle, like a network failure: it is asked for again after 1, 2, 4, … seconds, at most 30 seconds apart, and the playlist's other segments are read ahead meanwhile. Playback that needs the segment while it waits asks for it itself. A 401 or 403 to that request is final for the playlist and shows the error panel ([canvas engine](../architecture/2026-04-04-canvas-playback-engine.md)).

### Testing

[`media-pipeline.test.js`](../../../../service/node/test/media-pipeline.test.js) refuses a split segment with the old links after the refresh has finished. [`hls-segment-prefetcher.test.js`](../../../../clients/player/test/unit/hls-segment-prefetcher.test.js) refuses a read-ahead twice and checks that its retry cycle reads it, and that playback waiting on a refused read-ahead asks itself. [`test/e2e/ytdlp-playback.test.js`](../../../../test/e2e/ytdlp-playback.test.js) plays separate audio and video files to their end in the car and in the web profile, with and without a queue item, and in the car also with the links refused once (a refresh) and the last audio segment refused while the car reads it ahead.

## Alternatives considered

**Stop reading the refused playlist ahead until playback asks.** The canvas engine resumes after a stall only with 3 seconds of encoded media cached on every playlist. With the missing segment inside those 3 seconds, a stall from a decoder hiccup waits for a read-ahead that never comes, and playback never reaches the segment to ask for it. The end-to-end test stalled that way.

**Recover from `UPSTREAM_ACCESS_DENIED` with a fresh stream.** A source that refuses for good, such as a removed video, would rebuild the session again and again. And the refusal that ended this stream came to a read-ahead long before playback needed the bytes, when the node could already serve them.

**Drop the 30-second refresh cooldown.** Every refusal from a source that keeps refusing would run yt-dlp again. The cooldown stays; only links a refresh already replaced are asked again.

## Consequences

A refusal around a refresh, or a brief refusal by the CDN, no longer ends a stream in the car. A source that keeps refusing gets one read-ahead request per refused segment and cycle, at most 30 seconds apart, until playback reaches the segment and its own refusal shows the error panel.
