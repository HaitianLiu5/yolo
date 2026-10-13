# Agent Note: Device telemetry in Workers Logs

Status: implemented

English | [中文](2026-10-11-device-telemetry.zh.md)

## Problem

Playback problems happen in the car — after a sleep, on a weak connection, in a browser that no longer identifies itself — where nobody can open developer tools. The earlier home server kept the player's log, and the log went away with that server. Diagnosing a failure needs the device's own view of events, in order, next to the Hub's decisions, without storing telemetry in D1 or showing technical details to the person watching.

## Decision

A paired device posts its own events to `POST /v1/devices/self/events` ([`service/control/src/device-events.js`](../../../../service/control/src/device-events.js)), and the control plane writes each event as one structured line in **Workers Logs** — nothing goes to D1. Only a device credential is accepted, and the device id comes from the credential, never from the body. A line is `{ kind: "device_event", userId, deviceId, pageId, sessionId, type, at, seq, receivedAt, …fields }`.

**Limits.** A batch holds at most 50 events and 60 KiB; an event's fields at most 8 KiB, beyond which the largest fields are dropped and listed in `truncated`. Each device may send 12 batches a minute (counted per Worker instance, best effort), beyond which the answer is `429 rate_limited`. Fields nest at most 5 levels deep, arrays hold at most 100 entries, and strings at most 500 characters. Both ends strip secrets: fields whose key contains token, authorization, cookie, ticket, secret, password, or credential are dropped, `/m/<token>` in strings becomes `/m/<redacted>`, and `ydt_…`, `Bearer …`, and `ticket`, `token`, or `code` query parameters are masked.

**The client** ([`clients/player/src/telemetry/device-events.js`](../../../../clients/player/src/telemetry/device-events.js)) sends at most one batch every 10 seconds. Offline, it buffers up to 400 events, drops the oldest when full, and reports the count in the next batch's `dropped`. When the page is hidden, on `pagehide`, and on `freeze`, it sends what remains with a keepalive `fetch` (`sendBeacon` cannot carry the device credential).

| Events | What they record |
|---|---|
| `health_heartbeat`, `mediabunny_state` (the canvas engine) or `native_video_state` (the `<video>` engine), `stall_start`, `playback_recovery_*` | The player's runtime log ([two engines](../architecture/2026-10-12-two-playback-engines.md)) |
| `realtime_open`, `realtime_close` (`code`, `reason`, `wasClean`), `realtime_ticket_failed`, `realtime_welcome`, `realtime_probe` | The realtime connection |
| `stream_request_waited`, `stream_request_joined`, `stream_request_retry`, `stream_request_ok`, `stream_request_failed` | Stream requests, with error codes and messages ([wake request ordering](../bug-fix/2026-10-11-wake-request-ordering.md)) |
| `page_start`, `visibilitychange`, `pagehide`/`pageshow`, `freeze`/`resume`, `online`/`offline` | The page lifecycle |
| `page_wake`, `wake_to_playback` | A wake (`resume`, `pageshow`, or a timer more than 20 seconds late), and the milliseconds until the picture moves again |
| `session_expired`, `resume_decision` (`why`: `playing`, `interrupted`, `paused`; `interruptedForMs`) | A `410`, and what a returning page decided ([progress and resume](2026-10-11-yolo-owns-progress-and-resume.md)) |
| `autoplay_result` (`sound`, `muted`, `blocked`; `userActivated`, `audioContextState`), `audio_unlocked` | Whether a start without a tap got sound, and how long it played muted |
| `stream_selected` | Each load or rebuild: `reason`, the `engine` that plays it (`canvas` or `native`), source plugin, delivery, the source's width, height, frame rate, codec, and bitrate, `formatId`, `maxVideoKbps`/`ceilingKbps`/`capped`, the viewport, and the path: `network` (`lan` or `tunnel`), `lanHost`, and `original` (the source's file as it is) |
| `stream_first_frame` | The `engine`, the decoder's real picture size and codec, the canvas size (the `<video>` element's, as `video`, for the `<video>` engine), and whether they match the source's claim; once per stream and again after each seek, with `seeks` |
| `quality_change_requested`, `quality_change_failed`, `bandwidth_insufficient`, `network_unstable` | [Adaptive quality](2026-10-11-adaptive-quality.md) decisions, and why a stall of 8 seconds happened (available versus needed kbps) |
| `playback_error_shown`, `playback_retry_requested` | The code and text when the player gives up, and the owner's retry |
| `lan_probe` (`outcome`, `trigger`, `elapsedMs`, `permission`, `host`), `lan_fallback` (`code`, `message`, `position`) | [LAN direct play](2026-10-12-lan-direct-play.md): each probe of the node's LAN origin and why it failed, and each LAN stream that fell back to the tunnel |
| `display_scale`, `env` | The [display size](2026-10-11-display-size.md) after it applies, and the browser itself (below) |

