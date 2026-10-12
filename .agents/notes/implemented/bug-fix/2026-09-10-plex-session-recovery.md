# Agent Note: Recover from a reclaimed Plex transcode session

Status: implemented

English | [中文](2026-09-10-plex-session-recovery.zh.md)

## Problem

Plex reclaimed an idle HLS transcode session after 180 seconds, and Drive-In kept fetching its segment URLs. Each upstream 404 triggered up to 15.75 seconds of retry delays, longer than the browser's 12-second inactivity limit, so the UI reported network trouble while the upstream was answering immediately with definitive 404s. A WebSocket reconnect also skipped restoration whenever a local player existed, so the dead session was never replaced.

## Decision

A missing segment of a transcoder-backed stream becomes a typed expiration that the player answers with a fresh stream. The design started in the Drive-In server and now spans Yolo's media node and the Plex source plugin; it is source-neutral, so any source whose stream comes from a transcoder can use it.

- [`plugins/source-plex/src/playback.js`](../../../../plugins/source-plex/src/playback.js) interprets Plex's transcode inventory (`sessionHealth`) and exposes it as the stream descriptor's `health()`, and marks its HLS Input `transcoder: true`.
- [`service/node/src/media/pipeline.js`](../../../../service/node/src/media/pipeline.js) owns the retry budget for missing segments of a `transcoder` Input, asks `health()` when a segment or playlist is missing, and turns a proven absence into a typed expiration response. Proxies never restart playback. Sessions the node does not hold (after a restart, or once stopped) answer the same way.
- `HlsSegmentPrefetcher` stops requesting an expired playlist and preserves the typed error; a fresh playlist is independent of the old one. `MediabunnyPlayer` reports expiration of the active session and, while paused, defers a background expiration until play is requested.
- [`clients/tesla/src/player.js`](../../../../clients/tesla/src/player.js) is the single owner of fresh-session recovery: it asks Yolo for a new stream of the same item (`POST /v1/playback/play` with `reason: "recovery"`, the position, the playback intent, and the session it replaces), and Yolo keeps the track choice. On reconnect, `clients/tesla/src/main.js` reuses the local player only while the Hub still has this device playing the same session.

### Contract and budgets

- A missing manifest or segment plus a successful inventory proving absence returns HTTP 410 with JSON `code: SESSION_EXPIRED` and the same code in `X-Yolo-Error-Code`. The response is not cached, and the control plane passes it through unchanged.
- An inaccessible or malformed inventory means `unknown`, not expired. A probe is bounded to two seconds (three including the pipeline's own limit).
- A missing segment gets at most four attempts, with delays of 0, 250, 500, and 1000 ms. Negotiating the complete response headers, probes included, has an eight-second budget; a slow but progressing body is not cut off.
- A client disconnect cancels segment requests.

### Testing

Unit tests cover the missing, alive, and unknown states (`plugins/source-plex/test`) and the pipeline's 404-then-expired path (`service/node/test/media-pipeline.test.js`). The end-to-end Plex test (`test/e2e/tesla-client.test.js`) decodes real HLS from a Plex fixture, drops the fixture's transcode session, and checks that the player gets a new stream at the position reached. Live Plex and Tesla checks remain separate from fixture success, and already open browser pages need a reload to pick up new client code.

## Alternatives considered

**Infer a timeout or impose a custom session lifetime.** Plex's own inventory is authoritative: [python-plexapi](https://github.com/pkkid/python-plexapi/blob/master/plexapi/server.py) uses `/transcode/sessions` for the active transcodes, and Yolo reuses that API instead of guessing when a session dies.

**Change Plex's global settings.** No Plex setting is changed; in particular, the transcoder's throttle buffer is not a session lease.

**Keep retrying a missing segment.** Retrying a definitive 404 only delayed the failure past the browser's inactivity limit and hid the real cause behind a network error.

## Consequences

A reclaimed transcode turns into a short, typed recovery at the position reached instead of a stall reported as bad network. Recovery has one owner, the player, so proxies and prefetchers never race to restart playback. The node probes Plex's inventory on missing segments, which costs a bounded request, and an `unknown` inventory deliberately keeps retrying rather than declaring expiry.
