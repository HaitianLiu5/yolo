# Agent Note: Smooth playback first: quality changes never discard the buffer

Status: proposed

English | [中文](2026-10-21-smooth-playback-first.zh.md)

## Problem

Yolo's playback is judged by smoothness first: a picture that keeps moving beats a sharper one, media already buffered is never thrown away, and the mechanism that adapts quality has to be simple enough to trust. The car shows why. Its connection on the road carries anything from half a megabit to several, and the canvas engine keeps up to 210 seconds of encoded segments so that a dead spot passes unseen ([canvas engine](../../implemented/architecture/2026-04-04-canvas-playback-engine.md)). Today every quality change and every recovery replaces the stream and throws that buffer away.

### Who decides quality today

Six parties shape the rate of one stream:

| Party | What it decides | Where |
|---|---|---|
| The player's controller | Measures throughput and buffer every second and asks for a stream with another cap: down after an 8-second stall or 20 seconds of a short buffer draining, up one rung after 90 seconds of 1.6× headroom with 30 seconds buffered, with cooldowns and a penalty that doubles the wait after an up then a down | [`quality.js`](../../../../clients/player/src/quality.js), [adaptive quality](../../implemented/feature/2026-10-11-adaptive-quality.md) |
| The Hub | Remembers the cap of the device's own last request for 30 minutes (`QUALITY_MEMORY_MS`), one value for every path, and applies it to whatever the device plays next | `deviceLimits` in [`hub-core.js`](../../../../service/control/src/hub/hub-core.js) |
| The node | Takes the lower of that cap and the media path's ceiling: 200,000 kbps on the LAN, 20,000 on remote direct play, 4800 on the relay | [media off the Worker](../../implemented/architecture/2026-10-13-media-off-the-worker.md) |
| The source plugin | Maps the cap to a rendition: Plex transcodes at the cap with a picture from its own table (720p from 2000 kbps, 480p from 1200, 360p from 600); yt-dlp picks the formats under it | [`playback.js`](../../../../plugins/source-plex/src/playback.js), [`formats.js`](../../../../plugins/source-ytdlp/src/formats.js) |
| Plex's transcoder | Decides the picture it actually makes: the 2200 kbps rung asked for 1280×720 and decoded at 720×404, smaller than the 1500 kbps rung's 852×480 | Plex |
| hls.js or native HLS | Switches among the variants of a multi-variant playlist under the cap, on the `<video>` engine only | [two engines](../../implemented/architecture/2026-10-12-two-playback-engines.md) |

### How a change is applied today

A change, up or down, is `POST /v1/playback/play` with `reason: "quality"`, the current position, the session it replaces, and `maxVideoKbps`. The Hub prepares a new node session, for Plex a new transcode with its `offset` at the position, and stops the old one. When the `load` arrives, `play()` in [`player.js`](../../../../clients/player/src/player.js) disposes the engine with its decoders and its encoded buffer, makes a new engine, and plays once 3 seconds of the new stream are buffered.

Recovery takes the same road. An engine error that `isRecoverablePlaybackError()` accepts, any message that matches "decod" included, asks for a new stream at the position (`reason: "recovery"`) after the 1, 3, 10, 30, and 60-second backoff, and that stream again replaces the engine. A direct path that fails mid-stream moves to the next path the same way ([media off the Worker](../../implemented/architecture/2026-10-13-media-off-the-worker.md)), and so does a session that expired while the buffer still held minutes of it ([Plex session recovery](../../implemented/bug-fix/2026-09-10-plex-session-recovery.md)). A seek to a place the stream cannot serve, such as one before a resumed Plex transcode's start, asks for a new stream there (`reason: "seek"`).

### What happened on 2026-10-21

The car played a Plex film through the relay over LTE. Times are UTC, from the car's device events and the node's log:

