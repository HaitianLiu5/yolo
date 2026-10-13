# Agent Note: 控制面放 Cloudflare，媒体节点留在家里

Status: implemented

[English](2026-10-07-control-plane-on-cloudflare-media-node-at-home.md) | 中文

## 问题

Drive-In 是用户本人家里机器上的一个 Node 进程（Express + `ws`）。它用 yt-dlp 解析网址、用 ffmpeg 转码、代理 Plex，并驱动特斯拉浏览器里的 `<canvas>` 播放器；它通过 cloudflared tunnel 对外暴露，HTTP、WebSocket 和代理路由都没有认证。大部分逻辑都在约 4200 行的 `server/index.js` 里，状态全放在模块级变量中。agent（智能体）通过本地 CLI 控制它，而 ChatGPT 和 claude.ai 用不了这条路：它们需要带 OAuth 的公网 HTTPS 地址。

目标是一个私人的、由 agent 驱动的媒体服务（以后还会有音乐、播客和有声书），Drive-In 只是它的客户端之一。媒体那一半（yt-dlp、ffmpeg、20GB 磁盘缓存、家庭网络里的 Plex）在 Cloudflare Workers 上跑不了。

## 决策

Yolo 分成两半。**控制面**是一个 Cloudflare Worker（`service/control`），带 D1、每个用户一个的 Durable Object（Hub）和 KV。**媒体节点**（`service/node`）是家里机器上的一个 Node 进程。Worker 是唯一的公网入口；家里的机器不对外暴露任何东西，控制面按 [Workers VPC 访问节点](2026-10-08-workers-vpc-node-access.zh.md)中的方式访问它。

```
Clients (Tesla client / browser / phone / agent)
   │  HTTPS + WSS, one origin
   ▼
Control plane: Cloudflare Worker (Hono)
   ├ /                Tesla client (Workers Static Assets, COOP/COEP)
   ├ /v1/*            HTTP API
   ├ /v1/realtime     WebSocket → Hub Durable Object (one per user)
   ├ /mcp             MCP (Streamable HTTP)
   ├ /oauth/*         authorization server, device grant, /device approval page
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

两边都用 **Hono**：它的路由是基于 Web 标准 `Request`/`Response` 的处理函数，在 Workers 和 Node 上都能跑。媒体流优先经过 Cloudflare：一个地址在哪里都能用，这对用户本人门槛最低。能连到节点局域网监听端口的家里设备改为直接从那里取媒体（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。v1 服务一个用户的多台设备；多用户家庭、其他网页和手机客户端和多个节点都不在 v1 范围内，但协议为它们留了位置。

<a id="deployment"></a>

### 部署

在仓库根目录，先 `npm install` 再 `npm run build`：先构建特斯拉客户端（`clients/tesla/dist`，Worker 把它当静态资源提供），再试构建 Worker。在 `service/control` 下：

1. `npx wrangler secret put NODE_SECRET`，值与节点 `.env` 里的 `NODE_SECRET` 相同。
2. `npx wrangler d1 migrations apply yolo --remote`。
3. `npx wrangler deploy`，静态资源随 Worker 一起上传。Worker 只在自定义域名上提供服务（`workers_dev: false`），并开着 Workers Logs。
4. 可选：`npx wrangler secret put LAN_DNS_TOKEN`，值是一个对该域名区有 Zone Read 和 DNS Edit 权限的 Cloudflare API token，它会开启[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)；其余由 Worker 的 cron trigger 完成。

在家里机器上：`npm install`，然后重启节点（`npm run dev:node`，或它的 launchd 服务）。cloudflared 在那台机器上运行，Workers VPC 服务指向 `127.0.0.1:9191`。内部接口一有变化，控制面和节点就要一起升级。用户本人第一次登录见 [passkey 登录](2026-10-08-passkey-owner-sign-in.zh.md)，配对屏幕见[设备码配对](../feature/2026-10-07-device-code-pairing.zh.md)，导入 Drive-In 的数据见 [D1 数据模型](2026-10-07-d1-data-model.zh.md)。

## 曾考虑的替代方案

**方案 A：一个进程全在家里，Cloudflare 只提供 tunnel。** 方案 B 胜出，因为它能和 Cloudflare 的基础设施以及现成的 OAuth、MCP 库打通；Worker 是唯一入口，家里的机器从不直接暴露；节点离线时页面和 MCP 照常可用；以后还能扩展到多个用户。

**两边都用 Express。** Express 只能跑在 Node 上。

### 为什么不选 vinext？

vinext 是用 Vite 重新实现的 Next.js，首要部署目标是 Workers，它不适合 Yolo。媒体那一半（yt-dlp、ffmpeg、当时的 better-sqlite3、20GB 磁盘缓存、局域网里的 Plex 服务器）在 Workers 上跑不了。如果改为以 Node standalone 服务器部署，又用不上 Workers 的各种 binding，而且 Next.js 的路由模型不支持 WebSocket upgrade。播放器是纯 JavaScript 的 canvas 应用，用不上 React Server Components 和页面路由。

**优先局域网直连媒体。** 经 Cloudflare 的媒体在哪里都能用，也不需要按网络单独设置，所以它仍是默认路径；[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)是给能连到节点的家里设备的补充。

## 后果

只要 Cloudflare 可用，控制面就能访问，家里的机器也不接受任何入站连接。Yolo 依赖一个 Cloudflare 账号；不用它也能运行是一个[待定的提案](../../proposed/architecture/2026-10-07-self-hosting-without-cloudflare.zh.md)，而 Cloudflare 的条款是否允许经 Worker 代理视频[尚未确认](../../proposed/process/2026-10-07-cloudflare-video-terms.zh.md)。两边之间的约定一改变，两个部署单元就必须一起发布；即使播放器就在同一个网络里，每个媒体字节也要从家里到 Cloudflare 再绕回来。
