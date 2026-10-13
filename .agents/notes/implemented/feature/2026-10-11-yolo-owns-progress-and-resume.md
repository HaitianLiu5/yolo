# Agent Note: Yolo owns progress and resume

Status: implemented

English | [中文](2026-10-11-yolo-owns-progress-and-resume.zh.md)

## Problem

Watch progress was spread over Plex, the earlier single-process server, and Yolo, and that split was the root cause of "playback does not continue where I stopped": The Gentlemen had progress in Plex yet started at 00:00. A NAS owner without Plex has no other progress store at all. In the car, a page reload or a wake from sleep must also decide whether to continue playing, and browsers may refuse to start playback with sound without a tap.

## Decision

Yolo's own history is the source of truth for progress, and Plex becomes an optional source plugin whose own position is only a fallback. (Yolo's own library, which the same decision covers, is [proposed](../../proposed/feature/2026-10-11-own-library-and-nas.md).)

**Recording.** The Hub writes the active device's `report`s into Yolo's history — at once on a status change, otherwise at least every 30 seconds — and forwards them to the node's `/sessions/:id/progress`, where a source may write its own progress back (Plex does). History keeps the latest 500 items ([D1 data model](../architecture/2026-10-07-d1-data-model.md)).

**Choosing a start.** A play without `startTime` starts from Yolo's history when it holds an unfinished position past 5 seconds, from the beginning when the item was finished, and otherwise hands `startTime: null` to the source, which uses its own progress (Plex's `viewOffset`) or the beginning.

**Resuming after a reload or a wake**, like Spotify in a car ([`clients/tesla/src/resume-decision.js`](../../../../clients/tesla/src/resume-decision.js)): when the active device's last connection drops, the Hub records playback as paused at that position and marks `interruptedAt` if it was playing (`playing`, `buffering`, or `loading`). When the device comes back, an item that was playing, or was interrupted while playing, continues at the saved position however long the car slept; an item the owner had paused before leaving (no `interruptedAt`) stays paused. A later pause or resume by the user clears `interruptedAt`.

**Leaving the player.** Back, the player's or the browser's, stops the device's stream but keeps the item: the device reports `idle`, and the Hub saves the position, stops the node's session (a transcode ends), and keeps the item paused on that device, marked `leftAt`. That device's home screen shows it in the now-playing bar as "Paused on This browser" ("This screen" in the car) ([`clients/tesla/src/remote.js`](../../../../clients/tesla/src/remote.js)). The bar's play button, a tap on the bar, or a remote's play asks for a new stream at that position with the item's saved tracks and opens the player; "Stop playing" in the device picker ends it. A page that comes back (a reload or a wake) leaves an item marked `leftAt` in the bar instead of opening the player; a pause keeps the mark, and a resume or a new stream clears it.

**Sound.** Playback first tries to start with sound, which browsers may allow on sites with high media engagement. When the browser's autoplay policy blocks sound, the video plays muted, and a small "Tap for sound" prompt unmutes it on the first tap anywhere on the page. A stream with no video waits for the tap. The `autoplay_result` and `audio_unlocked` events record each outcome ([device telemetry](2026-10-11-device-telemetry.md)).

## Alternatives considered

**Keep relying on Plex's library and progress.** Progress would stay split between Plex and Yolo, which is the bug this fixes, and owners without Plex would have none.

**Always resume paused after a wake.** In a car, the owner expects what was playing to keep playing after the screen wakes, as Spotify does; only a deliberate pause before leaving should survive the wake.

## Consequences

`play` without `start_at` continues where the owner left off on any device, and items Yolo has not played yet still resume at Plex's position. A car left playing resumes playing after any length of sleep, muted when the browser blocks sound. Going Back from the player keeps the item one tap away in the now-playing bar.