| Time | What happened | Buffered ahead |
|---|---|---|
| 19:03:45 | Play at the relay's ceiling, 4800 kbps at 720p: the Hub remembered no cap. First frame after 8.6 seconds, then stalls of 5.5 and 1 seconds | 3 s at most |
| 19:04:18 | Down to 1500 kbps (`draining`: 2713 kbps measured against 4928 needed). A new transcode replaced the stream, and a seek restart then started it at 3:13 instead of 8:16, a bug fixed separately. Playback went on at 19:04:41 | 6 s, discarded |
| 19:12:24 | Up to 2200 kbps (4787 kbps measured). A new transcode replaced the stream, which played from 19:12:40 at 720×404, a smaller picture than before | 216 s (about 64 MB), discarded |
| 19:17:52 | "Decoding error." at 16:10. Recovery started a new transcode at 2200 kbps, which stalled with nothing buffered; at 19:18:11 a step down started another at 1500 kbps. The picture stood still until 19:18:30, about 39 seconds | 216 s (84 MB), discarded |

Through the drive, 153 segment downloads took longer than 3 seconds (`network_segment_slow`); those ran at 0.6 to 3.4 Mbps. The link was weak but usable: the 1500 kbps stream played from 19:04:41 to 19:12:24 without a stall and filled its buffer to 216 seconds. The decoding error's cause is not proven. The likeliest is a one-off failure of the car's (probably hardware) video decoder, then a corrupt segment from Plex (the plugin asks Plex for incomplete segments: `X-Plex-Incomplete-Segments: 1`); a codec change without a new configuration, a frame before a key frame, and memory growth are ruled out. "Decoding error." is the same text for the video and the audio decoder, and the player does not record which one failed.

### Where it breaks the goal

1. **The start ignores what the link carried.** The Hub forgets a device's rate after 30 minutes and keeps one rate for all paths, so a drive starts at the path's ceiling and spends its first minute stalling down to a rate the car already knew.
2. **Every change throws the buffer away.** A step up happens only with a full buffer, so the step that discards the most is the one taken when nothing was wrong. A step down discards little, but the new stream still starts from nothing.
3. **A decoder fault goes to the network.** The segments the decoder failed on were already in the car; rebuilding the decoder needs nothing from the network that then stalled the new stream.
4. **No single owner.** The controller, the Hub's memory, the node's ceiling, the plugin's table, Plex's transcoder, and hls.js each decide part of the rate, and most of the controller's 18 policy values (cooldowns, an oscillation penalty, an end-of-item rule) exist to limit the cost of the rebuild itself.

## Proposal

### Principles

1. **Smoothness first.** A stall costs more than any picture size; when the two conflict, the lower rate wins.
2. **Never discard buffered media.** No quality change, recovery, or change of path throws away encoded segments that lie ahead of the playhead. Only a seek the owner makes to a place outside the buffer leaves them.
3. **Start from what worked.** A stream starts at the last rate this screen sustained on this media path, remembered durably; without one, at a conservative default for the path.
4. **Change the rate at the buffer's end.** A new rate applies to the segments not yet fetched; what is buffered plays out first.
5. **Step up only with a full buffer and sustained headroom; step down when the buffer runs low.** The buffer level decides, with a dead band between the two marks in which nothing changes.
6. **Recover in place first.** A decoder fault restarts the decoders from the encoded buffer, a stream that can no longer fetch continues on a new stream from the buffer's end, and a new stream at the playhead is the last resort.
7. **One owner per decision.** Each decision below has exactly one owner; the others enforce limits or store values, and decide nothing.

### The rate controller

[`quality.js`](../../../../clients/player/src/quality.js) keeps its measurement and gets these rules:

| Rule | Canvas engine | `<video>` engine, stream with one variant |
|---|---|---|
| Estimate | Today's: the lower of the 25th percentile of the last eight downloads and their moving average, ignored when no download finished for 30 seconds and none is in flight | hls.js's estimate, or the buffer's growth, as today |
| Start | The remembered rate for this screen and path; without one, the path's default | The same |
| Low mark | 60 s buffered ahead | 10 s |
| Full | 180 s buffered ahead, or the rest of the item | 30 s, hls.js's default buffer goal, or the rest of the item |
| Down | Below the low mark with the estimate under the stream's rate × 1.15, or an 8-second stall: the highest rung at or below 75% of the estimate, less audio, divided by the speed, from the buffer's end | The same |
| Up | Full, with the estimate at or above the next rung's rate × 1.6 for 90 seconds: one rung, from the buffer's end | The same |
| Otherwise | Hold | Hold |

