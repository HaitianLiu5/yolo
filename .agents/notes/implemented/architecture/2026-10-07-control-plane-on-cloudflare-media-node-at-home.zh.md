# Agent Note: 控制面放 Cloudflare，媒体节点留在家里

Status: implemented

[English](2026-10-07-control-plane-on-cloudflare-media-node-at-home.md) | 中文

## 问题

早先的单进程服务是用户本人家里机器上的一个 Node 进程（Express + `ws`）。它用 yt-dlp 解析网址、用 ffmpeg 转码、代理 Plex，并驱动最初只面向特斯拉的播放器，即特斯拉浏览器里的一个 `<canvas>` 播放器；它通过 cloudflared tunnel 对外暴露，HTTP、WebSocket 和代理路由都没有认证。大部分逻辑都在约 4200 行的 `server/index.js` 里，状态全放在模块级变量中。agent（智能体）通过本地 CLI 控制它，而 ChatGPT 和 claude.ai 用不了这条路：它们需要带 OAuth 的公网 HTTPS 地址。

目标是一个私人的、由 agent 驱动的媒体服务（以后还会有音乐、播客和有声书），车里的播放器只是它的客户端之一。媒体那一半（yt-dlp、ffmpeg、20GB 磁盘缓存、家庭网络里的 Plex）在 Cloudflare Workers 上跑不了。

## 决策

Yolo 分成两半。**控制面**是一个 Cloudflare Worker（`service/control`），带 D1、每个用户一个的 Durable Object（Hub）和 KV。**媒体节点**（`service/node`）是家里机器上的一个 Node 进程。Worker 是唯一的公网入口；家里的机器不对外暴露任何东西，控制面按 [Workers VPC 访问节点](2026-10-08-workers-vpc-node-access.zh.md)中的方式访问它。

```
Clients (the player in a car, a browser, or a phone; agents)
   │  HTTPS + WSS, one origin
   ▼
Control plane: Cloudflare Worker (Hono)
   ├ /                the player (Workers Static Assets, COOP/COEP)
   ├ /v1/*            HTTP API
   ├ /v1/realtime     WebSocket → Hub Durable Object (one per user)
   ├ /mcp             MCP (Streamable HTTP)
   ├ /oauth/*         authorization server and device grant
   ├ /.well-known/*   OAuth metadata
   ├ /device          screen pairing approval page
   ├ /login, /auth/*  owner sign-in with a passkey
   ├ /account         the owner's account page
   ├ /m/*             media, passed through to the node unchanged
   ├ cron (5 min)     the node's LAN name, address record, and certificate
   └ D1: users, devices, queue, playlists, history, track preferences
   │  Workers VPC binding (through Cloudflare Tunnel; the node has no public address)
   ▼
Media node: Node on the home machine (Hono)
   ├ /internal/v1/*   called only by the control plane
   ├ /m/*             media sessions, authorized by the media token in the path
   └ LAN listener     HTTPS on the private address: /m/* and /lan/probe for devices at home
```

「当前在播什么」由 Hub 负责；媒体会话（代理、ffmpeg、上游转码）由节点负责。两边只通过[节点内部接口](2026-10-07-node-internal-api.zh.md)通信。节点离线时，页面、MCP 和队列管理照常可用；播放和浏览片库返回 `node_offline`。

两边都用 **Hono**：它的路由是基于 Web 标准 `Request`/`Response` 的处理函数，在 Workers 和 Node 上都能跑。媒体流优先经过 Cloudflare：一个地址在哪里都能用，这对用户本人门槛最低。能连到节点局域网监听端口的家里设备改为直接从那里取媒体（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。v1 服务一个用户的多台设备；多用户家庭和多个节点都不在 v1 范围内，但协议为它们留了位置。

任何人不带凭据就能访问的路由，用 Workers 的限流绑定按客户端地址限流（[`service/control/src/rate-limit.js`](../../../../service/control/src/rate-limit.js)），因为每个这样的请求都可能写 KV、查 D1 或访问家里的节点。登录（`/login`、`/auth/*`）、配对（`/device` 和设备授权）和 OAuth（`/oauth/*`）每个地址每分钟允许 60 个请求。一个地址的 `/m/*` token 在一分钟内被节点拒绝（403 或 410）超过 30 次后，它在接下来一分钟内对 `/m/*` 的请求直接得到 429，不再到达节点；有效的媒体 token 从不计数。这两个绑定写在模板里，所以每个实例和 e2e 测试栈都有；计数器按 Cloudflare 的每个数据中心分别计算。

