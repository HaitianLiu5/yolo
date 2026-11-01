# Agent Note: 腾讯体育回放和直播，车上用 H.264

Status: implemented

[English](2026-10-26-tencent-sports-replays.md) | 中文

## 问题

用户付费订阅了腾讯体育，想在 Yolo 里看比赛：比赛进行时看直播，结束后看回放，优先英文原声。挡在前面的有五件事。yt-dlp 不读腾讯体育的比赛页（`sports.qq.com/kbsweb/game.htm?mid=…`），只读其中回放的腾讯视频页面。腾讯只把回放的播放地址给中国大陆的观众，这由[出口代理层](../architecture/2026-10-13-node-egress-proxy.zh.md)解决。而 yt-dlp 解析出的回放是 HEVC，车上的 canvas 引擎解不了：它只播 H.264（[canvas 引擎](../architecture/2026-04-04-canvas-playback-engine.zh.md)）。yt-dlp 根本没有腾讯直播的解析器。而付费比赛只对登录了的账号完整播放，账号的腾讯视频会话不到两小时就过期，所以从浏览器导出的 cookie 几天内就失效。

## 决策

### 比赛页

yt-dlp 插件自己读比赛页（[`tencent-sports.js`](../../../../plugins/source-ytdlp/src/tencent-sports.js)）：比赛的回放列表（`matchweb.sports.qq.com/kbs/matchVideoAll`）给出每个回放的腾讯视频 id、合集、标题、语言、时长和图片，比赛详情给出两队和比分。两者都不需要代理或登录。

- 比赛页经回放的腾讯视频页面（`v.qq.com/x/cover/<合集>/<vid>.html`）播放其中一个回放，由 yt-dlp 读取：页面的 `vid` 参数指定的那个，没有就放英文原声全场，再没有就放任一语言的全场，最后放第一个回放。还没有回放的比赛返回 `not_found`。
- 条目的 id 仍是比赛页，所以历史记录和续播位置属于比赛页；回放的标题和图片取自列表，用于 `describe()`、`details()` 和流，因为 yt-dlp 从腾讯视频读不到这两样。
- `expand()` 把比赛页展开成所有回放，比赛页播放的那个排第一，所以把它导入成播放列表时会列出各节和另一种解说。比赛页没有 `sequence()`：这些回放是可以互相替代的版本，不是一个连续系列，看完全场后不应该接着放第一节。
- 流的时长以流为准，不取列表里的：用户没有登录时，腾讯对付费回放只给一段短短的试看。
- 比赛页一分钟后会重新查询，因为比赛会开始和结束：开赛前返回 `not_found`（“还没开始”）。

### 直播

比赛进行时（比赛详情的 `matchPeriod` 为 1），比赛页播放直播，除非它的 `vid` 指定了某个回放（[`tencent-live.js`](../../../../plugins/source-ytdlp/src/tencent-live.js)）。比赛详情列出比赛的直播频道：主频道（`liveId`）和其他解说（`multiCameras`）；比赛页播放英文原声（“英文原音”），没有就放主频道。腾讯的直播播放信息接口（`info.zb.video.qq.com`，`cmd=2`）把频道换成某个清晰度的 HLS：360p、540p、720p 或 1080p，取不超过设备高度的最高一档。每个请求都带 cKey，也就是 yt-dlp 给腾讯视频点播接口算的那个签名（对频道、时间、guid、平台和页面做 AES-128-CBC，encryptVer 8.1），插件用 JavaScript 计算；有一个单元测试把它和 yt-dlp 对同一请求算出的结果对齐。付费比赛还带上用户的会话，作为 cookie 以及 `vuserid` 和 `vusession`；没有会话时腾讯返回 25（请登录），Yolo 会提示运行 `accounts login`。

这路流是 H.264 加 AAC 的 MPEG-TS 滑动窗口直播 HLS，即带 `isLive` 的普通 `hls`，Yolo 本来就能直播播放；它不需要 DVR 索引，也不需要代理，因为腾讯在中国大陆以外也会返回它。它的 `refresh()` 会重新请求接口。直播比赛不跑 yt-dlp，所以没有字幕、章节、故事板或弹幕；标题是比赛的名字，带当前比分，图片是频道的。

### 登录

Yolo 保存一个自己的登录（[`tencent-account.js`](../../../../plugins/source-ytdlp/src/tencent-account.js)）：腾讯体育上的微信登录，做法和腾讯体育自己的网页登录并保持登录一样。腾讯体育把它换成腾讯视频会话（`app.sports.qq.com/init/login?videoAuth=1`，给出 `vuserid` 和 `vusession`，有效期为其 `tokenTTL`，约 110 分钟），并用 refresh token 续期微信令牌（`init/refresh`），refresh token 大约能用 30 天。节点按需续期：需要会话而剩余不足十分钟时就续；续期失败就匿名播放，在日志里提示重新登录，一分钟内不再重试。

