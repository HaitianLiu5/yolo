# Agent Note: 在局域网内直接从家里的节点播放

Status: proposed

[English](2026-10-12-lan-direct-play.md) | 中文

## 问题

在家里用浏览器播放 Yolo 时，每个媒体字节都要经过 Cloudflare。节点经 cloudflared tunnel 把它从家里的线路上传出去，Worker 再转发，最后又从同一条线路下载回来（[同源透传](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.zh.md)、[Workers VPC](../../implemented/architecture/2026-10-08-workers-vpc-node-access.zh.md)）。所以家里的上行带宽限制了画质：节点的上限是 4.8 Mbps（`STREAM_MAX_VIDEO_BITRATE_KBPS`），而且 Plex 插件对每个条目都向 Plex 请求不超过这个码率的 720p 流，所以即使文件就在同一台机器上、浏览器也能解码原文件，更大的文件仍会被转码（[片源插件 API](../../implemented/architecture/2026-10-11-source-plugin-api.zh.md)）。Plex 自己的应用在家庭网络里直接播放这样的文件。这段绕行还让家里的播放也受制于 Cloudflare 对代理视频的条款这一待定问题（[视频条款](../process/2026-10-07-cloudflare-video-terms.zh.md)）。

在节点所在网络里的浏览器应当直接从节点取媒体，能解码时播放原文件，其他地方都走 tunnel。播放器页面来自控制面的公网 HTTPS 源，并且跨源隔离（[canvas 引擎](../../implemented/architecture/2026-04-04-canvas-playback-engine.zh.md)），所以访问局域网里节点的请求，是一个从公网站点发往私有地址的跨源请求，浏览器会限制这类请求。具体服务商的名字必须留在核心、控制面和节点之外（[插件架构](../../implemented/architecture/2026-10-11-plugin-architecture.zh.md)）。

## 提案

### 结论

在电脑和手机浏览器里，Yolo Web 可以实现局域网直连播放，做法与 Plex 相同：一个解析到节点私有地址的公网域名、这个域名的公共受信证书，以及一个先探测该地址、不通就走 tunnel 的客户端。任何设备都不需要私有证书颁发机构或浏览器开关。有三个限制条件：

- Chrome 和 Firefox 会按站点询问一次 Local Network Access（局域网访问权限），macOS 上的 Chrome 还需要系统的“本地网络”权限。Safari 什么都不问。
- 开启了 DNS rebinding 防护的路由器会丢弃这个域名的私有地址解析结果，除非用户本人把该域名加入白名单。
- 车上尚未验证。特斯拉的浏览器（Linux 上的桌面版 Chrome 148）会不会弹出或授予 Local Network Access 权限还不知道，只有在车连着家里 Wi-Fi 时实测才能回答。探测失败的车继续走 tunnel。

“不转码”只在浏览器能解码文件编码的地方成立。原始 MP4 文件原样播放；编码浏览器能解码的 Matroska 文件通过流复制重新封装（remux）；浏览器不能解码的音频（DTS、TrueHD）单独转换；完整转码只留给图形字幕、浏览器不能解码的视频，以及比文件码率还慢的 Wi-Fi。收益最大的是 Plex 和计划中的 NAS 片源。yt-dlp 条目今天就不转码，所以对它们来说，局域网路径只省掉 tunnel 往返和上行带宽限制。

### 设计

1. 节点开第二个监听端口，在它的局域网地址上提供 HTTPS，只服务 `/m/*` 和一个探测接口。内部 API 仍在 `127.0.0.1:9191`。
2. 控制面在用户本人的域名区里给这个监听端口分配一个解析到节点私有 IPv4 地址的域名，并通过 DNS-01 从 Let's Encrypt 取得它的证书。私钥从不离开节点。
3. Hub 把局域网源告诉每个设备。设备探测它并报告是否连通，Hub 对连通的设备在 `prepare` 中传 `network: "lan"`。
4. 路径里的媒体 token 仍是唯一的凭据。局域网 URL 就是局域网源下同样的 `/m/{token}/…` 路径。
5. 在局域网路径上，片源插件根据设备的能力描述和更高的码率上限，在直接播放、重新封装和转码之间选择。节点核心只按容器和编码判断能否播放，所以不会出现服务商的名字。
6. 播放中的局域网故障转成现有的恢复流程，经 tunnel，在同一位置继续。
7. Yolo 不运营 plex.direct 式的服务。1.0 的每个用户本人都有 Cloudflare 域名区，用他自己的域名区就能得到同样的结果。

这修改了一条现行规则：客户端不再与每个 `/m/*` 请求同源。局域网源是唯一的例外，它带着跨源隔离页面接受的 CORS 头提供服务。

### 设备怎样找到局域网里的节点

