# Agent Note: Tencent Sports replays, in H.264 for the car

Status: implemented

English | [中文](2026-10-26-tencent-sports-replays.zh.md)

## Problem

The owner pays for Tencent Sports and wants its game replays in Yolo, the whole game with the original English commentary first. Three things stood in the way. yt-dlp does not read a Tencent Sports game page (`sports.qq.com/kbsweb/game.htm?mid=…`), only the Tencent Video pages of its replays. Tencent gives a replay's play address only to a viewer in mainland China, which the [egress proxy layer](../architecture/2026-10-13-node-egress-proxy.md) solves. And the replays yt-dlp resolves are HEVC, which the car's canvas engine does not decode: it plays H.264 only ([canvas engine](../architecture/2026-04-04-canvas-playback-engine.md)).

## Decision

### Game pages

The yt-dlp plugin reads a game page itself ([`tencent-sports.js`](../../../../plugins/source-ytdlp/src/tencent-sports.js)): the game's replay list (`matchweb.sports.qq.com/kbs/matchVideoAll`) names each replay's Tencent Video id, cover, title, language, length, and picture, and the game's details name its teams and score. Neither needs a proxy or a sign-in.

- A game page plays one replay through its Tencent Video page (`v.qq.com/x/cover/<cover>/<vid>.html`), which yt-dlp reads: the replay the page's `vid` parameter names, else the whole game with the original English commentary, else the whole game in any language, else the first replay. A game with no replay yet is `not_found`.
- The item keeps the game page as its id, so its history and resume position belong to the game page; the replay's title and picture come from the list, since yt-dlp reads neither from Tencent Video.
- `expand()` turns a game page into every replay, the one the page plays first, so importing it as a playlist lists the quarters and the other commentary. A game page has no `sequence()`: the replays are alternatives, not a run, and nothing should play the first quarter after the whole game.
- The stream's length is the stream's, not the list's: without the owner's sign-in Tencent gives a short preview of a paid replay.

### Signing in

A paid replay plays in full only for a signed-in Tencent Video account: yt-dlp reads the cookies file the plugin is given (`cookiesFile` or `YTDLP_COOKIES_FILE`), and the account's Tencent Video login cookies (on `v.qq.com` and `video.qq.com`) must be in it. A sign-in on `sports.qq.com` alone is not sent to Tencent Video's play-info API, so it gives the preview.

### H.264 for the car

Tencent Video's play-info API answers with H.264 unless the request asks for HEVC, and yt-dlp always asks (`hevclv=28`) and names no codec in the formats it lists, so a format selector cannot tell them apart. The plugin ships a yt-dlp extension in Python, [`yt-dlp/yolo/yt_dlp_plugins/extractor/yolo_vqq.py`](../../../../plugins/source-ytdlp/yt-dlp/yolo/yt_dlp_plugins/extractor/yolo_vqq.py), which every yt-dlp run loads with `--plugin-dirs`. It overrides yt-dlp's Tencent Video extractor in one place: with `--extractor-args vqqvideo:codec=h264`, its play-info request does not ask for HEVC. The plugin passes that argument when the device announces no HEVC codec (`hvc1` or `hev1`), as the car does; a screen that decodes HEVC gets yt-dlp's own request. The same 720p replay then arrives as H.264 from Tencent, with nothing transcoded.

## Alternatives considered

**Transcoding HEVC to H.264 on the node.** It would cover any HEVC source, but needs the node to find a stream's codec from its segments, since Tencent's formats name none, and a new transcoding path for HLS; it spends the node's encoder on every game and gives a softer picture than Tencent's own H.264 at the car's 720p.

**Reading Tencent's play-info API from JavaScript instead of through yt-dlp.** It would take the codec, the title, and the login into the plugin's own hands, but it means porting yt-dlp's request signing for Tencent Video and keeping it current alone. The sign-in from `sports.qq.com` did not help either: passed as the web player's `logintoken`, it still gave the preview, and the player Tencent Sports itself uses signs its requests with obfuscated code that Yolo does not reproduce.

**Asking yt-dlp upstream for an extractor argument.** It is the clean end state and would let the extension go, but the car needed H.264 before a yt-dlp release could carry it.

**Choosing a game's replay by a time or a channel.** The replay list names the commentary only in each title and language field, so the plugin matches "英文" or "English" there, and "全场" for the whole game.

## Consequences

A game page plays in the car with English commentary, in H.264, with its real name, and a game imports as a playlist of every replay; the egress rule for Tencent's play-info API is the only proxied request.

The costs:

- The repository has its first Python file. It runs only inside yt-dlp, and it depends on yt-dlp's Tencent Video extractor calling `_download_webpage` with a `query` that has `hevclv`, so a yt-dlp bump that changes that extractor can make the car's replays HEVC again; the plugin's tests check that the argument is passed, not what Tencent returns.
- Full replays depend on Tencent Video login cookies in the node's cookies file, which expire and must be exported again from a signed-in browser.
- The plugin knows two Tencent Sports endpoints and the wording of their replay titles, which can change without notice.
