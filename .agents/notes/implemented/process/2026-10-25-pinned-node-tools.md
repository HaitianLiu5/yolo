# Agent Note: The checkout pins the node's yt-dlp and Deno

Status: implemented

English | [中文](2026-10-25-pinned-node-tools.zh.md)

## Problem

The node runs yt-dlp for every web page it plays, and yt-dlp runs Deno for YouTube. Owners installed both with Homebrew or their distribution, so which versions ran depended on the machine and the day it was set up, Homebrew upgraded them on its own schedule, and a rollback restored Yolo's code but not the tools it had been tested with. When a site changed and a newer yt-dlp fixed it, every owner had to notice and upgrade by hand. `doctor` could only say that some yt-dlp was on PATH.

## Decision

### The manifest

[`tools.json`](../../../../tools.json) at the repository root pins one release of each tool: its GitHub repository, the release tag, and for macOS and Linux on arm64 and x64 the archive's name, its SHA-256, and the executable inside it. It pins yt-dlp, as its unpacked-folder builds (`yt-dlp_macos.zip`, `yt-dlp_linux.zip`, `yt-dlp_linux_aarch64.zip`), and Deno. The file is committed and versioned with the code, so a Yolo version names exactly one set of tools.

### Installing

The root `postinstall` script runs `npm run yolo -- tools install --postinstall`, so every `npm install` and `npm ci` installs the pinned set ([`ops/lib/tools.js`](../../../../ops/lib/tools.js)):

- A build the cache lacks is downloaded from its GitHub release, checked against its SHA-256 before anything is unpacked, and unpacked with `unzip` under a temporary name that becomes final only once complete.
- The cache is shared by every checkout on the machine: `~/Library/Caches/yolo/tools` on macOS, `$XDG_CACHE_HOME/yolo/tools` (else `~/.cache/yolo/tools`) on Linux, or `YOLO_TOOLS_CACHE`. It keeps two releases of each tool besides the pinned one, for rollbacks and other checkouts.
- `.tools/bin/<tool>` in the checkout, which git ignores, links the pinned executable, and each tool runs `--version` once, which proves it starts and pays the first start of yt-dlp's macOS build (about 10 seconds) before a play would.
- A failed or mismatched download fails `npm install`. `YOLO_TOOLS=skip` skips the step, which CI uses because no job runs a real node and the e2e tests fake yt-dlp. On a platform `tools.json` has no builds for, the step does nothing and the node finds the tools on PATH as before.

### Running

At start the node puts `.tools/bin` first on its PATH ([`service/node/src/main.js`](../../../../service/node/src/main.js)), so every plugin's child process, and yt-dlp's own search for Deno, runs the pinned builds even when another yt-dlp is installed. A plugin option that names an executable, such as the yt-dlp plugin's `binary`, still wins. Code under `service/` names no tool.

### Upgrades, rollbacks, and checks

`npm run yolo -- upgrade` and `rollback` run `npm ci` in the checkout before they restart the node, so the node comes back with the tools the target release pins; a rollback finds the older builds in the cache. `doctor` fails when a pinned tool is missing or `.tools/bin` links another release, with the fix `npm run yolo -- tools install`; `npm run yolo -- tools status` runs the same check alone.

### Bumping a tool

`npm run yolo -- tools bump <tool>` pins the tool's latest release, with the SHA-256 GitHub states for each archive. A site fix in yt-dlp reaches owners as a Yolo release that bumps `tools.json`, usually a patch release ([versions and releases](2026-10-13-versions-and-releases.md)); nothing updates itself between releases.

### What the owner still installs

ffmpeg and cloudflared stay system programs, installed with Homebrew or the distribution and checked on PATH by `doctor`. FFmpeg publishes no builds of its own, and the static builds available are third-party snapshots of its development branch; ffmpeg's command line also changes far more slowly than the sites yt-dlp follows.

## Alternatives considered

**Owners install every tool themselves.** That was the previous state, and the source of the drift above.

**yt-dlp updating itself.** Running `yt-dlp -U` daily fixes sites fastest, but then what an instance runs depends on when it last updated, no test ran that pairing, and a rollback cannot restore it.

**Committing the binaries.** Each tool is about 40 MB per platform, so four platforms and frequent yt-dlp releases would grow the repository with every bump, and ffmpeg builds carry GPL redistribution terms.

**A Homebrew formula that depends on the tools.** Homebrew would install them, but versions would follow Homebrew rather than Yolo, rollbacks could not restore them, and Linux would need something else.

**A container image.** It pins everything, but on macOS a container loses VideoToolbox, the home network's addresses, and Bonjour, which the node needs.

**yt-dlp's single-file builds.** The macOS one unpacks itself on every run and took about 10.6 seconds to print its version on every start; the folder build takes 0.26 seconds after its first.

**Pinning ffmpeg too.** The static builds for macOS are development snapshots from one maintainer, and the Intel ones stopped in January 2026, a weaker footing than the official GitHub releases yt-dlp and Deno publish.

**A tools directory in each checkout.** Every worktree and deploy checkout would download the same 80 MB again; a shared cache with per-checkout links downloads each release once per machine.

## Consequences

A Yolo version runs the yt-dlp and Deno it was tested with on every machine, an upgrade or rollback changes them with the code, and `doctor` checks the exact builds. An owner installs two fewer programs, and a Homebrew yt-dlp left on PATH no longer matters.

The cost is that `npm install` needs GitHub and downloads about 80 MB the first time on a machine, a site fix waits for a Yolo release instead of arriving with yt-dlp's, and Yolo trusts yt-dlp's and Deno's GitHub releases, pinned by SHA-256.