- **从哪里开始。** 在节点所在的机器上运行 `npm run yolo -- accounts login`，它在终端里画出微信的二维码（`open.weixin.qq.com/connect/qrconnect`，用腾讯体育的微信应用），等用户在手机上扫码并确认，再把微信给的 code 交给腾讯体育（`matchweb.sports.qq.com/wx/oAuth`），它设置的 cookie 就是这个登录。这一切由插件的 setup entry（[`setup.js`](../../../../plugins/source-ytdlp/src/setup.js)）完成；命令（`ops/commands/accounts.js`）找的是 setup entry 用于 `accounts` 的任何插件。Yolo 还没有自己的登录时，就从用户 cookie 文件里 `sports.qq.com` 上的微信登录开始，此后一直保存它；保存的登录续不上时，会改用之后重新导出的那个。
- **保存在哪里。** 在插件的状态目录里（`tencent.json`，权限 0600）；`accounts login` 写入后节点会重新读取，不用重启。令牌不会进入日志或流。
- **回放。** yt-dlp 读腾讯视频页面时，用的是用户 cookie 文件的一份副本，其中会话的 cookie（在 `.video.qq.com` 和 `.v.qq.com` 上）替换掉原有的（状态目录里的 `tencent-cookies.txt`，每有新会话就重写一次）；其他页面照旧读用户的文件。经 cn 出口代理，腾讯视频页面的一次 yt-dlp 运行约要 16 秒，所以它在 45 秒后才被停止，而不是其他页面的 30 秒，仍在 Hub 等待 prepare 的 60 秒以内。

### 车上的 H.264

腾讯视频的播放信息接口默认给 H.264，除非请求要 HEVC；而 yt-dlp 总是要（`hevclv=28`），列出的格式也不写编码，所以格式选择器分不出两者。插件带了一个用 Python 写的 yt-dlp 扩展 [`yt-dlp/yolo/yt_dlp_plugins/extractor/yolo_vqq.py`](../../../../plugins/source-ytdlp/yt-dlp/yolo/yt_dlp_plugins/extractor/yolo_vqq.py)，每次运行 yt-dlp 都以 `--plugin-dirs` 加载。它只在一处覆盖 yt-dlp 的腾讯视频解析器：带上 `--extractor-args vqqvideo:codec=h264` 时，它的播放信息请求不要 HEVC。设备声明的编码里没有 HEVC（`hvc1` 或 `hev1`）时插件传这个参数，车就是这样；能解 HEVC 的屏幕用 yt-dlp 原本的请求。于是同一个回放由腾讯直接以 H.264 给出，最高 1080p，不用转码。

## 曾考虑的替代方案

**在节点上把 HEVC 转成 H.264。** 它对任何 HEVC 片源都管用，但节点得从分片里判断流的编码（腾讯的格式不写编码），还要给 HLS 加一条新的转码路径；每场比赛都占用节点的编码器，而且画质不如腾讯自己的 H.264。

**用 JavaScript 直接读腾讯的点播播放信息接口，不经 yt-dlp。** 这样编码和标题都由插件自己掌握，但 yt-dlp 已经读这个接口、它的格式和字幕，并且一直跟着更新。直播接口用 JavaScript 读，只是因为 yt-dlp 不读它；它需要的 cKey 很短，和 yt-dlp 的相同。

**只用导出的 cookie 登录。** 它们只在腾讯视频会话结束前有效，也就是浏览器最后一次续期后的两小时内，之后就只给试看，直到用户再导出一次。把 `sports.qq.com` 的登录作为播放器的 `logintoken` 传过去也没用：腾讯视频接口认的是 `init/login` 由它换出的会话。

**用 QQ 登录。** 腾讯体育也支持 QQ 登录（`graph.qq.com`），但那是另一套要维护的扫码流程，而用户的账号是用微信登录的。

**在屏幕上显示二维码。** 让车或电视的屏幕显示二维码、用户用手机扫，需要节点、控制面和播放器都能承载插件的登录，目前还没有别的插件需要。

**请 yt-dlp 上游加一个解析器参数。** 这是干净的最终做法，有了它就可以去掉这个扩展，但车上需要 H.264 的时候，yt-dlp 的发布还来不及带上它。

**按时间或频道选比赛的回放。** 回放列表只在每个回放的标题和语言字段里写解说语言，所以插件在那里匹配“英文”或“English”，用“全场”判断整场比赛。

## 后果

比赛页在车上以英文解说、H.264 播放，标题是真实的名字：进行时播直播，结束后播回放；一场比赛能导入成包含所有回放的播放列表；腾讯点播播放信息接口的出口规则是唯一经代理的请求。用户大约每月用手机登录一次，不必再为腾讯导出 cookie。

代价：

- 仓库里有了第一个 Python 文件。它只在 yt-dlp 里运行，并且依赖 yt-dlp 的腾讯视频解析器用带 `hevclv` 的 `query` 调用 `_download_webpage`，所以升级 yt-dlp 时如果这个解析器变了，车上的回放可能又变回 HEVC；插件的测试检查的是参数有没有传，而不是腾讯返回什么。
- 节点保存着腾讯体育的微信 refresh token，它能在大约 30 天内续期用户的腾讯会话；它留在节点所在机器上插件的状态目录里。
- 插件知道腾讯体育的回放列表、比赛详情和登录接口，腾讯的直播接口和它的 cKey，以及回放标题和频道名称的写法，这些都可能不打招呼就变；扫码登录的最后一步，即腾讯体育的微信回调，没有实时测试覆盖。
