# Agent Note: Order a waking device's requests after its welcome

Status: implemented

English | [中文](2026-10-11-wake-request-ordering.zh.md)

## Problem

In production on 2026-10-11, the car slept for 52 minutes. On waking, the next segment answered `410`, so the player asked for a new stream at once, while the realtime connection was still reconnecting. The request reached the Hub before the new connection's `hello`, the Hub considered the device offline and answered `409 device_offline` ("Browser is offline"), and a second later the connection came up. The 410 recovery and the resume after `welcome` also both asked for a stream, so one could replace the other and come back `superseded`.

## Decision

Both sides now handle this order ([`clients/player/src/stream-requests.js`](../../../../clients/player/src/stream-requests.js), [`service/control/src/hub/hub-core.js`](../../../../service/control/src/hub/hub-core.js)):

- **The device waits for its welcome.** A request the device makes for its own playback (recovery, the resume after `welcome`, a seek rebuild, a track change, pressing play on the device) waits until the realtime channel is open and this connection has received `welcome`; while reconnecting, requests queue and go out after the `welcome`. On a wake (`resume`, `pageshow`, or a timer more than 20 seconds late), the device first pings the old connection and replaces it if no answer arrives within 5 seconds; requests wait meanwhile.
- **One recovery at a time.** A recovery triggered by `410` and the resume triggered by `welcome` merge into one request instead of superseding each other. When the first one is no longer wanted or comes back `superseded`, it wanted another stream than the second may, and the second goes itself: the welcome that names a stream whose `load` a reconnect lost asks for it while the player's recovery of the stream it plays is on its way ([Hub and realtime channel](../architecture/2026-10-07-hub-and-realtime-channel.md)).
- **Bounded retries.** `device_offline`, `node_offline`, `rate_limited`, and `resolve_failed` (the codes marked retryable), network errors, and a realtime channel that has not come back are retried after 1, 2, 4, and 8 seconds, within 45 seconds in total; then the player shows the error with its reason ("…(gave up after 5 tries in 15 s)"). When the network or the channel stays away, the player's own recovery loop tries again later, because a car can be offline for minutes. A `device_offline` while the device believes it is connected means the connection died during sleep, so the client replaces it at once.
- **The Hub waits for a hello.** A `POST /v1/playback/play` sent with a device credential for that device itself (named explicitly, or by omitting `deviceId`, since a screen's own request is for that screen) waits up to 5 seconds for that device's `hello` before deciding `device_offline`. A connection is the device's from the moment its `hello` binds it, before its `welcome` is read ([Hub and realtime channel](../architecture/2026-10-07-hub-and-realtime-channel.md)): a request that arrives after the bind does not wait, and the `load` it brings can reach the device just before the `welcome`. A request that arrived earlier waits until the `welcome` has gone out. Each device has its own waiters; nothing polls. Requests from agents, and requests for other devices, never wait.

The `stream_request_*`, `page_wake`, and `wake_to_playback` events and the Hub's `hello_wait` lines record each step ([device telemetry](../feature/2026-10-11-device-telemetry.md)).

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

A car that wakes resumes without a spurious "Browser is offline", and the two triggers of recovery no longer fight. A device's own requests can take up to 45 seconds before an error appears, and the Hub may hold one request for 5 seconds; both are bounded and logged.
