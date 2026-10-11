# Plex session recovery

## Incident

Plex reclaimed an idle HLS session after 180 seconds. Drive-In continued fetching
its segment URLs. Each upstream 404 triggered up to 15.75 seconds of retry delays,
longer than the browser's 12-second inactivity limit. The UI reported network
trouble while the upstream was actually returning immediate, definitive 404s.
A WebSocket reconnect skipped restoration whenever a local player existed.

## Community baseline

[python-plexapi](https://github.com/pkkid/python-plexapi/blob/master/plexapi/server.py)
uses `/transcode/sessions` for the active transcode inventory. We reuse that Plex
API, not an inferred timeout or a custom session lifetime. No Plex global setting
is changed. In particular, the transcoder throttle buffer is not a session lease.

## Boundaries (Yolo 0.3)

The design moved from the Drive-In server into Yolo's media node and the Plex
source plugin, and became source-neutral: any source whose stream comes from a
transcoder can use it.

- `plugins/source-plex/src/playback.js` interprets Plex's transcode inventory
  (`sessionHealth`) and exposes it as the stream descriptor's `health()`. It
  marks its HLS Input `transcoder: true`.
- `service/node/src/media/pipeline.js` owns missing-segment retry budgets for a
  `transcoder` Input, asks `health()` when a segment or playlist is missing,
  and turns a proven absence into a typed expiration response. Proxies never
  restart playback. Sessions the node does not hold (a node restart, or a
  stopped session) answer the same way.
- `HlsSegmentPrefetcher` stops requests for an expired playlist and preserves
  the typed error. A fresh playlist is independent of the old one.
- `MediabunnyPlayer` reports active-session expiration and defers background
  expiration while paused until play is requested.
- `clients/tesla/src/player.js` remains the single owner of fresh-session
  recovery. It asks Yolo for a new stream of the same item (`POST
  /v1/playback/play` with `reason: "recovery"`, the position, the playback
  intent and the session it replaces); Yolo keeps the track choice.
- On reconnect, `clients/tesla/src/main.js` reuses a local player only while
  the Hub still has this device playing the same session.

## Contract and budgets

- A missing manifest or segment plus a successful inventory proving absence
  returns HTTP 410, JSON `code: SESSION_EXPIRED`, and the same code in
  `X-Yolo-Error-Code`. Responses are not cached. The control plane passes it
  through unchanged.
- An inaccessible or malformed inventory means `unknown`, not expired. A probe
  is bounded to two seconds (three including the pipeline's own limit).
- Missing segments receive at most four attempts, with delays 0/250/500/1000 ms.
  The complete response-header negotiation (including probes) has an
  eight-second budget; a slow but progressing body is not cut off.
- Client disconnect cancels segment requests.

## Verification

Unit tests cover missing/alive/unknown states (`plugins/source-plex/test`) and
the pipeline's 404-then-expired path (`service/node/test/media-pipeline.test.js`).
The end-to-end Plex test (`test/e2e/tesla-client.test.js`) decodes real HLS from
a Plex fixture, drops the fixture's transcode session, and checks that the
player gets a new stream at the position reached.

Live Plex and Tesla checks remain separate from fixture success. Existing open
browser pages need a reload to acquire updated client code.
