# Agent Note: Pictures of the moment while scrubbing on the Apple clients

Status: implemented

English | [中文](2026-11-07-scrub-previews.zh.md)

## Problem

Dragging the timeline on the iPhone and iPad app showed only a time, and scrubbing on the Apple TV showed the system's bar with no picture, because a stream rarely carries the I-frame playlist AVKit needs. Finding a scene meant seeking, waiting for the stream, and trying again. The owner wants what Infuse gives: the moment's picture over the timeline, following the scrub.

## Decision

The media node serves a small picture of any moment of a session's video, and the Apple clients show it over the timeline while the owner scrubs.

### What the node serves

The stream descriptor's `previews` is `/m/{token}/preview`, or null for a live stream and on a node without previews. `GET /m/{token}/preview/{seconds}.jpg` answers a JPEG at most 480 pixels wide, near that moment rather than exact, authorized by the media token like every `/m/*` URL and reached by the stream's media path. A moment past the end answers `400`, a stream without previews `404`, and a node with no room `429`.

The node ([`frames.js`](../../../../service/node/src/media/frames.js), `preview`) reads the picture from the first of these that works, using the same readers as [agents' frames](2026-10-13-video-frames.md):

1. **Memory.** Pictures already read, 64 MiB at most, by item and moment, so a stream of the same item finds them too.
2. **The source's own storyboard images**, the tile nearest the moment. A first preview waits 500 ms for the lookup and reads a frame if it is slower. Eight sheets stay in memory.
3. **The nearest keyframe at or before the moment** (`-skip_frame nokey`), which decodes nothing else: from the playing session's cached segment, its one fMP4 HLS segment, or a fast seek in its Input. What the playlists said is kept for 60 seconds. A transcoding source's session, whose segments exist only near where the device plays, reads the item a `prepare()` with `reason: "frame"` gives, kept until 60 seconds after the last preview, when its `stop()` runs.

A read takes at most 12 seconds, and three run at once; a fourth is refused, not queued. These reads are apart from the two that agents' frames and storyboards share, and from their per-agent limit, because the media token authorizes them and the client paces them.

### How a client reads them

`PreviewSchedule` in [`ScrubPreviews.swift`](../../../../clients/apple/YoloKit/Sources/YoloKit/ScrubPreviews.swift) decides which moments to read:

- Moments lie on a grid of one three-hundredth of the video, between 2 and 10 seconds.
- At most two reads run at once. When one ends, the next is the moment the owner is at by then and the next one in the direction they move, so a fast scrub skips what it passed. A read in progress is never cancelled, because its picture stays useful.
- While the exact picture is on its way, the nearest one within twelve moments shows.
- Three failures in a row end the reading until the next scrub. A `429` only waits for the owner's next move.

[`Shared/ScrubPreviews.swift`](../../../../clients/apple/Shared/ScrubPreviews.swift) keeps the last 120 pictures for the item, through a new stream of the same item.

### The iPhone and iPad app

The card follows the finger above the timeline, kept on screen at its ends: the picture in the video's shape, a quarter of the timeline wide, between 180 and 320 points, with the time under it. The middle controls give it their room during the drag, and playback goes on behind it.

### The Apple TV app

AVKit offers no way to give its transport bar a picture or to read where a scrub stands, so `AVPlayerViewController` shows only the picture, with `showsPlaybackControls` off, and [`PlayerTransport.swift`](../../../../clients/apple/TV/PlayerTransport.swift) draws the controls and takes the remote:

| On the Siri Remote | While it plays or pauses | While scrubbing |
|---|---|---|
| Swipe left or right | Starts a scrub and pauses the picture | Moves the moment; a whole swipe covers a quarter of the video, between two and twenty minutes |
| Click | Pauses or plays and shows the controls | Seeks to the moment and returns to playing if it played |
| Play/Pause | Pauses or plays and shows the controls | Seeks to the moment and plays |
| Left or right edge | Skips ten seconds | Moves the moment ten seconds |
| Swipe down or the down edge | Moves focus to the menus | |
| Back | Leaves the menus, then hides the controls, then leaves the player | Returns to where the scrub began |

The controls hide four seconds after the last press while it plays, and stay while it is paused, scrubbing, or in the menus. The menus are the ones the transport bar had (subtitles, audio, danmaku, share, Move to) as buttons, plus a speed menu in place of the system's. A live stream shows `LIVE` and scrubs what it can seek, without pictures.

## Alternatives considered

**I-frame playlists for the system's transport bar.** AVKit shows pictures while scrubbing when a stream's master playlist lists an `EXT-X-I-FRAME-STREAM-INF`. A progressive MP4 has no playlist to add it to, and most sources' HLS has none, so the node would have to encode single-frame fragments and rewrite master playlists, which adds a variant AVPlayer may also pick for playback. It would keep the system's bar on the TV and give the phone nothing.

**A second, muted AVPlayer seeking behind the card.** It needs no server work, but reads full-bitrate segments for each position, and seeking a transcoding source's stream far away disturbs the transcode the first player reads.

**`AVAssetImageGenerator` on the stream.** It does not read HLS, which most streams are.

**`/v1/storyboard` windows.** A storyboard labels its tiles with their times, goes through the Worker as base64 up to 2 MiB, reads up to thirty moments per call, and counts against limits set for agents; a scrub asks for one small picture at a time from the media path.

**A prebuilt sprite of the whole video.** It would answer at once, but reading a whole video ahead for a scrub the owner may never do costs each source's upstream reads and the node's CPU on every item.

**A pause on the iPhone while dragging.** Playback goes on behind the card, as it did behind the time, so a drag that ends where it began changes nothing Yolo hears. The TV pauses because a scrub there can stay open after the finger lifts, and its sound would go on for as long as the owner looks.

## Consequences

Finding a scene takes one drag on every source. The first picture of a moment costs a keyframe read upstream, about a second on a site's CDN, which a source's storyboard avoids. Without a new node, the stream carries no `previews` and the clients show the time alone.

The TV's controls are the app's own to maintain: focus, the remote's presses, and what the system's bar gave for free, such as its info panel, are now this code's or gone. A pause during a TV scrub is reported as the owner's pause, so other screens see the session paused until it ends.

The web player still shows only the time; `previews` is there for it when it wants one.
