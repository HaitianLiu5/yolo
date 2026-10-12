# Agent Note: Three test layers and in-car checks

Status: implemented

English | [中文](2026-07-21-test-layers.zh.md)

## Problem

Yolo's behavior spans pure policy (the Hub, pairing, quality decisions), real boundaries (HTTP bodies, the D1 schema, WebCodecs), and a full journey through a Worker, a media node, ffmpeg, and a browser. A test suite that proves everything end to end is slow and flaky; one that proves only units misses the joins. Tests also run on the owner's home machine, next to the live media node, and must never touch its state, its port, Cloudflare, YouTube, or Plex. Some conditions — the real Tesla renderer, a mobile connection, the Cloudflare path — cannot be reproduced locally at all.

## Decision

Yolo has three test layers, each with its own job:

- **Unit** (`*/test/unit`, and the `test/*.test.js` of the service and plugin workspaces): deterministic policy and state transitions — the Hub, the device pairing flow, the source plugins' `prepare()`, the media pipeline against local HTTP origins. They need no ffmpeg, browser, or network.
- **Integration** (`clients/tesla/test/integration`, `service/control/test/integration`): one real boundary each, such as HTTP bodies, WebCodecs orchestration, or the `/v1` API over the real service layer and D1 schema, with external dependencies injected.
- **End to end** (`test/e2e`): the real stack — the media node, and the control plane under `wrangler dev --local` with a generated config, local D1 and KV, and no fixed ports, nothing sent to Cloudflare — with the Tesla client served as the Worker's static assets. Chromium pairs through the device code flow and plays the four stream types (`direct`, `hls`, `dash_split`, `plex`) through `/m/*`, started by an agent over MCP. Media is made with ffmpeg; yt-dlp and Plex are local fixtures (`test/e2e/fixtures.js`).

An assertion belongs at the lowest layer that can prove the behavior; end-to-end tests cover complete journeys and do not repeat every edge case of the unit tests.

**Isolation.** Tests never use the repository's runtime state: the node gets `YOLO_RUNTIME_DIR` and its own socket under a temporary directory, and `DRIVEIN_ENV_FILE=""` so it loads no `.env`. Network tests use local origins or injected transports. No test shares a port, calls YouTube or Plex, or depends on a running Yolo node, and nothing runs against the live node's runtime directory or its port 9191. Modules under `service/control/src` that tests import do not import `cloudflare:workers` (only `index.js` and `hub/hub.js` may), so they stay testable in plain Node.

**Commands.** `npm run test:unit`, `npm run test:integration`, and `npm run test:e2e` (which builds `clients/tesla` first if `dist/` is missing) run the layers independently; `npm run check` runs the documentation gates, builds the client and the Worker, and runs all three. The e2e tests need ffmpeg and Chromium (or Google Chrome).

### In-car checks

Route and playback changes are also checked in the car with the stream type they affect: `hls`, `direct`, `dash_split`, or `plex`, confirming that the player loads and pairs, seeking works, and picture and sound stay in sync. After changes to playback or networking, a fault check covers what local automation cannot reproduce: the real Tesla renderer, the mobile connection, the Cloudflare path, and the home node together. Start a fixed 720p60 YouTube or Bilibili video, then run each fault separately and let playback settle before the next:

| Fault | Expected |
|---|---|
| Disconnect the car for 30 seconds | Buffered video continues where possible; recovery resumes near the prior position without a page reload |
| Disconnect for 60 seconds | The player explains a measured bandwidth shortfall or an unstable connection; retry delays stay capped at 60 seconds |
| Disconnect for 180 seconds | The page stays responsive and memory stays bounded; playback re-resolves the source when connectivity returns |
| Switch Wi-Fi to LTE or another hotspot | Old CDN and session URLs are dropped, and a fresh stream resumes at the saved position |
| Restart the media node while playing | The stale session answers `410`, and the player builds a fresh stream instead of retrying the stale URL |

It passes when no state loops forever (buffering, disconnect, reconnect); recovery follows the 1, 3, 10, 30, then 60-second backoff without a retry storm; HLS prefetch drains after recovery with one download active; a bandwidth warning claims insufficient Mbps only when at least two throughput samples support it; quality changes follow the [adaptive policy](../feature/2026-10-11-adaptive-quality.md); and the device's events show `stall_start`, the recovery, a fresh stream request, and `playback_recovery_stable` ([device telemetry](../feature/2026-10-11-device-telemetry.md)).

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

Most behavior is proven quickly and deterministically, and the end-to-end layer proves the joins with real media, a real Worker runtime, and a real browser, without credentials or a network. Browser end-to-end tests remain the slowest and least stable layer under load. Hardware, moving-vehicle networks, and real YouTube, Bilibili, and Plex accounts still need the in-car check; a green suite does not prove them.