What stays: at most one change in flight, no adaptation of live streams, the speed's multiplier on every rate, the ladder of 400 to 13,000 kbps, and the end of steps down for an item whose source has nothing lower. With the rest of the item buffered nothing changes.

Without a remembered rate, a stream starts at its path's default:

| Path | Default start |
|---|---|
| LAN direct play | The path's ceiling, the original where the device plays it |
| Remote direct play | 1500 kbps |
| The relay | 1500 kbps |

1500 kbps is the rate that played without a stall on 2026-10-21 and Plex's 480p preset; the relay's ceiling stays 4800 kbps.

### Remembering the rate

The Hub keeps one rate per device and path (`lan`, `wan`, `relay`) in its Durable Object storage, without expiry, in place of today's one value for 30 minutes. It writes the `maxVideoKbps` of the device's own requests on that path, as today, and an optional `rate: { path, kbps }` in the report's `health` when the controller settles on a rate without a request of its own. It applies the rate to every play on that device that names none: an agent's play, the queue's next item, a transfer, a resume. A rate learned on the relay never applies to the LAN. The previous release ignores the new keys and the new field, so no protocol number changes ([client protocol](../../implemented/architecture/2026-10-19-client-protocol.md)).

### Continue at the buffer's end

A change of rate becomes a splice: the old stream plays to the end of its buffer, and a new stream continues from there.

1. The player picks the splice time T: the end of the buffered media, the earliest end among the stream's playlists, which is a segment boundary. It cancels a read-ahead of the old stream past T and fetches no more of it.
2. It asks Yolo as today: `POST /v1/playback/play` with `reason: "quality"`, `startTime: T`, the session it replaces, and `maxVideoKbps`.
3. The Hub prepares the new session and stops the old node session as today, since the player already holds what it needs of it. For `quality` and `recovery` it keeps counting the position where the screen is rather than at T, so a resume after a dropped connection does not skip the buffered stretch.
4. The source prepares at T as it prepares any start: Plex starts a transcode with its `offset` at T, and yt-dlp resolves formats under the new cap. The plugin API does not change.
5. The engine adds the new stream's Input to the same HLS prefetcher, which keeps one byte cap (128 MiB) and one download slot over both streams and never evicts the old stream's segments before T to make room for the new one. The new stream fills from T while the old one plays.
6. At T the video producer ends the old track's iterator (`canvases(start, T)`) and starts the new track's (`canvases(T)`) on a new decoder; the canvas takes the new picture size from the first new frame. Audio does the same with `buffers(start, T)` and `buffers(T)` into the same ring buffer, placed by timestamp, so a small gap becomes silence and an overlap is trimmed. A new stream whose sound needs another sample rate reopens the audio output at T.
7. Once playback passes T, the old Input and its segments are released.

A quality change, up or down, splices. So does a read-ahead that ends in `SESSION_EXPIRED` or in exhausted retries, and a direct path that fails mid-stream: the buffered part plays while the new stream fills from its end. With nothing buffered ahead, T is the playhead, and the splice is today's replacement with nothing to lose. A seek outside the buffer and a track change still ask for a stream at the place the owner chose. A new stream whose media begins more than one segment after T, or whose timestamps are not the item's, cannot be spliced: the engine plays the buffer to T and loads the new stream there, which pauses at T but still keeps the buffer.

### Recover in place

A decoder error climbs a ladder, and each step records which decoder failed (video or audio), the timestamp, and the segment:

1. Restart the failed track's decoder from the encoded buffer at the position, through `restartProducers()` as `seek(t, { preserveHlsBuffer: true })` reaches it when the sound is turned on today. Sound keeps playing when only the picture's decoder failed, and no request leaves the car.
2. If the same timestamp fails again, fetch that segment again from the same session, since it may be corrupt or incomplete, and open the video decoder with `hardwareAcceleration: "prefer-software"`.
3. If it fails a third time, skip to the next key frame.
4. Only then ask for a new stream at the position, through today's recovery and its backoff.

