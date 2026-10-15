# Agent Note: Yolo owns progress and resume

Status: implemented

English | [中文](2026-10-11-yolo-owns-progress-and-resume.zh.md)

## Problem

Watch progress was spread over Plex, the earlier single-process server, and Yolo, and that split was the root cause of "playback does not continue where I stopped": The Gentlemen had progress in Plex yet started at 00:00. A NAS owner without Plex has no other progress store at all. In the car, a page reload or a wake from sleep must also decide whether to continue playing, and browsers may refuse to start playback with sound without a tap.

## Decision

Yolo's own history is the source of truth for progress, and Plex becomes an optional source plugin whose own position is only a fallback. (Yolo's own library, which the same decision covers, is [proposed](../../proposed/feature/2026-10-11-own-library-and-nas.md).)

**Recording.** The Hub writes the active device's `report`s into Yolo's history — at once on a status change, otherwise at least every 30 seconds — and forwards them to the node's `/sessions/:id/progress`, where a source may write its own progress back (Plex does). History keeps the latest 500 items ([D1 data model](../architecture/2026-10-07-d1-data-model.md)).

**Choosing a start.** A play without `startTime` starts from Yolo's history when it holds an unfinished position past 5 seconds, from the beginning when the item was finished, and otherwise hands `startTime: null` to the source, which uses its own progress (Plex's `viewOffset`) or the beginning.

**Resuming after a reload or a wake**, like Spotify in a car ([`clients/player/src/resume-decision.js`](../../../../clients/player/src/resume-decision.js)): when the active device's last connection drops, the Hub records playback as paused at that position and marks `interruptedAt` if it was playing (`playing`, `buffering`, or `loading`). When the device comes back, an item that was playing, or was interrupted while playing, continues at the saved position however long the car slept; an item the owner had paused before leaving (no `interruptedAt`) stays paused. A later pause or resume by the user clears `interruptedAt`.

**Leaving the player.** Back (the player's button, a swipe down on the picture, or the browser's) pauses and hides the player but keeps it, as YouTube keeps a video in its miniplayer ([`clients/player/src/kept-player.js`](../../../../clients/player/src/kept-player.js)): the engine, what it decoded and buffered, and its tracks, quality, subtitles, and danmaku. The device reports `idle` with `keep: true`, and the Hub saves the position and keeps the item paused on that device, marked `leftAt` and `kept`, without stopping the node's session. That device's home screen shows it in the now-playing bar as "Paused on This browser" ("This screen" in the car) ([`clients/player/src/remote.js`](../../../../clients/player/src/remote.js)). The bar's play button, a tap on the bar, or a remote's or an agent's resume shows the same player again, which plays on in place with no new play or prepare request; its controls show for a moment and then fade. "Stop playing" in the device picker ends it. A hidden player does no work: nothing is decoded or drawn, its timers stop, and nothing more is fetched, except that a file the browser loads itself stops at the browser's own read-ahead.

Only one video plays at a time, so nothing releases the kept player with time or memory pressure. It goes when another stream starts on that screen, playback is stopped, playback moves to another device or another window of the screen takes over, or the page unloads; a page that goes away reports a plain `idle`, and the Hub stops the node's session then. Released, Back works as it did before the player was kept: the item waits paused in the bar, marked `leftAt`, and the bar asks for a new stream at that position with the item's saved tracks and opens the player. A page that comes back after a reload has no player to show: it reports a plain `idle` for an item the Hub still marks `kept`, and leaves the item in the bar instead of opening the player. A pause keeps both marks, and a resume or a new stream clears them. A live stream, and a player that is failing or waiting for a new stream, are not kept: Back from one reports a plain `idle`, which the screen says again after its next welcome when a dead connection took it, also from a page loaded again in the same tab, rather than playing the item on ([Hub and realtime channel](../architecture/2026-10-07-hub-and-realtime-channel.md)).

Shown again after more than a minute hidden, the player first asks the node whether its stream still answers: the node ends a session idle for two hours, a media token lasts twelve, and Plex reclaims a transcode idle for 180 seconds. A stream that answers 410, an engine that failed while hidden, or a screen that left the LAN or remote path its stream came by goes through the player's recovery: a new stream of the same item at the same position, on the path the screen takes now, with the last picture shown until it plays. A seek while hidden (an agent's, or the bar's skip back) moves where the player goes on.

**The bar's picture** is the paused frame. For this screen's kept player it is the player's own, drawn small from the engine's `<canvas>` or `<video>` as it leaves, with no request. For another device's paused item, or this screen's after a reload, it is a 320-pixel frame from `/v1/frame` at the Hub's position, asked for again only when that position moves by two seconds or more ([video frames](2026-10-13-video-frames.md)). Otherwise, and while the item plays, it is the item's artwork.

**Sound.** Playback first tries to start with sound, which browsers may allow on sites with high media engagement. When the browser's autoplay policy blocks sound, the video plays muted, and a small "Tap for sound" prompt unmutes it on the first tap anywhere on the page. A stream with no video waits for the tap. The `autoplay_result` and `audio_unlocked` events record each outcome ([device telemetry](2026-10-11-device-telemetry.md)).

## Alternatives considered

**Keep relying on Plex's library and progress.** Progress would stay split between Plex and Yolo, which is the bug this fixes, and owners without Plex would have none.

**Always resume paused after a wake.** In a car, the owner expects what was playing to keep playing after the screen wakes, as Spotify does; only a deliberate pause before leaving should survive the wake.

**Stop the stream on Back, as before.** Every return from the bar waited for a new stream, a new Plex transcode included, and started over with an empty buffer.

**Release a kept player after a while hidden, or under memory pressure.** The owner ruled this out: only one video plays at a time, so a kept player never competes with another for memory or for the node, and a timed release would bring back the wait it removes. A stream that expired while hidden is rebuilt when it is shown again instead.

## Consequences

`play` without `start_at` continues where the owner left off on any device, and items Yolo has not played yet still resume at Plex's position. A car left playing resumes playing after any length of sleep, muted when the browser blocks sound. Going Back from the player keeps the player itself one tap away in the now-playing bar, and it plays on in place without waiting. In exchange, a kept player holds its decoders and buffers, and the node its session, until another stream, a stop, a move, or the page going away releases it.
