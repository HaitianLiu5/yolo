# Agent Note: A retry at a stream's end never loads at the end

Status: implemented

English | [中文](2026-10-12-retry-at-stream-end.zh.md)

## Problem

When a stream had reached its end and the player showed its error, pressing **Try again** hung on "Loading". `retryPlayback()` in [`clients/player/src/player.js`](../../../../clients/player/src/player.js) took its start from `getPlaybackRecoveryPosition()`, the end, and asked to rebuild the failed session there, with nothing left to play. When the stream had already played out, Yolo had also ended that session (the device's `ended` with nothing queued), so the rebuild came back `superseded` and nothing replaced the spinner.

The same bug made an end-to-end test of dash_split seeks fail intermittently: its 60-second fixture could end before the test's last Try again.

## Decision

No retry, recovery, or resume asks for a stream with nothing left to play ([`clients/player/src/playback-recovery.js`](../../../../clients/player/src/playback-recovery.js)). Nothing is left when the position is within the last second of a known, non-live duration (`hasNothingLeftToPlay`, `NOTHING_LEFT_SECONDS`).

- **Try again plays the item again**, where it stopped, or from the beginning when nothing is left there, as Yolo starts any finished item ([progress and resume](../feature/2026-10-11-yolo-owns-progress-and-resume.md)). `planRetry()` decides how: while the Hub's latest `PlaybackState` still holds the failed session, Try again rebuilds it (`reason: "recovery"` with the session it replaces); when Yolo already ended or stopped that session, or refuses the rebuild as `superseded` with no session left, Try again sends a new `play` of the item on this device. `playback_retry_requested` records the plan.
- **An automatic recovery at the end finishes the item.** A recovery (a `410`, a stalled seek, a decoder error) whose position has nothing left to play sends `ended`, as a natural end does, and Yolo plays the queue's next item or stops. `playback_recovery_finished` records it.
- **A page that comes back at the end finishes the item.** When a reload or a wake finds this device's item at its end, `resumeDecision()` says `finished` and the page sends `ended` instead of asking for a stream there.

Recovery in the middle of a stream is unchanged.

### Testing

The unit test of `planRetry` pins the contract: once Yolo has ended the session of an item that played out, Try again plays the item from the beginning. Unit tests also cover `hasNothingLeftToPlay` and `resumeDecision().finished`, and the car's end-to-end journey in [`test/e2e/car-playback.test.js`](../../../../test/e2e/car-playback.test.js) plays on with Try again from the error panel.

## Alternatives considered

**Advance to the queue's next item when there is one.** Try again names the item on screen; advancing would make one button do two different things depending on a queue the owner may not be looking at, and would skip an item whose end the owner never saw. A natural end and an automatic recovery at the end still advance, because there the item is over.

**Only lengthen the fixture.** The test would pass, but anyone pressing Try again at the end of a video would still hang.

**Disable the flaky test.** It would also stop covering format and picture size across seeks, rebuilds, and recovery, which the test exists for.

## Consequences

Try again always plays something, and an automatic recovery never replays a finished item by itself. An error in the last second of a film restarts it from the beginning when the owner presses Try again; Back leaves it instead. The one-second threshold is narrow on purpose: credits still to play resume where they were.