- 节点在 `/internal/v1/health` 里报告局域网监听端口：`lan: { origin, address, notAfter }`。只要节点报告监听端口正常，Hub 的 `welcome` 就带上 `lan: { origin }`。
- 设备用 2 秒超时探测 `GET {origin}/lan/probe`。探测不带 token。它在收到 `welcome` 时、浏览器触发 `online` 事件时，以及局域网媒体请求失败后运行。结果变化时，设备发送 `{ v: 1, type: "network", lan: true | false }`，Hub 像保存视口一样按设备保存最新值。
- 一块屏幕的第一次探测，要等用户本人在设置里为这块屏幕打开“通过家庭网络播放”之后才进行，这样浏览器的 Local Network Access 提示出现在用户本人预期的时候，而不是在第一次访问时。此后探测自动进行。在 Permissions API 认识这个权限的浏览器里（Chrome 的 `local-network`），`granted` 跳过等待，`denied` 则让设置页说明如何允许。
- 由探测决定，和 Plex Web 并行测试各条连接的做法一样（[Plex](#how-plex-jellyfin-and-emby-do-it)）。不在家时探测会悄悄失败：私有地址超时，或者 TLS 在对方网络里占用该地址的设备上失败。

### 流怎样选择局域网路径

- 对最近一次探测成功的设备，Hub 在 `prepare` 中传 `network: "lan"`。节点于是用 `LAN_MAX_VIDEO_KBPS`（默认不限）代替 `STREAM_MAX_VIDEO_BITRATE_KBPS` 作为上限，仍会被设备的[自适应码率上限](../../implemented/feature/2026-10-11-adaptive-quality.zh.md)压低，并在插件的 prepare 上下文里传入 `network`。
- 流描述增加 `origin`：局域网源，或者表示页面自身源的 `null`。设备用它解析每个流、播放列表和字幕 URL；今天 `player.js` 和 `subtitles.js` 是对 `location.origin` 解析的。节点的播放列表已经使用绝对路径（`/m/{token}/…`），会按播放列表自己的源解析。
- 播放过程中变得可达的设备保留当前的流。局域网路径从下一个流开始生效：新条目、跳到流起点之前、清晰度或音轨字幕变化，或者恢复。

### 域名和证书

对用户本人自己的域名区（`haitian.site`）：

- **域名**是每个节点一个标签，位于 passkey 依赖方 `yolo.haitian.site` 之外，例如 `yolo-lan-<random>.haitian.site`。位于 `yolo.haitian.site` 之下的域名可以请求用户本人的 passkey，因为 WebAuthn 允许子域名上的页面把父域名用作依赖方 ID。会话 cookie 是 `__Host-` cookie，兄弟主机无法设置或覆盖它们。
- **DNS 记录**是一条仅 DNS（不代理）的 A 记录，指向节点的私有 IPv4 地址，TTL 60 秒。节点报告新地址时，控制面更新它。
- **证书**通过 ACME DNS-01 从 Let's Encrypt 获取，这是唯一不需要入站连接到节点的验证方式。节点生成密钥对和只含它这一个域名的 CSR，并在 `/internal/v1/health` 里返回 CSR。控制面用 WebCrypto 完成 ACME 订单，用一个只限该域名区 DNS 编辑权限的 token（Worker secret `LAN_DNS_TOKEN`）通过 Cloudflare API 写入 `_acme-challenge` TXT 记录，再把证书链发给新的 `/internal/v1/lan/certificate`。节点无需重启就换上新证书。续期遵循 ACME Renewal Information，没有它时在有效期过去三分之二时续期，所以 Let's Encrypt 和 CA/Browser Forum 已排定的更短有效期不需要任何改动（[证书](#certificates-for-a-private-address)）。
- **会公开的内容：**域名会出现在证书透明度（Certificate Transparency）日志里，A 记录会公开节点的私有地址。两者透露的都不超过一个家庭局域网地址。

对其他用户：[分发](2026-10-11-distribution-to-other-owners.zh.md)已经让每个用户都有自己的 Cloudflare 账号和域名，所以一键部署命令创建 DNS token，同一机制就能服务他们。只有没有域名区的用户才需要 Yolo 运营的 plex.direct 式服务，也就是 1.0 之外的[不依赖 Cloudflare 的自托管](../architecture/2026-10-07-self-hosting-without-cloudflare.zh.md)。这样的服务需要 Let's Encrypt 为其共享域名放宽频率限制（[证书](#certificates-for-a-private-address)）；需要能回答编码了 IP 的域名（`192-168-1-10.<owner-hash>.<domain>`）的权威 DNS；需要只签 CSR、由每个用户的控制面认证的签发服务；还会让 Yolo 成为每个用户续期都依赖的常驻服务。它的复杂度高，等自托管时再说。

### 局域网监听端口和授权

- 监听端口只服务 `/m/{token}/…` 下的 `GET` 和 `HEAD`、`OPTIONS` 预检和 `/lan/probe`。媒体 token 对每个媒体请求的授权与经 Worker 时完全相同（[同源透传](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.zh.md)）。局域网上访问不到其他任何东西；用户本人的配对码仍只在 Unix socket 上。
- 它只绑定节点的私有 IPv4 地址，并拒绝私有地址段以外的对端，所以在允许入站 IPv6 的路由器后面，节点的公网 IPv6 地址也不会暴露它。它只回答 `Host` 是自己域名的请求，从而挡住针对它的 DNS rebinding。它不提供 HTML：每个响应体都是媒体、播放列表、WebVTT 或 JSON，并带 `X-Content-Type-Options: nosniff`。
- CORS：`Access-Control-Allow-Origin` 是控制面的 `PUBLIC_ORIGIN`。`Access-Control-Expose-Headers` 列出 `Content-Range`、`Accept-Ranges`、`ETag` 和 `X-Yolo-Error-Code`，让 hls.js 和 canvas 引擎能读取字节范围和带类型的错误。响应还带 `Cross-Origin-Resource-Policy: cross-origin`，所以无论浏览器怎样取，页面的 COEP 都接受。
- 单个字节范围是 CORS 安全列表里的 `Range` 取值，所以媒体请求不需要预检。canvas 引擎的预取器还会发送 `X-Drive-In-Prefetch: 1`，这个自定义头会让每个分片请求都要预检，而预检按 URL 缓存；在局域网上这个标记改放进 URL 的查询串。

### “不转码”对每种片源意味着什么

| 片源 | 今天，经 tunnel | 在局域网上 |
|---|---|---|
| Plex | Plex 转码器按 720p、最高 4.8 Mbps 转码；`directStream=1` 已经会复制符合这些限制的视频 | **直接播放（direct play）：**容器和编码能在设备上播放时，插件把 Plex 的原始文件（`/library/parts/{id}/{changestamp}/{file}`）作为带 `cache: false` 的 `file` Input 返回，节点按字节范围代理。**直接串流（direct stream）：**用设备的分辨率和局域网上限调用 Plex 的通用转码器，它复制视频，只转换设备不能播放的部分。**转码：**和今天一样，用于烧录图形字幕和设备不能解码的视频 |
| yt-dlp | 不转码：节点代理或拼接在 4.8 Mbps 上限内选出的格式 | 插件不变。局域网上限让它能选 1080p 及以上，并在设备能解码时选 VP9 或 AV1。节点仍从互联网下载；局域网路径省掉的是上行带宽和经 Cloudflare 的往返 |
| NAS 和文件夹里的文件（[0.5](2026-10-11-own-library-and-nas.zh.md)） | 尚未实现 | 由 ffprobe 描述文件。编码受支持的 MP4 或 WebM 直接播放；Matroska 通过流复制重新封装；DTS 或 TrueHD 音频单独转换；其余转码。经 tunnel 时这些文件通常超过上行带宽，要在 NAS 硬件上转码，所以正是局域网路径让高码率的 NAS 文件能在家里播放 |

**Plex：由节点代理原文件；浏览器从不直接访问 Plex。**直接从 Plex 取流的浏览器会拿到用户本人的 Plex token，而它能管理整个 Plex 服务器；客户端还需要 Plex 的 URL 和认证方式，这就破坏了不认识具体服务商的客户端。Plex 自己的 `plex.direct` 域名和证书同样需要 Local Network Access 权限，所以在浏览器里直连 Plex 什么也得不到。Plex 通常就跑在节点所在的机器上（`PLEX_URL` 默认是 `http://localhost:32400`），所以代理只花一次本机回环的复制，Plex 在别的机器上时多一跳局域网；媒体 token、会话过期、停止和进度仍归 Yolo 管。

### 在插件架构中的位置

- **控制面核心**保存每个设备的 `network` 状态、`welcome` 里的局域网源，以及 DNS 和 ACME 的工作。这些都不涉及服务商的名字。
- **节点核心**负责局域网监听端口、局域网上限、prepare 上下文里的 `network`，以及一个可播放性辅助函数 `context.playable(media)`。它接收一份不涉及服务商的描述 `{ container, video: { codec, profile, bitDepth, hdr, width, height }, audio: [{ codec, channels }], kbps }`，与设备的能力描述比较，回答 `direct`、`remux`、`audio` 或 `transcode`，并附上原因。`file` Input 增加 `remux`：用 ffmpeg 流复制写成 fMP4 HLS，音频复制或转成 AAC。文件夹插件需要的本地路径随 0.5 提供。
- **能力描述**增加直接播放需要的细节（[能力协商](../../implemented/architecture/2026-10-07-capability-negotiation.zh.md)）：容器（`mp4`、`webm`）；带 profile 和位深的视频编码（H.264 High 与 High 10、HEVC Main 与 Main 10、AV1、VP9）；音频编码（`mp4a`、`mp3`、`opus`、`flac`、`ac-3`、`ec-3`）；HDR；以及按显示屏得出的 `maxHeight`。`<video>` 引擎用 `MediaCapabilities.decodingInfo()` 测出它们。车上的能力描述仍是 canvas 上的 720p H.264 和 AAC。
- **插件**把各自的元数据映射成这份描述。Plex 插件在原文件、Plex 的直接串流和 Plex 的转码之间选择；yt-dlp 继续按码率上限和编码列表选格式；文件夹和 WebDAV 插件用 ffprobe。服务商代码留在 `plugins/` 里，所以 `git grep -niE "plex|yt-?dlp|youtube" -- service/` 的命中保持不变。客户端仍然不认识具体服务商：它只看到一个源和一种交付方式。

### 回退

- 没有局域网源、权限待定或被拒绝、或探测失败：设备和今天一样走 tunnel。
- 播放中局域网媒体请求失败（Wi-Fi 断开、车开走、笔记本在另一个网络上唤醒）：引擎的网络错误启动播放器的恢复流程。设备先发送 `lan: false` 的 `network`，所以在同一位置重建时走 tunnel、用 tunnel 的上限，如果原文件超过上限，插件就选择转码。车上 canvas 引擎最多 210 秒的缓冲通常能盖住这次切换。
- Wi-Fi 比原文件慢：自适应码率控制器降低上限，插件改为转码，仍经局域网提供。
- 证书过期、地址过时，或者路由器丢弃这个域名：探测失败，设备留在 tunnel 上。设置页和 `/diag` 显示权限状态和最近一次探测结果。

### 用户本人需要做的设置

| 步骤 | 何时需要 |
|---|---|
| 一个对该域名区有 DNS 编辑权限的 Cloudflare API token，存为 Worker secret `LAN_DNS_TOKEN` | 一次，必需；对其他用户可由部署命令创建 |
| 在 Yolo 设置里为这块屏幕打开“通过家庭网络播放” | 每块屏幕一次 |
| 在 Chrome 和 Firefox 里允许该站点的 Local Network Access | 每个浏览器一次，在浏览器提示时 |
| 在 macOS 的系统设置、隐私与安全性、本地网络里允许 Chrome | 每台 Mac 一次，在系统提示时 |
| 在路由器的 DNS rebinding 防护里把该域名加入白名单 | 只在路由器过滤私有地址解析结果时 |
| 在 macOS 防火墙里允许节点 | 只在防火墙开启时 |
| 为节点所在机器做 DHCP 地址保留 | 可选；省去 DNS 记录更新 |

一步都不做时，媒体和今天完全一样经 tunnel 传输，什么都不会坏。

### 可行性和复杂度

| 部分 | 可行性 | 复杂度 | 难点 |
|---|---|---|---|
| 局域网监听端口：`/m/*`、探测、CORS、只绑私有地址、证书热替换 | 可行 | 低 | 在第二个服务器后面复用媒体处理逻辑 |
| 由控制面负责的域名、DNS 记录和 ACME DNS-01 | 可行 | 中 | Worker 里的 ACME 客户端；有效期缩短后的续期；地址变化 |
| 发现、探测、`network` 状态，以及两个引擎里的流源 | 可行 | 中 | 各浏览器的 Local Network Access 状态；每个 URL 都要按流的源解析 |
| 能力描述的细节和可播放性辅助函数 | 可行 | 中 | 编码 profile 和 HDR 因浏览器和系统而异 |
| 局域网上的 Plex 直接播放和直接串流 | 可行 | 低到中 | Plex 复制 HEVC 时是否写 fMP4 分片，Apple 的 HLS 规则要求这样 |
| 节点通过流复制重新封装 Matroska | 可行 | 中到高 | 跳转：在关键帧处重启 ffmpeg 并换算位置 |
| 局域网上的 yt-dlp | 可行 | 低 | 只改上限和编码列表 |
| 经恢复流程回退 | 可行 | 低到中 | 区分局域网故障和上游故障 |
| 连着家里 Wi-Fi 的车 | 未知 | 权限可用时为低 | 特斯拉浏览器对 Local Network Access 的处理，只能在车上测 |
| Yolo 运营的 plex.direct 式服务 | 可行，但不提议 | 高 | 频率限制放宽、权威 DNS、签发服务，以及成为每个用户都依赖的常驻服务 |

<a id="how-plex-jellyfin-and-emby-do-it"></a>

## Plex、Jellyfin 和 Emby 的做法

**Plex** 要解决的问题和 Yolo 一样，因为 Plex Web 也来自公网 HTTPS 源：

- **域名和证书。**每台服务器以 `https://{IP-description}.{identifier}.plex.direct:{port}` 访问，其中地址部分是“a `-` separated string of the IPv4 or IPv6 address components”（[Plex Media Server API](https://developer.plex.tv/pms/)）。Plex 的 DNS 对任何这类域名都回答其中编码的地址，每台服务器持有一张对应自己 identifier 的通配符证书。证书在 2015 年推出时来自 DigiCert，如今来自 Let's Encrypt（[安全连接](https://support.plex.tv/articles/206225077-how-to-use-secure-server-connections/)、[Valsorda，2015](https://words.filippo.io/how-plex-is-doing-https-for-all-its-users/)）。
- **发现。**客户端向 plex.tv 请求服务器的连接列表（`/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`）。每条连接有 `uri` 以及 `local` 和 `relay` 两个标记，“connections labeled as `local` should be preferred over those that are not, and `relay` should only be used as a last resort”（[API](https://developer.plex.tv/pms/)）。已发布的 Plex Web 4.162 并行测试每条直连，只有全部失败时才试中继；这是从它的代码里读出来的，并非文档所述。原生应用还通过 UDP 32410、32412、32413 和 32414 端口上的 GDM 组播在局域网里找服务器（[网络](https://support.plex.tv/articles/200430283-network/)），浏览器用不了这个。
- **回退。**先是经端口转发的远程访问，再是 Plex Relay，后者对所有订阅用户都限制为每个流 2 Mbps（[中继](https://support.plex.tv/articles/216766168-accessing-a-server-through-relay/)）。
- **DNS rebinding。**Plex 的文档说明，路由器的 rebinding 防护可能阻断局域网内的安全连接，并让用户放行 `plex.direct`，例如在 dnsmasq 里写 `rebind-domain-ok=/plex.direct/`，在 Unbound 里写 `private-domain: "plex.direct"`（[安全连接](https://support.plex.tv/articles/206225077-how-to-use-secure-server-connections/)）。
- **Local Network Access。**从 Chrome 142 起，Plex Web 会请求这个权限。用户拒绝时，Plex Web 改为远程连接（[Plex 论坛，2025-11-06](https://forums.plex.tv/t/important-note-about-the-plex-web-app-local-network-access/933264)），而从 2025-04-29 起远程播放需要 Plex Pass 或 Remote Watch Pass（[远程播放](https://support.plex.tv/articles/requirements-for-remote-playback-of-personal-media/)）。
- **决策。**Direct Play 原样发送文件；Direct Stream 重新封装，可以只转换音频；烧录字幕总是需要完整转码（[直接播放和直接串流](https://support.plex.tv/articles/200250387-streaming-media-direct-play-and-direct-stream/)）。服务器根据客户端的 profile 和请求的画质在 `/{transcodeType}/:/transcode/universal/decision` 做决定，参数包括 `directPlay`、`directStream`、`directStreamAudio`、`location`（`lan`、`wan`、`cellular`）和 `X-Plex-Client-Profile-Extra`；原始文件是 `/library/parts/{partId}/{changestamp}/{filename}`（[API](https://developer.plex.tv/pms/)）。“LAN Networks”设置决定哪些客户端算本地（[网络](https://support.plex.tv/articles/200430283-network/)）。

**Jellyfin** 由服务器自己提供网页客户端，所以在家里的浏览器中，页面和媒体同源，常常是纯 HTTP，下面这些浏览器限制都不会出现。HTTPS 默认关闭，交给反向代理；Jellyfin 不提供证书服务（[网络设置](https://jellyfin.org/docs/general/post-install/networking/)）。原生客户端通过向 UDP 7359 端口广播来找服务器。`LocalNetworkSubnets` 决定哪些客户端是本地的，`RemoteClientBitrateLimit` 只对其余客户端生效。客户端发送一份设备 profile，jellyfin-web 用 `canPlayType` 构建它（`browserDeviceProfile.js`），服务器的 `StreamBuilder` 在直接播放、直接串流（视频不动）和转码之间选择（[转码](https://jellyfin.org/docs/general/post-install/transcoding/)）。

**Emby** 的 Emby Connect 只帮设备找到服务器；每条连接都是直连（[Emby Connect](https://emby.media/support/articles/Emby-Connect.html)）。域名和证书由用户自己准备（[保护你的服务器](https://emby.media/support/articles/Secure-Your-Server.html)）。托管在 `https://app.emby.media` 的应用连不上没有 HTTPS 的服务器，因为浏览器会拦截混合内容，Emby 给的建议是改用纯 HTTP 打开这个应用（[连接问题](https://emby.media/support/articles/Connectivity.html)）。

Yolo 采用 Plex 的形态（私有地址的公网域名、真实证书、探测和回退），因为它的页面同样在公网 HTTPS 源上。它采用 Jellyfin 的设备 profile 来做可播放性判断。它不需要 Plex 的任何中心化服务，因为每个用户本人都已有域名区。

## 浏览器限制

以下内容核对于 2026-10-12，当时 Chrome 稳定版是 156，Firefox 是 157，Safari 是 27。

- **混合内容。**HTTPS 页面不能播放来自公网域名的纯 HTTP 媒体。Chrome 把音视频升级为 HTTPS，且不回退（[chromestatus](https://chromestatus.com/feature/5557268741357568)）；Firefox 127 对图片、音频和视频做同样的事（[Firefox 127](https://www.firefox.com/en-US/firefox/127.0/releasenotes/)）；Safari 18 升级所有图片和媒体（[WebKit](https://webkit.org/blog/15443/)）。所以节点需要带该域名证书的 HTTPS。
- **Chrome 的 Local Network Access。**从 Chrome 142 起，公网站点发往“reserved for local use”地址的请求要等权限提示（[Chrome](https://developer.chrome.com/blog/local-network-access)、[chromestatus](https://chromestatus.com/feature/5152728072060928)）。地址空间由解析出的 IP 决定，所以解析到 `192.168.x.x` 的公网域名即使用有效的 HTTPS 也算本地。它覆盖 `fetch()`、子资源和 iframe 导航，从 Chrome 147 起还覆盖 WebSocket 和 WebTransport。用户的选择作为站点设置保存。Chrome 145 把这个权限拆成 `local-network` 和 `loopback-network`，并保留 `local-network-access` 作为别名（[chromestatus](https://chromestatus.com/feature/5068298146414592)）。早先 Private Network Access 方案的预检头已经取消，`LocalNetworkAccessAllowedForUrls` 等企业策略可以预先授予权限（[chromestatus](https://chromestatus.com/feature/5197681148428288)）。
- **Chrome 的混合内容豁免**只允许 HTTPS 页面对私有 IP 字面量、`.local` 域名，或带 `targetAddressSpace: "local"` 的 `fetch()` 使用纯 HTTP，并说明“public domain is not exempt from mixed content, even if it resolves to a local network address”（[Chrome](https://developer.chrome.com/blog/local-network-access)）。`<video src>` 和 hls.js 的 XHR 无法声明这个选项，Safari 和 Firefox 也没有这种豁免。
- **Firefox** 在 Firefox 153 为所有用户开启了 Local Network Access，在 154 扩展到 WebSocket（[153](https://www.firefox.com/en-US/firefox/153.0/releasenotes/)、[154](https://www.firefox.com/en-US/firefox/154.0/releasenotes/)）。对私有地址的 HTTPS 请求，它在 TLS 握手成功之后才检查权限（`network.lna.defer_https_check`），所以碰上别的网络里设备的探测，会在任何提示之前就因 TLS 失败。
- **Safari** 没有提供 Local Network Access：WebKit 的相关偏好默认关闭，启用它的 bug 仍未关闭（[WebKit bug 295047](https://bugs.webkit.org/show_bug.cgi?id=295047)）。Apple 的“本地网络”隐私限制（iOS 14 和 macOS 15 及以后）豁免 Safari 和 WebKit 视图，并在用户授权之前阻止其他应用发起本地连接，macOS 上的 Chrome 受此影响。它不管监听和接受入站连接，所以节点的监听端口不需要授权（[TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)）。
- **CORS 和 COEP。**在 `Cross-Origin-Embedder-Policy: credentialless` 下，像 `<video src>` 这样的跨源 `no-cors` 请求不需要 `Cross-Origin-Resource-Policy` 头即可加载，也不带凭据（[MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy)）。hls.js 和 canvas 引擎发的是 `cors` 请求，需要 `Access-Control-Allow-Origin`。单个字节范围在 Chrome 99、Firefox 117、Safari 16 及以后是安全列表里的 `Range` 取值（[MDN](https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_request_header)），`Content-Range` 必须显式暴露。Firefox 从 119 起支持 `credentialless`；Safari 不支持，所以页面在 Safari 里不是跨源隔离的，Safari 通过 `<video>` 播放。
- **车上。**特斯拉的浏览器是 Linux 上的桌面版 Chrome 148（[显示大小](../../implemented/feature/2026-10-11-display-size.zh.md)），所以 Local Network Access 对它适用。Chrome 把这个功能标为需要嵌入方支持，Android WebView 无条件授予它（[chromestatus](https://chromestatus.com/feature/5152728072060928)）；没有任何文档说明特斯拉的浏览器会提示、授予还是拒绝。canvas 引擎在主线程发起请求，所以 Chrome 对 service worker 和 shared worker 的额外规则不适用。设备将在 `env` 事件里报告权限状态和探测结果（[设备遥测](../../implemented/feature/2026-10-11-device-telemetry.zh.md)），车第一次连上家里 Wi-Fi 时就能回答这个问题。

## 浏览器不转码能播放什么

直接播放需要 `<video>` 元素或 Media Source Extensions 接受的容器，以及设备能解码的编码。截至 2026-10-12：

| 格式 | Chrome 和 Edge | Firefox | Safari |
|---|---|---|---|
| MP4（及 fMP4）、WebM | 支持 | 支持 | 支持 |
| Matroska | 从 145 起出现在 Chromium 的媒体类型表里，没有发布说明 | 从 145 起，支持常用编码 | 没有文档 |
| H.264，8 位 | 支持 | 支持，依靠系统解码器 | 支持 |
| HEVC | 从 107 起，在有硬件解码的地方支持；macOS 11 及以后的所有 Mac 都支持 | Windows 从 134 起，macOS 从 136 起，Linux 从 137 起 | 支持 |
| AV1 | 支持 | 支持 | 只在有硬件解码器时：M3 Mac、iPhone 15 Pro、iPhone 16 及以后 |
| VP9 | 支持 | 支持 | 支持 |
| AAC、MP3、FLAC | 支持 | 支持 | 支持 |
| AC-3、E-AC-3 | 不支持（桌面版 Chrome） | 没有一手资料；按不支持处理 | 支持，在 HLS 中 |
| DTS、TrueHD | 不支持 | 不支持 | 不支持 |

来源：MDN 关于[容器](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers)、[视频编码](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs)和[音频编码](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs)的页面；[Chrome 的 HEVC](https://chromestatus.com/feature/5186511939567616)；Firefox [134](https://www.mozilla.org/en-US/firefox/134.0/releasenotes/)、[136](https://www.mozilla.org/en-US/firefox/136.0/releasenotes/)、[137](https://www.mozilla.org/en-US/firefox/137.0/releasenotes/) 和 [145](https://www.mozilla.org/en-US/firefox/145.0/releasenotes/)；[Safari 17 的 AV1](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/)；Chromium 的[媒体类型表](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/base/mime_util_internal.cc)和 [AC-3 编译开关](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/media_options.gni)；以及 Apple 的 [HLS 制作规范](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices)。浏览器对 10 位 H.264（High 10）的支持没有文档，所以按不支持处理。

可播放性辅助函数据此得出四种结果：

- **直接播放：**编码设备能解码的 MP4 或 WebM，按字节范围提供。在 Chrome 给出文档、Safari 支持之前，Matroska 一律重新封装。
- **重新封装：**设备不接受容器、但能解码编码。ffmpeg 的流复制改变容器时“with no quality loss”，但“might not work in some cases”（[ffmpeg](https://ffmpeg.org/ffmpeg.html)）。节点用 `-hls_segment_type fmp4` 写 HLS（[格式](https://ffmpeg.org/ffmpeg-formats.html)）；复用器在 `hls_time` 之后“on the next key frame”切分片，而 Apple 要求每个分片都以 IDR 帧开头，并要求 HEVC 用 fMP4 而不是 MPEG-TS 承载。
- **只转音频：**复制视频，把音频转成 AAC，用于 DTS、TrueHD，以及 Safari 以外的 AC-3 或 E-AC-3。
- **转码：**设备不能解码的视频（Chrome 在没有硬件解码器时的 HEVC、较旧 Apple 设备上的 AV1、10 位 H.264）、需要烧录的图形字幕（PGS 或 VobSub，因为浏览器只绘制 WebVTT），或者码率超过链路能承受的范围。

车上的能力描述是 canvas 上的 720p H.264 和 AAC，所以它只对本来就在这个范围内的片源直接播放，例如许多 yt-dlp 格式。其他情况下，局域网路径能为车省掉 tunnel 这一跳，但省不掉转码。

<a id="certificates-for-a-private-address"></a>

## 私有地址的证书

- **不能为地址本身签证书。**Baseline Requirements 规定“CAs SHALL NOT issue Certificates containing Internal Names or Reserved IP Addresses”（[BR §4.2.2](https://github.com/cabforum/servercert/blob/main/docs/BR.md)），而 Let's Encrypt 只用 HTTP-01 或 TLS-ALPN-01 验证 IP 地址证书（[Let's Encrypt](https://letsencrypt.org/2025/07/01/issuing-our-first-ip-address-certificate)）。节点需要一个 DNS 域名。
- **DNS-01** 可以“validate domain names whose webservers aren't exposed to the public internet”（[验证方式](https://letsencrypt.org/docs/challenge-types/)）。
- **有效期不断缩短。**Let's Encrypt 的默认 profile 签发 90 天证书；45 天的 `tlsserver` profile 从 2026-05-13 起可用；默认有效期在 2027-02-10 降到 64 天，在 2028-02-16 降到 45 天（[从 90 天到 45 天](https://letsencrypt.org/2025/12/02/from-90-to-45)、[profile](https://letsencrypt.org/docs/profiles/)）。CA/Browser Forum 把每张公共证书的有效期上限定为：2026-03-15 起 200 天，2027-03-15 起 100 天，2029-03-15 起 47 天（[SC-081](https://cabforum.org/2025/04/11/ballot-sc081v3-introduce-schedule-of-reducing-validity-and-data-reuse-periods/)）。所以续期从一开始就自动进行，而遵循 ACME Renewal Information 的续期不受频率限制（[频率限制](https://letsencrypt.org/docs/rate-limits/)）。
- **频率限制**是每个注册域名每 7 天 50 张证书，注册域名按 Public Suffix List 确定（[频率限制](https://letsencrypt.org/docs/rate-limits/)）。一个用户为一个域名续期远远碰不到它。多个用户共用的域名则需要 Let's Encrypt 放宽限制，因为这个列表不接受“whose sole purpose is to circumvent rate limits of third parties”的条目（[准则](https://github.com/publicsuffix/list/wiki/Guidelines)）。
- **Cloudflare** 只对指向私有地址的代理记录写明了限制（[私有源站](https://developers.cloudflare.com/dns/private-origins/troubleshooting/)），所以这条记录保持仅 DNS。API token 的范围以域名区为单位，运行时限制只涉及客户端地址和有效期，不涉及具体记录（[创建 token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)、[限制 token](https://developers.cloudflare.com/fundamentals/api/how-to/restrict-tokens/)）。Cloudflare 的 Origin CA 证书“only encrypt traffic between Cloudflare and your origin server”，所以浏览器不信任它们（[Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)）。
- **DNS rebinding 防护**会丢弃指向私有地址的公网解析结果。OpenWrt 默认开启 `rebind_protection`，用 `rebind_domain` 加白名单（[OpenWrt](https://openwrt.org/docs/guide-user/base-system/dhcp)）；pfSense 的防护“active by default”，用 `private-domain` 或 `rebind-domain-ok` 加白名单（[pfSense](https://docs.netgate.com/pfsense/en/latest/services/dns/rebinding.html)）；OPNsense 同样过滤，用 Unbound 的私有域名作白名单（[OPNsense](https://docs.opnsense.org/manual/unbound.html)）；FRITZ!Box 按主机名添加例外（[FRITZ!Box](https://uk.fritz.com/service/knowledge-base/dok/FRITZ-Box-5590-Fiber/3565_The-FRITZ-Box-reports-Your-DNS-rebind-protection-rejected-your-query-for-reasons-of-security/)）。用户本人把节点的域名或整个域名区加入白名单。
- **公共通配符 DNS 服务**，例如 [sslip.io](https://sslip.io/)，会回答内嵌地址的域名；[local-ip.sh](https://local-ip.sh/) 公开了它通配符证书的私钥供任何人使用，任何人都能冒充它下面的每个域名。

## 曾考虑的替代方案

**浏览器直接从 Plex 取流**，经 Plex 自己的 `plex.direct` URL。页面会拿到能管理整个 Plex 服务器的 Plex token；客户端要带上 Plex 的 URL 和认证方式，违背了不认识服务商的客户端；Plex 的地址同样需要 Local Network Access 权限；Yolo 的媒体 token、会话过期和进度也都用不上。节点通常就在 Plex 所在的机器上，代理原文件只花一次本机回环的复制。

**经 Chrome 的混合内容豁免，用纯 HTTP 访问节点的私有 IP 地址。**它只在 Chrome 里、只对 `fetch()` 或 IP 字面量 URL 有效，仍需要 Local Network Access 权限。Safari 和 Firefox 会升级或拦截这个请求，媒体 token 也会在局域网里明文传输。

**节点上用私有证书颁发机构或自签名证书。**每台设备都得信任这个颁发机构，车做不到，而且装进设备的根证书可以对该设备冒充任何网站。

**sslip.io 或 nip.io 这类公共通配符 DNS 服务。**每个用户的局域网播放都会依赖第三方的 DNS，而同时发放共享通配符证书的服务会公开证书私钥，任何人都能冒充该域名（[证书](#certificates-for-a-private-address)）。

**现在就运营 Yolo 的 plex.direct 式服务。**1.0 的每个用户都已有 Cloudflare 域名区，无需 Yolo 运营任何服务就能得到同样的结果。只有和[不依赖 Cloudflare 的自托管](../architecture/2026-10-07-self-hosting-without-cloudflare.zh.md)一起，这个服务才值得它的代价。

**在节点上跑 ACME，把域名区 token 放进 `.env`。**这样更简单：有维护良好的 Node ACME 客户端，也不用新增内部端点。但它把能编辑整个域名区的凭据放到家里的机器上，而每个节点插件都能读 `.env`（[插件信任模型](../../implemented/architecture/2026-10-11-plugin-architecture.zh.md)）。由控制面跑 ACME 时，节点只持有它自己那一个域名的私钥。

**为局域网子域名签通配符证书**（`*.lan.haitian.site`）。节点只需要一个域名，只签这一个域名的证书能让被盗的私钥只对这个域名有用。

**探测之前先比对公网地址。**节点得先知道自己的公网地址，经 IPv6 访问 Cloudflare 的设备和经 IPv4 被看到的节点对不上，而且仍然需要探测。

**页面和节点之间用 WebRTC 数据通道。**它不需要证书、DNS 域名或路由器例外。但每个引擎都要写自定义加载器，Safari 的原生 HLS 用不了它，节点需要 WebRTC 协议栈，而且 Chrome 计划把 WebRTC 也纳入 Local Network Access（[chromestatus](https://chromestatus.com/feature/5065884686876672)）。

**像 Jellyfin 那样，在局域网里由节点提供播放器。**第二个源需要自己的设备凭据、自己的跨源隔离和一条跨源的实时通道，而且用户本人的 passkey 绑定在控制面的域名上。

**在一个流播放到一半时切换到局域网路径。**它最多省下一个流剩余部分的 tunnel 流量，却要付出一次用户本人没有要求的重建；下一个流反正会走局域网路径。

## 验收标准

在用户本人家里的 Wi-Fi 上，配置好 `LAN_DNS_TOKEN`，并为每块屏幕打开“通过家庭网络播放”：

- Mac 上的 Chrome 和 Safari、iPhone 上的 Safari 以及 Firefox，都从局域网源以原始分辨率和码率播放一部以 H.264 和 AAC 存成 MP4 的 Plex 影片。Plex 里没有它的转码会话，Workers Logs 里也没有它的会话的 `/m/*` 请求。
- 一部视频为 H.264 的 Matroska 影片通过 Plex 的直接串流播放，视频按 Plex 的决策报告被复制。
- 在片源和设备允许时，yt-dlp 条目以高于 4.8 Mbps 的码率播放。
- 局域网播放中关掉 Wi-Fi，播放经 tunnel 在同一位置继续。
- 拒绝了 Local Network Access 的浏览器、丢弃该域名的路由器和过期的证书，都让播放留在 tunnel 上，设置页显示原因。
- 证书续期不需要重启节点。
- 车要么从局域网源播放，要么报告让它留在 tunnel 上的权限状态和探测结果。
- `git grep -niE "plex|yt-?dlp|youtube" -- service/` 的命中文件和之前相同。

## 风险

安全方面：

- **家里机器上多了一个监听端口。**局域网里的每台设备，包括访客设备和智能家居设备，都能连到它。它只提供 token 授权的媒体和探测接口，只绑定私有 IPv4 地址，拒绝私有地址段以外的对端和其他 `Host` 名的请求，也不提供 HTML。媒体处理逻辑里的漏洞从此在局域网上就能触及，而不仅仅经 Worker。
- **域名区凭据。**`LAN_DNS_TOKEN` 能编辑域名区里的每条记录，因为 Cloudflare 按域名区而不是按记录限定 API token 的范围。它和 Worker 的其他 secret 放在一起，而那些 secret 失窃本来就等于全面失守。
- **节点的私钥**被盗后，窃取者可以在任何网络上冒充节点的域名。这个域名在 passkey 依赖方之外，也设置不了 `__Host-` 会话 cookie。它与控制面同站（same-site），所以用户本人的路由必须继续检查确切的源，而不是站点。
- **权限范围很宽。**Local Network Access 向控制面的源开放整个局域网，而不只是节点，所以注入页面的脚本可以扫描家庭网络。页面的内容安全策略以及不加载第三方脚本是防线。
- **会公开的内容：**A 记录公开节点的私有地址，证书透明度日志公开它的域名。
- **媒体 token** 在两个源上都有效，所以泄露的 URL 在其会话结束之前也能从局域网播放，和今天经 Worker 播放一样。

其他风险和代价：

- 车可能永远拿不到这个权限，那它的局域网路径就一直用不上。
- 很多用户不知道怎样在路由器上添加 rebinding 例外，于是他们的局域网路径一直关着；设置页必须说明原因。
- 两条媒体路径让播放问题的可能来源翻倍，所以遥测必须记录每个流由哪个源提供。
- 流复制重新封装只能在关键帧处切分片，所以关键帧稀疏的文件跳转粒度粗。
- 弱 Wi-Fi 上播放高码率原文件，会在自适应控制器降到转码之前卡顿。
- 对 yt-dlp 条目，节点仍经家里的线路下载，家里下行慢的话依然慢。
- DHCP 地址变了之后，DNS 记录要等节点下一次报告和记录的 TTL 过后才会跟上。
- 证书过期会关闭局域网路径，直到控制面续期；播放继续经 tunnel 进行。
- 这个提案改变了一条现行规则：今天每个 `/m/*` 请求都是同源的，[canvas 引擎](../../implemented/architecture/2026-04-04-canvas-playback-engine.zh.md)记录和根目录的 `AGENTS.md` 都这样写。实现时要同时更新两者。
