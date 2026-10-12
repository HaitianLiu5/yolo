# Agent Note: The picture's resolution looks wrong after seeking a dash_split stream

Status: proposed

English | [中文](2026-10-11-dash-split-resolution-after-seek.zh.md)

## Problem

On a Bilibili video delivered as `dash_split` (separate audio and video joined into fMP4 HLS), the owner saw the resolution look wrong after seeking. It has not been reproduced. A seek inside the stream keeps the stream, while a seek outside it (or a recovery) rebuilds it with a new `prepare`, so a wrong picture could come from the plugin choosing another format, from the node's delivery, from the decoder, or from the canvas sizing.

## Proposal

Telemetry to catch it already ships ([device telemetry](../../implemented/feature/2026-10-11-device-telemetry.md)): `stream_selected` records each load's claimed width, height, frame rate, codec, bitrate, `formatId`, cap, and viewport, and `stream_first_frame` records the decoder's real picture size and codec and the canvas size, once per stream and again after every seek (`seeks`). The end-to-end test "seeking a dash_split stream keeps its format and picture size" covers the local case.

The next time it happens in the car:

1. In Workers Logs, take that device's `stream_selected` and `stream_first_frame` events for the session (`kind = "device_event" AND deviceId = "dev_…"`, sorted by `at`).
2. Compare the claimed and real sizes before and after the seek, and whether the seek rebuilt the stream with another `formatId` or cap.
3. Fix the layer that diverged — the yt-dlp plugin's format choice, the node's split-to-HLS delivery, or the client's canvas sizing — with a regression test at the lowest layer that can show it.

## Alternatives considered

**Guess a fix without data.** The bug has not been reproduced, and four layers could cause it; a guessed change risks altering correct behavior while missing the cause.

## Acceptance criteria

Either the telemetry of a real occurrence identifies the diverging layer and a fix with a regression test lands, or the case is reproduced locally and fixed the same way. The resolution after a seek on `dash_split` matches the format the plugin selected.

## Risks

The problem may be rare, and Workers Logs keeps three days on the free plan, so an occurrence must be investigated soon after it happens. Bilibili's mirrors and formats change on their side, so a local reproduction may never match the car's conditions.
