# Agent Note: 媒体节点的内部接口

Status: implemented

[English](2026-10-07-node-internal-api.md) | 中文

## 问题

控制面决定什么在哪里播放；节点负责解析片源、运行媒体会话，并和家庭网络打交道。两半之间需要一份范围很窄的约定：谁都不越界去碰对方的状态，节点离线时不影响控制面，并且只有控制面能让节点做事。

## 决策

节点（[`service/node/src/app.js`](../../../../service/node/src/app.js)）只在 `127.0.0.1` 上向控制面提供 `/internal/v1/*`，控制面通过 [`nodeFetch()`](2026-10-08-workers-vpc-node-access.zh.md) 访问它。每个请求都带签名，作为私有传输之上的纵深防御：请求头 `x-yolo-timestamp` 和 `x-yolo-signature` 携带以 base64url 编码的 `HMAC-SHA256(nodeSecret, timestamp\nmethod\npath-and-query\nSHA-256(body))`，时钟偏差超过 5 分钟即拒绝。它的两个媒体监听端口经 HTTPS 只提供 `/m/*` 和 `/edge/probe`：在这台机器的局域网私有地址上服务家里的设备（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)），在用户本人打开远程访问时经路由器端口服务任何地方的设备（[媒体流离开 Worker](2026-10-13-media-off-the-worker.zh.md)）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/internal/v1/health` | 版本号、内部协议编号、运行时长、`media`（会话数、转码数、缓存统计）、`sources`（每个片源的状态）、`plugins`（每个插件的加载状态和错误）、`lan`（局域网监听端口：`enabled`、`port`、`address`、`name`、`origin`、`listening`、`notBefore`、`notAfter`、`error`）、`wan`（远程监听端口：同样的字段，加上 `addresses`、`ipv6`、带路由器 `mode`、`gateway`、`method`、`externalAddress`、`externalPort`、`requestedPort`（向路由器请求的端口，或用户本人转发的端口）和 `error` 的 `mapping`、`publicAddress`、`nat`、`natReason`、它的连接计数 `guard`，以及 `certificate`，即 `"name"` 或 `"ip"`；没有域名时还有 `identifiers`，即已取得证书的地址；`challenge`，带 CA 验证的 `type`、`externalPort`、`internalPort`，以及路由器的 `mapping` 和 `method`；`order`，带 `running`、`failures`、`retryAt`、`error`、`validatedAt` 和 `ipv6Error`） |
| POST | `/internal/v1/claim` | `{ url }` → `{ source }`：节点按顺序问片源插件，第一个认领的胜出；都不认领时返回 `not_found`。控制面每次播放网址前都先调用它 |
| POST | `/internal/v1/prepare` | `{ sessionId, source, capabilities, viewport, startTime, reason, tracks: { preferences }, limits, network, mediaToken }` → 带 `network` 和 `origin` 的流描述（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）：`network` 指明媒体路径（`lan`、`wan` 或 `relay`；`tunnel` 读作 `relay`），`lan` 或 `wan` 在对应监听端口正常服务时走它，否则走中转；流描述写明实际走的路径和监听端口的源。插件的 `prepare()` 解析片源，媒体管线提供流，`mediaToken` 绑定到这个会话。`startTime: null` 让片源决定起点。**同一个 `sessionId` 重复调用会重建会话**，换音轨就是这样做的 |
| POST | `/internal/v1/warm` | `{ sources, capabilities, viewport, limits, network }` → `{ warming }`：最多前 3 个来源交给各自插件的 `warm()`（[来源插件 API](2026-10-11-source-plugin-api.zh.md)），带上在这条路径上 `prepare` 会传的 `capabilities`、`limits` 和 `network`；在后台一次运行一个，最多 6 个排队，已在排队的来源不再加入；`warming` 是接下的个数。回答不等它们完成，失败直接丢弃 |
| POST | `/internal/v1/sessions/:id/stop` | 停止会话：约 10 秒后作废 token，回收 ffmpeg，并调用片源的 `stop()`（例如停掉 Plex 转码） |
| POST | `/internal/v1/sessions/:id/tracks` | `{ source, subtitles?, audio?, position }` → `{ tracks, reload }`。只换 `vtt` 字幕时保留原来的流，`reload` 为空；涉及 `burn` 字幕或换音轨时在 `position` 重建会话，`reload` 是新的流描述 |
| POST | `/internal/v1/sessions/:id/progress` | 控制面转发的播放进度；节点交给片源的 `progress()`（Plex 写回自己的进度） |
| GET | `/internal/v1/tracks?source=` | 某个来源的音轨；`source` 是 Source 的 JSON |
| GET | `/internal/v1/details?source=` | 条目的详情，形状统一：来自片源的 `details()`，没有时用它的 `describe()` 并标 `partial: true`（[片源插件 API](2026-10-11-source-plugin-api.zh.md#methods)） |
| GET | `/internal/v1/chapters?source=` | `{ chapters: [{ start, end, kind, title? }], supported }`：片源的章节和片头片尾标记，已统一整理；片源没有 `chapters()` 时 `supported: false` |
| GET | `/internal/v1/comments?source=&start=&end=` | `{ available, start, end, complete, comments: [{ t, text, mode, color, size }] }`：条目在 `start <= t < end` 之间的时间轴评论（弹幕），最多 12 分钟，来自节点的评论缓存（[弹幕](../feature/2026-10-13-danmaku.zh.md)）；条目没有评论时 `available: false`，片源没有 `comments()` 时还带 `supported: false`；区间有一部分读不到时 `complete: false`。片源可能有评论时，`/prepare` 返回的流描述里带着正在播放的屏幕自己的评论路径 `comments: "/m/{token}/comments"` |
| POST | `/internal/v1/transcript` | `{ source, sessionId?, track?, language?, selected?, from?, to?, maxChars? }` → `{ track, from, to, text, count, nextFrom, length }`：一条文字字幕中与该范围重叠的字幕条，以 `m:ss 文本` 行给出，最多 `maxChars`（500–20,000，默认 6,000）个字符；改带 `query`（和 `limit?`）时返回 `{ track, query, matches: [{ at, time, text }] }`。`sessionId` 指正在播放这个条目的会话，先读它的字幕文本；`selected` 是用户选中的字幕。图形字幕返回错误 |
| POST | `/internal/v1/metadata` | `{ source }` 或 `{ url }`（先认领）→ `{ source, title, thumbnail, duration, isLive }`；`search` 解析 URL、给队列条目补标题都用它 |
| GET | `/internal/v1/library/…` | 和 [`/v1` 的片库路由](2026-10-07-v1-http-api.zh.md)一一对应。片库和条目的 id 是 `<片源>:<id>`，节点按前缀找到插件；搜索和片库列表合并所有片源的结果，失败的片源列在 `unavailable` 里 |
| GET | `/internal/v1/thumbnail?url=` | 别的主机上的一张图片，供 [`/v1/thumbnail`](2026-10-07-v1-http-api.zh.md) 使用：返回图片及其类型；主机不是公网地址时返回 `forbidden`（见下文的**缩略图**） |
| POST | `/internal/v1/frame` | `{ source, time, width?, sessionId? }` → `{ image, mimeType, width, height, bytes, time, title, duration, input, plugin }`：条目在 `time` 秒处的一张 JPEG，以 base64 放在 `image` 里；会话 `sessionId` 正在播放这个条目时，ffmpeg 从这个会话读取，否则从一次带 `reason: "frame"` 的新 `prepare()` 读取；`input` 说明从哪里读出（`file`、`hls`、`split` 或 `cache`）。同时最多两个，每个 15 秒（[视频画面](../feature/2026-10-13-video-frames.zh.md)） |
| POST | `/internal/v1/storyboard` | `{ source, from?, to?, count?, width?, sessionId?, duration? }` → `{ image, mimeType, width, height, bytes, title, duration, from, to, step, count, columns, rows, tileWidth, tileHeight, times, missing, origin, input, plugin }`：把 `count` 个均匀分布、各自标好时间的画面排成网格的一张 JPEG；小图来自片源自己的故事板图片时 `origin` 为 `storyboard`，否则为 `frames`；`missing` 列出没有画面的时间。它和 `/frame` 共用那两个名额，时限 30 秒（[故事板](../feature/2026-10-13-video-frames.zh.md#storyboards)） |
| POST | `/internal/v1/playlists/expand` | `{ url }` → `{ title, url, items: [{ source, title, thumbnail, duration }] }`，由片源插件按顺序展开 |
| POST | `/internal/v1/owner-code/verify`、`/consume` | 用户本人的配对码（[passkey 登录](2026-10-08-passkey-owner-sign-in.zh.md)） |
| PUT | `/internal/v1/lan` | `{ name, allowOrigin }` → 局域网监听端口的状态和 `csr`，即用节点自己的私钥为 `name` 生成的证书请求 |
| PUT | `/internal/v1/lan/certificate` | `{ name, chain }` → 状态：与节点私钥和 `name` 相符的证书链无需重启即被装上 |
| PUT | `/internal/v1/wan` | `{ name, allowOrigin, enabled }` → 远程监听端口的状态和 `csr`；`enabled: false`（用户本人关闭远程访问）会关闭监听端口并删除路由器映射（[媒体流离开 Worker](2026-10-13-media-off-the-worker.zh.md)）。没有域名时是 `{ certificate: "ip", allowOrigin, enabled, acmeDirectory }` → 状态，最多等这次调用发起的订单 20 秒：节点自己为家里的公网地址取得证书（[没有域名时的媒体](../feature/2026-10-13-no-domain-deployment.zh.md#media-without-a-domain)） |
| PUT | `/internal/v1/wan/certificate` | `{ name, chain }` → 状态，与局域网监听端口相同 |
| GET/HEAD | `/m/{token}/…` | 媒体流，只认路径里的媒体 token（[同源透传](2026-10-07-same-origin-media-passthrough.zh.md)），在局域网监听端口上也一样：`f/{n}` 文件或分片（字节范围、磁盘缓存）、`p/{n}.m3u8` 改写过的播放列表（`?at=` 用于直播回看）、`l/{n}/{seq}` 直播 DVR 分片、`dash/master.m3u8` 等分离音视频拼成的 HLS、`x/{file}` ffmpeg 输出，以及 `sub/{n}.vtt` 字幕 |

**节点离线时**，`prepare` 返回 `node_offline`；页面、MCP 和队列管理照常可用，播放器提示媒体节点离线。节点离线时加进队列的网址保持未认领的 `{ url }`，直到播放时再认领。

**缩略图。** 片源的 `thumbnail` 是别的主机上的图片，例如视频网站的图片服务器（[片源插件 API](2026-10-11-source-plugin-api.zh.md)）。屏幕自己加载它，就会让那台主机看到屏幕的地址，所以由节点去获取（[`thumbnails.js`](../../../../service/node/src/thumbnails.js)），屏幕从 Yolo 自己的源加载。这样图片服务器看到的是家里的地址，和它从节点的媒体请求里看到的一样；Worker 也不会向插件指定的主机发请求。网址来自插件、已保存的记录，或任何持有 read token 的一方，所以这次获取要防范服务器端请求伪造。它只接受不带凭据的 http(s) 网址。域名解析出的每个地址都必须是公网地址：回环、私有、共享、链路本地、文档、组播和保留网段，以及它们的 IPv4 映射和 NAT64 形式，都被排除。检查在套接字自己的域名解析里进行，所以 DNS rebinding 无法在检查和连接之间换掉地址；最多三次重定向，每一次都再检查一遍。应答必须是不超过 4 MiB 的 JPEG、PNG、WebP、GIF 或 AVIF 图片（不接受 SVG），整个获取必须在 10 秒内完成。节点在内存里保留最近 32 MiB 的图片，同一个网址同一时间只获取一次；控制面把应答标成 `private, max-age=86400`，所以屏幕的浏览器会保留它一天。图片在家庭网络上的片源改用 `artwork` 提供。

**升级。** 在 Source 格式和接口演进时，路径保持 `/internal/v1` 不变；由一个协议编号说明双方能否互相理解。控制面在每个请求里用 `x-yolo-protocol` 发送 `NODE_PROTOCOL`（没有就是协议 0），节点接受自己的编号和前一个编号，其他编号一律回答 `node_offline` 并附上双方的编号。如果某个发布对这个 API 的改动让上一个发布的另一半跟不上，就提高编号，这样可以先升级节点、再升级 Worker（[版本与发布](../process/2026-10-13-versions-and-releases.zh.md)）。`/internal/v1/health` 上报节点的 `version` 和 `protocol`。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 后果

控制面关于媒体知道的一切都经过这张表，所以节点可以在它后面自由地改动管线、插件和缓存。请求经过两重认证（私有传输和签名），但签名区分不了用户本人和控制面，所以签发配对码的接口不放在这里。协议编号把控制面和节点之间的同步要求变成了一项检查：不匹配时每个请求都会失败，并说明该升级哪一边，而不是在对方读不懂的 Source 上失败。
