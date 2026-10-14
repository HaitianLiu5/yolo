# Agent Note: 没有域名的实例把控制面运行在 workers.dev 和 Workers Free 上

Status: implemented

[English](2026-10-13-no-domain-deployment.md) | 中文

## 问题

Yolo 的控制面过去要先有一个托管在 Cloudflare zone 上的自定义域名才能工作：Worker 只在一条路由上提供服务，passkey、OAuth token 和节点的媒体名称都绑定在这个主机名上。没有域名的用户本人无法开始，而买一个域名又让第一个小时多出付款、注册商和 DNS 设置三件事。Workers Free 预计够用，但从没按 Yolo 自己的用量核对过：每条实时通道连接都把票据写进 KV，定时任务反复改写媒体名称的状态，而 Free 给整个账号每天只有 1,000 次 KV 写入。

## 决策

<a id="two-tiers"></a>

### 两档部署

一个实例在两种地址之一上提供服务，由 `npm run yolo -- init` 记录在实例文件里：

| | 零成本 | 域名 |
|---|---|---|
| 地址 | `https://<worker>.<账号子域名>.workers.dev` | 用户本人 zone 上的 `https://<主机名>` |
| 费用 | Workers Free，别无其他 | 域名，在 Cloudflare Registrar 每年约 5–11 美元 |
| 登录、配对、agent、实时通道 | 有 | 有 |
| 直连播放 | 没有名称时的做法，见下文 | 按名称的局域网直连和远程直连，所有浏览器都可用 |
| 谁决定地址 | Cloudflare 可能重命名账号的 workers.dev 子域名 | 用户本人 |

