# Agent Note: Library items that move to a new id

Status: implemented

English | [中文](2026-10-21-moved-library-items.zh.md)

## Problem

A library item's id is its source's own, such as a Plex item's `ratingKey`, and Yolo keys history, resume positions, and track preferences by `<plugin>:<id>` ([source plugin API](../architecture/2026-10-11-source-plugin-api.md)). A source can give the same file a new id: a Plex library rescan turned `plex:9916` into `plex:9919`, with the same title and the same 4,039 seconds. The owner's screen, history, and the Hub still named the old id, every stream request came back `not_found` ("Library item not found" from the plugin), and the player showed "This video can't play right now." with a **Try again** that could never work.

## Decision

### The Hub finds the item again

When the node's `prepare` answers `not_found` for a play, the Hub's `relocate()` ([`hub-core.js`](../../../../service/control/src/hub/hub-core.js)) looks for the item under a new id before it refuses:

- **What it looks for:** the title and duration of the item the request names (a queue item), or of the item playing when it has the same id, or else of the old id's history entry. Without a title and a positive duration it looks for nothing.
- **Where:** the node's library search ([node's internal API](../architecture/2026-10-07-node-internal-api.md)) for that title, at most 20 results, waiting at most 15 seconds.
- **What counts as the item:** a result of the same source (its id starts with `<plugin>:`) under another id, whose title is equal after Unicode NFKC normalization, trimming, collapsing whitespace, and lowercasing, and whose `duration` is within 2 seconds. Exactly one such result is the item; none, or more than one, is no item.

With the item found, the Hub logs `item_relocated` (`from`, `to`), moves the old id's history entry (its position and play count) and its saved track choice to the new id unless the new id has its own, which it keeps, and prepares the new id with the start position and track preferences read under the old one. The stream, the Hub's state, and history's later writes name the new id. Moving history and the track choice is best effort: a failure is logged as `relocate_write_failed`, and the stream plays.

Without the item, the play is refused with `not_found`: "This video is no longer in the library", followed by the source's own answer.

### The screen says so

`describePlaybackError()` in [`playback-error.js`](../../../../clients/player/src/playback-error.js) gives the error panel ([`player-screens.js`](../../../../clients/player/src/player-screens.js)) "This video is no longer in the library." for a `not_found` anywhere in the error's cause chain, unless the error is a media dead end, and the panel hides **Try again**; **Back** stays.

## Alternatives considered

**The source's own stable identifier.** Plex keeps a GUID per item across rescans, but not every source has one, an item's `id` is the source's to choose, and core code must not know one provider's identifiers ([plugin architecture](../architecture/2026-10-11-plugin-architecture.md)). A plugin that has such an identifier can make it the item's `id` itself.

**Matching by title alone.** Titles repeat: remakes, a film and its trailer, episodes that share a name. A duration within 2 seconds tells most of them apart.

**Playing the best of several matches.** Playing the wrong video, and moving the owner's history onto it, is worse than saying the video is gone.

**A plugin method that relocates an item.** Every source would implement it; the `search` every library source has already answers the question, with no change to the plugin API.

## Consequences

A video that a library rescan gave a new id plays again on the next request, where the owner left it, with the subtitles chosen for it, and its history follows it. The cost is one failed `prepare` and one library search before the stream. History and the track choice move on the first such play, but queue entries, playlist items, and share links keep the id they were made with: a queue or playlist item finds the item again each time it plays, and a share link to a moved item no longer plays.

A different file with the same title and a length within 2 seconds of the old one, such as another copy of the same film, is taken for the moved item when it is the only one; two such files play nothing. Any `not_found` from `prepare` starts the search, also one for a source plugin the node has not loaded; the answer then still says the video is no longer in the library, with the source's own words after it. The search needs the source to find the item by the title Yolo knows and to return its `duration` in seconds (`LibraryItem` in [`service/plugin-api/src/index.js`](../../../../service/plugin-api/src/index.js)); a title that carries more than the item's own name, as an episode's carries its show and number, may not match the source's search, and then the item is not found again.

## Testing

[`hub-core.test.js`](../../../../service/control/test/unit/hub-core.test.js) plays an item whose `prepare` answers `not_found` and finds it under its one new id by a title spaced and cased differently and a duration 1.5 seconds off, from the old id's position, with history and the track choice moved; two matches, only another source's, and a duration 2.5 seconds off play nothing and answer `not_found`. [`history.test.js`](../../../../service/control/test/unit/history.test.js) covers a move onto an id that has its own entry. The player's sentence and the hidden **Try again** have no test of their own.
