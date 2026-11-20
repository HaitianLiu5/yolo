# Agent Note: Agents accept their changes by walking them

Status: implemented

English | [中文](2026-11-20-agent-acceptance.zh.md)

## Problem

Yolo had about 480 unit and integration tests, 145 Swift unit tests, 30 scripted end-to-end journeys, a conformance kit for native clients, a tvOS UI test, and four GitHub Actions workflows. Between 2026-10-21 and 2026-11-07, when the Actions minutes ran out and the workflows stopped (#138), 447 runs failed 10 times. None of those failures was a bug an owner would have met: two were a timing race in the voice test, two were the provider-name rule catching a word in a comment, one was a plugin missing the description screens show, and five were the e2e runners themselves (ffmpeg installs that timed out, an ffmpeg crash, a port already in use). The Apple workflow passed 51 runs of 51. In the same weeks three commits only repaired tests (#96, #143, #82), #98 rewrote an e2e journey after a Chrome update, and test code was 16% of all code churn. A full local `npm run check` took about 14.5 minutes, 13.6 of them the e2e journeys. Unit tests pinned how the code was written, so every refactor rewrote them; the journeys drifted from what screens do; and the conformance kit had no recorded run. Meanwhile what owners did hit, a car's stutter, a Bilibili region, a screen that paired but showed nothing, came from paths no suite modeled.

## Decision

Whoever makes a change, the agent in practice, proves it by running Yolo and using it: the paths the change touches, on every screen it reaches, with the real player in Chrome (car mode and web mode), the iOS app, and the tvOS app in the Simulator, as the owner would. The [`yolo-acceptance`](../../../skills/yolo-acceptance/SKILL.md) skill is the checklist: how to start, the paths, how to walk each, what passes, what the stack cannot show, and what the report carries (screenshots, command output, MCP answers, and what was not walked). No unit test, scripted end-to-end test, or CI gate is added in place of that walk, and merging and releasing never wait for a check; they wait for the owner.

**What stays automatic** is what needs no cases written and kept: `npm run check` runs the documentation gates, builds the player and the Worker, and runs the rule checks ([`scripts/run-gates.js`](../../../../scripts/run-gates.js) `rules`), in about 15 seconds: no file under `service/` names a provider ([plugin architecture](../architecture/2026-10-11-plugin-architecture.md)); every text the player, the owner pages, and the Apple apps show has its Chinese ([player language](../feature/2026-10-26-player-language.md)); nothing the Worker serves references another host, and the owner pages keep Yolo Web's dark tokens ([two engines](../architecture/2026-10-12-two-playback-engines.md)); one version everywhere with its CHANGELOG entry ([versions and releases](../process/2026-10-13-versions-and-releases.md)); every catalog plugin describes itself for screens; and every skill is linked for Claude Code. Modules those checks import from `service/control/src` stay free of `cloudflare:workers`, so they load in plain Node. A change under `clients/apple/` also builds both apps in Release. GitHub Actions runs no checks; its one workflow answers `@claude` mentions.

**The stack.** `npm run stack` ([`scripts/stack/`](../../../../scripts/stack/)) starts the whole of Yolo on the machine: the media node and the control plane under `wrangler dev --local` on free ports, with local D1 and KV, a generated config with no route or Workers VPC binding, an owner and the owner's session, an agent's token through the real OAuth flow, and stand-ins for everything outside Yolo: media made with ffmpeg in each stream type, a yt-dlp and a Plex that answer locally, a folder library, and a library of events. It keeps the isolation the tests had: the node gets its own `YOLO_RUNTIME_DIR` and socket under a temporary directory, `YOLO_ENV_FILE=""`, and Bonjour off; nothing calls Cloudflare, YouTube, Plex, or Let's Encrypt; nothing touches the live node's runtime directory or port 9191. Its commands approve a screen's code as the owner, make an agent's MCP and `/v1` calls, and print the owner's code for a passkey. `npm run stack:walk` walks the main path on one screen (pair, an agent plays, pause, seek, resume) with a screenshot and what the screen and Yolo said at each step, and asserts nothing: the agent judges what it saw. A debug build of the Apple apps launched with `-YoloServer <address>` pairs with that address, past Bonjour, which would offer the owner's own instance.

Two rules from the test layers stand on their own: a page's mode and engine come from the device type and the Tesla fingerprint, so a change is walked in car mode and web mode both; and a change that may differ under the oldest supported Node (22) is run under it (`npx -y node@22 …`), since Node 22 cancels a pending promise when the event loop drains.

### In-car checks

Route and playback changes are also checked in the car with the stream type they affect: `hls`, `direct`, `dash_split`, or `plex`, confirming that the player loads and pairs, seeking works, and picture and sound stay in sync. After changes to playback or networking, a fault check covers what the stack cannot reproduce: the real Tesla renderer, the mobile connection, the Cloudflare path, and the home node together. Start a fixed 720p60 YouTube or Bilibili video, then run each fault separately and let playback settle before the next:

| Fault | Expected |
|---|---|
| Disconnect the car for 30 seconds | Buffered video continues where possible; recovery resumes near the prior position without a page reload |
| Disconnect for 60 seconds | Once a stall lasts 8 seconds, the device's events report `bandwidth_insufficient` (available versus needed kbps) or `network_unstable`; retry delays stay capped at 60 seconds |
| Disconnect for 180 seconds | The page stays responsive and memory stays bounded; playback re-resolves the source when connectivity returns |
| Switch Wi-Fi to LTE or another hotspot | Old CDN and session URLs are dropped, and a fresh stream resumes at the saved position |
| Restart the media node while playing | The stale session answers `410`, and the player builds a fresh stream instead of retrying the stale URL |
| Open the player with `?decodeErrorAt=<seconds>` a little ahead of where it will play, then again with `&decodeErrorCount=4` | Once: a `decoder_recovery` at step 1 with `outcome: "recovered"`, no new stream, and the sound playing on. Four times: steps 1 to 3 `failed`, step 4 `requested`, then one new stream at the position |

It passes when no state loops forever (buffering, disconnect, reconnect); recovery follows the 1, 3, 10, 30, then 60-second backoff without a retry storm; HLS prefetch drains after recovery with one download active; `bandwidth_insufficient` is reported only when at least two throughput samples support it; quality changes follow the [adaptive policy](../feature/2026-10-11-adaptive-quality.md); and the device's events show `stall_start`, the recovery, a fresh stream request, and `playback_recovery_stable` ([device telemetry](../feature/2026-10-11-device-telemetry.md)).

## Alternatives considered

**Keep the cut suite and run it locally.** The suite had already been cut by 80% on 2026-10-18 to one test per contract. What was left still failed on its own harness more often than on a product bug, cost 14 minutes a run, and a third of the fixes in its last month were to tests. A smaller suite is still a suite to keep in step with code that changes daily.

**Keep the scripted journeys, drop the unit tests.** The journeys proved the joins, but each was a script of selectors and timings that a layout or a Chrome update broke, and green journeys did not prevent the stutters and region failures owners saw. Their valuable part, a whole local Yolo with fake providers, stays as `npm run stack`; the assertions go, and the agent looks at the result instead.

**Bring CI back for the static checks only.** They take 15 seconds locally and run in `npm run check`; a required check that cannot run (as when the minutes ran out) only blocks merges.

**Keep the D1 migration test and the conformance kit.** Neither caught anything in its recorded runs, and the kit had no recorded run at all. A migration is walked by starting the stack, which applies every migration to a new D1, and meets real rows when the owner upgrades, which backs D1 up first and can roll back.

## Consequences

`npm run check` takes about 15 seconds instead of about 14.5 minutes, and no change waits on a machine to merge. Code changes no longer carry test rewrites, and the agent's report shows the screens themselves.

What it gives up: a regression on a path the change did not seem to touch is no longer caught by a test that happened to cover it; the walk catches it only if the agent walks that path, so the skill asks for every screen when the Hub, `/v1`, the realtime channel, MCP, or a source changes, and for the main path on all five screens when unsure. Narrow rules the unit tests pinned (backoff timings, quality thresholds, protocol edge cases) are now proven only by the walk, the in-car checks, and review. The walk depends on the agent looking honestly at what it saw and reporting what it did not walk. The real Tesla, real providers, real certificates, the Cloudflare path, Safari, and real Apple hardware remain outside the stack, as they were outside the suite.
