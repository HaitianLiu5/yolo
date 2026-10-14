# Agent Note: 在局域网内直接从家里的节点播放

Status: implemented

[English](2026-10-12-lan-direct-play.md) | 中文

## 问题

在家里用浏览器经控制面播放 Yolo 时，每个媒体字节都要经过 Cloudflare。节点经 cloudflared tunnel 把它从家里的线路上传出去，Worker 再转发，最后又从同一条线路下载回来（[同源透传](../architecture/2026-10-07-same-origin-media-passthrough.zh.md)、[Workers VPC](../architecture/2026-10-08-workers-vpc-node-access.zh.md)）。所以家里的上行带宽限制了画质：节点的上限是 4.8 Mbps（`STREAM_MAX_VIDEO_BITRATE_KBPS`），而且 Plex 插件对每个条目都向 Plex 请求不超过这个码率的 720p 流，所以即使文件就在同一台机器上、浏览器也能解码原文件，更大的文件仍会被转码（[片源插件 API](../architecture/2026-10-11-source-plugin-api.zh.md)）。Plex 自己的应用在家庭网络里直接播放这样的文件。这段绕行还让家里的播放也受制于 Cloudflare 对代理视频的条款（[媒体流离开 Worker](../architecture/2026-10-13-media-off-the-worker.zh.md)）。

播放器页面来自控制面的公网 HTTPS 源，并且跨源隔离（[canvas 引擎](../architecture/2026-04-04-canvas-playback-engine.zh.md)），所以访问局域网里节点的请求，是一个从公网站点发往私有地址的跨源请求，浏览器会限制这类请求。具体服务商的名字必须留在核心、控制面和节点之外（[插件架构](../architecture/2026-10-11-plugin-architecture.zh.md)）。

## 决策

在节点所在网络里的设备直接从节点取媒体，能解码时播放原文件；其他地方，以及局域网路径出问题的任何时候，都走下一条媒体路径：远程直连，然后是用户本人打开时的中转（[媒体流离开 Worker](../architecture/2026-10-13-media-off-the-worker.zh.md)）。做法与 Plex 相同：一个解析到节点私有地址的公网域名、这个域名的公共受信证书，以及一个先探测该域名、不通就走别的路径的客户端。每个用户本人都用自己的 Cloudflare 域名区；Yolo 不运营 plex.direct 式的服务。任何设备都不需要私有证书颁发机构或浏览器开关。

这修改了一条现行规则：客户端与每个 `/m/*` 请求同源，节点的媒体源除外——局域网源和远程源——它们带着跨源隔离页面接受的 CORS 头作答。路径里的媒体 token 仍是唯一的凭据，局域网 URL 就是局域网源下同样的 `/m/{token}/…` 路径。

### 局域网监听端口

控制面为它命名并装上该域名的证书之后，[`service/node/src/lan.js`](../../../../service/node/src/lan.js) 运行第二个 HTTPS 监听端口，它和远程监听端口用同一个模块构建（[`edge.js`](../../../../service/node/src/edge.js)）：

- 它只绑定这台机器的私有 IPv4 地址：有线或 Wi-Fi 网卡上的第一个 RFC 1918 地址（跳过隧道和虚拟网卡），或者 `LAN_ADDRESS`。端口是 `LAN_PORT`（9443；设为 0 关闭监听）。节点每 60 秒检查一次自己的地址，DHCP 换了地址时把监听移过去。
- 它通过同一条媒体流水线服务 `/m/{token}/…` 下的 `GET` 和 `HEAD`、`OPTIONS` 预检，以及 `GET /edge/probe`（`{ ok, name, path }`，不带 token；`/lan/probe` 为 0.5 之前的播放器回答 `{ ok, name }`），别的都不服务：内部 API 仍在 `127.0.0.1:9191`，用户本人的配对码仍只在 Unix socket 上。
- 它只回答 `Host` 和 TLS 服务器名都是自己域名的请求（否则回 421），从而挡住针对它的 DNS rebinding；也只回答私有、链路本地或回环地址的对端。
- 每个响应都带 `Access-Control-Allow-Origin`（值为控制面的 `PUBLIC_ORIGIN`）、`Access-Control-Expose-Headers`（`Content-Range`、`Accept-Ranges`、`Content-Length`、`ETag`、`X-Yolo-Error-Code`）、`Timing-Allow-Origin`、`Cross-Origin-Resource-Policy: cross-origin`、`X-Content-Type-Options: nosniff` 和 `Content-Security-Policy: default-src 'none'; sandbox`。响应的内容类型从不是 HTML 或 XML。预检允许 `Range`。
- 节点在 `<runtime>/.lan/`（git 忽略）下保存一把 ECDSA P-256 私钥，并为它唯一的域名生成证书请求（[`lan-csr.js`](../../../../service/node/src/lan-csr.js)）；私钥从不离开节点。新的证书链经过与私钥和域名的核对，用 `setSecureContext()` 换上，无需重启。

