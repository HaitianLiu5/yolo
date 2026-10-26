---
name: yolo-testing
description: Use when choosing which Yolo tests and checks prove a change, running them, or diagnosing a failing test or CI job; routes in-car, WebKit, and live-provider proof to its owner. Adapted from OpenClaw's openclaw-testing skill.
---

# Testing Yolo

Prove the contract you changed, run the gates the change needs, and stop. Repeat or widen a run only for changed inputs, a failure, or a named risk. Writing, changing, or reviewing a test also goes through [`yolo-test-audit`](../yolo-test-audit/SKILL.md). The layers and their jobs are in [test layers](../../notes/implemented/testing/2026-07-21-test-layers.md).

## Proof policy

- `npm run check` is the required proof for every change (AGENTS.md). While iterating, run only the touched files: `node --test <file>` from the owning workspace, or `npm run test:unit -w <workspace>`.
- One focused run of the owner test, then the full check once before pushing. Never rerun or re-push just to turn CI green; fix the real failure.
- Report what you did not run: in-car checks, WebKit, real yt-dlp or Plex, the Cloudflare path.

## Select the proof

| Change | Proof |
|---|---|
| Player module (`clients/player/src`) | its unit test if one exists, then the e2e journey that plays through it (`car-playback`, `web-playback`, `media-paths`) |
| Canvas engine (`engine/mediabunny-player.js`) | e2e car playback, and the in-car check for the affected stream type |
| `<video>` engine | e2e web playback, and `YOLO_E2E_WEBKIT=1` or Safari |
| Route, `/m/*`, `/v1`, MCP, pairing, auth | control unit or integration test, then e2e |
| Node media pipeline, LAN or remote listener | node test, then e2e `media-paths` |
| Source or DNS plugin | the plugin's own test, then e2e if it plays through the stack |
| D1 migration | the migration test, against the previous release's rows |
| `ops/` command | its test if one exists, then a `--dry-run` or `npm run yolo -- doctor --offline` |
| Notes or docs only | `npm run doc-sync` and `git diff --check`; no runtime tests |

- A runtime bug: reproduce it at its real entry point first, then fix, then rerun that entry point and its siblings.
- External services (YouTube, Bilibili, Plex, Let's Encrypt, Cloudflare) are never called by tests. A claim about them needs a live check by the owner, stated as pending.
- A Tesla claim needs the in-car check in the test-layers note; a green suite does not prove the car.

## State boundaries

- Tests run on the owner's home machine beside the live node. Never use the live node's runtime directory, its socket, `.env`, or port 9191; the e2e stack takes free ports and a temporary `YOLO_RUNTIME_DIR`.
- Never run a contributor's untrusted code with the owner's credentials.
- e2e needs ffmpeg and a Chrome that decodes H.264. Playwright's own Chromium does not, so the car journeys fail there with "Browser cannot decode video codec: avc"; point `PLAYWRIGHT_CHROMIUM_EXECUTABLE` at Google Chrome or a Chrome for Testing build (`storage.googleapis.com/chrome-for-testing-public/<version>/linux64/chrome-linux64.zip`).

## CI failures

- Bind the diagnosis to the exact commit and job; read the failed log once.
- Separate product, harness, infrastructure, and the oldest supported Node (CI runs Node 22 and 24; reproduce with `npx -y node@22 --test <file>`).
- A failure that is red on `main` too is not the PR's: say so once and port a fix if one exists.

## Test failure policy

- A failing test is a defect until shown otherwise. Reproduce it once in the same order, find the owner, and fix the product, fixture, shared state, or ordering bug.
- A proven repair keeps one regression test, at the owner, that failed before the fix.
- Never hide a failure with retries, longer timeouts, weaker assertions, broader mocks, or a skipped test.
