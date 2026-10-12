# Agent Note: Fixes from the Drive-In repository review of 2026-09-05

Status: implemented
Archived: 2026-10-12

English | [中文](2026-09-06-drive-in-review-fixes.zh.md)

## Problem

A review of the Drive-In repository on 2026-09-05, before Yolo existed, found defects across the old server, the player, and deployment: cache collisions, stuck playback at the ends of short streams, subtitles that reappeared or broke playback, recovery loops, and configuration that was silently ignored or forced on everyone.

## Decision

Each finding was fixed with a regression test; the separately requested removal of Docker support was kept.

| Finding | Resolution |
|---|---|
| HLS cache collisions | Generic segment keys include the full URL and the exact range; old pathname-only keys are not reused. Provider-specific signed-URL identities remain supported |
| Short HLS stuck buffering | ENDLIST playlists expose whether every remaining segment, the current one included, is cached; only a fully available finite tail bypasses the forward-buffer target, and decoding is still required |
| Remote Plex embedded subtitles fail playback | Missing or inaccessible source paths get burn-in descriptors, and no local extraction is scheduled for them |
| Audio shorter than video freezes playback | The worklet drains a partial final audio quantum; after audio ends and drains, the clock continues on wall time from the same position, and seeking restores the audio clock |
| An old stop stops a new play | Stop is broadcast with the synchronous stop intent, before the asynchronous cleanup is awaited |
| Mute lost when the player is replaced | Every new player applies the current mute state, independently of unlocking the audio context |
| Paused recovery loops | A new paused player confirms readiness without requiring progress, and the old player cannot confirm its replacement |
| Late subtitles reappear | Track loading is cancellable and checks the current request; disabling, removal, replacement, and new playback invalidate old loads |
| Plex offset zero ignored | An explicit zero is kept; non-numeric, negative, and non-finite offsets are rejected; an omitted offset still resumes Plex's progress |
| Missing transcode initialization URI | Shared HLS rewriting handles URI attributes (EXT-X-MAP) as well as media lines |
| URL SRT conversion undefined | The downloader is a testable module that imports the existing SRT converter |
| Mandatory Chrome cookies | Cookies are optional and explicitly configured with yt-dlp's browser or file options |
| Local `.env` ignored | Node's native env-file loading runs before logging and storage start; exported settings take precedence |
| Docker deployment issues | The Dockerfile, Compose file, Docker CI, and its update configuration were removed at the owner's request |

The same work fixed a seek-spinner race, let a one-segment ffmpeg output become ready, and made split-stream self-probing use the actually bound port. Lockfile updates within existing ranges brought `npm audit` to zero advisories. The final `npm run check` ran 178 tests and the production build.

## Alternatives considered

**New runtime libraries.** No runtime library was added: the fixes extend the existing buffer policy, shared audio ring, playback lifecycle, and subtitle converter, and HLS URI handling is shared between generic proxying and ffmpeg output rather than introducing another player or manifest dependency.

## Consequences

Before deploying, the root `.env` began to take effect on startup (exported values still win); an installation that relied on Chrome login had to set `YTDLP_COOKIES_FROM_BROWSER=chrome` or `YTDLP_COOKIES_FILE`; generic `.ts` entries under the old cache key were no longer hit and aged out normally; and the server and the rebuilt player had to be deployed together so the worklet's end-of-audio flag and the player clock stayed in step. Tesla hardware, moving-vehicle networks, and real YouTube, Bilibili, and Plex accounts still needed acceptance in the car.
