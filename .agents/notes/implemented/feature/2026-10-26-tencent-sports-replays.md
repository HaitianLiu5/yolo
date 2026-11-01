# Agent Note: Tencent Sports replays and live games, in H.264 for the car

Status: implemented

English | [中文](2026-10-26-tencent-sports-replays.zh.md)

## Problem

The owner pays for Tencent Sports and wants its games in Yolo, live while they are played and as replays after, with the original English commentary first. Five things stood in the way. yt-dlp does not read a Tencent Sports game page (`sports.qq.com/kbsweb/game.htm?mid=…`), only the Tencent Video pages of its replays. Tencent gives a replay's play address only to a viewer in mainland China, which the [egress proxy layer](../architecture/2026-10-13-node-egress-proxy.md) solves. And the replays yt-dlp resolves are HEVC, which the car's canvas engine does not decode: it plays H.264 only ([canvas engine](../architecture/2026-04-04-canvas-playback-engine.md)). yt-dlp has no extractor for Tencent's live streams at all. And a paid game plays in full only for a signed-in account, whose Tencent Video session lasts under two hours, so cookies exported from a browser stop working within days.

## Decision

### Game pages

The yt-dlp plugin reads a game page itself ([`tencent-sports.js`](../../../../plugins/source-ytdlp/src/tencent-sports.js)): the game's replay list (`matchweb.sports.qq.com/kbs/matchVideoAll`) names each replay's Tencent Video id, cover, title, language, length, and picture, and the game's details name its teams and score. Neither needs a proxy or a sign-in.

- A game page plays one replay through its Tencent Video page (`v.qq.com/x/cover/<cover>/<vid>.html`), which yt-dlp reads: the replay the page's `vid` parameter names, else the whole game with the original English commentary, else the whole game in any language, else the first replay. A game with no replay yet is `not_found`.
- The item keeps the game page as its id, so its history and resume position belong to the game page; the replay's title and picture come from the list, for `describe()`, `details()`, and the stream, since yt-dlp reads neither from Tencent Video.
- `expand()` turns a game page into every replay, the one the page plays first, so importing it as a playlist lists the quarters and the other commentary. A game page has no `sequence()`: the replays are alternatives, not a run, and nothing should play the first quarter after the whole game.
- The stream's length is the stream's, not the list's: without the owner's sign-in Tencent gives a short preview of a paid replay.
- A game page is asked again after a minute, since a game starts and ends: before it starts it is `not_found` ("not started yet").

### Live games