内部 API 增加 `PUT /internal/v1/lan`（`{ name, allowOrigin }`，返回监听端口的状态和一份证书请求）和 `PUT /internal/v1/lan/certificate`（`{ name, chain }`），`/internal/v1/health` 报告 `lan: { enabled, port, address, name, origin, listening, notBefore, notAfter, error }`（[节点内部 API](../architecture/2026-10-07-node-internal-api.zh.md)）。

### 域名、记录和证书

Worker secret `MEDIA_DNS_TOKEN` 是用户本人唯一要提供的输入：一个 Cloudflare API token，对容纳 `PUBLIC_ORIGIN` 主机名的域名区有 Zone Read 和 DNS Edit 权限（它在 0.5 之前的名字 `LAN_DNS_TOKEN` 在下一个版本之前仍会被读取）。没有它，下面的一切都不运行。有了它，[`service/control/src/edge/lan.js`](../../../../service/control/src/edge/lan.js) 由 Worker 的 cron trigger 每 5 分钟运行一次，用户本人在设置里按 **Check now**（立即检查）时也运行：

1. **域名区和域名。**它找出 token 能读取的、包含页面主机名的最具体的域名区，并只为节点命名一次：`yolo-lan-<8 位十六进制>.<域名区>`，例如 `yolo-lan-3f9a01c2.example.com`。等于或位于 passkey 依赖方主机名（`yolo.example.com`）之下的域名会被拒绝，因为 WebAuthn 允许子域名上的页面把父域名用作依赖方 ID。会话 cookie 是 `__Host-` cookie，兄弟主机无法设置或覆盖它们。
2. **节点。**它通过 `nodeFetch()` 发送带域名和 `PUBLIC_ORIGIN` 的 `PUT /internal/v1/lan`；节点回答它的私有地址、证书的有效期和一份证书请求。
3. **记录。**它维护一条从该域名指向这个地址的仅 DNS（不代理）A 记录，TTL 60 秒，节点报告新地址时随之更新。
4. **证书。**节点没有这个域名的证书，或者证书有效期已过去三分之二时，它用 DNS-01 完成一次 ACME 订单（[`acme.js`](../../../../service/core/src/acme.js)，Worker 与节点共用的 ACME 客户端：WebCrypto、ES256、不留联系地址），写入 `_acme-challenge` TXT 记录，最多等一分钟让公网 DNS 能查到它，验证后删除它，再通过 `nodeFetch()` 把证书链发给 `PUT /internal/v1/lan/certificate`。签发失败后先等 30 分钟再试，每次加倍，最长一天。

`LAN_ACME_DIRECTORY` 指定 ACME 服务器：`wrangler.jsonc` 里是 Let's Encrypt 的正式目录；变量未设置时用它的 staging 目录，那里的证书浏览器不接受。状态是 `OAUTH_KV` 里的一个 KV 值 `yolo:lan`，包括 ACME 账号的私钥；有变化时写入，否则每小时写一次。`GET /v1/owner/media` 把它（去掉私钥）和其他媒体路径一起显示给已登录的用户本人，`POST /v1/owner/media/check` 立即执行上述步骤（`/v1/owner/lan` 和 `/v1/owner/lan/check` 为 0.5 之前的播放器保留）（[v1 HTTP API](../architecture/2026-10-07-v1-http-api.zh.md)）。

