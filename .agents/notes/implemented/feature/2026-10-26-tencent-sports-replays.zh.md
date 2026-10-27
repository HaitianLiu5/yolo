# Agent Note: 腾讯体育回放，车上用 H.264

Status: implemented

[English](2026-10-26-tencent-sports-replays.md) | 中文

## 问题

用户付费订阅了腾讯体育，想在 Yolo 里看比赛回放，优先看英文原声全场。挡在前面的有三件事。yt-dlp 不读腾讯体育的比赛页（`sports.qq.com/kbsweb/game.htm?mid=…`），只读其中回放的腾讯视频页面。腾讯只把回放的播放地址给中国大陆的观众，这由[出口代理层](../architecture/2026-10-13-node-egress-proxy.zh.md)解决。而 yt-dlp 解析出的回放是 HEVC，车上的 canvas 引擎解不了：它只播 H.264（[canvas 引擎](../architecture/2026-04-04-canvas-playback-engine.zh.md)）。

## 决策

### 比赛页

yt-dlp 插件自己读比赛页（[`tencent-sports.js`](../../../../plugins/source-ytdlp/src/tencent-sports.js)）：比赛的回放列表（`matchweb.sports.qq.com/kbs/matchVideoAll`）给出每个回放的腾讯视频 id、合集、标题、语言、时长和图片，比赛详情给出两队和比分。两者都不需要代理或登录。

- 比赛页经回放的腾讯视频页面（`v.qq.com/x/cover/<合集>/<vid>.html`）播放其中一个回放，由 yt-dlp 读取：页面的 `vid` 参数指定的那个，没有就放英文原声全场，再没有就放任一语言的全场，最后放第一个回放。还没有回放的比赛返回 `not_found`。
- 条目的 id 仍是比赛页，所以历史记录和续播位置属于比赛页；回放的标题和图片取自列表，用于 `describe()`、`details()` 和流，因为 yt-dlp 从腾讯视频读不到这两样。
- `expand()` 把比赛页展开成所有回放，比赛页播放的那个排第一，所以把它导入成播放列表时会列出各节和另一种解说。比赛页没有 `sequence()`：这些回放是可以互相替代的版本，不是一个连续系列，看完全场后不应该接着放第一节。
- 流的时长以流为准，不取列表里的：用户没有登录时，腾讯对付费回放只给一段短短的试看。

### 登录

付费回放只对登录了的腾讯视频账号完整播放：yt-dlp 读取插件拿到的 cookie 文件（`cookiesFile` 或 `YTDLP_COOKIES_FILE`），这个账号在腾讯视频的登录 cookie（在 `v.qq.com` 和 `video.qq.com` 上）必须在里面。只在 `sports.qq.com` 上登录，登录信息不会发给腾讯视频的播放信息接口，所以只能拿到试看。

### 车上的 H.264

腾讯视频的播放信息接口默认给 H.264，除非请求要 HEVC；而 yt-dlp 总是要（`hevclv=28`），列出的格式也不写编码，所以格式选择器分不出两者。插件带了一个用 Python 写的 yt-dlp 扩展 [`yt-dlp/yolo/yt_dlp_plugins/extractor/yolo_vqq.py`](../../../../plugins/source-ytdlp/yt-dlp/yolo/yt_dlp_plugins/extractor/yolo_vqq.py)，每次运行 yt-dlp 都以 `--plugin-dirs` 加载。它只在一处覆盖 yt-dlp 的腾讯视频解析器：带上 `--extractor-args vqqvideo:codec=h264` 时，它的播放信息请求不要 HEVC。设备声明的编码里没有 HEVC（`hvc1` 或 `hev1`）时插件传这个参数，车就是这样；能解 HEVC 的屏幕用 yt-dlp 原本的请求。于是同一个回放由腾讯直接以 H.264 给出，最高 1080p，不用转码。

## 曾考虑的替代方案

**在节点上把 HEVC 转成 H.264。** 它对任何 HEVC 片源都管用，但节点得从分片里判断流的编码（腾讯的格式不写编码），还要给 HLS 加一条新的转码路径；每场比赛都占用节点的编码器，而且画质不如腾讯自己的 H.264。

**用 JavaScript 直接读腾讯的播放信息接口，不经 yt-dlp。** 这样编码、标题和登录都由插件自己掌握，但要移植 yt-dlp 为腾讯视频做的请求签名，并独自跟着更新。`sports.qq.com` 上的登录也帮不上忙：作为网页播放器的 `logintoken` 传过去，拿到的仍是试看；腾讯体育自己的播放器用混淆过的代码给请求签名，Yolo 不去复现它。

**请 yt-dlp 上游加一个解析器参数。** 这是干净的最终做法，有了它就可以去掉这个扩展，但车上需要 H.264 的时候，yt-dlp 的发布还来不及带上它。

**按时间或频道选比赛的回放。** 回放列表只在每个回放的标题和语言字段里写解说语言，所以插件在那里匹配“英文”或“English”，用“全场”判断整场比赛。

## 后果

比赛页在车上以英文解说、H.264 播放，标题是真实的名字，一场比赛能导入成包含所有回放的播放列表；腾讯播放信息接口的出口规则是唯一经代理的请求。

代价：

- 仓库里有了第一个 Python 文件。它只在 yt-dlp 里运行，并且依赖 yt-dlp 的腾讯视频解析器用带 `hevclv` 的 `query` 调用 `_download_webpage`，所以升级 yt-dlp 时如果这个解析器变了，车上的回放可能又变回 HEVC；插件的测试检查的是参数有没有传，而不是腾讯返回什么。
- 完整回放依赖节点 cookie 文件里的腾讯视频登录 cookie，它们会过期，过期后要从登录着的浏览器重新导出。
- 插件知道腾讯体育的两个接口和回放标题的写法，它们可能不打招呼就变。