零成本实例的用户本人拿到完整的控制面：站点根路径上的播放器、用 6 位数字码完成的 passkey 登录、屏幕配对、通过 MCP 和 OAuth 接入的 agent、`/v1`，以及 Hub。媒体路径归 [媒体流离开 Worker](../architecture/2026-10-13-media-off-the-worker.zh.md) 管。没有 zone 就没有局域网名称和远程名称，也没有 `MEDIA_DNS_TOKEN`；实例文件记录 `media.wan.certificate: "ip"`：节点自己为它的公网地址取得证书，定时任务只把用户本人的开关转给它（[没有域名时的媒体](#media-without-a-domain)）。

### 实例文件

| 字段 | 含义 |
|---|---|
| `domain` | 自定义域名；实例没有 zone 时为 `null` |
| `workersDev` | Worker 在 workers.dev 上提供服务时为 `true` |
| `host` | 控制面的公开主机名：域名，或 `<worker>.<账号子域名>.workers.dev` |
| `publicOrigin` | 未设置时为 `https://<host>` |
| `media.wan.certificate` | 有域名时为 `"name"`，没有时为 `"ip"`；可以显式设置 |

分档之前的实例文件只有 `domain`、没有 `workersDev`，按域名档读取，不做任何改动；文件的版本仍是 1。[`ops/lib/instance.js`](../../../../ops/lib/instance.js) 拒绝同时出现域名和 `workersDev`、把 workers.dev 主机名当作自定义域名、不符合 `<worker>.<子域名>.workers.dev` 的 `host`，以及没有域名却要按名称签发证书。

### 不带域名的 init

不带 `--domain`（或带 `--workers-dev`）运行 `npm run yolo -- init` 时选择 workers.dev（[`ops/commands/init.js`](../../../../ops/commands/init.js)）：

1. 新实例得到一个自己的 Worker 名称：`yolo-` 加 6 个随机字母和数字，不透露用户本人的任何信息；首次部署前可以用 `--worker` 改成别的名称。
2. wrangler 登录后，它读取账号的 workers.dev 子域名（`GET /accounts/{id}/workers/subdomain`，使用 `wrangler auth token` 返回的 token）。读取不改动任何东西。账号还没有子域名时，它停下来等用户本人批准（退出码 2），并建议一个中性的名称，因为这个名称会永久公开，而且账号里的每个 Worker 都挂在它下面；`--workers-subdomain <name>` 负责注册。
3. 子域名看起来是由账号的邮箱或名称生成时（Cloudflare 给较早的账号起的名字就是 `<email>-s-account` 这种），它会发出警告，因为证书透明度日志会一直保留这个名称。
4. 它记录 `host`，并在 `.env` 里写入 `PUBLIC_ORIGIN=https://<host>`。

在 `wrangler login` 之前，init 先写好实例文件和 `.env`，然后停下来等人操作；再次运行时补上主机名。workers.dev 实例渲染出的配置是 `workers_dev: true`、没有 `routes`、`PUBLIC_ORIGIN` 为这个主机名；域名实例是 `workers_dev: false` 加上它的自定义域名路由（[`ops/lib/wrangler-config.js`](../../../../ops/lib/wrangler-config.js)）。模板里 `preview_urls` 对两者都是 `false`，所以 Worker 只在唯一一个源上响应。

### workers.dev 上的 passkey、会话和跨源隔离

`workers.dev` 在公共后缀列表（Public Suffix List）里，所以 `<账号子域名>.workers.dev` 自成一个站点。passkey 的依赖方 ID 是 `PUBLIC_ORIGIN` 的完整主机名，其他账号无法占用；会话和挑战用的 cookie 是 `__Host-` cookie，其他主机既不能设置也不能读取。同一账号里的另一个 Worker 与 Yolo 同站：`SameSite=Lax` 分不开它们，但 Yolo 修改状态的路由会把 `Origin` 或 `Sec-Fetch-Site` 与精确的源比对。账号里只放 Yolo，就没有这层暴露。

播放器的 COOP 和 COEP 响应头来自静态资源层里的 `_headers` 文件，在任何主机名上都会发出；workers.dev 主机名走 HTTPS，满足跨源隔离的要求。`doctor` 在两档上都会加载 `/` 并检查这两个响应头（`worker.isolation`）。

<a id="moving-the-address"></a>

### 迁移地址

用户本人加上域名、重命名 Worker、重命名账号子域名时，地址都会改变；Cloudflare 重命名 workers.dev 子域名时也是如此，而它的 Developer Platform 条款允许它"出于任何理由或无需理由"这样做。没有 `--change-domain` 时，`init` 拒绝每一种迁移（退出码 2），并说明代价。迁移并部署之后：

- **passkey** 以旧主机名作为依赖方 ID。用户本人用 `npm run owner-code` 和 6 位数字码注册一个新的，它会替换所有 passkey 并注销所有会话（[用户本人登录](../architecture/2026-10-08-passkey-owner-sign-in.zh.md)）。
- **agent** 持有的 token，其签发者和受众都是旧的源；每个 agent 都要重新接入。
- **屏幕** 把设备凭据存在旧源的存储里；每块屏幕都要重新配对。

迁到域名会保留 Worker 和它的数据：`init --domain <host> --change-domain` 设置路由，并在渲染出的配置里关掉 workers.dev；D1 里的观看记录、队列和播放列表都还在。

### Workers Free

Yolo 用到的每个绑定都能在 Workers Free 上部署：SQLite 后端的 Durable Object、D1、KV、定时触发器、Workers Logs、限流绑定（文档没有写任何套餐限制，而且缺少绑定时 [`rate-limit.js`](../../../../service/control/src/rate-limit.js) 什么也不限制），以及 Workers VPC（测试期间在所有套餐上免费）。没有哪个绑定需要退路。Free 限制的是每个账号每天的用量，在 UTC 00:00 重置：

| 计数 | Free 每天的上限 | 超过以后 |
|---|---|---|
| Worker 请求 | 100,000（静态资源不计入） | workers.dev 上返回 Error 1027 直到午夜；没有路由就没有"放行"（fail open）设置 |
| KV 写入、删除 | 各 1,000 | 写入失败：新的 OAuth 授权和刷新、登录 |
| D1 写入行、读取行 | 100,000 和 5,000,000 | 查询失败 |
| Durable Object 请求 | 100,000 | 对 Hub 的调用失败 |

`doctor` 读取账号昨天和今天（UTC）的分析数据，把较忙的一天与这些上限比较（`cloudflare.limits`），达到上限的一半就发出警告（[`ops/lib/plan.js`](../../../../ops/lib/plan.js)）。wrangler 登录所用的 API 读不到账号的套餐，所以这些档位按 Free 计算，修复说明里写明在 Workers Paid 上可以忽略。

### KV 写入

Yolo 有两类 KV 写入会无上限地重复。实时通道票据过去在每次连接时写进 KV；现在它保存在用户的 Hub Durable Object 里，其存储每天允许 100,000 次行写入（[OAuth](../architecture/2026-10-07-oauth-authorization-server.zh.md#realtime-tickets)）。媒体名称的状态过去在远程路径正常时每 5 分钟的定时任务都会改写一次，因为它记录外部检查最近一次到达节点的时间；有错误持续存在时也一样，因为错误里记着发生的时间。现在只有其他内容变化时才写，否则每小时写一次。OAuth 自己对 KV 的使用保持不变。

每天的 KV 写入：

| | 之前 | 之后 |
|---|---|---|
| 实测，一个家庭的实例，2026 年 10 月 11–13 日 | 24–45（另有 10–19 次删除） | |
| 估算，繁忙的家庭：2 块屏幕、播放 6 小时、3 个 agent、50 次重连 | 约 520：票据 50，OAuth 刷新最多 144，登录约 10，远程状态 288，局域网状态 24 | 约 200：OAuth 最多 144，登录约 10，两个状态各 24 加上变化 |
| ……再加一辆每 30 秒重连一次、持续 2 小时的车 | 约 760 | 约 200 |
| ……再加一个整天出错的局域网名称 | 约 1,020：超过上限 | 约 200 |
| 没有域名 | | 约 180：没有局域网名称；远程访问打开时，按地址的远程路径状态，每天 24 次加上变化时 |

<a id="media-without-a-domain"></a>

### 没有域名时的媒体

没有 zone 时，节点的监听端口就没有名字。剩下的是 Let's Encrypt 为 IP 地址签发的证书，从 2026 年 1 月 15 日起提供（[正式可用](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)）：

- 只在 `shortlived` 配置档（profile）下签发，有效期 160 小时（[配置档](https://letsencrypt.org/docs/profiles/)）；
- 只能用 HTTP-01 验证（「只能在 80 端口上完成」），或在 443 端口上用 TLS-ALPN-01 验证；DNS-01 不适用，「因为不涉及 DNS」（[验证方式](https://letsencrypt.org/docs/challenge-types/)、[IP 证书](https://letsencrypt.org/2025/01/16/6-day-and-ip-certs)）；
- TLS-ALPN-01 验证一个地址时，服务器名是这个地址的反向名称，因为 TLS 不允许在服务器名里写地址（[RFC 8738](https://datatracker.ietf.org/doc/html/rfc8738)）。

没有任何公共 CA 为私有地址签发证书：「CA 不得签发包含内部名称或保留 IP 地址的证书」（[BR §4.2.2](https://github.com/cabforum/servercert/blob/main/docs/BR.md)）。很多路由器拒绝自动映射 1024 以下的端口：NAT-PMP 网关可以拒绝 80 端口（[RFC 6886](https://datatracker.ietf.org/doc/html/rfc6886)），而许多路由器的 UPnP 背后的 miniupnpd 建议只允许 1024 及以上的端口（[miniupnpd.conf](https://raw.githubusercontent.com/miniupnp/miniupnp/master/miniupnpd/miniupnpd.conf)）。

`media.wan.certificate` 为 `"ip"`（Worker 以 var `WAN_CERTIFICATE` 读取）时，屏幕这样播放：

| 屏幕在哪里 | 怎样播放 |
|---|---|
| 离开家时，包括用 LTE 的车 | 远程直连，从 `https://<公网 IPv4 地址>:<port>` 播放，用的是这个地址的 Let's Encrypt 证书 |
| 在家时 | 同一个地址，只有路由器能回环到自己的公网地址（NAT 回环，即 hairpin）时才可用；否则在用户本人打开中转时走中转 |
| 处在运营商级 NAT 或双重 NAT 之后 | 中转打开时走中转，和有域名时一样 |

局域网直连播放需要域名：没有任何公共证书能写上节点的私有地址，而以纯 HTTP 访问这个地址仍是被否决的方案（[局域网直连播放](2026-10-12-lan-direct-play.zh.md)）。路径顺序仍是局域网、远程、中转；没有域名时局域网路径从不出现。

#### ACME 在哪里运行

节点自己为它的地址完成 ACME 订单，用的是 Worker 做 DNS-01 时用的同一个客户端（[`service/core/src/acme.js`](../../../../service/core/src/acme.js)）。两种模式下，监听端口的私钥都留在节点上。

- **没有任何凭据到达节点。** 有名字的媒体由 Worker 运行 ACME，是因为 DNS-01 需要区域 token：它能编辑区域里的每条记录，放在家里的机器上，每个节点插件都能读到（[插件信任模型](../architecture/2026-10-11-plugin-architecture.zh.md)）。HTTP-01 和 TLS-ALPN-01 不需要任何凭据。节点的 ACME 账号密钥只能为 80 或 443 端口能到达节点的地址取得证书，而以节点权限运行的节点插件本来就能做到这一点。
- **控制面仍然只通过 `nodeFetch()` 到达节点。** 它发送 `PUT /internal/v1/wan`，带上 `certificate: "ip"`、页面源、用户本人的开关和 ACME 目录，并读取节点的回答（[节点内部 API](../architecture/2026-10-07-node-internal-api.zh.md)）。节点发往 CA 的请求从家里出去，和它发往片源的请求一样。
- **应答和验证在同一台机器上。** CA 从多个观测点验证、还会重试，节点必须恰好在这期间应答。如果放在 Worker 里，每个订单都要在一次定时任务内多次调用 `nodeFetch()` 来打开和关闭节点的应答，而 Worker 只能猜 CA 什么时候验证完。
- **节点最先看到新地址。** 它每 5 分钟读取一次家里的地址，每次续期映射时也从路由器读取，所以不用等定时任务就能下单。
- **Worker 不能请求 IP 地址**（[已知问题](https://developers.cloudflare.com/workers/platform/known-issues/)），所以它也没法从外部检查结果。

#### 验证方式及其端口

节点这一侧是 [`service/node/src/wan.js`](../../../../service/node/src/wan.js) 和 [`acme-challenge.js`](../../../../service/node/src/acme-challenge.js)：

- **HTTP-01，默认方式。** CA 在 80 端口上请求 `http://<address>/.well-known/acme-challenge/<token>`。节点在 `WAN_CHALLENGE_PORT`（9480）上应答：这是路由器转发到的地址上的一个纯 HTTP 监听端口，只在订单进行期间存在，也只提供这个订单的 token。在 `auto` 模式下（`WAN_CHALLENGE_MAPPING`，默认取 `WAN_MAPPING` 的值），节点为这个订单用 PCP、NAT-PMP 或 UPnP IGD 向路由器请求它的 80 端口，有效期 10 分钟，订单结束时删除映射。路由器分配了别的外部端口就算拒绝，因为 CA 只检查 80 端口。
- **TLS-ALPN-01，用于远程监听端口的路由器端口是 443 时**（`WAN_EXTERNAL_PORT=443`）。远程监听端口用一张带 `acmeIdentifier` 扩展的自签名证书，应答针对该地址反向名称的 `acme-tls/1` 握手；为此，它在拿到证书之前就开始监听。不用映射第二个端口，源是 `https://<address>`，而且 CA 的验证本身就证明了媒体端口能到达。
- **路由器拒绝时。** 节点不下单，所以不消耗失败的授权次数。它的状态、`yolo doctor` 和设置都会写明要做的那一个转发：把 TCP 80 端口转发到 `<节点地址>:9480` 并设置 `WAN_CHALLENGE_MAPPING=manual`；或者把 TCP 443 端口转发到 `<节点地址>:9444` 并设置 `WAN_EXTERNAL_PORT=443` 和 `WAN_MAPPING=manual`，这样媒体也经这一个端口提供。远程监听端口自己的端口和有域名时一样映射，所以路由器只映射 1024 及以上的端口时，转发 80 端口就是路由器上唯一的一步。
- **IPv6。** 当 `WAN_IPV6` 给了监听端口一个全局 IPv6 地址时，证书也覆盖它，用 `[address]:80` 上的 HTTP-01 验证；因为 IPv6 没有 NAT，节点直接在那里监听。节点无法在那里监听、或 CA 到达不了时，节点只为 IPv4 下单，并在一天内不再加入 IPv6。屏幕使用 IPv4 源。

#### 续期和新地址

- 节点为家里的公网 IPv4 地址取得证书：以控制面的 `/.well-known/yolo?address=1` 看到的地址为准，否则以路由器报告的为准；只在远程访问打开、而且家里不在运营商级 NAT 或双重 NAT 之后时才这样做，并且总是用 `shortlived` 配置档。
- 它在这些时候下单：没有当前地址的证书时；160 小时有效期过去三分之二时，也就是大约每 107 小时一次，低于 Let's Encrypt 每周每组标识 5 张证书的限额；以及地址变化后立刻下单。地址变化时它先续一次路由器映射，免得路由器之前的回答被当成又一层 NAT。新证书装好之前，监听端口不会在旧地址下提供任何流。
- CA 那边失败后等 30 分钟再试，每次加倍，最长 6 小时，低于每个标识每小时 5 次失败授权的限额（[限额](https://letsencrypt.org/docs/rate-limits/)）；端口被拒绝时每 30 分钟再试一次；用户本人的开关、页面源或目录一有变化就立刻再试。
- 状态和 ACME 账号的私钥一起放在 `<runtime>/.lan/wan/ip.json`，只有用户本人可读。

#### 控制面

没有域名时，[`edge/wan.js`](../../../../service/control/src/edge/wan.js) 不取名字、不写 DNS 记录、不需要 `MEDIA_DNS_TOKEN`，也不运行 ACME 订单。每次定时任务以及用户本人要求时，它把 `certificate: "ip"`、页面源、用户本人的开关和 `LAN_ACME_DIRECTORY` 发给节点，并把节点的回答保存在 `yolo:wan` 里。节点以有效证书在当前地址下提供服务后，状态就是 `ok`：CA 验证这个地址时已经从外部到达了节点，这取代了 Worker 的探测。welcome 随后以这个源列出 `wan`；源变化时，每个 Hub 都给它已连接的屏幕发送 `media`，屏幕不用重连就会探测新地址。

#### 在家时：路由器的回环

在家的屏幕只有在路由器能回环到自己的公网地址时，才能到达这个地址；RFC 4787 和 RFC 5382 要求 NAT 支持回环，但很多家用路由器仍不支持。Yolo 按每个家庭实测，而不是假定它可用。

- **标记。** Hub 把每块屏幕实时连接的地址（`CF-Connecting-IP`）和上次定时任务记录的家里公网地址比较，并在这块屏幕的 welcome 和 `media` 消息里给 `wan` 标上 `home: true`（[`edge/paths.js`](../../../../service/control/src/edge/paths.js)）。家里的地址本身只留在 Hub 里。屏幕经 IPv6 到达 Cloudflare、而家里是经 IPv4 被看到时，它不会被标记，它的探测也不被当作回环测试。
- **测试。** 被标记的屏幕的 `wan` 探测给出答案：探测有回答时为 `hairpin: "ok"`，没有回答时为 `"failed"`，写在屏幕的 `media_probe` 事件和 `network` 报告里，Hub 会记录下来（[`media-paths.js`](../../../../clients/player/src/media-paths.js)）。
- **没有回环时**，屏幕在中转打开时走中转，否则没有路径；这时 `media_unreachable` 会说家庭网络需要一个域名。

#### 设置里

设置里用户本人的「Media paths」以一张「Without a domain」卡片开头：远程访问打开后，离开家时每块屏幕（包括车）都从家里地址上的节点直接播放；节点自己向路由器请求需要的端口，被拒绝时会写明要转发的那一个端口；在家时，屏幕只有在路由器能回环时才用同一个地址，否则用中转；一个域名（每年约 5 美元起）能让每个浏览器都在家庭网络上直连播放。家庭网络卡片说明它需要域名；远程直连卡片显示按地址的源、CA 验证用的路由器端口和证书的有效期。在每块屏幕上，局域网开关换成「Needs a domain」，路径那一行说明路由器能否回环（[`settings.js`](../../../../clients/player/src/settings.js)）。

#### 按地址访问的监听端口

没有名字时，Host 检查什么也过滤不了：按地址连接的扫描器发送的 `Host` 恰好正确，而浏览器连接地址时不发送 TLS 服务器名。所以监听端口：

- 只对 `Origin` 是页面源的请求回答探测，只向这个源发送 CORS 头，并以空响应体回答所有拒绝（404、405、421、429），扫描器既不知道它到达了 Yolo，也看不到控制面的源；
- 拒绝所有 TLS 服务器名，只有订单进行期间 CA 的验证除外；
- 保留远程监听端口的其他规则：先验 token、再做任何事，一分钟内失败 20 次的对端被拒绝 10 分钟（扫描器得到的每个 404 都算），以及连接数限制（[威胁模型](../architecture/2026-10-13-media-off-the-worker.zh.md#the-threat-model-of-the-remote-listener)）。

这个地址，以及那里运行着 TLS 服务这件事，随每张证书进入证书透明度（Certificate Transparency）日志，大约每周两次。保护监听端口的是狭窄的暴露面和这些限制；对扫描器隐藏它，只是让它少受关注。

#### 没有域名时用户本人要做的设置

| 步骤 | 什么时候需要 |
|---|---|
| 在设置里打开远程访问 | 一次 |
| 路由器上什么都不用做 | 路由器会映射它的 80 端口和远程监听端口的端口时 |
| 把 TCP 80 端口转发到节点的 `WAN_CHALLENGE_PORT`（9480），并设置 `WAN_CHALLENGE_MAPPING=manual` | 路由器只映射 1024 及以上的端口时 |
| 或者把 TCP 443 端口转发到节点的 `WAN_PORT`（9444），并设置 `WAN_EXTERNAL_PORT=443` 和 `WAN_MAPPING=manual` | 路由器什么都不映射时：一个转发同时用于验证和媒体 |
| 打开中转并接受警告 | 只为没有直连路径能到达的屏幕 |

<a id="the-media-dns-token-on-the-domain-tier-only"></a>

### 媒体 DNS token，仅限域名档

按名称的局域网直连和远程直连需要 `MEDIA_DNS_TOKEN`，即一个能编辑 zone 里 DNS 记录的 token，而 `wrangler login` 申请不到 DNS 编辑权限。`npm run yolo -- provision media-dns`（[`ops/lib/media-dns.js`](../../../../ops/lib/media-dns.js)）用 Cloudflare 的命令行工具 `cf` 来创建它，使用一个专用的配置档 `yolo`：用户本人只需登录一次，只授予 `account-api-tokens.write`、`dns.write` 和 `zone.read`（`cf auth create yolo --scopes …`），用户本人自己的 `cf` 登录不受影响。它创建一个归账号所有、名为 "Yolo media DNS" 的 token，只在这个实例的 zone 上具有 DNS Write 和 Zone Read，并把它的值从 `cf` 的输出经 stdin 直接交给 `wrangler secret put MEDIA_DNS_TOKEN`：这个值既不打印，也不写入磁盘。再次运行时，它保留 Worker 上已有的 secret，包括用户本人手工存进去的；`--rotate` 会轮换这个同名 token（如果它覆盖的是别的 zone，先把它改到本实例的 zone），再存入新的值。没有 `cf`，或者用户本人不同意授权时，这一步会打印一个控制台页面，已经填好本实例账号和 zone 上的 DNS 编辑和 Zone 读取权限，再用 `npm run wrangler -- secret put MEDIA_DNS_TOKEN` 粘贴 token。域名实例的 Worker 上既没有 `MEDIA_DNS_TOKEN` 也没有 `LAN_DNS_TOKEN` 时，`doctor` 会指出这一步（`cloudflare.media-dns`）。workers.dev 实例不需要 token，这一步也会这样说明。

### doctor 在 workers.dev 上报告什么

- `config.workersdev` 每次运行都警告：重命名会改变地址，用户本人随后要重做哪些事，以及域名可以消除这个风险。
- `cloudflare.workersdev` 把账号子域名与实例的主机名比较，被重命名后报告失败，并给出修复方法：`init --change-domain`、部署、新的 passkey、重新接入 agent、重新配对屏幕。

## 推迟的部分

- **给屏幕用的 IPv6 源。** 在家且有 IPv6 的屏幕不用回环就能到达节点的全局地址。证书已经覆盖这个地址，但屏幕的流从节点取得源，而节点只提供一个远程源；屏幕得说明它到达的是哪个源。
- **给在家里地址上的屏幕用局域网上限。** 经路由器回环的流不占用上行带宽，所以它可以用 `LAN_MAX_VIDEO_KBPS`，而不是上行带宽的上限。
- **ACME 续期信息（ARI）**，Let's Encrypt 对用它协调的续期免除限额。

## 曾考虑的替代方案

**必须有域名。** 这样只有一档，但在用户本人看到 Yolo 运行之前就要付款、找注册商、设置 DNS，而控制面根本不需要 zone 提供的任何东西。想要局域网直连和稳定的地址，仍然建议用域名。

**给控制面用免费的动态 DNS 名称，例如 deSEC 或 DuckDNS。** Cloudflare 只能为公共后缀下一级的顶点托管 zone，子域名 zone 是 Enterprise 功能，所以 Worker 无法在这种名称上使用自定义域名；而且每次登录都会依赖第三方的可用性。

**用 WebAuthn 相关源请求（Related Origin Requests）把 passkey 带到新地址。** 那样会让 Cloudflare 可能重命名的 workers.dev 主机名永久成为 passkey 依赖方的一部分。6 位数字码已经能让用户本人在家里的机器上恢复。

**同时在 workers.dev 和域名上提供服务。** passkey 和 token 都绑定在一个源上，第二个源只会提供一个无法完成登录的页面。

**必须用 Workers Paid。** 一次连接不再消耗 KV 写入之后，一个家庭用 Free 就够了。每月 5 美元的 Paid 仍然推荐给打开中转或接入很多 agent 的用户本人，它也去掉了 `doctor` 报告的每日上限。

**无状态的签名票据。** 用 `NODE_SECRET` 签名的票据不需要存储，但"只能用一次"仍然需要记住已经用过的票据；而连接本来就要去的那个 Hub 正好能保存这份记录。

**由用户本人把 DNS token 粘贴给 agent。** token 会经过对话。用 `cf` 时，唯一要人做的是一次浏览器授权，token 的值从 Cloudflare 直接进入 Worker secret，不会被展示。

**ACME 放在 Worker 里，由节点应答验证。** 这样每个实例在 KV 里只有一个 ACME 账号，和有名字的路径一样。但它并没有把任何凭据挪离节点，因为 HTTP-01 和 TLS-ALPN-01 不需要凭据；它要围绕一次只有 CA 知道时机的验证，多调用几次 `nodeFetch()` 来打开和关闭节点的应答；每次地址变化都要多等一次定时任务；而 Worker 仍然无法检查结果，因为它不能请求地址。

**永久映射 80 端口，或让验证监听端口一直监听。** 这样续期就不依赖路由器每次都同意映射。但在两次订单之间，80 端口白白暴露在互联网上；而拒绝映射的路由器，无论哪种方式都会拒绝。

**媒体监听端口通过 DuckDNS 或 deSEC 这类免费动态 DNS 服务做 DNS-01。** 有了名字，局域网直连播放和 Host 检查都能回来。但它让每位用户本人的续期和开播都依赖第三方，还要把它的 token 放在家里的机器上；而在 Cloudflare 注册商买一个便宜的域名，能得到同样的结果，也不依赖第三方。

**在家时以纯 HTTP 访问节点的私有地址。** Chromium 在本地网络访问（Local Network Access）提示之后，对私有 IP 字面量免除混合内容拦截，这样没有域名也能局域网直连播放。Safari 和 Firefox 没有这种豁免，媒体 token 会以明文穿过局域网，而特斯拉的浏览器是否授予这个权限也不清楚；它和[局域网直连播放](2026-10-12-lan-direct-play.zh.md)里一样仍被否决。

**默认把媒体端口放在 443。** 源就不带端口，一个端口同时用于验证和媒体。但拒绝 80 端口的路由器出于同样的理由也会拒绝 443，而且用户本人可能已经在家里用着 443；所以它仍由用户本人选择，拒绝时的提示会写明它。

## 后果

只有一个 Cloudflare 账号的用户本人也能零成本部署 Yolo，并拿到完整的控制面。零成本档放弃的是：

- **地址可能改变。** 无论是 Cloudflare 还是用户本人重命名，都意味着用 6 位数字码注册新的 passkey、重新接入每个 agent、重新配对每块屏幕；`doctor` 每次运行都会警告，并能发现重命名。
- **没有按名称的局域网直连**，所以家里的 Safari 和 Firefox 只能走远程路径或中转播放，具体见媒体笔记。
- **workers.dev 是共享的后缀。** Cloudflare 把它定位为个人或业余项目的去处。一些学校、公司和 DNS 过滤器会拦截或标记 workers.dev 主机名，账号子域名也一直公开在证书透明度日志里。Cache API 在那里不起作用（Yolo 没有用它），超过每日上限的请求得到 Error 1027，没有放行选项。
- **同一账号里的另一个 Worker 与 Yolo 同站**；专用账号可以消除这一点。

在 Workers Free 上，一个家庭的 KV 写入不再随重连增长。Free 上剩下的风险是：每个请求 10 毫秒的 CPU 时间（在 Node 里实测，热的 MCP 请求为 1–2.4 毫秒；冷 isolate 的第一个请求可能超过 10 毫秒，Cloudflare 允许偶尔超出；请留意 Workers Logs 里的 `exceededCpu`）；重新排序超过 50 项的播放列表时会碰到每次调用 50 个查询的上限；以及 Workers VPC 测试期结束后的价格尚未公布。部署期间由上一版 Worker 签发的票据会失败一次，客户端随后申请新的票据。

在媒体上，没有域名、也不花钱的用户本人，离开家时也能播放，包括用 LTE 的车：路由器会映射 80 端口和媒体端口时，路由器上什么都不用做，否则做一个端口转发；Cloudflare 不承载任何媒体。处在运营商级 NAT 之后时一切照旧：没有远程路径。

没有域名时媒体的代价：

- 每四天半一次的续期依赖路由器当时同意映射 80 端口；续期失败后证书仍有大约 53 小时的有效期，退避会一直重试。
- 新地址会让 `wan` 中断：节点下一次检查（最多 5 分钟）、一次订单（大约一分钟）和下一次定时任务（最多 5 分钟），之后每个 Hub 会通知已连接的屏幕。
- 在家时，直连播放依赖路由器的回环，而很多路由器不支持；屏幕的报告会按家庭显示它，而一个域名能去掉这个依赖。
- 家里的地址大约每周两次进入证书透明度日志，并和一个 TLS 服务关联起来。
- 节点要向 CA 发送请求，并持有一个 ACME 账号密钥。
- 此前版本的节点会对 `certificate: "ip"` 回答错误，所以节点要先于 Worker 升级，每次发布都是这个顺序（[版本与发布](../process/2026-10-13-versions-and-releases.zh.md)）；只有没有域名的实例才会发送这个字段，所以 `NODE_PROTOCOL` 不变。

## 测试

[`wan-ip.test.js`](../../../../service/node/test/wan-ip.test.js) 让节点对接回环地址上的一个 ACME 替身：它检查每个 JWS 签名、`shortlived` 配置档和 `ip` 标识，并像 CA 经路由器那样连接节点的端口来验证。覆盖的情形有：经一个为订单建立、订单结束后删除的 80 端口映射完成 HTTP-01；路由器端口为 443 时在远程监听端口上完成 TLS-ALPN-01；80 端口被拒绝时留下要做的转发、不下单；新地址在重新询问路由器后立刻取得证书；有效期过去三分之二时续期；以及按地址连接的扫描器得到空的 404、看不到控制面的源。[`edge.test.js`](../../../../service/control/test/unit/edge.test.js) 在没有 DNS token 的情况下跑控制面这一侧：Worker 不做 DNS、ACME 或探测，状态和 welcome，源变化时通知屏幕，以及错误里带着节点的提示。[`hub-core.test.js`](../../../../service/control/test/unit/hub-core.test.js) 钉住只有在家里地址上的屏幕才会得到的 `home` 标记、`hairpin` 报告、写明需要域名的拒绝，以及 `media` 消息；[`media-paths.test.js`](../../../../clients/player/test/unit/media-paths.test.js) 钉住有回环和没有回环时的回环报告，以及收到 `media` 后探测新源。没有任何测试请求 Let's Encrypt 或真实路由器。