域名会出现在证书透明度（Certificate Transparency）日志里，A 记录会公开节点的私有地址。两者透露的都不超过一个家庭局域网地址。

### 发现和流的路径

- 只要最近一次检查发现节点在监听且证书有效，Hub 的 `welcome` 就在 `media.paths` 里列出 `{ path: "lan", origin, notAfter }`，并为 0.5 之前的播放器把同样的内容放在 `lan` 里（[Hub 和实时通道](../architecture/2026-10-07-hub-and-realtime-channel.zh.md)）。
- 设置里的 **Play over the home network**（通过家庭网络播放）按屏幕设置（[`clients/player/src/media-paths.js`](../../../../clients/player/src/media-paths.js)）。在用户本人打开它之前，屏幕从不探测，所以浏览器的 Local Network Access 提示出现在用户本人预期的时候；如果浏览器已经授予 Chrome 的 `local-network` 权限，这块屏幕在用户本人关掉之前算作已打开。
- 屏幕探测 `GET {origin}/edge/probe`，并同时探测远程源：收到 welcome 时、浏览器触发 `online` 事件时、一条流失败 30 秒后（超时 2 秒），以及用户本人打开开关或按 **Check** 时（超时 60 秒，给浏览器的提示留出时间）。权限被拒绝时，或者在从未连到节点的屏幕上权限仍待询问时，自动探测不发请求，所以提示不会自己冒出来。
- 探测有回答时，屏幕先于任何其他路径选择 `lan`；选择变化时，以及每次 welcome 之后一次，屏幕发送 `{ v: 1, type: "network", path, reason, probes }`；它自己的播放请求在 `network` 里带上路径。Hub 按设备保存最新值（`network:<deviceId>`）；只有设备自己的请求能设置它，别人的请求不能。
- Hub 在 `prepare` 中传入 `network`。只有在监听端口正常服务时，节点才走局域网路径；这时它的上限是 `LAN_MAX_VIDEO_KBPS`（默认 200,000，高于任何光盘原盘），而不是经过家里上行带宽的那些路径的上限（[自适应码率](2026-10-11-adaptive-quality.zh.md)），仍会被设备的[自适应码率上限](2026-10-11-adaptive-quality.zh.md)压低，插件的 prepare 上下文里带 `network` 和 `playable()`。流描述带 `network`（实际走的路径）和 `origin`（监听端口的源，走中转时为 null）。
- 设备把流的每个流、播放列表、分片和字幕 URL 都按流的源解析；节点的播放列表使用绝对路径，会按播放列表自己的源解析。canvas 引擎在所有源上都用查询参数 `prefetch=1` 标记预读，因为自定义请求头会让每个局域网分片请求都要等预检；`<video>` 引擎用 `crossorigin="anonymous"` 加载（[两个引擎](../architecture/2026-10-12-two-playback-engines.zh.md)）。
- 播放过程中变得可达的设备保留当前的流；局域网路径从下一个流开始生效：新条目、跳到流之外、清晰度或音轨字幕变化，或者恢复。

### 播放原文件

节点核心回答插件的 `playable(media)`：一份不涉及服务商的描述 `{ container, video: { codec, profile, bitDepth, hdr, width, height }, audio: [{ codec, channels }], kbps }`，与设备的能力描述和流的上限比较（[`media/playable.js`](../../../../service/node/src/media/playable.js)）。它回答 `direct`（容器和编码都能原样播放）、`remux`（只有容器不行）、`audio`（只有音频不行）或 `transcode`（视频编码、高于 8 位的位深、HDR、超过 `maxHeight` 的高度，或超过上限的码率），并列出每个原因。能力描述增加 `containers`（每个能播放的 profile 都是 `mp4`）；`<video>` 的能力描述在浏览器能播放时加入 `flac`、`ac-3` 和 `ec-3`，`maxHeight` 按显示屏取 720、1080、1440 或 2160。车上的能力描述仍是 canvas 上的 720p H.264 和 AAC（[能力协商](../architecture/2026-10-07-capability-negotiation.zh.md)）。

