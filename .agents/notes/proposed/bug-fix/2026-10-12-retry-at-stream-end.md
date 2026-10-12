# Agent Note: Try again at the end of a stream hangs on Loading

Status: proposed

English | [中文](2026-10-12-retry-at-stream-end.zh.md)

## Problem

When a stream has already reached its end and the player shows its error, pressing **Try again** asks for a new stream at the position where playback stopped — the end — and the player hangs on "Loading". `retryPlayback()` in [`clients/tesla/src/player.js`](../../../../clients/tesla/src/player.js) takes the start from `getPlaybackRecoveryPosition()` and requests a fresh session there, with nothing left to play.

It shows up as an intermittent failure of the end-to-end test "seeking a dash_split stream keeps its format and picture size" in [`test/e2e/playback-experience.test.js`](../../../../test/e2e/playback-experience.test.js): about one run in three, on the unmodified branch as well. The test's fixture is 60 seconds long; by the time the test triggers its final error and Try again, playback can already have run to the end, especially under load.

## Proposal

- A retry or recovery whose position is at or past the item's end does not load at the end: it restarts the item from the beginning, or, when the queue has a next item, advances to it. Which of the two applies follows the existing rule for starting a finished item (Yolo starts it from the beginning, [progress and resume](../../implemented/feature/2026-10-11-yolo-owns-progress-and-resume.md)) unless the owner decides that Try again should advance.
- Lengthen the test's fixture so that the test cannot reach the end before its last step, and add a test that presses Try again after the end and expects playback to restart (or advance) rather than hang.

## Alternatives considered

**Only lengthen the fixture.** It makes the test pass but leaves the hang in the product for anyone who presses Try again at the end of a video.

**Disable the flaky test.** It would also stop covering format and picture size across seeks, rebuilds, and recovery, which the test exists for.

## Acceptance criteria

Pressing Try again after a stream has ended never leaves the player on "Loading": it restarts or advances. The end-to-end test passes in repeated runs, including under load, and a new test covers Try again after the end.

## Risks

Restarting versus advancing changes what the owner sees after an error at the end of an item; choosing wrongly could replay a video the owner meant to leave. The fix touches recovery code that several triggers share (a `410`, a wake, a seek rebuild), so it must not change recovery in the middle of a stream.
