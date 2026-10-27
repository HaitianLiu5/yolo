# Agent Note: Bilibili's pages through the egress rule, its media from upos

Status: implemented

English | [中文](2026-10-27-bilibili-through-the-egress-rule.zh.md)

## Problem

Some Bilibili series (番剧) play only in mainland China, even for the owner's paid account. From the node's network, both the episode page and Bilibili's play-info API refuse such an episode (`-10403`, "抱歉您所在地区不可观看"). The [egress proxy layer](../architecture/2026-10-13-node-egress-proxy.md) can send `www.bilibili.com` through a proxy in China, which passes the page's region check, and yt-dlp then reads the play info embedded in the page.

But the play info Bilibili embeds for a viewer in China names mainland CDN hosts for many files: peer CDN hosts on `*.mcdn.bilivideo.cn:8082` and `*.edge.mountaintoys.cn:4483`. The node fetches media directly, as the egress layer intends, and from abroad those hosts give no first byte or time out. On 2026-10-27, with that rule live, every popular Bilibili video stalled on the Apple TV and in Chrome, not only series, so the rule was removed and series stayed region-limited.

Measured from the home node that day:

- In the play info of 9 popular videos fetched through the China line, every main URL was on a mainland CDN host, and each file listed a backup URL on Bilibili's upos CDN (`upos-sz-*.bilivideo.com`).
- The upos backups answered from the US with `206`. A URL signed in China also played on the upos mirrors the plugin already ranks (`upos-sz-mirrorcosov`, `-mirrorali`, `-mirrorhw`), and a `mountaintoys` URL moved to an upos host played too.
- An `mcdn` URL is signed for its host (its query names `os=mcdn`), so moved to an upos host it answers `403`, and in place it answered slowly or not at all.
- yt-dlp keeps only each file's main URL and drops the backups, so the plugin never saw a reachable one.

## Decision

The yt-dlp plugin ships a second yt-dlp extension, [`yt-dlp/yolo/yt_dlp_plugins/extractor/yolo_bilibili.py`](../../../../plugins/source-ytdlp/yt-dlp/yolo/yt_dlp_plugins/extractor/yolo_bilibili.py), loaded with `--plugin-dirs` on every run like the one that asks Tencent Video for H.264 ([Tencent Sports replays](2026-10-26-tencent-sports-replays.md)). It overrides yt-dlp's Bilibili video and series extractors in one place: before yt-dlp turns the play info into formats, a file whose main URL is not on an upos host gets its first upos backup as its main URL. yt-dlp's formats then carry upos URLs, and the plugin's mirror probe orders the upos mirrors as it does for any Bilibili video ([`mirrors.js`](../../../../plugins/source-ytdlp/src/mirrors.js)).

- **It runs for every Bilibili page, proxied or not.** From the node's own network the main URLs are already upos or Akamai hosts, so nothing changes there; a file with no upos backup keeps its main URL.
- **The owner's rule names only `www.bilibili.com`.** That host serves pages, never media; Bilibili's APIs (`api.bilibili.com`), its upos CDN, and the season list the plugin reads stay direct ([up next](2026-10-23-up-next.md)).

## Alternatives considered

**Sending the mainland CDN hosts through the proxy as well.** It would play every file as Bilibili named it, but every byte of every Bilibili video would cross the proxy, which is slow, may count against a paid allowance, and is the detour the egress layer exists to avoid.

**Moving each mainland CDN URL to an upos host in the plugin.** It works for `mountaintoys` URLs, whose path and signature are upos's, but an `mcdn` URL is signed for its own host and is refused elsewhere; only Bilibili's own backup URLs are reliable, and only yt-dlp sees them.

**Reading Bilibili's play info in JavaScript instead of yt-dlp.** It would keep the backups without Python, but means porting yt-dlp's Bilibili extractors (sign-in, the series and video variants, their formats) and keeping them current alone.

## Consequences

With `www.bilibili.com` in the owner's egress rule, region-limited series play up to the account's best quality from upos mirrors, and every other Bilibili video plays as before, its page now read through the proxy.

The costs:

- Every Bilibili page yt-dlp reads crosses the proxy, a little slower, and needs the proxy up: while it has no endpoint, no Bilibili video resolves.
- The extension depends on yt-dlp's Bilibili extractors calling `extract_formats` with play info whose files keep their `backupUrl` or `backup_url`, so a yt-dlp bump that changes that can bring the stalls back with the rule on. The plugin's tests check that the extension is loaded on every run, not what Bilibili returns.
- A file whose play info lists no upos backup still stalls behind a mainland CDN host.