| 片源 | 走其他路径 | 在局域网上 |
|---|---|---|
| Plex | 车：Plex 转码器按 720p、最高 4.8 Mbps 转码；`directStream=1` 会复制符合这些限制的视频。远程直连播放上的 `<video>` 设备得到局域网一栏所述的直接串流，画面大小在远程上限能承载的范围内取设备的；走中继时是车的 720p（[能力协商](../architecture/2026-10-07-capability-negotiation.zh.md)） | **直接播放（direct play）：**`playable()` 回答 `direct`、没有烧录字幕、选中的音频就是文件的默认音频时，插件把 Plex 的原始文件（`/library/parts/{id}/{changestamp}/{file}`）作为带 `cache: false` 的 `file` Input 返回，节点按字节范围代理。**直接串流（direct stream）：**否则，`<video>` 设备得到 Plex 的通用转码器，画面大小是设备的（按 `maxHeight` 取 16:9），`maxVideoBitrate` 是流的上限，所以 Plex 复制符合条件的视频、只转换其余部分；必须转码时目标码率最高 20 Mbps。车仍用固定的 720p 转码 |
| yt-dlp | 不转码：节点代理或拼接在路径上限内（默认远程直连播放 20 Mbps、中继 4.8 Mbps）最高到设备高度选出的格式 | 在局域网上限下做同样的选择，这个上限允许在设备高度内选码率更高的格式。节点仍从互联网下载；局域网路径省掉的是上行带宽和经 Cloudflare 的往返 |

浏览器从不访问 Plex：token 作为请求头从节点发给 Plex，设备只看到 `/m/…` URL。Plex 通常就跑在节点所在的机器上（`PLEX_URL` 默认是 `http://localhost:32400`），所以代理只花一次本机回环的复制；媒体 token、会话过期、停止和进度仍归 Yolo 管。

### 回退

- 没有局域网源、开关关闭、权限被拒绝或探测失败：设备走下一条媒体路径。
- 局域网流的任何恢复（引擎错误、跳转卡住、画面冻结、流加载失败）都先把屏幕移到下一条路径：远程直连的探测有回答时走远程直连，否则在中转打开时走中转。它发送 `network`，记录 `media_path_fallback`，恢复自己的请求也要求那条路径，所以在同一位置的重建经那条路径、按它的上限进行，原文件超过上限时插件改为转码。30 秒后屏幕再次探测。车上 canvas 引擎最多 210 秒的缓冲通常能盖住这次切换。
- Wi-Fi 比原文件慢：自适应码率控制器降低上限，插件改为转码，仍经局域网提供。

### 遥测

Workers Logs 显示每个流走了哪条路径，以及局域网尝试为什么失败（[设备遥测](2026-10-11-device-telemetry.zh.md)）：

- `path: "lan"` 的设备事件 `media_probe` 带 `outcome`、`trigger`、`elapsedMs`、`permission`（Chrome 的 `local-network` 状态，或 null）和局域网的 `host`。结果有：`ok`；`off`（开关关着，所以没有探测）；`timeout`（没有及时应答：在别的网络上，或被防火墙拦下）；`permission_denied`；`permission_prompt`（权限仍待询问，或提示被关掉）；`certificate`（welcome 里的证书已过期）；`dns_rebinding`（权限已授予、证书有效，却很快失败：域名没有到达节点，通常是路由器的 rebinding 防护丢弃了它的私有地址解析结果）；以及 `http_<status>`。
- 设备事件 `media_path_fallback` 带 `from: "lan"`、移到的路径 `to`、失败错误的 `code` 和 `message` 以及 `position`；`stream_selected` 带 `network`、`mediaHost` 和 `original`（片源的原文件）。
- Hub 为每次 prepare 记录 `event: "stream"`（`sessionId`、`deviceId`、`reason`、`requester`、`asked`、`network`、`deliveryType`、`maxVideoKbps`），其中 `network` 是节点实际提供的路径；每次报告记录 `event: "network"`。
- 控制面记录 `kind: "lan"`，其 `event` 为 `"certificate"`、`"address_changed"` 或 `"error"`（`step`、`message`、`failures`、`retryAt`）。