<a id="deployment"></a>

### 部署

一个实例从它自己的检出目录用 `npm run yolo` 部署，详见 [agent 部署](../feature/2026-10-13-agent-deployment.zh.md)，[`skills/yolo-deploy`](../../../../skills/yolo-deploy/SKILL.md) 带着一步步完成。被忽略的实例文件保存域名和 Cloudflare 的 id；`provision` 创建 D1、KV、隧道，以及指向家里机器上 `127.0.0.1:9191` 的 Workers VPC 服务；`migrate` 先备份 D1 再执行迁移；`deploy` 构建播放器（`clients/tesla/dist`，Worker 把它当静态资源提供），并用节点 `.env` 里的 `NODE_SECRET` 部署 Worker；`service install` 在家里机器上把节点和 cloudflared 作为服务运行。Worker 只在自定义域名上提供服务（`workers_dev: false`），并为它自己的结构化日志开着 Workers Logs，不记调用日志（[设备埋点](../feature/2026-10-11-device-telemetry.zh.md)）。可选的 Worker secret `LAN_DNS_TOKEN` 是一个对该域名区有 Zone Read 和 DNS Edit 权限的 Cloudflare API token，它会开启[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)；其余由 Worker 的 cron trigger 完成。

控制面和节点先后升级，顺序见[版本与发布](../process/2026-10-13-versions-and-releases.zh.md)。用户本人第一次登录见 [passkey 登录](2026-10-08-passkey-owner-sign-in.zh.md)，配对屏幕见[设备码配对](../feature/2026-10-07-device-code-pairing.zh.md)。

用 Workers Paid 计划时，一个预算提醒能让异常用量在一天之内被发现。在后台打开 **Manage Account → Billing → Billable Usage → Set Budget Alert**，输入一个金额（例如 5 美元），再选 **Create**（或者 **Notifications → Add → Budget Alert**）；对还没有预算提醒的 Pay-as-you-go 账户，Cloudflare 默认会加一个 10 美元的提醒。免费计划不产生账单：超过每日限额后，请求会直接失败。

## 曾考虑的替代方案

**方案 A：一个进程全在家里，Cloudflare 只提供 tunnel。** 方案 B 胜出，因为它能和 Cloudflare 的基础设施以及现成的 OAuth、MCP 库打通；Worker 是唯一入口，家里的机器从不直接暴露；节点离线时页面和 MCP 照常可用；以后还能扩展到多个用户。

**两边都用 Express。** Express 只能跑在 Node 上。

### 为什么不选 vinext？

vinext 是用 Vite 重新实现的 Next.js，首要部署目标是 Workers，它不适合 Yolo。媒体那一半（yt-dlp、ffmpeg、当时的 better-sqlite3、20GB 磁盘缓存、局域网里的 Plex 服务器）在 Workers 上跑不了。如果改为以 Node standalone 服务器部署，又用不上 Workers 的各种 binding，而且 Next.js 的路由模型不支持 WebSocket upgrade。播放器是纯 JavaScript 应用，带 canvas 引擎和 `<video>` 引擎，用不上 React Server Components 和页面路由。

**优先局域网直连媒体。** 经 Cloudflare 的媒体在哪里都能用，也不需要按网络单独设置，所以它仍是默认路径；[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)是给能连到节点的家里设备的补充。

## 后果

只要 Cloudflare 可用，控制面就能访问，家里的机器也不接受任何入站连接。Yolo 依赖一个 Cloudflare 账号；不用它也能运行是一个[待定的提案](../../proposed/architecture/2026-10-07-self-hosting-without-cloudflare.zh.md)，而 Cloudflare 的条款是否允许经 Worker 代理视频[尚未确认](../../proposed/process/2026-10-07-cloudflare-video-terms.zh.md)。两个部署单元分开运行，由一个协议编号决定其中一个在升级时双方能否通信；即使播放器就在同一个网络里，媒体也要从家里到 Cloudflare 再绕回来，除非播放器能连到节点的局域网监听端口、直接从那里取媒体（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。
