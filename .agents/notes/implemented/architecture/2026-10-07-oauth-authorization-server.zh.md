# Agent Note: 所有客户端共用一个 OAuth 授权服务器

Status: implemented

[English](2026-10-07-oauth-authorization-server.md) | 中文

## 问题

Yolo 的客户端差别很大：ChatGPT 和 Claude 作为远程 MCP 客户端接入，浏览器或手机交互式登录，车机屏幕没有键盘，浏览器发起的 WebSocket 又带不了 `Authorization` 头。每种客户端都需要一个范围明确、用户本人可以撤销的凭据，而且都不能依赖 cookie（见[同源透传](2026-10-07-same-origin-media-passthrough.zh.md)）。

## 决策

控制面是所有客户端的 OAuth 2.1 授权服务器，基于 `@cloudflare/workers-oauth-provider` 实现（[`service/control/src/index.js`](../../../../service/control/src/index.js)）。每个客户端都出示 Bearer access token：

| 客户端 | 流程 |
|---|---|
| agent（智能体，Claude、ChatGPT） | 动态客户端注册（RFC 7591）或 Client ID Metadata Document，然后是授权码 + PKCE。元数据在 `/.well-known/oauth-authorization-server` 和 `/.well-known/oauth-protected-resource`（RFC 9728） |
| 浏览器和手机 | 授权码 + PKCE |
| 车机和电视屏幕 | 设备码流程（RFC 8628），见[设备码配对](../feature/2026-10-07-device-code-pairing.zh.md) |
| 媒体节点 | 不用 OAuth：通过 Workers VPC 访问，请求用 `nodeSecret` 签名（[访问节点](2026-10-08-workers-vpc-node-access.zh.md)） |

授权页、设备确认页和 `/v1/owner` 下用户本人的设置路由要求用户本人先登录；只有这几处用到会话 cookie（[passkey 登录](2026-10-08-passkey-owner-sign-in.zh.md)、[用户本人的路由](2026-10-07-v1-http-api.zh.md#owner-routes)）。

### Scope

| scope | 允许做什么 |
|---|---|
| `read` | 读取状态、设备、片库、队列、播放列表和历史 |
| `control` | 播放、暂停、跳转、切换设备、选择音轨 |
| `manage` | 修改队列、播放列表、历史和设备 |

scope 之间没有包含关系：只有 `manage` 的 token 不能读取状态。agent 默认申请全部三个 scope（`requiredScopes`），用户本人可以在授权页上关掉任意一项（[用户本人的网页](2026-10-12-owner-web-pages.zh.md)）。每个 MCP 工具和每个 `/v1` 路由都只要求一个 scope。

### Token

access token 有效期 1 小时，refresh token 可轮换。授权服务器把客户端、授权和 token 的哈希存在 `OAUTH_KV` 命名空间里，并加密它们的 `props`，所以 D1 里没有 OAuth 表。token 的 audience 是部署的源（例如 `https://yolo.example.com`），所以一个 token 同时覆盖 `/mcp` 和 `/v1`。设备凭据是控制面自己的 token，通过 `resolveExternalToken` 接入同一套 `/v1` 鉴权。

### 实时通道票据

浏览器不能给 WebSocket 设置 `Authorization`，所以客户端先带 Bearer token 调用 `POST /v1/realtime/ticket`，换到一张有效期 30 秒的一次性票据，再连接 `wss://…/v1/realtime?ticket=…`（[`service/control/src/realtime.js`](../../../../service/control/src/realtime.js)）。配对设备的票据带着它的设备 id，所以这条连接只能是这台设备。

票据的形式是 `<hub id>.<secret>`。用户的 [Hub](2026-10-07-hub-and-realtime-channel.zh.md) Durable Object 签发 secret，并把它的哈希在自己的存储里保留 30 秒；升级请求会发到 id 指向的那个 Hub，由它一次性兑现 secret，并从自己存下的内容得知设备 id。Worker 只接受 `HUB.idFromString` 对自己命名空间认可的 id，所以伪造的票据不会唤醒任何 Hub；客户端自己带来的设备或用户请求头会被丢掉。

## 曾考虑的替代方案

**把实时通道票据放在 `OAUTH_KV` 里。** 那样每次连接都要一次 KV 写入和一次删除，而 Workers Free 每天只允许 1,000 次 KV 写入：一辆信号不好、每 30 秒重连一次的车，两个小时就用掉 240 次；写入额度用完后，新的连接和 agent 的 token 刷新都会失败，直到 UTC 午夜。Durable Object 的存储在 Free 上每天允许 100,000 次行写入，而且是强一致的，所以一张票据也不可能在两个地点各兑现一次。

**Cloudflare Access 加 cookie。** 它把登录挡在每个路由前面，但需要 Zero Trust 后台配置，无法给 agent 提供远程 MCP 客户端所期望的 OAuth 流程，而且它的 cookie 到不了原生播放器、跨源请求和局域网直连的媒体。

## 后果

所有客户端都使用同一种 token，在同一个地方校验；agent 只要粘贴一个 URL 并获得批准就能接入。用户本人在 Yolo 的设置里撤销 agent：`DELETE /v1/owner/agents/:id` 通过 provider 的 `listUserGrants` 和 `revokeGrant` 撤销这个客户端的每一个授权，连同它的访问 token 和刷新 token；KV 是最终一致的，所以已经签发的 token 在其他地点最多还能再用大约一分钟。用户本人用配对码重置时，会撤销网页会话和 passkey，但既不撤销 agent 的 token，也不撤销设备凭据。设备在设置里或用 `remove_device` 撤销。
