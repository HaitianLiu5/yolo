# Yolo

[English](README.md) | 中文

**Yolo 是一个私人的、由 agent（智能体）驱动的媒体服务。**它的播放器运行在特斯拉的浏览器或其他任何浏览器里，你的 AI agent（ChatGPT、Claude、Codex）通过 MCP 控制播放，整个服务运行在你自己的 Cloudflare 账号和你家里自己的机器上，播放的是你自己的片源。

> 在车上，请只在停车时或作为乘客使用 Yolo。遵守当地法律，只播放你有权访问的媒体。Yolo 与特斯拉或 Plex 没有任何关联。

<a id="you-own-every-piece"></a>

## 每一部分都归你所有

- **没有 Yolo 服务器。**控制面是你 Cloudflare 账号里、挂在你自己域名上的一个 Worker；媒体节点是你家里机器上的一个进程。你的实例不调用 Yolo 项目运行的任何服务。
- **不向我们发送埋点。**Yolo 没有任何分析统计，也不回传数据。你的屏幕只把播放诊断发到你自己的 Workers Logs，并且先去掉其中的 token。
- **用户本人只用 passkey 登录。**没有密码，也没有邮件重置。第一个 passkey 和每一次重置都需要一个 6 位数字码，而只有你家里的机器能签发它。
- **媒体直接从你家里来。**屏幕通过 HTTPS 从节点取视频：在家庭网络里走节点的内网地址；你打开远程访问后，在其他任何地方经过路由器上的一个端口。只有在你打开中转期间，你的 Worker 才会中转媒体，而新实例的中转默认关闭。
- **开源。**Yolo 采用 MIT 许可证，你从本仓库的发布标签部署它，所以你能读到自己运行的代码。

<a id="how-it-works"></a>

## 工作原理

```mermaid
flowchart LR
  agents["AI agents<br/>ChatGPT · Claude · Codex"]
  screen["Player<br/>Tesla browser · any browser"]

  subgraph cloudflare["Your Cloudflare account, on your domain"]
    worker["Worker<br/>player page · /v1 · /mcp with OAuth · passkey sign-in"]
    hub["Hub<br/>Durable Object: devices, playback state, commands"]
    d1[("D1<br/>history · progress · queue · playlists · devices")]
    kv[("KV<br/>OAuth grants")]
  end

  subgraph home["Your home machine"]
    cloudflared["cloudflared<br/>outbound-only tunnel"]
    api["Node internal API<br/>127.0.0.1 only"]
    pipeline["Media pipeline<br/>source plugins"]
    listener["Media listeners: LAN · remote<br/>HTTPS, media tokens only"]
  end

  sources["Plex · web video sites"]

  agents -- "MCP + OAuth" --> worker
  screen -- "control: HTTPS + WebSocket" --> worker
  worker --- hub
  worker --- d1
  hub --- d1
  worker --- kv
  worker -- "Workers VPC" --> cloudflared
  cloudflared --> api
  api --> pipeline
  pipeline -- "fetch" --> sources
  pipeline --> listener
  listener == "media: LAN direct, remote direct" ==> screen
  worker -. "media relay: off by default" .-> screen
```

默认情况下，Worker 只承载控制：播放器页面、登录、MCP、`/v1` API，以及记录哪块屏幕在播放什么的 Hub。它经由 Workers VPC 和一条 Cloudflare Tunnel 访问节点的内部 API；这条隧道由 cloudflared 从你家里向外建立，所以控制不需要任何入站端口。每块屏幕的媒体走第一条可用的路径：

1. **局域网直连。**在家庭网络里，你在设置中打开了 **Play over the home network**（通过家庭网络播放）的屏幕，会从节点在内网地址上的 HTTPS 监听端口取流。它用的是你域名区里的一个仅 DNS（不代理）名称和一张 Let's Encrypt 证书，证书的私钥从不离开节点。
2. **远程直连。**你打开远程访问后，其他任何地方的屏幕（包括用 LTE 的车）都能经过路由器上的一个端口，访问节点的远程监听端口（默认 9444）。节点通过 PCP、NAT-PMP 或 UPnP IGD 向路由器申请这个端口，定期续期，并在停止时删除映射；如果路由器对这三种协议都不响应，就由你手动转发端口。这个监听端口有自己的、指向你家公网 IP 地址的仅 DNS 名称和自己的 Let's Encrypt 证书，你的 Worker 会先从家庭网络之外确认端口能访问，然后才让屏幕使用它。
3. **中转。**Worker 把节点的媒体转发给屏幕，它是最后一条路径。新实例的中转默认关闭，因为在 Free、Pro 和 Business 套餐上经你的 Worker 中转视频很可能不符合 Cloudflare 的条款，Cloudflare 届时可能限制你域名上的视频，或对你的账号采取措施；要打开中转，你必须先接受这条警告。从有这个开关之前的发布升级上来的实例会保持中转开启，直到你在 Settings > Media paths 里关掉它，在此期间 `yolo doctor` 会发出警告。