While a game is played (its details' `matchPeriod` is 1), its page plays live, unless its `vid` names a replay ([`tencent-live.js`](../../../../plugins/source-ytdlp/src/tencent-live.js)). The details name the game's live channels: its main one (`liveId`) and the other commentary (`multiCameras`); the page plays the original English commentary ("英文原音"), else the main channel. Tencent's live play-info API (`info.zb.video.qq.com`, `cmd=2`) turns a channel into its HLS at a definition: 360p, 540p, 720p, or 1080p, the tallest at most the device's height. Each request carries a cKey, the signature yt-dlp computes for Tencent Video's on-demand API (AES-128-CBC over the channel, the time, a guid, the platform, and the page, encryptVer 8.1), which the plugin computes in JavaScript; a unit test pins it to yt-dlp's for the same request. A paid game also carries the owner's session as cookies and as `vuserid` and `vusession`; without it Tencent answers 25 (sign in), and Yolo says to run `accounts login`.

The stream is a sliding live HLS window of H.264 and AAC in MPEG-TS, plain `hls` with `isLive`, which Yolo already plays live; it needs no DVR index and no proxy, since Tencent answers it from outside mainland China. Its `refresh()` asks the API again. A live game has no yt-dlp run, so it has no subtitles, chapters, storyboard, or comments; its title is the game's, with the score as it stands, and its picture the channel's.

### Signing in

Yolo keeps a sign-in of its own ([`tencent-account.js`](../../../../plugins/source-ytdlp/src/tencent-account.js)): a WeChat sign-in on Tencent Sports, the way Tencent Sports' own page signs in and stays signed in. Tencent Sports turns it into a Tencent Video session (`app.sports.qq.com/init/login?videoAuth=1`, giving `vuserid` and `vusession` for its `tokenTTL`, about 110 minutes) and renews the WeChat token with its refresh token (`init/refresh`), which lasts about 30 days. The node renews the session on demand, when one is needed with less than ten minutes left; a failed renewal plays anonymously, says in the log to sign in again, and is not tried again for a minute.

- **Where it starts.** `npm run yolo -- accounts login` on the node's machine draws WeChat's QR code in the terminal (`open.weixin.qq.com/connect/qrconnect`, with Tencent Sports' WeChat app), waits while the owner scans and confirms it on their phone, and gives WeChat's code to Tencent Sports (`matchweb.sports.qq.com/wx/oAuth`), whose cookies are the sign-in. The plugin's setup entry ([`setup.js`](../../../../plugins/source-ytdlp/src/setup.js)) does this; the command (`ops/commands/accounts.js`) finds any plugin whose setup entry is for `accounts`. Without a sign-in of its own, Yolo starts from a WeChat sign-in on `sports.qq.com` in the owner's cookies file, and keeps it from then on; one exported again later is used when the kept one no longer renews.
- **Where it is kept.** In the plugin's state directory (`tencent.json`, mode 0600), which the node reads again when `accounts login` writes it, so no restart is needed. Tokens never reach a log or a stream.
- **Replays.** yt-dlp reads a Tencent Video page with a copy of the owner's cookies file in which the session's cookies (on `.video.qq.com` and `.v.qq.com`) replace any it had (`tencent-cookies.txt` in the state directory, written again for each new session); every other page reads the owner's file as before. Through the cn egress proxy a Tencent Video page's yt-dlp run takes about 16 seconds, so it gets 45 seconds before it is stopped instead of the 30 every other page gets, still within the 60 seconds the Hub waits for a prepare.

### H.264 for the car

Tencent Video's play-info API answers with H.264 unless the request asks for HEVC, and yt-dlp always asks (`hevclv=28`) and names no codec in the formats it lists, so a format selector cannot tell them apart. The plugin ships a yt-dlp extension in Python, [`yt-dlp/yolo/yt_dlp_plugins/extractor/yolo_vqq.py`](../../../../plugins/source-ytdlp/yt-dlp/yolo/yt_dlp_plugins/extractor/yolo_vqq.py), which every yt-dlp run loads with `--plugin-dirs`. It overrides yt-dlp's Tencent Video extractor in one place: with `--extractor-args vqqvideo:codec=h264`, its play-info request does not ask for HEVC. The plugin passes that argument when the device announces no HEVC codec (`hvc1` or `hev1`), as the car does; a screen that decodes HEVC gets yt-dlp's own request. The same replay then arrives as H.264 from Tencent, at up to 1080p, with nothing transcoded.

## Alternatives considered

**Transcoding HEVC to H.264 on the node.** It would cover any HEVC source, but needs the node to find a stream's codec from its segments, since Tencent's formats name none, and a new transcoding path for HLS; it spends the node's encoder on every game and gives a softer picture than Tencent's own H.264.

**Reading Tencent's on-demand play-info API from JavaScript instead of through yt-dlp.** It would take the codec and the title into the plugin's own hands, but yt-dlp already reads that API, its formats, and its subtitles, and keeps up with them. The live API is read in JavaScript only because yt-dlp does not read it; the cKey it needs is short and the same as yt-dlp's.

**Exported cookies as the only sign-in.** They worked until their Tencent Video session ended, within two hours of the browser's last renewal, and then gave the preview until the owner exported them again. Passing the `sports.qq.com` sign-in to the player as its `logintoken` did not help: what Tencent Video's APIs accept is the session `init/login` makes from it.

**Signing in with QQ.** Tencent Sports also signs in with QQ (`graph.qq.com`), but its QR flow is another one to keep, and the owner's account signs in with WeChat.

**Showing the QR code on a screen.** A car or TV screen showing the code, scanned by the owner's phone, would need the node, the control plane, and the player to carry a plugin's sign-in, which no other plugin needs yet.

**Asking yt-dlp upstream for an extractor argument.** It is the clean end state and would let the extension go, but the car needed H.264 before a yt-dlp release could carry it.

**Choosing a game's replay by a time or a channel.** The replay list names the commentary only in each title and language field, so the plugin matches "英文" or "English" there, and "全场" for the whole game.

## Consequences

A game page plays in the car with English commentary, in H.264, with its real name: live while it is played, its replay after; a game imports as a playlist of every replay; the egress rule for Tencent's on-demand play-info API is the only proxied request. The owner signs in once a month or so, with a phone, and never exports cookies for Tencent again.

The costs:

- The repository has its first Python file. It runs only inside yt-dlp, and it depends on yt-dlp's Tencent Video extractor calling `_download_webpage` with a `query` that has `hevclv`, so a yt-dlp bump that changes that extractor can make the car's replays HEVC again; the plugin's tests check that the argument is passed, not what Tencent returns.
- The node keeps a WeChat refresh token for Tencent Sports, which can renew the owner's Tencent session for about 30 days; it stays in the plugin's state directory on the node's machine.
- The plugin knows Tencent Sports' replay list, game details, and sign-in endpoints, Tencent's live API and its cKey, and the wording of replay titles and channel names, all of which can change without notice; the QR sign-in's last step, Tencent Sports' WeChat callback, is not covered by a live test.