**The `env` event** describes the browser once per page load, and again after a realtime reconnect only when it changed; it stays under 8 KiB ([`clients/player/src/telemetry/environment.js`](../../../../clients/player/src/telemetry/environment.js)). It carries the user agent and `userAgentData` (brands, mobile, platform, and from `getHighEntropyValues` platformVersion, architecture, bitness, model, fullVersionList, wow64, formFactors); screen and viewport sizes; `devicePixelRatio`; `(pointer: coarse)`, `(hover: none)`, and `(display-mode: fullscreen)`; maxTouchPoints, hardwareConcurrency, deviceMemory, and language; cross-origin isolation and SharedArrayBuffer; MSE and WebCodecs support for avc1, hevc, mp4a, and opus; what the `<video>` element offers (`nativeVideo`: its answer for native HLS, and the HLS path, codecs, Picture-in-Picture, fullscreen, and AirPlay the `<video>` engine would use); the Tesla fingerprint's score breakdown (`tesla`, see [device code pairing](2026-10-07-device-code-pairing.md)); and a bounded native-bridge probe: the window's global names left after removing standard ones (at most 100), the type and keys of known bridge names (`qt`, `qt.webChannelTransport`, `cefQuery`, `chrome.webview`, `webkit.messageHandlers`, `external`, `tesla`, `QtCarBrowser`, `android`, `JSBridge`, and others), and non-standard properties on `navigator`. The probe reads only names, types, and keys, and never calls a function it finds. Since 2026.26 the car's user agent no longer says "Tesla", and these data exist to design how to recognize it.

**On screen**, the player shows no technical details: while waiting, a spinner, which shows the start-up buffer percentage after 1.5 seconds; while recovering, the last frame; when it gives up, one sentence ("This video can't play right now.") with **Try again** and **Back**. The details of the latest playback in this browser — the chosen stream, throughput, buffer, cap changes, the last error — are kept in `localStorage` as `yolo.playback.diagnostics` and shown under "Last Playback" on `/diag`.

### Reading the logs

Workers Logs is on (`observability` in `wrangler.jsonc`) without invocation logs: those would record every request's URL, and with it the media token in `/m/{token}/…`, the realtime ticket, and the pairing code. Query strings are also dropped from any URL that still reaches a log or a trace. Query it in the Cloudflare dashboard under **Workers & Pages → yolo-control → Observability** (or the account-level **Observability**). The free plan keeps three days. Yolo writes three kinds of structured lines, each a `console.log` of one object whose fields can be filtered directly:

| `kind` | Written by | Contents |
|---|---|---|
| `device_event` | `POST /v1/devices/self/events` | One device event per line: `deviceId`, `sessionId`, `pageId`, `type`, `at` (device time, ms), `receivedAt`, and the event's fields |
| `hub` | The Hub Durable Object | `event` is `socket_accept`, `socket_hello`, `socket_close` (with `code`, `reason`, `wasClean`), `state` (written only when `status`, `sessionId`, or `deviceId` changes, with a `cause` such as `play:recovery`, `report`, or `disconnect`), `hello_wait` (a device's request waiting for its own hello; `outcome` is `hello` or `timeout`), `device_error` (the device's message, with media tokens and tickets redacted), `decision` (`device_offline`, `node_offline`, `superseded`, `rate_limited`, with `reason` and `why`), `stream` (each prepare: `asked` and the `network` the node served, `reason`, `deliveryType`, `maxVideoKbps`), or `network` (a device's LAN report) |
| `lan` | The LAN maintenance (cron trigger, or the owner's check) | `event` is `certificate` (`name`, `notAfter`), `address_changed` (`from`, `to`), or `error` (`step`, `message`, `failures`, `retryAt`) |

Queries go in the Observability search bar (the Query Builder's filters stay in sync with it):

```text
kind = "device_event" AND deviceId = "dev_…"
kind = "device_event" AND type = "wake_to_playback"
kind = "device_event" AND (type = "session_expired" OR type = "stream_request_failed")
kind = "hub" AND event = "decision"
kind = "hub" AND deviceId = "dev_…" AND (event = "socket_close" OR event = "socket_hello" OR event = "state")
kind = "device_event" AND deviceId = "dev_…" AND (type = "lan_probe" OR type = "lan_fallback" OR type = "stream_selected")
kind = "hub" AND event = "stream" AND deviceId = "dev_…"
kind = "lan"
```

`list_devices` or `GET /v1/devices` gives the `deviceId`. To investigate one incident in the car, filter `device_event` by `deviceId` and time range and sort by `at` to follow the device's side (`page_wake` → `realtime_close`/`realtime_open`/`realtime_welcome` → `session_expired` → `stream_request_*` → `wake_to_playback`), then read `kind = "hub"` for the same period to see the Hub's sockets and decisions. `pageId` changes on every page load, which separates the times before and after a reload.

**Volume.** While playing, a device logs about one heartbeat every 30 seconds plus state changes and network events; the Hub logs state changes, not each 5-second `report`. The free plan allows 200,000 log events a day (0.5 GB a day from 2026-12-01); media segment requests write no log lines.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

An incident in the car can be reconstructed from the device's ordered events and the Hub's decisions without any extra infrastructure, and the person watching only ever sees a spinner or one sentence. Telemetry lives three days on the free plan, so an incident must be investigated soon after it happens. Cloudflare keeps no per-request line for `/m/*`, so a media request shows up only in the device's events and the node's own log.