[Agent Notes](.agents/notes/README.zh.md) 解释了每一部分以及为什么这样构建。可以从[整体拆分](.agents/notes/implemented/architecture/2026-10-07-control-plane-on-cloudflare-media-node-at-home.zh.md)、[经 Workers VPC 访问节点](.agents/notes/implemented/architecture/2026-10-08-workers-vpc-node-access.zh.md)、[局域网直连播放](.agents/notes/implemented/feature/2026-10-12-lan-direct-play.zh.md)和[媒体流离开 Worker](.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.zh.md)读起。

<a id="what-happens-when-you-press-play"></a>

## 按下播放时发生了什么

1. 你在一块屏幕上打开你的站点，你的 Worker 返回播放器页面。
2. 屏幕用它的设备凭据完成认证，并连接 Hub；这个凭据是你用 passkey 批准它配对时一次性发给它的。Hub 列出已就绪的媒体路径，屏幕同时探测所有路径，按局域网直连、远程直连、中转（仅在开启时）的顺序，选用第一条有响应的路径。
3. 你点一下播放，或者某个 agent 通过 MCP 调用 `play`。Worker 把请求交给 Hub，Hub 经由 Workers VPC 请节点为这块屏幕的路径准备一个会话。片源插件（Plex、yt-dlp 等）告诉节点从哪里读取媒体，节点返回这个会话的媒体 token，以及它所服务路径的源（origin）。如果屏幕没有可用的路径而中转又是关闭的，Hub 会在节点做任何工作之前以 `media_unreachable` 拒绝，并说明每条路径需要什么。
4. 如果一条流在它的路径上失败，屏幕会在同一位置换到下一条路径继续播放，之后的流再重新选用最好的路径。
5. 媒体字节从节点流向屏幕。在两条直连路径上，TLS 就终止在节点本身。
6. 屏幕上报播放位置，Hub 把你的进度存进 D1，所以任何一块屏幕或任何一个 agent 都能从你停下的地方续播。

<a id="who-can-see-what"></a>

## 谁能看到什么

| 谁 | 能看到什么 |
|---|---|
| Yolo 项目及其作者 | 看不到你实例的任何东西：Yolo 不运行任何服务器，也不回传任何数据。 |
| 你的 Cloudflare 账号 | 控制数据（你的设备、agent、观看记录、队列、播放列表和播放状态）以及你自己的 Workers Logs。中转关闭时看不到媒体字节。 |
| 你接入的 agent | 它们调用 Yolo 的工具时得到的返回内容，限于你授予的权限范围：状态、设备、片库、搜索结果、队列、播放列表和观看记录。 |
| 片源网站和 Plex | 节点为你要播放的内容及其缩略图发出的请求，来源是你家的 IP 地址。 |
| 屏幕连接的第三方 | 没有：屏幕只和你的 Worker 及你的节点通信，播放器的字体和所有图片都来自你自己的源。 |
| 公共互联网 | 你的主机名和节点的名称，它们出现在 DNS 和证书透明度（Certificate Transparency）日志里。使用局域网直连时，还有 DNS 里节点的内网地址。使用远程直连时，还有 DNS 里你家的公网 IP 地址，以及唯一一个只提供带授权 token 的媒体和一个可达性探测的 HTTPS 端口。 |

远程直连会公开你家的公网 IP 地址，Plex 的远程访问也是如此；它的名称进入证书透明度日志后不久，扫描器就会找到这个端口。如果你不想这样，就保持远程访问关闭：家里的屏幕照样直连播放，离开家时则只能通过中转播放，前提是你打开了中转。

<a id="security-model"></a>

## 安全模型

Yolo 的安全建立在小而明确的边界和你能读到的代码上：

