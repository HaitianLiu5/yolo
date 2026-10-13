# Agent Note: 媒体流离开 Worker

Status: proposed

[English](2026-10-13-media-off-the-worker.md) | 中文

## 问题

离开家时，Yolo 播放的每个媒体字节都从节点经 cloudflared 隧道和 Workers VPC 到达 Worker，再由 Worker 在用户本人的公开自定义域名下以 `/m/*` 提供出去（[同源媒体透传](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.zh.md)、[Workers VPC](../../implemented/architecture/2026-10-08-workers-vpc-node-access.zh.md)）。只有在家的设备能绕开这条路，靠的是[局域网直连播放](../../implemented/feature/2026-10-12-lan-direct-play.zh.md)。

Cloudflare 的条款限制的正是这种用法。应用服务（Application Services）的服务专属条款中「Content Delivery Network (Free, Pro, or Business)」一节（最后更新于 2026-09-28）原文如下（[条款](https://www.cloudflare.com/service-specific-terms-application-services/)）：

> "Unless you are an Enterprise customer, Cloudflare offers specific Paid Services (e.g., the Developer Platform, Images, and Stream) that you must use in order to serve video and other large files via the CDN. Cloudflare reserves the right to disable or limit your access to or use of the CDN, or to limit your End Users' access to certain of your resources through the CDN, if you use or are suspected of using the CDN without such Paid Services to serve video or a disproportionate percentage of pictures, audio files, or other large files."

- **关键在视频托管在哪里。** Cloudflare 对这一条的解释是：只要内容「托管在 Stream、Images 或 R2 这样的 Cloudflare 服务上」，客户就可以提供视频；而「托管在 Cloudflare 之外的视频和大文件，在我们的 CDN 上仍受限制」（[博客，2023-05-16](https://blog.cloudflare.com/updated-tos/)）。Yolo 的视频托管在用户本人的节点上。
- **公开主机名受限，私有路由不受限。** 从 2026-08-25 起，Cloudflare 的文档写明：Tunnel 的公开主机名路由「经 Cloudflare 代理流量」，在 Free、Pro 和 Business 套餐上受这条限制约束；而「这条限制不适用于私有网络路由」（[视频交付](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)、[Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)、[文档 PR 32886](https://github.com/cloudflare/cloudflare-docs/pull/32886)）。Workers VPC 让节点到 Worker 这一段保持私有，但 Worker 的自定义域名是公开主机名。
- **Workers Paid 有争议的余地，Workers Free 没有。** 这条条款把 Developer Platform 列为一项付费服务；Cloudflare 也曾说过，一位付费 Workers 客户经 Worker 不缓存地透传外部存储里的大文件是允许的（[tardis.dev，2023-02](https://blog.cloudflare.com/how-cloudflare-erroneously-throttled-a-customers-web-traffic/)）。但那些文件不是视频，也没有任何官方说法把这种解读用到视频上。按 Self-Serve Subscription Agreement 第 4.1 节，Workers Free 不是「付费服务」，这种解读覆盖不到它。
- **受影响的是整个账号，不只是视频。** 该协议禁止以「违反或意图规避」其限制的方式使用服务（第 2.2.1(c) 节）；违反第 2.2 节时，Cloudflare 可以「立即暂停或终止你对服务的全部或部分使用」（第 8 节）（[协议](https://www.cloudflare.com/terms/)）。
- **分发会放大风险。** 每位用户本人都在自己的账号上运行同样的 Worker 和 `/m/{token}/` 模式，很可能用的是 Workers Free；而 Jellyfin 的社区准则已经把「推荐在普通 Cloudflare 隧道后提供视频」视为违规（[Jellyfin](https://jellyfin.org/docs/general/community-standards/)）。

Cloudflare 没有任何说法直接针对「Worker 不缓存地透传自托管视频」。Yolo 按这样的解读来规划：在 Free、Pro 和 Business 区域上，中转（relay）不合规。这也回答了 [Cloudflare 对代理视频的条款](../process/2026-10-07-cloudflare-video-terms.zh.md)里的待定问题。

## 提案

Worker 只保留控制：登录、片库目录、token、Hub 和 MCP。媒体流按该设备能用的第一条路径从节点直达设备；只有用户本人打开了中转，Worker 才提供媒体流。

| 路径 | `network` | 源（origin） | 能到达 | 设备 |
|---|---|---|---|---|
| 局域网直连 | `lan` | `https://yolo-lan-<id>.<zone>:9443`，一条指向节点私有地址的仅 DNS 记录 | 家庭网络里的设备 | 所有设备 |
| 远程直连 | `wan` | `https://yolo-wan-<id>.<zone>:<port>`，一条指向家里公网地址的仅 DNS 记录，由路由器转发 | 互联网上的任何设备，包括用 LTE 的车 | 所有设备 |
| Tailscale | `tailnet` | `https://yolo-ts-<id>.<zone>:9445`，一条指向节点 tailnet 地址的仅 DNS 记录 | 登录了用户本人 tailnet 的设备 | 手机和电脑；车永远不用，因为它的浏览器跑不了 Tailscale |
| 中转 | `relay` | `PUBLIC_ORIGIN`，经隧道和 Worker | 任何地方 | 仅在用户本人打开中转时 |

每条路径提供的都是同样的 `/m/{token}/…` 地址，只凭路径里的媒体 token 授权，所以一条流在任何源上都能播，token 和节点的会话都不用变。

### 每台设备的路径选择

- **顺序。** 车机 profile 的屏幕依次尝试 `lan`、`wan`、`relay`；web profile 的屏幕依次尝试 `lan`、`wan`、`tailnet`、`relay`。屏幕用不了的路径直接跳过：中转关闭时跳过 `relay`，车上跳过 `tailnet`。
- **发现。** Hub 的 `welcome` 带上 `media: { paths: [{ path, origin, notAfter }], relay }`，只列出上次检查时监听端口在服务、证书有效的路径（[Hub 和实时通道](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md)）。在一个版本内，它还继续带上现在的 `lan` 字段，照顾还没有重新加载的播放器标签页。
- **每块屏幕的开关。** 「通过家庭网络播放」继续管 `lan`，新增的「使用 Tailscale」开关管 `tailnet`。这两种地址在 Local Network Access 下都算本地地址：它像 RFC 1918 的网段一样把 `100.64.0.0/10` 归为本地（[LNA](https://wicg.github.io/local-network-access/)），所以 Chrome 和 Firefox 会先征求用户本人同意。`wan` 解析到公网地址，不需要权限，不设开关就会探测。
- **探测。** 每个监听端口都以 `{ ok, name, path }` 回答 `GET /edge/probe`；局域网监听端口在一个版本内保留 `/lan/probe`。屏幕同时探测它所有的候选路径：收到 welcome 时、浏览器触发 `online` 事件时、开关变化时，以及某条路径失败 30 秒后；`lan` 和 `tailnet` 的超时是 2 秒，`wan` 是 5 秒。屏幕按顺序取第一条探测成功的路径，等更靠前的路径最多等到它的探测超时。Plex Web 测试直连的方式也是这样：并行测试，中转放在最后。
- **上报。** 选择变化时，以及每次 welcome 之后一次，屏幕发送 `{ v: 1, type: "network", path, reason, probes }`；它自己的播放请求带上 `network: <path>`。Hub 为每台设备保存最新的值，就像现在保存 `lan` 或 `tunnel` 一样；在一个版本内，它把 `tunnel` 当作 `relay` 读取。
- **流。** Hub 把 `network` 传给 `prepare`，节点在流描述里返回所选监听端口的源。`lan` 保持 `LAN_MAX_VIDEO_KBPS` 的上限；`wan`、`tailnet` 和 `relay` 用 `STREAM_MAX_VIDEO_BITRATE_KBPS`，因为它们都走家里的上行带宽；两者都会被设备的[自适应上限](../../implemented/feature/2026-10-11-adaptive-quality.zh.md)压低。片源插件看到的仍然是：局域网直连为 `lan`，其他所有路径为 `tunnel`，所以 Plex 插件的远程分支不用改就能服务它们。
- **没有路径。** 设备上次上报时一条路径都没找到、而中转又关闭时，Hub 拒绝准备流，返回 `media_unreachable`。它的消息写明试过哪些路径、每条需要怎样设置；agent 的 `play` 调用返回同样的消息。

### 回退

引擎有上限的重试放弃之后，一条流才算在它的路径上失败（canvas 引擎对分片的无限重试是 1.0 的阻断问题，会在这项工作之前修好）。随后恢复流程把屏幕切到顺序里的下一条路径，发送 `network`，记录 `media_path_fallback`，并在同一位置重建流，就像现在失败的局域网流切到隧道一样。30 秒后屏幕再次探测更靠前的路径；正在播放的流不会往上切，下一条流才用最好的路径。车在局域网流播放途中离开家里的 Wi-Fi 时，会在 `wan` 上继续播放。

### 远程直连

#### 名称、记录和证书

局域网直连播放的那套机制给节点再起一个名字。Worker 的定时任务用同一个 `LAN_DNS_TOKEN`（Zone Read 和 DNS Edit）给节点起一次名字 `yolo-wan-<8 位十六进制>.<zone>`，维护一条从它指向家里公网 IPv4 地址的仅 DNS 的 A 记录，TTL 60 秒，并用 ACME DNS-01 为这个名字单独签一张证书（[`acme.js`](../../../../service/control/src/lan/acme.js)）。私钥留在节点上：节点发出证书请求，拿到新证书链后不用重启就换上；在有效期过去三分之二时开始续期。Cloudflare 自己的文档就把灰云（仅 DNS）子域名列为受限视频的补救办法之一。

**公网地址。** 节点用它的运维签名经 IPv4 请求 Worker 的 `GET /.well-known/yolo`，签名请求的回答里带上这次请求的来源地址（`CF-Connecting-IP`）。定时任务通过 `nodeFetch()` 从节点读到这个地址，地址变了就更新记录。全程不用任何第三方地址服务。用户本人打开 IPv6 后，节点再经 IPv6 问一次，定时任务维护一条指向节点全局地址的 AAAA 记录；即使家里的 IPv4 在运营商级 NAT 之后，有 IPv6 的设备也能用它到达节点。

#### 节点的远程监听端口

第三个监听端口沿用局域网监听端口的代码（[`lan.js`](../../../../service/node/src/lan.js)），在控制面给它起名之后才运行，端口为 `WAN_PORT`（9444；设为 0 即关闭）。它绑定路由器转发到的那个私有 IPv4 地址，打开 IPv6 时还绑定节点的全局 IPv6 地址。用户本人在路由器上把一个外部端口转发给它；控制面为这条路径给出的源带上这个外部端口，用户本人没有另外指定时为 443。

把它暴露到互联网是这条路径的代价，所以这个监听端口把互联网能碰到的东西压到最少：

- **只有媒体。** 它只提供 `/m/{token}/…` 下的 `GET` 和 `HEAD`、`OPTIONS` 预检和 `GET /edge/probe`，别的都不提供。内部 API 仍在 `127.0.0.1` 上，用户本人的配对码仍走 Unix socket。
- **只认自己的名字。** `Host` 不是这个监听端口名字的请求得到 `421`，所以按地址连上来的扫描器碰不到任何处理逻辑。
- **先验 token，再做任何事。** 在动会话、调用片源或请求上游之前，监听端口先检查媒体 token 的格式、签名、有效期和会话是否还在。伪造的 token 得到 `403`，已结束的会话得到 `410`，响应体里不带细节。媒体 token 用一把从 `NODE_SECRET` 专为这一用途派生的密钥签名（带用途标签的 HKDF），并带上版本前缀，所以面向互联网的检查不会去验证一个同时还能授权内部 API 调用或用户本人 socket 的签名。
- **按对端地址限速。** 起始值：一个对端一分钟内 token 校验失败 20 次，就被拒绝 10 分钟；每个对端最多 32 个打开的连接，总共最多 256 个；所有对端加起来每秒最多 20 个新的 TLS 连接。设置 Node 的 `headersTimeout`、`requestTimeout` 和请求头大小上限，空闲的 keep-alive 连接 5 秒后关闭。
- **沿用局域网监听端口的响应策略。** `Access-Control-Allow-Origin` 设为 `PUBLIC_ORIGIN`、`Cross-Origin-Resource-Policy: cross-origin`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`，并且从不返回 HTML 或 XML 内容类型。
- **TLS 1.2 或更新版本**，使用这个监听端口名字的证书。
- **日志不含 token。** 每个完成的媒体响应记一行结构化日志，每个被拒绝的对端记一行 `kind: "edge"`。
- **随时可关。** 用户本人在设置里关掉远程访问后，定时任务删除记录，并让节点关闭这个监听端口。

#### 运营商级 NAT 的检测和回退

- **路由器看到的地址。** 节点向默认网关询问外部地址：先用 PCP 或 NAT-PMP，再用 UPnP IGD，以路由器能回答的为准；它从不创建端口映射。这个地址落在 `100.64.0.0/10` 或 RFC 1918 网段里，或者和 Worker 看到的公网地址不同时，说明家里在运营商级 NAT 或双重 NAT 之后，这条路径的状态为 `cgnat`。
- **外部看到的情况。** 定时任务从家庭网络之外的 Worker 请求 `https://<name>:<port>/edge/probe`。没有回应就是 `unreachable`：转发没设好、运营商封了这个端口，或者防火墙丢弃了请求。要先确认 Worker 的子请求能不能到达仅 DNS 主机上的任意端口；如果不能，用户本人设备的探测就是唯一的外部检查。
- **状态。** `off`、`pending`（已命名，还没从外部连通）、`ok`、`cgnat`、`unreachable`、`certificate`（没有有效证书）和 `error`。只有状态为 `ok` 时 welcome 才列出 `wan`；设置用文字说明每种状态需要用户本人做什么。
- **回退。** 没有 `wan` 时，手机和电脑用 `tailnet`；车在用户本人打开中转时用中转，否则离家时得到 `media_unreachable`。车所在的网络有 IPv6 时，IPv6 仍可能给它一条路径，遥测会显示这一点。

在家的设备如果 `lan` 失败、转而连到 `wan` 的名字，拿到的是家里的公网地址，这只在路由器支持 NAT 回环时可用；路径顺序让这种情况很少出现。

### Tailscale

节点所在的机器和用户本人的手机、电脑加入同一个 tailnet。节点在自己的网络接口上找到 tailnet 地址，或者使用 `TAILNET_ADDRESS`，并在上面运行第四个监听端口，端口为 `TAILNET_PORT`（9445；设为 0 即关闭）。它的策略和远程监听端口相同，只是只接受 tailnet 网段内的对端（`100.64.0.0/10`、`fd7a:115c:a1e0::/48`）。定时任务给它起名 `yolo-ts-<8 位十六进制>.<zone>`，维护一条指向 tailnet 地址的仅 DNS 的 A 记录，并用同样的方式签发证书。这条记录公开的是一个只有 tailnet 成员才能到达的地址。Yolo 不调用任何 Tailscale API，也不持有任何 Tailscale 密钥：它只是绑定一个地址。Tailscale 无法让两台设备直接相连时，会经它的 DERP 中继转发流量，速度更慢。

### 中转，需主动开启

- Worker 的 `/m/*` 透传保留，但中转关闭时回答 `403`，带 `X-Yolo-Error-Code: RELAY_OFF`；只有中转打开时 welcome 才列出它。即使打开，它也是最后一条路径。
- 用户本人在设置里打开它，需要 passkey 会话，并先确认这段警告：「通过你的 Cloudflare Worker 中转视频，很可能不符合 Cloudflare 对 Free、Pro 和 Business 区域的条款，Workers Free 则明确不在许可范围内。Cloudflare 可能限制你域名上的视频，或对你的账号采取措施。只有你接受这个风险时才打开。」开关和用户本人接受警告的时间存放在 KV 里，`yolo doctor` 和 `get_status` 会报告它，每次改动都写一行安全日志。
- 新实例的中转默认关闭。带来这项改动的版本在升级时也会把它关掉，它在更新日志里的升级块列出需要人来做的一步：设置远程直连或 Tailscale，或者打开中转（[版本和发布](../../implemented/process/2026-10-13-versions-and-releases.zh.md)）。
- 中转从不改写内容类型，也不把响应改造成看起来像别的流量：掩盖它在提供视频，会被视为规避这条限制，从而让整个账号承担风险。
- 用户本人为 Yolo 单独使用一个区域（zone），这样针对区域的视频限制不会波及其他网站；并且每位用户本人自己注册和持有 Cloudflare 账号，这是协议的要求（第 2.2.1(a) 节）。
- 用户本人可以就中转向 Cloudflare 支持要一份书面答复，问题写成：「Workers Paid、Custom Domain、经 Workers VPC 不缓存地透传自托管的 HLS、一个家庭使用」。答复会更新警告文字和这份记录。

### 所选路径的遥测

- **设备事件**（[设备遥测](../../implemented/feature/2026-10-11-device-telemetry.zh.md)）：`media_probe` 取代 `lan_probe`，并新增 `path`；`media_path` 记录所选路径的每次变化，带 `path`、`reason` 和每次探测的结果；`media_path_fallback` 取代 `lan_fallback`，并新增 `from` 和 `to`；`stream_selected` 带上 `network`（现在就是路径）和媒体主机。
- **Hub** 记录 `event: "stream"`，带上节点实际服务的路径，就像现在记录 `network` 一样，并按天统计每条路径的流数量。
- **节点** 为每个完成的媒体响应记一行，带路径、状态码、字节数、耗时和是否命中缓存，不含 token。
- **控制面** 记录 `kind: "edge"`，带 `path` 和 `event: "certificate"`、`"address_changed"`、`"cgnat"`、`"unreachable"` 或 `"error"`，取代 `kind: "lan"`。
- **设置** 显示每块屏幕最近使用的路径及原因、每条路径一张卡片（状态、名字、地址、证书日期和最近的错误），以及最近 7 天经中转的流数量。

### 每位用户本人要做的设置

| 步骤 | 路径 | 什么时候需要 |
|---|---|---|
| 把 `LAN_DNS_TOKEN` 设为 Worker secret，和局域网直连播放一样 | `lan`、`wan`、`tailnet` | 一次，任何直连路径都需要 |
| 给节点所在的机器做 DHCP 地址保留 | `wan` | 一次：路由器的转发指向一个固定地址 |
| 在路由器上把一个外部 TCP 端口转发到节点的 `WAN_PORT` | `wan` | 一次 |
| 在设置里打开远程访问，并填写外部端口 | `wan` | 一次 |
| 为节点的 `WAN_PORT` 添加 IPv6 防火墙规则 | `wan` | 仅用 IPv6 时 |
| 在 macOS 防火墙里放行节点 | `wan`、`tailnet` | 仅防火墙开启时 |
| 在节点所在的机器和每台手机、电脑上安装 Tailscale 并加入同一个 tailnet，并在每块屏幕上打开「使用 Tailscale」 | `tailnet` | 每台设备一次 |
| 打开中转并接受警告 | `relay` | 仅用户本人需要时 |
| 向 Cloudflare 支持要一份书面答复 | `relay` | 可选 |

[`yolo-deploy`](../../../../skills/yolo-deploy/SKILL.md) skill 把路由器上的步骤列为需要人来做的检查点，`yolo doctor` 报告每条路径的状态和修复方法（[agent 部署](../../implemented/feature/2026-10-13-agent-deployment.zh.md)）。

### 组成部分和复杂度

| 部分 | 复杂度 | 原因 |
|---|---|---|
| 播放器里的路径顺序、并行探测、回退和每块屏幕的开关 | 中 | 两个引擎、四条路径；改变 welcome 的那个版本里还有旧的播放器标签页 |
| Hub 里的路径、welcome 和 `media_unreachable` | 低 | Hub 已经为每台设备保存一个 network |
| `wan` 和 `tailnet` 的名字、记录和证书 | 低 | 把局域网的代码推广到一组名字 |
| 公网地址和运营商级 NAT 检查 | 中 | 路由器协议各不相同，外部检查取决于 Worker 能连到哪里 |
| 带限速和超时的远程监听端口 | 中 | Yolo 第一个前面没有 Cloudflare、直接面对互联网的部分 |
| 媒体 token 专用的派生密钥 | 低 | 两半各自派生；版本前缀兼顾改动之前签发的 token |
| Tailscale 监听端口 | 低 | 一个地址加一个对端网段 |
| 中转开关、它的警告和升级步骤 | 低 | 一个 KV 值、一个用户本人路由和一条更新日志 |
| 遥测和设置 | 低 | 现有事件上的新字段，以及每条路径一张卡片 |
| 车在 LTE 上的四种流类型，以及手机走 Tailscale | 中 | 真实网络、运营商 NAT 和车的浏览器 |

总体：中高。

## 曾考虑的替代方案

**中转继续作为默认路径。** 它不需要任何设置、在哪里都能用，但在 Free、Pro 和 Business 区域上很可能不符合 Cloudflare 的条款，在 Workers Free 上则明确不符合；而且每位用户本人都要在自己的账号上承担这个风险，这个账号上可能还有其他网站。

**删掉中转。** 那样的话，处在运营商级 NAT 之后、车又需要在外面看视频的用户本人，在 R2 暂存出现之前就一条路径都没有。保留为需主动开启，把选择留给每位用户本人，并把警告放在前面。

**R2 暂存。** 节点把预先切好分片的 HLS 或 fMP4 上传到用户本人的 R2 存储桶，设备从 R2 播放；这属于「托管在」Cloudflare 上的内容，因此合规。它需要一条上传管线、一个在播放前准备片子的步骤和淘汰机制；开播前就要占用家里的上行带宽，而边写边缓存的做法仍会代理第一次观看。存储费用为每 GB 每月 0.015 美元，出口流量免费，存放在 Cloudflare 上的内容受 Developer Platform 内容规则约束（[R2 价格](https://developers.cloudflare.com/r2/pricing/)）。它是给无法做端口转发的用户本人的、全在 Cloudflare 内的合规路径，推迟到 1.0 之后。

**Cloudflare Stream。** 合规，但 Stream 会对每次上传重新编码，Yolo 失去对码率档位的控制；费用是每月每 1,000 分钟存储 5 美元，加上每 1,000 分钟分发 1 美元：一个 500 部电影、约 60,000 分钟的片库，光存储每月就要约 300 美元（[Stream 价格](https://developers.cloudflare.com/stream/pricing/)）。

**Tailscale Funnel。** 它不用端口转发就能把节点发布在公开的 `*.ts.net` 地址上，车的浏览器也能用。但「经 Funnel 发送的流量受不可配置的带宽限制」（[Funnel](https://tailscale.com/kb/1223/funnel)），只提供 443、8443 和 10000 三个端口，一位 Tailscale 员工也说过对媒体而言它是「漏斗，不是水管」（[HN](https://news.ycombinator.com/item?id=35375794)），所以无法保证持续 8 Mbps 的视频。如果测量表明它扛得住，它可能作为实验性路径回来，给处在运营商级 NAT 之后的车用。

**Tailscale Serve 加 `ts.net` 证书。** 可行，但需要打开 tailnet 的 HTTPS 证书功能，并在 Yolo 之外配置 `tailscale serve`，Yolo 还得从用户本人那里得知这个名字。在用户本人的区域里用一套名字、记录和证书的机制，就能服务所有直连路径。

**Cloudflare One Client 或 Mesh 私有路由。** Cloudflare 豁免私有路由，所以这条路仍在用户本人的 Cloudflare 账号之内；但它需要一个 Zero Trust 组织和注册过的设备，而车无法注册。Tailscale 对用户本人来说更容易设置；私有路由路径以后可以作为插件出现。

**租一台小 VPS 做中转，用 WireGuard 连到节点。** 对 Cloudflare 而言合规，车也能连到，但每位用户本人都要多租一台机器并维护它。

**用隧道的公开主机名提供媒体。** Cloudflare 的文档把 Tunnel 公开主机名路由放在同一条限制之下，[透传那份记录](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.zh.md)也已经否决过经隧道的 `media.` 子域名。

**用 UPnP、NAT-PMP 或 PCP 自动创建端口映射。** 它能省掉手动转发，但很多路由器关掉了这些协议，而且软件自己在路由器上开端口会让用户本人意外。节点只读取外部地址。

**把媒体 token 绑定到设备的地址。** 车的地址在 LTE 上、在不同网络之间都会变，一条流每次地址变化都会断。

## 验收标准

- 新实例上中转是关闭的，Worker 的 `/m/*` 回答 `403 RELAY_OFF`，打开中转必须先确认警告。
- 有端口转发时，车在 LTE 上经 `wan` 播放全部四种流类型（`hls`、`direct`、`dash_split`、`plex`）；车在局域网流播放途中离开家里的 Wi-Fi，会在同一位置经 `wan` 继续播放。
- 离家时，装了 Tailscale 的手机在 Safari 里经 `tailnet` 播放，电脑在 Chrome 里同样可以。
- 在运营商级 NAT 之后（用测试路由器复现），设置显示 `cgnat`，手机用 `tailnet`，车得到 `media_unreachable` 以及它需要的设置说明，除非中转已打开。
- 测试固定远程监听端口的范围：其他 `Host` 得到 `421`，伪造的 token 在任何会话操作之前得到 `403`，反复失败的对端被拒绝，除 `/m/*`、`OPTIONS` 和探测之外没有任何路由，没有 HTML 内容类型。这个监听端口的安全审查有记录。
- 每条流的路径都出现在设备事件、Hub 的 `stream` 日志和节点的媒体日志行里，设置显示每块屏幕最近使用的路径和中转的计数。
- 上线时，[透传](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.zh.md)、[局域网直连播放](../../implemented/feature/2026-10-12-lan-direct-play.zh.md)、[Workers VPC](../../implemented/architecture/2026-10-08-workers-vpc-node-access.zh.md) 和[设备遥测](../../implemented/feature/2026-10-11-device-telemetry.zh.md)这几份记录都描述了它，README 写明中转的警告，`yolo doctor` 检查每条路径。

## 风险

- **很多用户本人无法做端口转发：** 运营商级 NAT、租用的路由器，或者运营商封了入站端口。他们的手机用 Tailscale，车只有中转可用；最早一批实例的 `edge` 事件会显示这种情况有多常见，以及多快需要 R2 暂存。
- **节点直接面对互联网。** 证书进入证书透明度日志后几分钟内，扫描器就会找到这个端口；媒体处理逻辑或 Node 的 TLS 和 HTTP 代码里的漏洞会变得在任何地方都可触达；恶意流量能占满家里的上行带宽。监听端口的窄范围、它的限速、保持最新的 Node.js（`yolo doctor` 会检查）以及用户本人的开关共同限制这些风险。
- **家里的公网地址被公开** 在 DNS 里，会暴露用户本人的运营商和大致位置。
- **公网地址变化** 会让 `wan` 断开，直到节点下一次检查、下一次 5 分钟的定时任务和记录 60 秒的 TTL 都过去；期间的流会回退。
- **车所在的网络情况不明：** 它的 LTE 运营商是否允许出站连接到任意端口，以及它有没有 IPv6。车的 `media_probe` 事件会回答这两个问题。
- **路由器的 DNS 重绑定保护** 可能丢弃 Tailscale 名字的私有地址回答，就像它可能丢弃局域网名字一样；用户本人把这个区域加入白名单。
- **中转仍留在代码里。** 打开它的用户本人在自己的账号上承担风险。Cloudflare 的条款可能变化，所以每当 Cloudflare 更新条款时，都要重新检查警告和这份记录。
- **Workers VPC 仍是控制流量依赖的一个测试版产品**；媒体流离开 Worker 之后，它在测试期结束后尚未公布的价格就没那么要紧了。
- **四条媒体路径** 会成倍增加一个播放问题可能依赖的东西；遥测记录每条流走的路径。
