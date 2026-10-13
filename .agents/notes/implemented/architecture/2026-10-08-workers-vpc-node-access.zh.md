# Agent Note: 通过 Workers VPC 访问媒体节点

Status: implemented

[English](2026-10-08-workers-vpc-node-access.md) | 中文

## 问题

Cloudflare 上的控制面必须调用家里机器上的媒体节点（内部接口，以及 `/m/*` 下的每个媒体字节），同时不能给节点公网地址，也不想有需要轮换的凭据。Workers VPC 能让 Worker 经 Cloudflare Tunnel 访问私有服务，但截至 2026-09 它仍是 Beta，也没人测过它能不能承载持续的视频流量。

## 决策

控制面通过 **Workers VPC 服务 binding**（`service/control/wrangler.jsonc` 里的 `NODE`）访问节点，它指向运行 cloudflared 的机器上的 `127.0.0.1:9191`。节点的内部接口，连同控制面透传的 `/m/*` 媒体，只监听 `127.0.0.1`，节点也没有公网主机名。它的局域网监听端口绑定机器的私有局域网地址，只为家里的设备提供 `/m/*` 和 `/lan/probe`（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。

控制面对节点的每次调用都经过 [`service/control/src/node-client.js`](../../../../service/control/src/node-client.js) 里的 **`nodeFetch()`**；没有其他代码调用节点。`NODE_TRANSPORT` 选择路径，所以切换只需改配置：

- `vpc`（默认）：`NODE` binding。
- `tunnel`：tunnel 的公网主机名 `NODE_PUBLIC_ORIGIN`，前面挡着 Cloudflare Access，用 service token（`NODE_ACCESS_CLIENT_ID`、`NODE_ACCESS_CLIENT_SECRET`）认证。

无论哪条路径，每个请求都用 `NODE_SECRET` 签名，作为纵深防御（[节点内部接口](2026-10-07-node-internal-api.zh.md)）。发给节点的请求如果绕回 Worker 自己，会形成递归，每一跳都计费，所以 `nodeFetch()` 拒绝指向 Worker 自身主机的 `NODE_PUBLIC_ORIGIN`，Worker 对任何带节点签名的请求都返回 `508`。网关错误（502–504、520–524、530）对应 `node_offline`；媒体请求则不论状态码都拿回节点自己的回答。

### 流量实验

正式采用之前，一个一次性的实验 Worker 把所有请求转发给家里早先的服务，走两条交替的路径：`vpc`（Worker → VPC 服务 binding → tunnel → `localhost:9090`）和 `public`（Worker → 现有的 tunnel 公网主机名）。笔记本上的压测脚本每 4 秒请求一次约 1.5MB 的静态文件（相当于 720p 视频约 2.5 秒的一个分片），连续 60 分钟；每个请求都带随机查询串，让 `public` 路径无法命中 Cloudflare 缓存。`vpc` 路径的通过标准是：失败率不超过 0.5%；慢尾吞吐（p5）不低于 10 Mbps（720p 码率 4.8 Mbps 的两倍）；首字节时间 p95 不超过 `public` 路径 p95 的 1.5 倍再加 100ms。

2026-10-08 的压测通过：每条路径 450 个请求，`vpc` 路径失败 0 次，p5 吞吐 16.9 Mbps，首字节时间 p95 为 125ms，`public` 路径为 123ms。它只测了静态文件；计划中用真实播放器看半小时的测试没有做；生产环境经 `/m/*` 的播放配置为走 VPC 路径（`NODE_TRANSPORT: "vpc"`）。这份记录写下实验方法和结果之后，实验代码被删除了；它代理的服务已经不存在，代码可以从 Git 历史中找回。

## 曾考虑的替代方案

**tunnel 公网主机名加 Cloudflare Access service token。** 它现在可用，仍是配置好的退路，但会给节点一个公网地址和一个需要轮换的 service token。Workers VPC 两者都不需要。

## 后果

节点没有公网地址，也没有需要轮换的凭据；对它的每次调用都由一个函数负责，所以更换传输方式只涉及一个模块和一个变量。Yolo 依赖一个 Beta 阶段的 Cloudflare 产品；如果 Workers VPC 出问题或发生变化，设置 `NODE_TRANSPORT=tunnel` 就能切回去，不用改代码。实验证明的是批量传输和延迟，而不是真实 HLS 节奏、WebSocket 会话或 Plex 转码下的长时间播放；这些由日常使用覆盖，而不是由测量覆盖。