- **passkey。**用户本人只用 passkey 登录。注册第一个 passkey、或重置全部 passkey 所需的配对码，由节点在本地的 Unix socket 上签发，Worker 和互联网都访问不到这个 socket；配对码 15 分钟后过期，只能用一次，输错五次即作废（[用户本人登录](.agents/notes/implemented/architecture/2026-10-08-passkey-owner-sign-in.zh.md)）。
- **设备配对需要你批准。**屏幕显示一个二维码；你扫码、登录，核对屏幕的短码和名称，然后点 Allow。短码只能用一次，10 分钟后过期（[设备配对](.agents/notes/implemented/feature/2026-10-07-device-code-pairing.zh.md)）。
- **凭据只存哈希，并按 scope 限权。**D1 只保存设备凭据的哈希，并在每次请求时核对，所以移除一台设备会立即切断它。agent 拿到的 OAuth token 限于你允许的 `read`、`control` 和 `manage` scope；访问 token 一小时过期，KV 里只存 token 的哈希（[OAuth](.agents/notes/implemented/architecture/2026-10-07-oauth-authorization-server.zh.md)）。
- **每个会话一个媒体 token。**每个媒体 URL 都带着一个为单个播放会话签发的 HMAC 签名 token，只在这个会话存续期间有效，最长 12 小时；媒体请求不用 cookie（[媒体 token](.agents/notes/implemented/architecture/2026-10-07-same-origin-media-passthrough.zh.md)）。
- **内部 API 只在 127.0.0.1 上。**节点只在回环地址上提供内部 API。Worker 经由 Workers VPC 和你那条只向外建立的隧道访问它，并用只有 Worker 和节点持有的密钥给每个请求签名（[Workers VPC](.agents/notes/implemented/architecture/2026-10-08-workers-vpc-node-access.zh.md)）。
- **TLS 私钥留在节点上。**节点为它的每个名称各自生成私钥，对外只发送证书签名请求；你的 Worker 为每个名称分别申请恰好对应的 Let's Encrypt 证书（[局域网直连播放](.agents/notes/implemented/feature/2026-10-12-lan-direct-play.zh.md)）。
- **面向互联网的端口范围很窄。**远程监听端口只提供带授权 token 的媒体和一个探测，在 HTTP 和 TLS 里都只应答自己的名称，在任何会话工作之前先检查 token 的签名和有效期，要求 TLS 1.2 或更新版本，并且不记录任何 URL。关闭远程访问会删除它的 DNS 记录、关闭它，并删除路由器上的映射（[威胁模型](.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.zh.md#the-threat-model-of-the-remote-listener)）。
- **限流。**登录、配对和 OAuth 路由按地址限流；一个地址如果不断向 Worker 出示被拒绝的媒体 token，就会被封一分钟。节点的远程监听端口会在一个地址一分钟内失败 20 次后拒绝它 10 分钟，并把连接数限制在每个地址 32 个、总共 256 个。
- **密钥不进日志。**Workers Logs 不保留逐请求的日志行，设备埋点在两端都会去掉 token 和凭据（[设备埋点](.agents/notes/implemented/feature/2026-10-11-device-telemetry.zh.md)）。

需要知道的局限：

- 谁控制了你的 Cloudflare 账号或你家里的机器，谁就控制了你的实例。
- 插件拥有节点或 Worker 的全部权限；安装插件之前先审查它。
- 泄露的媒体 URL 在它的会话结束之前都能播放。
- 你家庭网络里的每台设备都能访问节点的局域网监听端口，它只提供带授权 token 的媒体。
- 远程访问开启期间，Node.js 的 TLS 或 HTTP 代码、或者媒体处理代码里的缺陷，整个互联网都能触及；按地址的限制也约束不了许多地址的联合行动。
- 远程直连需要一个互联网能访问到的路由器端口。在运营商级 NAT 后面（Yolo 会检测并报告这种情况），或者运营商屏蔽了入站端口时，离开家的屏幕就只剩中转一条路。
- 控制流量依赖 Workers VPC，它是 Cloudflare 的 beta 产品。

请按 [SECURITY.md](SECURITY.md) 的说明私下报告漏洞。

<a id="performance-and-bandwidth"></a>

## 性能和带宽

- **没有中转这一跳。**在直连路径上，媒体只从节点流向屏幕，不经过别处：在家时它留在你的网络里，离开家时它只经过一次你家的上行带宽，不绕道 Cloudflare。
- **在家播放原画质。**在局域网直连上，节点的码率上限是 200 Mbps，而不是 4.8 Mbps。只要浏览器能解码，Plex 插件就原样播放 Plex 的原始文件，不做转码；否则由 Plex 的 direct stream 复制符合条件的视频，只转换其余部分。网页视频可以用更高码率的格式。车机 profile 仍然是 720p H.264。
- **由你家上行承载时设上限。**在远程直连和中转上，节点默认把视频码率限制在 4.8 Mbps（`STREAM_MAX_VIDEO_BITRATE_KBPS`）。
- **自适应码率。**每块屏幕测量自己的吞吐量，连接变化时请求更低或更高的码率上限（[自适应码率](.agents/notes/implemented/feature/2026-10-11-adaptive-quality.zh.md)）。
- **网页视频的镜像对冲读取。**当片源为同一份字节提供多个 URL 时（比如一个 CDN 的多个镜像主机），节点从最好的那个读取每个字节范围，第一个读取卡住或落后时，就在另一个镜像上再发起一次读取，先读完的胜出（[媒体管线](.agents/notes/implemented/architecture/2026-10-11-node-media-pipeline.zh.md)）。
- **预读和磁盘缓存。**在车上，播放器最多提前缓冲 HLS 流的 210 秒；节点把取到的分片存进磁盘缓存（默认 20 GB），所以往回拖时不会重新下载。

<a id="deploy-it-with-your-agent"></a>

## 让你的 agent 来部署

Yolo 由替你工作的 agent 来安装。在家里那台要运行节点的 Mac 或 Linux 电脑上，在本仓库的克隆里打开 Claude Code 或 Codex 这类编程 agent，让它部署 Yolo。它按照 [`yolo-deploy`](skills/yolo-deploy/SKILL.md) 技能操作，每一步都通过 `npm run yolo -- <command>` 执行，遇到只有你能做的事就停下来。`npm run yolo -- doctor` 检查整个实例，并为每项失败的检查给出修复方法。运行节点的电脑需要 Node.js 22.12 或更新版本、yt-dlp、FFmpeg、Deno 和 cloudflared。

需要你亲自做的事：

- Cloudflare 账号和托管在上面的域名（免费套餐预计就够用），以及主机名；主机名是永久的，因为 passkey 绑定在它上面；
- 批准 `wrangler login`，在 Cloudflare 控制台里创建隧道并交出它的 token，以及创建两条直连路径都需要的 Cloudflare DNS token（`MEDIA_DNS_TOKEN`）；
- 在你的账号里创建任何东西之前，批准部署计划；
- 你的 passkey，用 agent 给你的 6 位数字码创建；
- 配对每块屏幕，批准每个 agent；
- 在 Settings > Media paths 里打开远程访问；只有当你的路由器对 PCP、NAT-PMP 和 UPnP IGD 都不响应时，才需要把 TCP 9444 转发到节点并设置 `WAN_MAPPING=manual`。

接入 AI 应用时，按照 [`yolo-connect-agent`](skills/yolo-connect-agent/SKILL.md) 操作：把 `https://<your-domain>/mcp` 交给应用，并用 passkey 批准一次。升级时，让你的 agent 来做：它按照 [`yolo-upgrade`](skills/yolo-upgrade/SKILL.md) 先告诉你这次发布改了什么并等你批准，再备份 D1、执行迁移、重启节点、部署 Worker 并运行 `doctor`；`npm run yolo -- rollback` 回到上一个发布。每次发布的说明在 [CHANGELOG.md](CHANGELOG.md) 里。你的实例的地址和 Cloudflare id 保存在不受版本控制的 `yolo.instance.json` 里；请把它和 `.env` 各备份一份。

<a id="features"></a>

## 功能

- **agent 优先。**一个带 OAuth 的远程 MCP 服务：给 agent 一个 URL，批准一次，它就能搜索、播放、暂停、跳转、切换字幕和音轨，管理队列和播放列表，并读取观看记录。
- **在特斯拉浏览器里播放。**在车上，播放器用 WebCodecs 解码并画到 `<canvas>` 上，因为车辆行驶时特斯拉可能会冻结普通的 `<video>` 元素。
- **每个浏览器都是一块屏幕，也是一个遥控器。**在电脑或手机的浏览器里（包括 iPhone），播放器用浏览器自己的 `<video>` 播放，支持画中画和锁屏控制，并能控制正在播放的那块屏幕（[Yolo Web](.agents/notes/implemented/feature/2026-10-11-yolo-web-client.zh.md)）。
- **一份观看记录。**所有屏幕和 agent 共用一份带续播的观看记录、一个队列和你的播放列表。
- **片源都是插件。**Plex 片库和网页视频（通过 yt-dlp）都是基于实验性 API 的插件，新插件从 [`plugins/source-example`](plugins/source-example/) 起步。

<a id="roadmap"></a>

## 路线图

Yolo 还处于 1.0 之前：它的内部协议和插件 API 在不同发布之间仍可能不兼容地修改。[Yolo 1.0](.agents/notes/proposed/feature/2026-10-11-yolo-1-0.zh.md) 定义了目标和通往它的路线，包括不依赖 Plex 或 yt-dlp 的片源、本地和 NAS 片库、插件 API 1.0，以及给其他用户用的安装包。

<a id="contributing"></a>

## 参与贡献

所有项目知识都在 [Agent Notes](.agents/notes/README.zh.md) 里，有英文和中文两种语言。在代码上工作的 agent 从 [AGENTS.md](AGENTS.md) 开始，`npm run check` 运行文档门禁、构建和每一层测试。参与贡献请看 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。

<a id="license"></a>

## 许可证

[MIT](LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
