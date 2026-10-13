# Agent Note: 媒体节点的内部接口

Status: implemented

[English](2026-10-07-node-internal-api.md) | 中文

## 问题

控制面决定什么在哪里播放；节点负责解析片源、运行媒体会话，并和家庭网络打交道。两半之间需要一份范围很窄的约定：谁都不越界去碰对方的状态，节点离线时不影响控制面，并且只有控制面能让节点做事。

## 决策

节点（[`service/node/src/app.js`](../../../../service/node/src/app.js)）只在 `127.0.0.1` 上向控制面提供 `/internal/v1/*`，控制面通过 [`nodeFetch()`](2026-10-08-workers-vpc-node-access.zh.md) 访问它。每个请求都带签名，作为私有传输之上的纵深防御：请求头 `x-yolo-timestamp` 和 `x-yolo-signature` 携带以 base64url 编码的 `HMAC-SHA256(nodeSecret, timestamp\nmethod\npath-and-query\nSHA-256(body))`，时钟偏差超过 5 分钟即拒绝。它的第二个监听端口在这台机器的局域网私有地址上提供 HTTPS，只向家里的设备服务 `/m/*` 和 `/lan/probe`（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/internal/v1/health` | 版本号、运行时长、`media`（会话数、转码数、缓存统计）、`sources`（每个片源的状态）、`plugins`（每个插件的加载状态和错误）、`lan`（局域网监听端口：`enabled`、`port`、`address`、`name`、`origin`、`listening`、`notBefore`、`notAfter`、`error`） |
| POST | `/internal/v1/claim` | `{ url }` → `{ source }`：节点按顺序问片源插件，第一个认领的胜出；都不认领时返回 `not_found`。控制面每次播放网址前都先调用它 |
| POST | `/internal/v1/prepare` | `{ sessionId, source, capabilities, viewport, startTime, reason, tracks: { preferences }, limits, network, renderer, mediaToken }` → 带 `network` 和 `origin` 的流描述（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）：局域网监听端口正常服务时，`network: "lan"` 走局域网路径。不带 `renderer` 时服务实时设备：插件的 `prepare()` 解析片源，媒体管线提供流，`mediaToken` 绑定到这个会话。`startTime: null` 让片源决定起点。**同一个 `sessionId` 重复调用会重建会话**，换音轨就是这样做的 |
| POST | `/internal/v1/sessions/:id/stop` | 停止会话：约 10 秒后作废 token，回收 ffmpeg，并调用片源的 `stop()`（例如停掉 Plex 转码） |
| POST | `/internal/v1/sessions/:id/tracks` | `{ source, subtitles?, audio?, position }` → `{ tracks, reload }`。只换 `vtt` 字幕时保留原来的流，`reload` 为空；涉及 `burn` 字幕或换音轨时在 `position` 重建会话，`reload` 是新的流描述 |
| POST | `/internal/v1/sessions/:id/progress` | 控制面转发的播放进度；节点交给片源的 `progress()`（Plex 写回自己的进度） |
| POST | `/internal/v1/sessions/:id/control` | `{ action: pause \| resume \| stop \| seek, position? }`，只用于节点渲染器；实时设备的命令由 Hub 直接发送 |
| GET | `/internal/v1/tracks?source=` | 某个来源的音轨；`source` 是 Source 的 JSON |
| POST | `/internal/v1/metadata` | `{ source }` 或 `{ url }`（先认领）→ `{ source, title, thumbnail, duration, isLive }`；`search` 解析 URL、给队列条目补标题都用它 |
| GET | `/internal/v1/renderers` | 节点自己驱动的播放器（节点渲染器），及其状态和进度 |
| GET | `/internal/v1/library/…` | 和 [`/v1` 的片库路由](2026-10-07-v1-http-api.zh.md)一一对应。片库和条目的 id 是 `<片源>:<id>`，节点按前缀找到插件；搜索和片库列表合并所有片源的结果，失败的片源列在 `unavailable` 里 |
| POST | `/internal/v1/playlists/expand` | `{ url }` → `{ title, url, items: [{ source, title, thumbnail, duration }] }`，由片源插件按顺序展开 |
| POST | `/internal/v1/owner-code/verify`、`/consume` | 用户本人的配对码（[passkey 登录](2026-10-08-passkey-owner-sign-in.zh.md)） |
| PUT | `/internal/v1/lan` | `{ name, allowOrigin }` → 局域网监听端口的状态和 `csr`，即用节点自己的私钥为 `name` 生成的证书请求 |
| PUT | `/internal/v1/lan/certificate` | `{ name, chain }` → 状态：与节点私钥和 `name` 相符的证书链无需重启即被装上 |
| GET/HEAD | `/m/{token}/…` | 媒体流，只认路径里的媒体 token（[同源透传](2026-10-07-same-origin-media-passthrough.zh.md)），在局域网监听端口上也一样：`f/{n}` 文件或分片（字节范围、磁盘缓存）、`p/{n}.m3u8` 改写过的播放列表（`?at=` 用于直播回看）、`l/{n}/{seq}` 直播 DVR 分片、`dash/master.m3u8` 等分离音视频拼成的 HLS、`x/{file}` ffmpeg 输出，以及 `sub/{n}.vtt` 字幕 |

**节点离线时**，`prepare` 返回 `node_offline`；页面、MCP 和队列管理照常可用，播放器提示媒体节点离线。节点离线时加进队列的网址保持未认领的 `{ url }`，直到播放时再认领。

**节点渲染器。** 节点可以自己驱动一个播放器，控制面把它当成 id 为 `node:<id>` 的设备，通过 `/sessions/:id/control` 控制它。Drive-In 的旧服务以前就这样接入（`node:legacy`），直到它被删除；现在节点不带任何渲染器，所以 `/renderers` 返回空列表，带 `renderer` 的 `/prepare` 返回 `not_found`，而控制面仍支持这类设备。

**升级。** 在 Source 格式和接口演进时，路径保持 `/internal/v1` 不变，所以控制面和节点要一起发布：旧控制面的 Source 会被新节点拒绝，反过来也一样。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 后果

控制面关于媒体知道的一切都经过这张表，所以节点可以在它后面自由地改动管线、插件和缓存。请求经过两重认证（私有传输和签名），但签名区分不了用户本人和控制面，所以签发配对码的接口不放在这里。控制面和节点保持同步是一条部署规则，而不是由版本号强制的约束。
