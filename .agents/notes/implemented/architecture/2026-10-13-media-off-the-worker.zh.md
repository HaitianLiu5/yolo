# Agent Note: 媒体流离开 Worker

Status: implemented

[English](2026-10-13-media-off-the-worker.md) | 中文

## 问题

离开家时，Yolo 播放的每个媒体字节过去都从节点经 cloudflared 隧道和 Workers VPC 到达 Worker，再由 Worker 在用户本人的公开源（origin）下以 `/m/*` 提供出去（[同源媒体透传](2026-10-07-same-origin-media-passthrough.zh.md)、[Workers VPC](2026-10-08-workers-vpc-node-access.zh.md)）。只有在家的设备能绕开这条路，靠的是[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)。这条绕行让每条流多经过一次 Cloudflare，把它限制在中转（relay）4.8 Mbps 的上限之内，还消耗账号的 Workers 请求数；而从节点出发的直连路径到达屏幕更快，并能用满家里的上行带宽。

Cloudflare 的服务专属条款保留限制视频的权利：Free、Pro 或 Business 区域没有使用它的任何一项付费媒体服务、而经它的 CDN 提供视频时，Cloudflare 可以加以限制（[条款](https://www.cloudflare.com/service-specific-terms-application-services/)）。

因此从 0.5 到 0.6，新实例启动时中转是关闭的，在某条直连路径能用之前，它的屏幕什么都播不了。一位朋友的第一次部署说明了这样做的代价：他的网关既不回应 NAT-PMP，也不回应默认关闭的 UPnP，于是远程直连失败，局域网路径又用不上，每个播放请求都以 `media_unreachable` 被拒绝。每个实例都是一个人自己的 Cloudflare 账号、供个人使用，所以用户本人决定（2026-10-14）：中转是一条正常、受支持的路径，它作为兜底自动启用。

## 决定

Worker 承担控制：登录、片库目录、token、Hub 和 MCP。媒体从节点走对这台设备第一条可用的直连路径（局域网或远程）到达设备，因为直连路径更快，也不消耗 Cloudflare 的带宽。经 Worker 的中转在用户本人自己的 Cloudflare 账号里，是始终可用的兜底：默认情况下，只有对一块屏幕没有任何直连路径可用时，它才承载这块屏幕的媒体。

| 路径 | `network` | 源（origin） | 能到达 |
|---|---|---|---|
| 局域网直连 | `lan` | `https://yolo-lan-<id>.<zone>:9443`，一条指向节点私有地址的仅 DNS 记录 | 家庭网络里的设备 |
| 远程直连 | `wan` | `https://yolo-wan-<id>.<zone>:<port>`，一条指向家里公网地址的仅 DNS 记录，经路由器的一个端口；没有域名时是 `https://<公网地址>:<port>`（[没有域名时的媒体](../feature/2026-10-13-no-domain-deployment.zh.md#media-without-a-domain)） | 互联网上任何设备，包括用 LTE 的车 |
| 中转 | `relay` | `PUBLIC_ORIGIN`，经隧道和 Worker | 任何地方：没有直连路径可用时（`auto`，默认值）、作为最后一条路径（`on`），或者从不（`off`） |

每条路径提供同样的 `/m/{token}/…` URL，只由路径中的媒体 token 授权，所以一条流在哪个源上都能播，token 和节点的会话都不用改。

### 设备上的路径选择

[`clients/player/src/media-paths.js`](../../../../clients/player/src/media-paths.js) 为这块屏幕选择路径；两个引擎都播放流所指明的源（[两个引擎](2026-10-12-two-playback-engines.zh.md)）。

- **发现。** Hub 的 `welcome` 带 `media: { paths: [{ path, origin, notAfter }], relay, relayMode }`（[`service/control/src/edge/paths.js`](../../../../service/control/src/edge/paths.js)）：上次局域网检查发现监听端口在用有效证书提供服务时列出 `lan`；远程访问打开、且上次从外部检查到达了监听端口时列出 `wan`（没有域名时，则是节点以一张验证时已从外部到达它的证书、在当前地址下提供服务时）；这位用户的中转模式；以及 `relay`，即中转是否可以承载媒体，供有这些模式之前的播放器读取。它还带 `lan`，即单独的局域网源，供 0.5 之前的播放器使用（[Hub 和实时通道](2026-10-07-hub-and-realtime-channel.zh.md)）。设备的实时连接来自家里的公网地址时，`wan` 条目带 `home: true`；没有域名的实例上，welcome 还带 `domain: false`，此时屏幕的局域网开关什么也找不到。welcome 列出的远程源变化时，Worker 让每个 Hub 给它已连接的屏幕发送 `media`，内容和它们的 welcome 一样（[`index.js`](../../../../service/control/src/index.js)）。
- **顺序。** 先 `lan`，再 `wan`，最后 `relay`。设置里的「通过家庭网络播放」仍然按屏幕控制 `lan`（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）；`wan` 解析到公网地址，不需要浏览器权限，也没有开关；只要模式不是 `off`，`relay` 就是候选，并且始终排在最后。
- **探测。** 每个监听端口对 `GET /edge/probe` 回答 `{ ok, name, path }`；局域网监听端口还为 0.5 之前的播放器保留 `/lan/probe`。屏幕同时探测所有候选：收到 welcome 时、收到 Hub 的 `media` 消息时、浏览器发出 `online` 事件时、局域网开关变化时，以及一条流失败 30 秒后；`lan` 超时 2 秒，`wan` 超时 5 秒。它按顺序取第一个探测有回答的路径，对排在前面的路径只等到它的探测结束。Plex Web 测试直连的方式相同：并行测试，中转放在最后。播放请求只在值得的时候等这一轮探测：屏幕记住每个网络上一轮完整探测选中的路径（这里的网络指 welcome 列出的监听端口，以及 welcome 是否认定屏幕在家）。在那里成功过的直连路径，会等它的探测；没有直连成功过的网络，播放立即走中转；屏幕没见过的网络，最多等 1 秒，然后取已经回答的最好路径，没有就走中转。这一轮探测继续进行，下一条流用它找到的路径。中转为 `off` 时，播放会等这一轮探测结束。
- **报告。** 选择变化时、每次 welcome 之后各一次，屏幕发送 `{ v: 1, type: "network", path, reason, probes }`，带上每次探测的结果（`ok`、`timeout`、`failed`、`off`、`certificate`、局域网的权限和重绑定结果，或 `http_<status>`）；什么都不通时 `path` 为 null。被标为 `home` 的屏幕还带 `hairpin`：它的 `wan` 探测有回答时为 `ok`，说明路由器能回环到自己的公网地址；没有回答时为 `failed`。它自己的播放请求带 `network: <path>`。Hub 按设备保存最新的路径和探测结果，就像以前保存 `lan` 或 `tunnel` 一样；在一个版本内，它把 `tunnel` 读作 `relay`，把只带 `lan` 的报告读作 `lan` 或 `relay`。
- **流。** Hub 把路径传给 `prepare`。节点只在对应的监听端口正在提供服务时才走 `lan` 或 `wan`，否则走中转；它在流描述里返回实际走的路径和该监听端口的源。每条路径有自己的上限：`lan` 是 `LAN_MAX_VIDEO_KBPS`（默认 200,000），`wan` 是 `WAN_MAX_VIDEO_KBPS`（20,000），由家里的上行带宽送到一块屏幕，`relay` 是 `STREAM_MAX_VIDEO_BITRATE_KBPS`（4800），因为中继只是后备而保持较低；设备的[自适应上限](../feature/2026-10-11-adaptive-quality.zh.md)可以把其中任何一个再压低。来源插件看到的 `network` 在局域网直连时是 `lan`，其他路径都是 `tunnel`，路径的上限则作为 `limits.maxVideoKbps` 交给它，`<video>` 设备的 Plex 转码能承载多高的画面由它决定（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）。
- **没有路径。** 中转为 `auto` 或 `on` 时，上次报告没有找到任何路径的设备会走中转：它收到的 welcome 可能早于当前模式。中转为 `off` 时，对没有路径或者正走中转的设备，Hub 在节点做任何事之前就以 `media_unreachable` 拒绝。消息逐条列出每条路径、设备探测发现了什么，以及每种修复方法；它的 `details` 为屏幕带上同样的内容：`reason`，以及形如 `{ action, text }` 的 `fixes`，其中 `relay` 把中转设为 Automatic（自动），`remote` 打开远程访问，`forward` 是路由器上的步骤，带上节点最近一次报告的端口、节点地址和路由器地址。屏幕显示原因和修复方法，而不是一条光秃秃的错误，并带一个按钮：它借这个浏览器上用户本人的 passkey 会话把中转设为 Automatic，或者打开设置去登录（在车里，则显示在手机上打开设置的那个码），然后重新播放这个条目。智能体的 `play` 返回这条消息。如果因为某个监听端口停止服务、节点只能退到中转而中转又关着，Hub 会停掉那个会话，并同样拒绝。

### 回退

引擎有限次的重试用完后，一条流就算在它的路径上失败了。如果屏幕在这条流的路径之下还有路径，恢复流程先把屏幕移到那里（`failed()`），发送 `network`，记录 `media_path_fallback`，并按那条路径在同一位置重建这条流，就像以前失败的局域网流转到隧道一样。30 秒后屏幕重新探测；正在播放的流从不往上换，下一条流会走最好的路径，所以一条开始可用的直连路径（在设好端口转发或有了新域名之后）会承载下一条流。车在一条局域网流中途离开家里的 Wi-Fi，会在 `wan` 上继续播放；`wan` 没有回答时，则在中转上继续，除非中转关着。

### 远程直连

#### 名称、记录和证书

远程访问在设置里打开后，Worker 的定时任务（每 5 分钟一次，以及用户本人要求时）在局域网维护之后运行 [`service/control/src/edge/wan.js`](../../../../service/control/src/edge/wan.js)，使用同一个 DNS provider（DNS 服务商）：区域 token，现在叫 `MEDIA_DNS_TOKEN`（Zone Read 和 DNS Edit；它在 0.5 之前的名字 `LAN_DNS_TOKEN` 在一个版本内仍会被读取），或者在自己区域里工作的 DNS provider 插件（[DNS provider 插件](2026-10-14-dns-provider-plugins.zh.md)）：

1. 它为节点取一次名字 `yolo-wan-<8 位十六进制数>.<zone>`，和局域网名字一样落在 passkey 依赖方之外（[`edge/names.js`](../../../../service/control/src/edge/names.js)）。
2. 它通过 `nodeFetch()` 发送 `PUT /internal/v1/wan`，带上名字、`PUBLIC_ORIGIN` 和 `enabled: true`。节点回答家里的公网地址、它的路由器映射、它在 IPv6 上监听时的 IPv6 地址、它是否处在运营商级 NAT 或双重 NAT 之后、证书的有效期，以及一个证书请求（[节点内部 API](2026-10-07-node-internal-api.zh.md)）。
3. 它维护从这个名字出发的仅 DNS 记录：A 指向公网 IPv4 地址；节点在 IPv6 上监听时，AAAA 指向节点的全局 IPv6 地址；TTL 为 60 秒，地址变化时跟着改。Cloudflare 自己的文档把灰云（仅 DNS）子域名列为解决视频受限的办法之一。
4. 它用局域网那套代码、通过 ACME DNS-01 为这个名字取得一张恰好只含这个名字的证书，在有效期过去三分之二时续期，退避规则相同，然后把证书链发给 `PUT /internal/v1/wan/certificate`。
5. 它从外部检查：Worker 以 5 秒超时请求 `https://<name>:<port>/edge/probe`。兼容性标志 `allow_custom_ports` 从兼容日期 2024-09-02 起默认开启（Yolo 的兼容日期是 2026-10-01），开启时 Worker 的 `fetch()` 对未经代理的主机使用 URL 里的端口（[兼容性标志](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)），而 `global_fetch_strictly_public` 让请求走公网，所以只要有回答，就证明路由器把这个端口从家外转发了进来。

远程名字有自己的密钥和证书，不和局域网名字共用一张：打开或关闭远程访问从不重新签发局域网证书，一个名字的签发失败或延迟从不拖住另一个名字的续期，而和公开监听端口完成握手的客户端只会看到远程名字。代价是每个续期周期多一次 ACME 订单，远在 Let's Encrypt 的限额之内。

状态保存在 KV 的 `yolo:wan` 下：`off`、`pending`（已命名，还没在提供服务）、`ok`、`cgnat`、`unreachable`（从外部检查没有回答：路由器没有转发这个端口，或者 ISP 或防火墙把它挡住了）、`certificate`，以及带失败步骤的 `error`（`zone`、`node`、`address`、`dns`、`certificate`、`install`、`listener`、`router`）。只有在 `ok` 时，welcome 才列出 `wan`。处在运营商级 NAT 之后时，记录会被删除。用户本人关闭远程访问时，这次运行先发送 `enabled: false`，节点关闭监听端口并删除它的路由器映射；然后才删除记录，删除失败时，之后的运行按证书的退避机制再试（30 分钟起，每次加倍，最长一天），所以 DNS 故障从不会让监听端口一直开着。即使另一次运行的证书订单持有租约，这个开关也立即生效（[DNS provider 插件](2026-10-14-dns-provider-plugins.zh.md#runs-orders-and-their-limits)）。

#### 没有域名时

监听端口的身份是家里的公网地址，节点自己为它取得 Let's Encrypt `shortlived` 证书：经路由器的 80 端口用 HTTP-01 验证，节点只在订单进行期间映射这个端口；或者在监听端口的路由器端口是 443 时，在监听端口上用 TLS-ALPN-01 验证。控制面发给节点的是 `certificate: "ip"` 而不是名字，不写记录，不需要 `MEDIA_DNS_TOKEN`，也跳过从外部的检查，因为 Worker 不能请求地址，而 CA 的验证已经从外部到达了节点。理由和机制见[没有域名时的媒体](../feature/2026-10-13-no-domain-deployment.zh.md#media-without-a-domain)。

#### 家里的公网地址和运营商级 NAT

- **互联网看到的地址。** 节点用运营商签名经 IPv4 请求 Worker 的 `GET /.well-known/yolo?address=1`，签名后的回答只带请求来源的地址（`CF-Connecting-IP`）（[智能体部署](../feature/2026-10-13-agent-deployment.zh.md)）。控制面配置节点时它问一次，之后每 5 分钟问一次；回答变化时，定时任务跟着改记录。不依赖任何第三方地址服务。
- **路由器看到的地址。** 端口映射协议会报告路由器自己的公网地址。
- **运营商级 NAT 或双重 NAT。** 当路由器自己的公网地址落在 `100.64.0.0/10` 或 RFC 1918 范围内，或者和互联网看到的地址不同，节点报告 `nat: "cgnat"` 并附上原因，不提供任何远程流，定时任务删除记录。

#### 路由器端口

[`service/node/src/portmap/`](../../../../service/node/src/portmap/) 把路由器公网地址上的一个 TCP 端口映射到节点，和 Plex 服务器的做法一样。在 `auto` 模式下（`WAN_MAPPING`，默认值），节点向默认网关（取自路由表，或 `WAN_GATEWAY`）依次用 PCP（RFC 6887）、NAT-PMP（RFC 6886；只会 NAT-PMP 的路由器会对 PCP 回答「unsupported version」）、UPnP IGD（`WANIPConnection` 或 `WANPPPConnection`；路由器只允许永久映射时就用永久映射）请求映射，取第一个有回答的。它请求 `WAN_EXTERNAL_PORT`（默认等于 `WAN_PORT`），使用路由器实际分配的端口；在 2 小时有效期过半之前、并且至少每 15 分钟续一次映射，每次续期都重新读取公网地址；自己的地址变化时重新映射；监听端口关闭或节点停止时删除映射。它只问默认网关，也只使用由网关自己的地址提供的 UPnP 描述。三种协议都没有回答的路由器会留下一条错误，写明要手动转发哪个端口。在 `manual` 模式下，用户本人在路由器上把 `WAN_EXTERNAL_PORT` 转发到节点的 `WAN_PORT`，节点不向路由器发送任何东西。节点只在远程监听端口提供服务时才映射，所以只有用户本人打开远程访问、证书装好之后，路由器才会收到请求。

#### 节点的远程监听端口

[`service/node/src/wan.js`](../../../../service/node/src/wan.js) 是第三个监听端口，和局域网监听端口用同一个模块（[`edge.js`](../../../../service/node/src/edge.js)）构建，端口为 `WAN_PORT`（9444；0 表示关闭）。它绑定路由器转发到的私有 IPv4 地址（`WAN_ADDRESS`，否则用局域网地址）；当 `WAN_IPV6` 为 `on` 或写明了地址时，它也绑定这台机器的全局 IPv6 地址——用户本人在路由器的 IPv6 防火墙放行该端口之后才设置它。它的源带上路由器的外部端口，外部端口是 443 时不带。它的密钥和证书放在 `<runtime>/.lan/wan/`。

<a id="the-threat-model-of-the-remote-listener"></a>

### 远程监听端口的威胁模型

远程监听端口是 Yolo 第一个前面什么都没有、直接面对互联网的部分。

- **要保护什么。** 家里的机器，上面有 `NODE_SECRET`、插件的凭据（其中包括 Plex token）和用户本人的文件；媒体会话，每个都由一个最长 12 小时有效的 token 授权；家里的上行带宽；以及远程名字的私钥。
- **谁能接触到它。** 互联网扫描器——证书进入证书透明度（Certificate Transparency）日志后，或者扫遍 IPv4 时，几分钟内就会找到这个端口；任何得知一个媒体 URL 的人；设备所在网络的运营方（车的运营商、酒店的 Wi-Fi）；以及用户本人浏览器里的恶意页面。
- **它暴露了什么。** 一个 TCP 端口：Node 的 TLS 和 HTTP 解析、监听端口的路由，以及媒体管线的 token 校验。

监听端口为此做的事：

- **只提供媒体。** 它提供 `/m/{token}/…` 下的 `GET` 和 `HEAD`、`OPTIONS` 预检和 `GET /edge/probe`，其他请求一律回答 404 或 405。内部 API 是 `127.0.0.1:9191` 上的另一个服务器，用户本人的配对码仍只走 Unix 套接字（[passkey 登录](2026-10-08-passkey-owner-sign-in.zh.md)）。
- **只认自己的名字，HTTP 和 TLS 都是。** 在 TLS 里报出别的服务器名的客户端拿不到证书；`Host` 或 TLS 服务器名不是监听端口自己名字的请求——包括不发送服务器名的客户端——得到 421。按地址连接的扫描器和 DNS 重绑定页面都到不了任何处理程序。没有域名时，监听端口按地址访问，扫描器也会发送这个地址，所以它改为给扫描器空的回答、不暴露控制面的源（[没有域名时的媒体](../feature/2026-10-13-no-domain-deployment.zh.md#media-without-a-domain)）。
- **先验 token，再做任何事。** 管线在查找会话、调用来源或请求上游之前，先检查媒体 token 的格式、有效期和 HMAC-SHA256 签名（用恒定时间比较）。伪造的 token 得到 403，过期的 token 或已结束的会话得到 410，都不带细节。
- **按对端限制。** 一分钟内请求失败 20 次（伪造的 token、未知路径、别的名字、别的方法）的对端会被拒绝 10 分钟：它已打开的连接得到 429，新连接在 TLS 之前就被关闭。每个对端最多 32 个打开的连接，总共最多 256 个，所有对端合起来每秒最多 20 个新连接。请求头必须在 10 秒内到齐、整个请求在 30 秒内到齐，请求头最大 8 KB，TLS 握手最长 10 秒，空闲的 keep-alive 连接 5 秒后关闭。
- **TLS 1.2 或更新版本**，证书恰好只含这个名字；私钥从不离开节点。
- **沿用局域网监听端口的响应策略。** `Access-Control-Allow-Origin` 设为 `PUBLIC_ORIGIN`、`Cross-Origin-Resource-Policy: cross-origin`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`，内容类型从不是 HTML 或 XML。
- **日志不含 token。** 每个媒体回答记一行（`kind: "media"`、`path`、状态、大小、耗时），对端被拒绝时记一行 `kind: "edge"`；不记任何 URL。
- **随时可以关掉。** 在设置里关闭远程访问，就会删除记录、关闭监听端口并删除路由器映射；在节点上设 `WAN_PORT=0` 也能关掉它。

仍然存在的风险：

- 远程访问打开期间，Node 的 TLS 或 HTTP 代码、或媒体处理程序里的缺陷，从任何地方都能触达；狭窄的暴露面、上述限制、及时更新的 Node.js 和这个开关限定了它的范围。
- 一个泄露的媒体 URL 在其会话结束前，从任何地方都能播放这个会话，经中转时也是如此。
- 这些限制保存在节点的内存里：重启会清空它们，许多地址联合起来时也不受每个对端的限制约束。
- 媒体 token 的密钥就是 `NODE_SECRET` 本身。媒体 token 签的是 `sessionId|userId|exp`，内部请求签的是 `timestamp\nMETHOD\npath\nbodyHash`，两者不可能撞上；监听端口只做校验，所以它不是一个签名预言机（signing oracle）。专为媒体 token 派生的密钥推迟实现。
- DNS 公开了家里的公网地址，从中能看出用户本人的 ISP 和大致位置；证书透明度日志公开了这个名字。

### 中转，作为兜底

- **三种模式**，按用户设置：`auto` 是默认值，只有对一块屏幕没有任何直连路径可用时，才让中转承载这块屏幕的媒体，无论是在一条流开始时，还是在一条直连流中途失败时，此时恢复流程在同一位置经中转继续；`on` 允许中转作为最后一条路径，即 0.5 和 0.6 的那个开关；`off` 从不中转。在屏幕上，`auto` 和 `on` 的选择相同，因为两种情况下路径顺序都把中转放在最后；`on` 保留了打开过开关的实例的选择，`auto` 则是默认行为的名称。
- Worker 的 `/m/*` 透传（[`service/control/src/media.js`](../../../../service/control/src/media.js)）为 token 所写的用户提供服务，除非这位用户的模式是 `off`；模式按 token 所写的用户从 D1 读取，每个 isolate 最多缓存 30 秒。模式为 `off` 时，它回答 `403`，带 `X-Yolo-Error-Code: RELAY_OFF`，不会到达节点。哪条流走中转由屏幕和 Hub 决定；透传为任何有效的 token 提供服务。它原样传回节点的响应。
- 模式保存在 D1 的 `media_settings` 表里（[D1 数据模型](2026-10-07-d1-data-model.zh.md)）：`relay_mode`（`auto`、`on` 或 `off`，迁移 `0008_relay_mode`）与 `relay` 并列；只要模式不是 `off`，`relay` 就保持为 1，所以只读 `relay` 的上一个版本也会把中转用作兜底。没有这一行的用户是 `auto`，所以新实例从第一次部署起就会中转。迁移 0008 把 `relay = 1` 的行设为 `on`；只有当用户本人明确做过选择时，才把 `relay = 0` 的行设为 `off`，明确选择是指 `relay_accepted_at` 有值（中转曾通过 0.5 的警告打开，后来又关掉），或者这位用户创建于 0006 编写之前（2026-10-13 23:03:23 UTC），0006 让这类用户的中转保持打开，所以只有用户本人会把它关掉；其余每一行都设为 `auto`，因为只要用户本人打开远程访问，0.5 和 0.6 就会默认写入 `relay = 0`。只看 `relay_accepted_at` 会漏掉第二种情况，因为 0006 没有写入接受时间；`updated_at` 也区分不了，因为打开远程访问同样会写入这样一行。回滚之后，上一个版本写入的行只改 `relay`：0 读作 `off`，写在模式为 `off` 的行上的 1 读作 `on`。
- 用户本人在 Settings › Media paths（设置 › 媒体路径）里选择模式，需要 passkey 会话（`PATCH /v1/owner/media`，带 `relay: "auto" | "on" | "off"`；来自有这些模式之前的页面的布尔值表示 `on` 或 `off`），没有确认步骤。这张卡片用一行文字说明一次：没有直连路径可用时，媒体经用户本人的 Cloudflare 账号传输；卡片还显示最近 7 天有多少条流走了中转，以及每块屏幕最近一次用的路径。每次改动都写一行 `kind: "security"` 日志（`event: "relay_mode"`、`from`、`to`），并把媒体路径重新发给每块已连接的屏幕，让它立即重新选择（[v1 HTTP API](2026-10-07-v1-http-api.zh.md)）。
- `yolo doctor` 把 `auto` 和 `on` 作为提示信息报告，附上最近 7 天走中转的流；只有中转为 `off` 而又没有直连路径可用时，它才报告失败，并附上两种修复方法；`get_status` 报告这个模式。
- 中转保持它较低的上限 `STREAM_MAX_VIDEO_BITRATE_KBPS`（4.8 Mbps），因为它是兜底，而且每个字节都要经过 Cloudflare 两次。

### 所选路径的遥测

- **设备事件**（[设备遥测](../feature/2026-10-11-device-telemetry.zh.md)）：每次探测一条 `media_probe`（`path`、`outcome`、`trigger`、`elapsedMs`、局域网的 `permission`、`host`，在家里的地址上还有 `home` 和 `hairpin`），每次换路径一条 `media_path`（`path`、`from`、`reason`、`probes`），每次往下回退一条 `media_path_fallback`（`from`、`to`、错误的 `code` 和 `message`、`position`），`stream_selected` 带 `network`（即路径）和 `mediaHost`。
- **Hub** 记录 `event: "stream"`，带请求的路径和节点实际走的路径；每次报告记录 `event: "network"`，带路径、探测结果和 `hairpin`。它保存每块屏幕最近一条流，以及 7 天内按 UTC 日计的、每条路径承载的流数量，其中一次重建只有在换到另一条路径时才计入；设置和 `doctor` 读取这些数据。
- **节点** 为远程监听端口上的每个媒体回答记一行，不含 URL；路由器映射的创建、删除和失败也记日志；没有域名时，每张家里地址的证书和每次失败的订单也记日志（`kind: "edge"`，`event: "certificate"` 或 `"certificate_error"`）。
- **控制面** 记录 `kind: "edge"`、`path: "wan"`，`event` 为 `"certificate"`、`"address_changed"`、`"cgnat"`、`"unreachable"`、`"off"`、`"records_left"` 或 `"error"`，与局域网的 `kind: "lan"` 并列；中转模式每次改动记录 `kind: "security"`。
- **设置** 显示每块屏幕的路径和它的探测发现了什么，以及用户本人的几张卡片：家庭网络、远程直连（用文字说明的状态、名字、地址、路由器端口和证书）、中转模式及它本周承载的流，以及每块屏幕最近一次用的路径。

### 每位用户本人要做的设置

| 步骤 | 路径 | 什么时候需要 |
|---|---|---|
| 把 `MEDIA_DNS_TOKEN` 设为 Worker secret（该区域的 Zone Read 和 DNS Edit），或者设置 DNS provider 插件的名称和 secret | `lan`、`wan` | 一次，任何直连路径都需要 |
| 在设置里打开远程访问 | `wan` | 一次 |
| 路由器上什么都不用做：节点自己用 PCP、NAT-PMP 或 UPnP IGD 请求 | `wan` | 路由器允许其中一种协议时，多数家用路由器都允许 |
| 给节点所在机器做 DHCP 保留、把 TCP `WAN_EXTERNAL_PORT` 转发到节点的 `WAN_PORT`，并设置 `WAN_MAPPING=manual` | `wan` | 只在路由器不支持这些协议时 |
| 为 `WAN_PORT` 加一条 IPv6 防火墙规则，并设置 `WAN_IPV6=on` | `wan` | 只为 IPv6 |
| 在 macOS 防火墙里放行节点 | `wan` | 只在防火墙开启时 |
| 什么都不用做：中转是 `auto` | `relay` | 每个实例，从第一次部署起 |
| 把中转设为 `off` | `relay` | 只在用户本人不希望任何媒体经过 Cloudflare 时 |

[`yolo-deploy`](../../../../skills/yolo-deploy/SKILL.md) 技能列出了这些步骤，以及针对具体路由器的步骤，`yolo doctor` 报告每条路径的状态和中转，并附上修复方法。部署结束时，`npm run yolo -- deploy` 报告哪条媒体路径可用：按 Worker 从外部检查的结果报告远程直连，或者报告经隧道的中转；远程直连无法到达时，它给出路由器上的步骤，但不让部署失败。没有域名时不需要 `MEDIA_DNS_TOKEN`，路由器上的步骤见[没有域名时的媒体](../feature/2026-10-13-no-domain-deployment.zh.md#media-without-a-domain)。

## 推迟的部分

- **IPv6 入站。** 节点既不打开 IPv6 防火墙通道（PCP 或 UPnP 的 `WANIPv6FirewallControl`），也不从外部检查 IPv6：Worker 的 `fetch()` 不能选择地址族。`WAN_IPV6` 是用户本人的声明，表示路由器已放行这个端口。
- **专为媒体 token 派生的密钥**（用带用途标签的 HKDF 从 `NODE_SECRET` 派生，并加上版本前缀），这需要两边都改，并在一个版本内接受旧 token。
- **R2 暂存**，给无法做端口转发的用户本人的、全在 Cloudflare 内、从存储播放的路径，放在 1.0 之后。
- **车在 LTE 上** 的表现在车里检查（[车内检查](../testing/2026-07-21-test-layers.zh.md#in-car-checks)）：车的 `media_probe` 事件会显示它的运营商能否到达这个端口、它有没有 IPv6。

## 曾考虑的替代方案

**像 0.5 和 0.6 那样默认关闭中转。** 那样新实例在用户本人设好直连路径或找到那个开关之前什么都播不了，路由器不映射任何端口的用户本人第一次播放就会被拒绝。把中转作为兜底，每个实例从第一次部署起就能播放，直连路径也仍然承载它们能承载的每一条流。

**中转作为第一条路径。** 它不需要任何设置、在哪里都能用，但每条流都会在 4.8 Mbps 的上限之下经过 Cloudflare 两次，即使节点在家里或经路由器就能直接到达屏幕。

**只有两种模式：自动和关闭。** 在屏幕上，`on` 和 `auto` 的选择相同；保留它，是为了让打开过开关的实例保有一个如实表明这一点的模式，迁移也不必替它做决定。

**删掉中转。** 那样的话，处在运营商级 NAT 之后、或者路由器不映射任何端口的用户本人，在 R2 暂存出现之前，离开家时就一条路径都没有。

**Tailscale。** 在节点的 tailnet 地址上开一个监听端口，配上用户本人区域里的名字和证书，就能服务用户本人 tailnet 里的手机和电脑。这个方案被否决了：每台设备都要安装并登录 Tailscale，多数用户本人不会付出这个代价；而 Yolo 的核心屏幕——特斯拉的浏览器——根本运行不了它。远程直连不用安装任何东西，就能到达每台设备，包括车。Tailscale Funnel 不用端口转发就能发布节点，但同样不采用：它的流量「受不可配置的带宽限制」（[Funnel](https://tailscale.com/kb/1223/funnel)），容不下持续的视频。

**只做手动端口转发。** 它不向路由器发送任何东西，但多数用户本人得自己去找路由器的转发页面；Plex 使用的那些路由器协议会替他们做好、续期并在之后删除，而手动模式仍留给不支持这些协议的路由器。

**两个名字共用一张证书。** 一次 ACME 订单就能覆盖两个名字，但打开或关闭远程访问都会重新签发局域网证书，一次失败的订单会拖住两边的续期，而且公开监听端口会把局域网名字展示给每个客户端。

**用第三方服务获取公网地址。** 那会多一个依赖，还会让第三方知道节点何时在检查；Worker 本来就能看到这个地址，而且有运营商签名把关。

**R2 暂存。** 节点把预先切好分片的 HLS 或 fMP4 上传到用户本人的 R2 存储桶，设备从 R2 播放，即托管在 Cloudflare 上的内容。它需要一条上传管线、一个在播放前准备片子的步骤和淘汰机制；开播前就要占用家里的上行带宽，而边写边缓存的做法仍会代理第一次观看。存储费用为每 GB 每月 0.015 美元，出口流量免费，存放在 Cloudflare 上的内容受 Developer Platform 内容规则约束（[R2 价格](https://developers.cloudflare.com/r2/pricing/)）。它推迟到 1.0 之后。

**Cloudflare Stream。** Stream 会对每次上传重新编码，Yolo 失去对码率档位的控制；费用是每月每 1,000 分钟存储 5 美元，加上每 1,000 分钟分发 1 美元：一个 500 部电影、约 60,000 分钟的片库，光存储每月就要约 300 美元（[Stream 价格](https://developers.cloudflare.com/stream/pricing/)）。

**Cloudflare One Client 或 Mesh 私有路由。** 它们需要一个 Zero Trust 组织和注册过的设备，而车无法注册。

**租一台小 VPS 做中转，用 WireGuard 连到节点。** 车能连到，但每位用户本人都要多租一台机器并维护它。

**用隧道的公开主机名提供媒体。** 它就是换了第二个主机名的中转路径，[透传那份记录](2026-10-07-same-origin-media-passthrough.zh.md)也已经否决过经隧道的 `media.` 子域名。

**把媒体 token 绑定到设备的地址。** 车的地址在 LTE 上、在不同网络之间都会变，一条流每次地址变化都会断。

## 后果

离开家时，远程直连变成 `ok` 之后，设备经路由器直接从节点播放，没有任何媒体经过 Cloudflare；在那之前，以及任何没有直连路径回答的地方，由中转承载。每个实例从第一次部署起就能播放，一条开始可用的直连路径会承载下一条流。路由器那一步通常什么都不用做，因为节点自己会去问路由器。

代价：

- 节点直接面对互联网；上面的威胁模型限定了它暴露的范围，用户本人的开关可以把它关掉。
- 处在运营商级 NAT 之后的用户本人、用着既不映射也不能转发的租用路由器的用户本人、以及 ISP 封锁入站端口的用户本人，没有远程路径；离开家时，他们的屏幕经中转播放，受它 4.8 Mbps 的上限约束。第一批实例的 `edge` 日志和中转计数会显示这种情况有多常见，以及 R2 暂存需要多快到来。
- 中转流消耗用户本人的 Workers 请求数，并且经过 Cloudflare 两次；在 Workers Free 上，主要经中转播放的家庭可能会达到每日限额，`doctor` 会报告这一点。
- 公网地址变化后，`wan` 会中断，直到节点下一次检查（5 分钟）、下一次定时任务（5 分钟）和记录 60 秒的 TTL 都过去；没有域名时，则是直到节点下一次检查、一次订单和下一次定时任务都过去，之后各个 Hub 会通知已连接的屏幕；在此期间，流会退到中转，除非中转关着。
- 一台在家的设备，如果局域网路径失败、又到达了 `wan` 名字，得到的是家里的公网地址，只有路由器支持 NAT 回环（NAT loopback）时才能用；路径顺序让这种情况很少见。没有域名时，这是在家时唯一的直连路径，屏幕的探测会报告路由器能否回环（[没有域名时的媒体](../feature/2026-10-13-no-domain-deployment.zh.md#media-without-a-domain)）。
- 三条媒体路径让播放问题可能依赖的东西成倍增加；遥测记录了每条流走的路径。
- Workers VPC 仍是一个处于测试阶段的依赖，承载控制流量和中转，所以它测试期之后的定价很重要。

## 测试

节点的测试在回环地址上用假路由器跑每一种路由器协议（[`portmap.test.js`](../../../../service/node/test/portmap.test.js)），并在真实 TLS 上钉住远程监听端口的范围（[`wan.test.js`](../../../../service/node/test/wan.test.js)）：别的 `Host` 或没有 TLS 服务器名得到 421，别的服务器名拿不到证书，伪造的 token 在任何会话操作之前得到 403，`/m/*`、`OPTIONS` 和探测之外没有任何路由，失败 20 次的对端被切断，连接限制，没有文档类型，映射只在监听端口提供服务后才建立、在远程访问关闭时删除，以及处在运营商级 NAT 之后没有远程流。控制面的测试用 Cloudflare API、ACME 服务器和节点的替身跑远程名字的维护（[`edge.test.js`](../../../../service/control/test/unit/edge.test.js)），还测试 Hub 在每种中转模式下的路径选择、`auto` 在开始时和恢复中的中转、带修复方法的 `media_unreachable`、`home` 标记和 `media` 消息、设置里的中转模式，以及迁移 0008 的映射（[`media-settings.test.js`](../../../../service/control/test/unit/media-settings.test.js)）。播放器的测试钉住路径顺序、回退、中转模式、探测结果，以及在家里地址上的回环报告（[`media-paths.test.js`](../../../../clients/player/test/unit/media-paths.test.js)），而 [`test/e2e/media-paths.test.js`](../../../../test/e2e/media-paths.test.js) 在 Chromium 里依次从局域网监听端口、远程监听端口和中转播放，每次都在同一位置。[`wan-ip.test.js`](../../../../service/node/test/wan-ip.test.js) 用一个 ACME 替身跑没有域名时的监听端口（[没有域名时的媒体](../feature/2026-10-13-no-domain-deployment.zh.md#media-without-a-domain)）。没有任何测试向真实路由器发送映射请求。