### One owner per decision

| Decision | Owner | The others |
|---|---|---|
| The rate of the segments still to fetch on a stream with one variant | The player's controller | The node caps it at the path's ceiling; the Hub stores it |
| The variant within a multi-variant stream on the `<video>` engine | hls.js or native HLS | Yolo's controller stays out; today's step down after a stall on such a stream goes |
| The rate a stream starts at | The screen's remembered rate for the path | The Hub stores it and applies it to plays the screen did not ask for itself |
| The rendition for a rate | The source plugin, from rungs whose picture never shrinks as the rate grows | Plex's transcoder makes what the plugin's rung was checked to give |
| Recovery | The engine first (decoders, buffer), then the player (new streams) | Proxies and the node never restart playback, as today |

### Checked against the hard constraints

- **The canvas engine's rules.** The decoded video queue stays one queue of 6 to 16 frames: the old producer ends at T before the new one starts. Encoded segments of both streams count against one 128 MiB cap and one download slot, so read-ahead stays single-flight, and the old stream fetches nothing past T ([canvas engine](../../implemented/architecture/2026-04-04-canvas-playback-engine.md)).
- **Plex transcodes.** A new rate is a new transcode with an `offset`, as today. A splice needs its timestamps on the item's timeline, which a resumed transcode already has: the engine reads its first timestamp as the position it starts at, and a seek before it asks for a new stream. It needs media at or before T: the plugin's `offset` is T rounded down to a whole second, and the node trims Plex's placeholder segments before it. Plex's segment length differs by rate (the trimmed placeholder counts in the node's log imply 3-second segments at 4800 kbps and 8-second ones at 1500 and 2200), so the splice is by time, not by segment number. For a moment two transcodes run, as they do today.
- **yt-dlp formats.** Renditions are fixed: a new rate is a new format choice at `prepare`, joined by byte range as today. A source that started below the cap for a slow mirror (`capped`) still steps up from there ([media pipeline](../../implemented/architecture/2026-10-11-node-media-pipeline.md)).
- **The relay's ceiling.** It stays 4800 kbps, and no rung above a path's ceiling is asked for.
- **Both engines.** The splice belongs to the canvas engine. The `<video>` engine leaves multi-variant streams to the browser, and for a stream with one variant it keeps replacing the stream, under the same controller rules; its buffer is hls.js's 30 seconds, not the car's 210 ([two engines](../../implemented/architecture/2026-10-12-two-playback-engines.md)).

### Would a multi-variant playlist from the node make this simpler?

Partly, and not where the evidence is:

- **For the `<video>` engine and sources that already have renditions, yes.** A node master playlist that lists several of yt-dlp's formats, each joined by byte range as the one format is today, would let hls.js and native HLS adapt by themselves, with no controller of Yolo's and no new session.
- **For Plex, no.** One transcode makes one rendition, so a ladder is one transcode per rung, started when a player first asks for that rung, on the machine that serves every other screen too. A browser's ABR probing upward would start transcodes it then abandons, and the rungs' segment grids differ (3 and 8 seconds above), so they do not meet at shared boundaries.
- **For the car, no.** Mediabunny reads each variant of a playlist as a track of its own, so switching variants in the canvas engine needs the same switch at a time T to a new decoder that the splice builds.

The splice is the work either way. Once it exists, the canvas engine can switch tracks of a multi-variant stream with it too, and a node ladder for yt-dlp sources is a separate, later proposal if the web's one-variant rebuilds show up in telemetry.

### What gets deleted or simplified

- `play()` no longer replaces the engine for a quality change, a read-ahead that expired, or a path fallback, and `onLoad()` drops its `Math.max(getPlaybackPosition(), startTime)` correction for a quality load: the new stream starts at T by construction.
- Seven of the controller's 18 policy values go: `upMinAfterDownMs`, `upMaxSustainMs`, `oscillationWindowMs`, and `penaltyResetMs` in phase 1; `downAfterDrainingMs`, `downCooldownMs`, and `minRemainingSeconds` in phase 3. `healthyBufferSeconds` becomes the full mark.
- The Hub's 30-minute memory (`QUALITY_MEMORY_MS`) becomes a memory per path without expiry.
- The step down after a stall on a multi-variant `<video>` stream goes.
- `isRecoverablePlaybackError()` no longer matches decoder messages: the engine handles a decoder error, and only its last step reaches the player.
- The Plex plugin's table from bitrate to picture becomes a list of checked rungs.

### What is taken from other players

- **hls.js** (1.7.3, the version the `<video>` engine bundles). Its automatic switches choose the level of the next fragment and never flush the buffer; only a manual `currentLevel` or `nextLevel` does ([`hls.ts`](https://github.com/video-dev/hls.js/blob/v1.7.3/src/hls.ts#L760-L820)). Its estimate is the lower of a fast and a slow moving average (3 and 9 seconds for VoD), it takes 0.95 of the estimate for the same or a lower level and 0.7 for a higher one, and it abandons a fragment in flight when finishing it would take longer than the buffer left ([`config.ts`](https://github.com/video-dev/hls.js/blob/v1.7.3/src/config.ts#L507-L516), [`abr-controller.ts`](https://github.com/video-dev/hls.js/blob/v1.7.3/src/controller/abr-controller.ts)). Taken: a new rate applies only to what is still to fetch, a stricter margin up than down, and cancelling a read-ahead past T.
- **Shaka Player** (4.16). Its ABR switches never clear the buffer by default (`clearBufferSwitch: false`); the new variant plays after the buffered content. It makes no decision until the estimate has seen 128 kB, switches at most once every 8 seconds, and estimates with the lower of two moving averages with half-lives of 2 and 5 seconds ([`player_configuration.js`](https://github.com/shaka-project/shaka-player/blob/v4.16.53/lib/util/player_configuration.js#L315-L344), [`simple_abr_manager.js`](https://github.com/shaka-project/shaka-player/blob/v4.16.53/lib/abr/simple_abr_manager.js)). Taken: no clearing, and a minimum of samples before the first decision, which the controller's `minSamples` already is.
- **Media3** (1.11.1, ExoPlayer's successor). `AdaptiveTrackSelection` defers a switch up while less than 10 seconds are buffered and a switch down while 25 seconds or more are, and picks the best track within 0.7 of the estimate ([`AdaptiveTrackSelection.java`](https://github.com/androidx/media/blob/1.11.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/trackselection/AdaptiveTrackSelection.java#L318-L324)). `DefaultBandwidthMeter` starts from an estimate per network type and country (on 4G, 0.68 to 2.5 Mbps) and resets it when the network type changes ([`DefaultBandwidthMeter.java`](https://github.com/androidx/media/blob/1.11.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/upstream/DefaultBandwidthMeter.java#L56-L84)). Taken: marks on the buffer around a dead band, and a start per kind of network, which Yolo learns from the screen's own history per path. Not taken: discarding buffered chunks 25 seconds ahead to fetch them again at a higher quality.
- **Netflix's buffer-based rate adaptation** ([Huang et al., SIGCOMM 2014](https://yuba.stanford.edu/~nickm/papers/sigcomm2014-video.pdf)). No official or peer-reviewed description of YouTube's production ABR was found, so the published design from a large service is Netflix's: in steady state the rate follows the buffer level, the lowest rate below a reservoir and rising through a cushion above it, and a capacity estimate matters only during startup. On Netflix's service it cut rebuffers by 10 to 20% against the default algorithm of the time at a similar average rate; its first version used a 240-second buffer with a 90-second reservoir. Taken: in steady state the buffer decides, through marks and a dead band; the car's 210-second buffer is of the same order.

### Decisions

1. **The default start without a remembered rate:** 1500 kbps on remote direct play and the relay; the LAN starts at its ceiling.
2. **The memory's lifetime:** no expiry. A remembered rate is only where a stream starts; the controller still steps up when the headroom is there.
3. **Stepping up in the car:** from one stream to the next until phase 3 ships, then within an item from the buffer's end.
4. **The canvas engine's marks:** low at 60 seconds and full at 180.
5. **Plex's rungs:** only rungs whose decoded picture was checked against the owner's Plex server, so far 4800 kbps at 1280×720 and 1500 kbps at 852×480, with 2200 kbps out. 3000 kbps at 720p and 700 kbps at 360p join once checked.
6. **The web's one-variant streams:** replaced under the new rules; no node ladder for yt-dlp sources for now.

## Phases

Each phase ships, and rolls back, on its own.

### Phase 1: start from what worked, never rebuild to go up

- The Hub's rate memory per device and path without expiry, `health.rate`, and the paths' default starts.
- A step up no longer replaces the stream on either engine: it becomes the screen's remembered rate, and the next stream starts there. The four values that only stopped up-and-down flapping go. Steps down keep today's rule and still replace the stream; they fire with under 20 seconds buffered.
- The Plex plugin keeps only checked rungs.
- Yolo's controller leaves multi-variant `<video>` streams to the browser.

On 2026-10-21 this would have kept the 216 seconds at 19:12:24, and the next drive on the relay would start at 1500 kbps.

### Phase 2: recover in place

- The decoder ladder in the canvas engine, with the failed decoder, timestamp, and segment in its events.
- A `decodeErrorAt` fault beside today's `videoStallMs`, for tests.

On 2026-10-21, if the first or second step had healed the decoder, the error at 19:17:52 would have cost a moment of still picture instead of about 39 seconds, two new transcodes, and 216 buffered seconds.

### Phase 3: continue at the buffer's end

- The splice in the canvas engine and its prefetcher; `player.js` splicing quality changes, expired or failed read-aheads, and path fallbacks; the Hub keeping the screen's position for `quality` and `recovery`.
- The controller's buffer marks for both directions, and steps up within an item from the buffer's end; three more policy values go.

On 2026-10-21 the step down at 19:04:18 would have played its 6 buffered seconds while the 1500 kbps stream filled behind them, instead of waiting for a new stream from nothing: 6 seconds to its first frame, and 23 with the seek restart.

## Testing

- **Unit.** [`quality.test.js`](../../../../clients/player/test/unit/quality.test.js): the start from the remembered rate, both marks and the dead band, a step up kept for the next stream (phase 1) and applied from the buffer's end (phase 3). [`hub-core.test.js`](../../../../service/control/test/unit/hub-core.test.js): the memory per path without expiry, `health.rate`, and the position kept for a splice. The Plex plugin's tests: rungs whose picture never shrinks. [`hls-segment-prefetcher.test.js`](../../../../clients/player/test/unit/hls-segment-prefetcher.test.js): two streams under one cap and one download slot, nothing fetched past T, nothing before T evicted for the new stream.
- **End to end.** [`car-playback.test.js`](../../../../test/e2e/car-playback.test.js): a quality change with 60 seconds buffered plays on without `stall_start`, the buffer never falls to zero, and the position never jumps by more than a second; `hls`, `dash_split`, and the Plex fixture each splice; an injected decoder error recovers without a stream request; a 410 on a read-ahead continues from the buffer's end. [`web-playback.test.js`](../../../../test/e2e/web-playback.test.js), also with `YOLO_E2E_WEBKIT=1`: the `<video>` engine's replacement and its step up kept for the next stream.
- **In the car** ([in-car checks](../../implemented/testing/2026-07-21-test-layers.md#in-car-checks)): a drive on the relay over LTE with `plex` and `hls`, where the start rate is the remembered one, no `stall_start` follows a `quality_change_requested`, each step's `stream_first_frame` shows a picture no smaller than the rung below, and the device's events name every splice and every recovery step.

## Rollback

`npm run yolo -- rollback` returns to the previous release after any phase. Phase 1's keys and `health.rate` are ignored by the previous release, which falls back to its 30-minute memory. Phase 2 changes only the player. Phase 3 changes the player and how the Hub counts the position for two reasons, and stores nothing new. No phase migrates data.

## Alternatives considered

**Tune today's numbers.** A longer wait before a step up or a shorter one before a step down changes when a stream is replaced, not that it is; the buffer is still thrown away at every change.

**A lower relay ceiling, such as 2200 kbps.** It would have started the car near a workable rate on 2026-10-21, but every screen on the relay would pay for it on every link, and it still replaces the stream at every change. The memory per path gives the car the same start from its own history.

**A fixed quality per path, as the original Tesla player had.** It is smooth on links that carry it and stalls with no way out on links that do not ([adaptive quality](../../implemented/feature/2026-10-11-adaptive-quality.md)).

**Multi-variant playlists from the node for every source.** Plex makes one rendition per transcode, and the canvas engine needs the splice to switch variants anyway; see the section above.

**Splice in the node behind one session.** The node would keep the device's playlist and serve its later segments from a new transcode. Plex's segment grid differs by rate, a picture of another size inside one track needs a decoder configuration the engine does not change mid-track, and the device would not know where the rate changed.

**Two engines handing over at T.** A second engine would bring a second AudioContext, canvas, and set of decoders into a car that reports 2 GB of device memory, and the hand-over would gap the sound. One engine with two Inputs shares the audio output and the byte cap.

**Discard buffered segments to fetch them again at a higher rate**, as Media3 does. The car's buffer is its insurance against dead spots, and a higher rate can wait for the buffer's end.

**Throughput alone decides, as today's controller mostly does.** On 2026-10-21 the measured rate ranged from 0.6 to 4.8 Mbps within minutes; the buffer level is the steadier signal, as Netflix's study found.

**Remember the rate in the screen's own storage.** Plays the screen did not ask for (an agent's, the queue's next item) need the rate at `prepare`, which the Hub runs; one home serves both.

## Acceptance criteria

- **Phase 1.** A screen that played at a rate on a path starts its next stream on that path at that rate, also the next day and when an agent starts it. No step up replaces a stream: no `stream_selected` with `reason: "quality"` follows a step up. Each Plex rung decodes at a picture no smaller than the rung below. A multi-variant `<video>` stream makes no quality request of Yolo's.
- **Phase 2.** An injected decoder error resumes from the buffer with no stream request and no loss of buffered segments beyond one group of pictures. In the car, a decoder error shows its recovery step and the decoder that failed, and no new session follows unless every step failed.
- **Phase 3.** A quality change, a read-ahead that expired, and a path fallback each play on without a stall whenever the buffer holds more than the new stream needs to start; the buffered seconds never drop at a change, and the position never jumps by more than a second. A drive on the relay shows no `stall_start` caused by a quality change.

## Risks

- **The splice trusts the new stream's timestamps.** A source that starts a new stream on another timeline, or a position misread when a new stream loads, would splice at the wrong place; the jump from 8:16 to 3:13 on 2026-10-21 followed a quality load, and its fix lands separately. The engine checks that the new stream's first timestamp lies within a segment of T and otherwise falls back to loading at T, and phase 3 builds on that fix.
- **A gap or an overlap at T.** Plex may start a resumed transcode a little before or after T: an overlap is trimmed, and a gap shows the last frame with silence for up to one segment.
- **A lower start costs sharpness.** On a day the link is better than remembered, a stream starts lower and climbs only once its buffer is full: a few minutes in phase 3, the next stream in phase 1. This is the trade the goal asks for.
- **Memory in the car.** During a splice both streams share the 128 MiB cap, and for a moment a second decoder starts while the first finishes, in a car that reports 2 GB of device memory.
- **More logic in the canvas engine.** The splice and the decoder ladder live in the engine, which the car's end-to-end tests run in Chromium; WebKit never runs it.
- **What is given up.** Phase 1 does not step up within an item; the `<video>` engine still replaces one-variant streams; and buffered segments are never fetched again at a higher rate.
