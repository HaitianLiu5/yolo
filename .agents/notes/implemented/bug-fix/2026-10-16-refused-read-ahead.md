# Agent Note: A refused read-ahead is not the end of a stream

Status: implemented

English | [中文](2026-10-16-refused-read-ahead.zh.md)

## Problem

A Tesla showed the error panel, "This video can't play right now.", 8 seconds before the end of a 30-minute YouTube video, instead of ending it. A seek near the end had started a new session on links from the yt-dlp plugin's resolution cache; YouTube's CDN refused them, and the node refreshed them ([media pipeline](../architecture/2026-10-11-node-media-pipeline.md)). The car's canvas engine reads up to 210 seconds ahead, so it asked for every remaining segment within seconds of that refresh. Two defects let one refusal at that time end the stream:

- **The node gave up on links it had already replaced.** A range that began with the old links and was refused after the refresh had finished asked for a refresh again. Within the refresh's 30-second cooldown the answer was no, and the node answered `403 UPSTREAM_ACCESS_DENIED`, though the session had fresh links.
- **The car took a read-ahead's refusal as final.** The HLS prefetcher marked the segment and its whole playlist as denied ([`hls-segment-prefetcher.js`](../../../../clients/player/src/engine/hls-segment-prefetcher.js)), and nothing asked for that track again. When playback reached the first segment it lacked, the stored error became the engine's, and the player does not recover from `UPSTREAM_ACCESS_DENIED`. Yolo never heard `ended`, and the item stayed in history 8 seconds short of its end.

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