### 用户本人需要做的设置

| 步骤 | 何时需要 |
|---|---|
| 一个对该域名区有 Zone Read 和 DNS Edit 权限的 Cloudflare API token，存为 Worker secret `MEDIA_DNS_TOKEN` | 一次，必需 |
| 在 Yolo 设置里为这块屏幕打开 **Play over the home network** | 每块屏幕一次 |
| 在 Chrome 和 Firefox 里允许该站点的 Local Network Access | 每个浏览器一次，在浏览器提示时 |
| 在 macOS 的系统设置、隐私与安全性、本地网络里允许 Chrome | 每台 Mac 一次，在系统提示时 |
| 在路由器的 DNS rebinding 防护里把该域名或整个域名区加入白名单 | 只在路由器过滤私有地址解析结果时 |
| 在 macOS 防火墙里允许节点 | 只在防火墙开启时 |
| 为节点所在机器做 DHCP 地址保留 | 可选；省去 DNS 记录更新 |

一步都不做时，媒体走其他路径，什么都不会坏。设置页用文字显示每块屏幕最近一次探测的结果，用户本人在 **Media paths**（媒体路径）下的家庭网络卡片显示域名、地址、证书日期和最近一次错误。

### 没有域名时

局域网直连播放需要区域。没有域名时，控制面不为局域网监听端口取名字，welcome 不列出 `lan` 路径并带上 `domain: false`，每块屏幕的设置用「Needs a domain」代替开关。这时在家的屏幕在路由器能回环到家里公网地址的地方，从远程源（也就是这个地址）播放，它的探测会报告能否回环；否则在用户本人打开中转时走中转（[没有域名时的媒体](2026-10-13-no-domain-deployment.zh.md#media-without-a-domain)）。以纯 HTTP 访问节点的私有地址仍被否决，见下文。

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
- **车上。**特斯拉的浏览器是 Linux 上的桌面版 Chrome 148（[显示大小](2026-10-11-display-size.zh.md)），所以 Local Network Access 对它适用。Chrome 把这个功能标为需要嵌入方支持，Android WebView 无条件授予它（[chromestatus](https://chromestatus.com/feature/5152728072060928)）；没有任何文档说明特斯拉的浏览器会提示、授予还是拒绝。canvas 引擎在主线程发起请求，所以 Chrome 对 service worker 和 shared worker 的额外规则不适用。车第一次连上家里 Wi-Fi 时，它带权限状态和结果的 局域网 `media_probe` 事件就能回答这个问题。

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

`playable()` 的四种结果由此得出：

- **直接播放：**编码设备能解码的 MP4，按字节范围提供。Matroska 从不直接播放，因为 Chrome 没有给出支持的文档，Safari 也不支持。
- **重新封装：**设备不接受容器、但能解码编码。Plex 用它的直接串流完成。ffmpeg 的流复制改变容器时“with no quality loss”，但“might not work in some cases”（[ffmpeg](https://ffmpeg.org/ffmpeg.html)）；它的 HLS 复用器在 `hls_time` 之后“on the next key frame”切分片（[格式](https://ffmpeg.org/ffmpeg-formats.html)），而 Apple 要求每个分片都以 IDR 帧开头，并要求 HEVC 用 fMP4 而不是 MPEG-TS 承载。
- **只转音频：**复制视频，把音频转成 AAC，用于 DTS、TrueHD，以及 Safari 以外的 AC-3 或 E-AC-3。
- **转码：**设备不能解码的视频（Chrome 在没有硬件解码器时的 HEVC、较旧 Apple 设备上的 AV1、10 位视频、HDR）、需要烧录的图形字幕（PGS 或 VobSub，因为浏览器只绘制 WebVTT），或者码率超过流的上限。

车上的能力描述是 canvas 上的 720p H.264 和 AAC，所以它只对本来就在这个范围内的片源直接播放，例如许多 yt-dlp 格式。其他情况下，局域网路径能为车省掉经家里上行带宽的这一跳，但省不掉转码。

<a id="certificates-for-a-private-address"></a>

## 私有地址的证书

- **不能为地址本身签证书。**Baseline Requirements 规定“CAs SHALL NOT issue Certificates containing Internal Names or Reserved IP Addresses”（[BR §4.2.2](https://github.com/cabforum/servercert/blob/main/docs/BR.md)），而 Let's Encrypt 只用 HTTP-01 或 TLS-ALPN-01 验证 IP 地址证书（[Let's Encrypt](https://letsencrypt.org/2025/07/01/issuing-our-first-ip-address-certificate)）。节点需要一个 DNS 域名。
- **DNS-01** 可以“validate domain names whose webservers aren't exposed to the public internet”（[验证方式](https://letsencrypt.org/docs/challenge-types/)）。
- **有效期不断缩短。**Let's Encrypt 的默认 profile 签发 90 天证书；45 天的 `tlsserver` profile 从 2026-05-13 起可用；默认有效期在 2027-02-10 降到 64 天，在 2028-02-16 降到 45 天（[从 90 天到 45 天](https://letsencrypt.org/2025/12/02/from-90-to-45)、[profile](https://letsencrypt.org/docs/profiles/)）。CA/Browser Forum 把每张公共证书的有效期上限定为：2026-03-15 起 200 天，2027-03-15 起 100 天，2029-03-15 起 47 天（[SC-081](https://cabforum.org/2025/04/11/ballot-sc081v3-introduce-schedule-of-reducing-validity-and-data-reuse-periods/)）。在证书有效期过去三分之二时续期，不论有效期是多长，所以有效期缩短时无需任何改动。
- **频率限制**是每个注册域名每 7 天 50 张证书，注册域名按 Public Suffix List 确定（[频率限制](https://letsencrypt.org/docs/rate-limits/)）。一个用户为一个域名续期远远碰不到它。多个用户共用的域名则需要 Let's Encrypt 放宽限制，因为这个列表不接受“whose sole purpose is to circumvent rate limits of third parties”的条目（[准则](https://github.com/publicsuffix/list/wiki/Guidelines)）。
- **Cloudflare** 只对指向私有地址的代理记录写明了限制（[私有源站](https://developers.cloudflare.com/dns/private-origins/troubleshooting/)），所以这条记录保持仅 DNS。API token 的范围以域名区为单位，运行时限制只涉及客户端地址和有效期，不涉及具体记录（[创建 token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)、[限制 token](https://developers.cloudflare.com/fundamentals/api/how-to/restrict-tokens/)）。Cloudflare 的 Origin CA 证书“only encrypt traffic between Cloudflare and your origin server”，所以浏览器不信任它们（[Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)）。
- **DNS rebinding 防护**会丢弃指向私有地址的公网解析结果。OpenWrt 默认开启 `rebind_protection`，用 `rebind_domain` 加白名单（[OpenWrt](https://openwrt.org/docs/guide-user/base-system/dhcp)）；pfSense 的防护“active by default”，用 `private-domain` 或 `rebind-domain-ok` 加白名单（[pfSense](https://docs.netgate.com/pfsense/en/latest/services/dns/rebinding.html)）；OPNsense 同样过滤，用 Unbound 的私有域名作白名单（[OPNsense](https://docs.opnsense.org/manual/unbound.html)）；FRITZ!Box 按主机名添加例外（[FRITZ!Box](https://uk.fritz.com/service/knowledge-base/dok/FRITZ-Box-5590-Fiber/3565_The-FRITZ-Box-reports-Your-DNS-rebind-protection-rejected-your-query-for-reasons-of-security/)）。用户本人把节点的域名或整个域名区加入白名单。
- **公共通配符 DNS 服务**，例如 [sslip.io](https://sslip.io/)，会回答内嵌地址的域名；[local-ip.sh](https://local-ip.sh/) 公开了它通配符证书的私钥供任何人使用，任何人都能冒充它下面的每个域名。

## 曾考虑的替代方案

**浏览器直接从 Plex 取流**，经 Plex 自己的 `plex.direct` URL。页面会拿到能管理整个 Plex 服务器的 Plex token；客户端要带上 Plex 的 URL 和认证方式，违背了不认识服务商的客户端；Plex 的地址同样需要 Local Network Access 权限；Yolo 的媒体 token、会话过期和进度也都用不上。节点通常就在 Plex 所在的机器上，代理原文件只花一次本机回环的复制。

**经 Chrome 的混合内容豁免，用纯 HTTP 访问节点的私有 IP 地址。**它只在 Chrome 里、只对 `fetch()` 或 IP 字面量 URL 有效，仍需要 Local Network Access 权限。Safari 和 Firefox 会升级或拦截这个请求，媒体 token 也会在局域网里明文传输。

**节点上用私有证书颁发机构或自签名证书。**每台设备都得信任这个颁发机构，车做不到，而且装进设备的根证书可以对该设备冒充任何网站。

**sslip.io 或 nip.io 这类公共通配符 DNS 服务。**每个用户的局域网播放都会依赖第三方的 DNS，而同时发放共享通配符证书的服务会公开证书私钥，任何人都能冒充该域名（[证书](#certificates-for-a-private-address)）。

**Yolo 运营的 plex.direct 式服务。**每个用户本人都已有 Cloudflare 域名区，无需 Yolo 运营任何服务就能得到同样的结果；[分发](../../proposed/feature/2026-10-11-distribution-to-other-owners.zh.md)让其他用户也有自己的账号和域名，他们的部署命令可以创建 DNS token。这个服务需要 Let's Encrypt 为其共享域名放宽频率限制，需要能回答编码了 IP 的域名的权威 DNS，需要只签由每个用户的控制面认证的 CSR 的签发服务，还会让 Yolo 成为每个用户续期都依赖的常驻服务。只有和[不依赖 Cloudflare 的自托管](../../proposed/architecture/2026-10-07-self-hosting-without-cloudflare.zh.md)一起，它才值得这个代价。

**在节点上跑 ACME，把域名区 token 放进 `.env`。**这样更简单：有维护良好的 Node ACME 客户端，也不用新增内部端点。但它把能编辑整个域名区的凭据放到家里的机器上，而每个节点插件都能读 `.env`（[插件信任模型](../architecture/2026-10-11-plugin-architecture.zh.md)）。由控制面跑 ACME 时，节点只持有它自己那一个域名的私钥。

**把 ACME 和局域网状态放在 Hub Durable Object 里，用 alarm 续期。**Hub 按用户划分，而节点、它的域名和证书属于整个部署；cron trigger 不需要唤醒任何对象，一个 KV 值就能保存每个 Hub 的 welcome 都要读的状态。

**为局域网子域名签通配符证书**（`*.lan.example.com`）。节点只需要一个域名，只签这一个域名的证书能让被盗的私钥只对这个域名有用。

**探测之前先比对公网地址。**节点得先知道自己的公网地址，经 IPv6 访问 Cloudflare 的设备和经 IPv4 被看到的节点对不上，而且仍然需要探测。

**用纯 HTTP 探测地址字面量，以区分 DNS 失败和 TLS 失败。**这要新增一个明文监听端口，而且只在 Chrome 里有效。很快失败这一结果加上权限状态和耗时，已经能告诉用户本人该查什么。

**不设按屏幕的开关，每个页面都探测。**Chrome 和 Firefox 会在第一次访问时弹出 Local Network Access 提示，用户本人还不知道原因。

**页面和节点之间用 WebRTC 数据通道。**它不需要证书、DNS 域名或路由器例外。但每个引擎都要写自定义加载器，Safari 的原生 HLS 用不了它，节点需要 WebRTC 协议栈，而且 Chrome 计划把 WebRTC 也纳入 Local Network Access（[chromestatus](https://chromestatus.com/feature/5065884686876672)）。

**像 Jellyfin 那样，在局域网里由节点提供播放器。**第二个源需要自己的设备凭据、自己的跨源隔离和一条跨源的实时通道，而且用户本人的 passkey 绑定在控制面的域名上。

**在一个流播放到一半时切换到局域网路径。**它最多省下一个流在别的路径上剩余部分的流量，却要付出一次用户本人没有要求的重建；下一个流反正会走局域网路径。

## 后果

在家里，浏览器以原始分辨率和码率播放 Plex 原文件，Plex 不转码，媒体也不经过 Cloudflare；对浏览器不接受其容器或音频的文件，Plex 的直接串流复制视频；在片源和设备允许时，yt-dlp 条目的码率超过 4.8 Mbps。不在家时，以及局域网路径出问题的任何时候，播放走下一条媒体路径。用户本人唯一要提供的是一个 token，所以安装程序能完成设置。

安全方面的代价：

- **家里机器上多了一个监听端口。**局域网里的每台设备，包括访客设备和智能家居设备，都能连到它。它只提供 token 授权的媒体和探测接口，只绑定私有 IPv4 地址，拒绝本地地址段以外的对端和其他 `Host` 名的请求，也不提供任何文档。媒体处理逻辑里的漏洞从此在局域网上就能触及，而不仅仅经 Worker。
- **域名区凭据。**`MEDIA_DNS_TOKEN` 能编辑域名区里的每条记录，因为 Cloudflare 按域名区而不是按记录限定 API token 的范围。它和 Worker 的其他 secret 放在一起，而那些 secret 失窃本来就等于全面失守。ACME 账号私钥和 OAuth 授权一起放在 KV 里。
- **节点的私钥**被盗后，窃取者可以在任何网络上冒充节点的域名。这个域名在 passkey 依赖方之外，也设置不了 `__Host-` 会话 cookie。它与控制面同站（same-site），所以用户本人的路由继续检查确切的源，而不是站点。
- **权限范围很宽。**Local Network Access 向控制面的源开放整个局域网，而不只是节点，所以注入页面的脚本可以扫描家庭网络。页面不加载任何第三方脚本。
- **会公开的内容：**A 记录公开节点的私有地址，证书透明度日志公开它的域名。
- **媒体 token** 在两个源上都有效，所以泄露的 URL 在其会话结束之前也能从局域网播放，和经 Worker 播放一样。

其他代价：

- 车的浏览器会不会授予 Local Network Access，要等车连上家里 Wi-Fi 才知道；它的 `media_probe` 事件会给出答案，始终得不到权限的车留在其他路径上。
- 不会在路由器里添加 rebinding 例外的用户继续走其他路径；屏幕的设置会说明原因。
- 两条媒体路径让播放问题可能依赖的东西翻倍；遥测记录每个流的路径。
- 弱 Wi-Fi 上的高码率原文件会先卡顿，自适应控制器才降到转码。
- 对 yt-dlp 条目，节点仍经家里的线路下载，所以慢的下行仍然慢。
- DHCP 换了地址之后，经过节点 60 秒的检查、下一次 5 分钟的运行和记录 60 秒的 TTL，记录才会更新。
- 证书过期会关闭局域网路径，直到控制面续期；播放经其他路径继续。
- 能力描述不测量 HDR 和 10 位解码，所以这类原文件即使浏览器能播放也会被转码。
- 节点自己的重新封装（对 `file` Input 做 ffmpeg 流复制，跳转时在关键帧处重启）没有实现：Plex 用它的直接串流重新封装，需要它的文件夹和 NAS 片源随 [Yolo 自己的媒体库](../../proposed/feature/2026-10-11-own-library-and-nas.zh.md)提供。续期不使用 ACME Renewal Information。

## 测试

节点的测试固定监听端口的范围（只认自己的 Host、只接受本地对端、CORS、没有内部 API、无需重启即可换上新证书），以及片源的上游凭据从不到达设备。控制面的测试针对一个在 Let's Encrypt staging 目录 URL 上应答的替身运行 ACME DNS-01，它检查每个 JWS 签名和验证记录，Cloudflare API 和节点也用替身；没有任何测试访问 Let's Encrypt 或 Cloudflare。Hub 和客户端的单元测试固定回退时的请求路径，Plex 插件的测试固定原文件 part 及其只出现在请求头里的 token，[`test/e2e/media-paths.test.js`](../../../../test/e2e/media-paths.test.js) 在 Chromium 里从局域网源播放 Plex 原文件，并在同一位置依次回退到远程直连和中转。车上的行为在车上检查（[车上检查](../testing/2026-07-21-test-layers.zh.md#in-car-checks)）。
