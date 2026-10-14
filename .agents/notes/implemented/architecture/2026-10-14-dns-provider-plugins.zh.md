# Agent Note: 由 DNS provider 插件为媒体监听端口命名，deSEC 是第一个

Status: implemented

[English](2026-10-14-dns-provider-plugins.md) | 中文

## 问题

局域网直连播放需要一个指向节点私有地址的公网名称和这个名称的证书，按名称的远程直连播放也需要一个指向家里公网地址的名称和证书（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)、[媒体流离开 Worker](2026-10-13-media-off-the-worker.zh.md)）。两者的名称都来自实例域名所在的 Cloudflare 区域。没有域名的实例运行在 workers.dev 上，没有区域（[无域名部署](../feature/2026-10-13-no-domain-deployment.zh.md)）：在家的屏幕只有在路由器能回环到家里公网地址的地方，才能从这个地址播放，否则走 Worker 的中转；家里的 Safari 和 Firefox 永远用不上局域网直连播放；远程监听端口的每张证书，在 CA 检查期间都需要路由器的 80 端口。免费的动态 DNS 服务不用购买就能提供名称和 DNS API，但每家的 API 都不同，而核心、控制面和节点都不能包含具体服务商的代码（[插件架构](2026-10-11-plugin-architecture.zh.md)）。

## 决策

节点的媒体名称来自一个 **DNS provider（DNS 服务商）**：内置的 Cloudflare 区域，或者由某个插件的控制面入口注册的服务商。实例在 `media.dns` 里选择其一。deSEC（desec.io）的免费 `dedyn.io` 名称带有管理记录的 REST API，适合 DNS-01，它是第一个插件 [`plugins/dns-desec`](../../../../plugins/dns-desec/)。它是可选的：Cloudflare 上的域名仍是推荐的路径，什么都不设置的实例行为不变。

Yolo 是一个家庭自用的私有服务。为了在没有域名时用上局域网直连播放，用户本人可以在知情的前提下接受媒体名称的续期和地址更新依赖第三方。这个取舍不替每位用户本人做，控制面也永远不搬到这类名称上。

### 服务商接口

[`service/control/src/edge/dns.js`](../../../../service/control/src/edge/dns.js) 选择服务商，并规定 `edge/` 调用的接口；`@useyolo/plugin-api` 把它定义为类型 `DnsProvider`。

| 成员 | 约定 |
|---|---|
| `zone(pageHost)` | 名称所在的区域 `{ id, name, … }`，只调用一次并保存在媒体状态里；服务商可以更新它自己的字段（例如 TTL），状态会保留新值。Cloudflare 的区域是包含控制面主机名的最具体的区域 |
| `setAddress(zone, name, type, address)` | 创建或移动这个名称唯一的 A 或 AAAA 记录：仅 DNS，TTL 很短 |
| `clearAddress(zone, name, type)` | 删除它；记录不存在时也算成功 |
| `setTxt(zone, name, value)` | 在 `_acme-challenge.<name>` 上设置 DNS-01 值并返回一个句柄；同一时间只有一个订单，所以它可以替换那里已有的任何值 |
| `clearTxt(zone, name, value, handle)` | 删除这个值，或者连同这个名称的所有 TXT 值一起删除 |
| `settleMs` | 公共解析器答出新值之后，CA 再等多久才检查；默认为 0，最多 5 分钟 |

- **注册。** 控制面入口调用 `yolo.registerDnsProvider(id, { title, secret, create })`（[`service/control/src/plugins.js`](../../../../service/control/src/plugins.js)）。`id` 由小写字母、数字和连字符组成，不能是 `cloudflare`。`secret` 指定保存服务商凭据的 Worker secret：它以大写的 id 开头（`desec` → `DESEC_TOKEN`），不是 Yolo 的 Worker 读取的任何名字（它的 secret，例如 `NODE_SECRET` 和 `MEDIA_DNS_TOKEN`，它的 var，以及它的绑定，例如 `OAUTH_KV`、`DB`、`HUB` 和 `NODE`），也不属于别的服务商。每次运行时，控制面用这个 secret 的值和实例的区域调用 `create({ token, zone, fetch, sleep })`，而且只在这个值是字符串时才调用，所以同名的绑定从不会交出去。
- **选择。** 实例文件里的 `media.dns` 渲染为 var `MEDIA_DNS_PROVIDER` 和 `MEDIA_DNS_ZONE`。默认值 `cloudflare` 就是域名所在的区域加上 `MEDIA_DNS_TOKEN`，与原来一样。其他任何 id 都表示那个插件的服务商和那个插件的 secret。选中的服务商如果插件没有打包进来，或者缺少 secret，就会在媒体状态里记为错误，设置页和 `doctor` 都会显示。控制面从不退回到另一个服务商，因为那样会把一个服务商的 token 交给另一个服务商。
- **在服务商之间迁移。** 媒体状态把 Cloudflare 以外的服务商和它的区域记为 `yolo:lan` 和 `yolo:wan` 里的 `dns`，所以有服务商之前的状态会被当作 Cloudflare 的状态读取，名称保持不变。服务商或区域变化时，每个名称会在新区域里重新选定，记录写到新区域，并为新名称申请证书。之前服务商那里的记录留在原处。
- **没有域名时。** 插件的服务商给 workers.dev 实例带来了名称，所以那里的 `media.wan.certificate` 和有域名时一样默认为 `"name"`：局域网直连播放，以及使用 DNS-01 和 Worker 外部检查的按名称远程直连播放。设为 `"ip"` 则让远程监听端口继续使用家里的地址。welcome 不再带 `domain: false`，每块屏幕的设置里重新出现局域网开关。
- **token 放在哪里。** 插件的服务商和 Cloudflare 一样，DNS-01 在 Worker 里运行，所以 token 是 Worker secret，从不到达家里的机器；在那台机器上，每个节点插件都能读取 `.env`（[插件架构](2026-10-11-plugin-architecture.zh.md)）。
- **setup 入口。** DNS provider 插件的 `package.json` 可以声明 `yolo.setup`：运维命令行在用户本人的机器上导入的模块，内容包括服务商的 id、名称和 secret、用户本人要做的步骤、对名称和 token 的检查，以及服务商的域名服务器。`provision media-dns` 和 `doctor` 通过 Worker 构建时读取的同一份插件配置找到它（[`ops/lib/media-dns.js`](../../../../ops/lib/media-dns.js)），所以命令行里不含任何服务商的 API。

<a id="runs-orders-and-their-limits"></a>

### 运行、订单和它们的限制

有等待时间的服务商会让订单变长，而 Worker 运行在 Workers Free 上：定时任务每 5 分钟触发一次，一次定时运行最多 15 分钟，一次调用最多 50 个子请求。一个 deSEC 订单大约需要 4 分钟：最多 4 次询问公共解析器，间隔 15 秒，然后等待 150 秒，再完成 ACME 交互；遇到两次限速重试和 5 分钟的等待时间时，可能需要大约 13 分钟。如果不加限制，在一次运行里申请两张首张证书需要大约 7 分钟，在解析器一直回答 NXDOMAIN 时最多约 80 个子请求，而期间开始的另一次运行会重新为远程监听端口命名，于是第一次运行的证书被拒绝，还留下一条记录。[`edge/maintain.js`](../../../../service/control/src/edge/maintain.js) 和 [`edge/lease.js`](../../../../service/control/src/edge/lease.js) 把两者都限制住了：

- **每次运行一个订单。** 局域网和远程维护共用一次运行，它最多申请一张证书；另一个名称保留它的名称和记录，在 5 分钟后的下一次运行里拿到证书。Cloudflare 的区域也是如此。
- **只管命名和订单的租约。** 一次运行在订单开始时向 KV 写入一个租约（`yolo:edge:lease`），运行结束时如果租约仍是自己的就删除它；它 15 分钟后自行过期，这是一次定时运行的时长上限。别的运行持有租约时，一次运行不为节点选择名称，也不申请证书，其余的事照做：远程访问开关立即关闭或打开监听端口，已有名称的记录保持最新。只有订单才写租约，所以 5 分钟一次的定时任务远在 Workers Free 每天 1,000 次 KV 写入和删除之内；KV 大约一分钟内达到一致，远短于两次定时运行之间的 5 分钟。
- **订单之前先保存。** 订单开始之前，区域、名称和它的记录已写入媒体状态，所以之后的运行不会再为节点重新命名。
- **用户本人的检查不等任何慢的东西，也不命名。** 设置里的「Check now」和远程访问开关在一个 HTTP 请求里运行，页面关闭就会取消它，而且它可能由一个 KV 还看不到定时运行的租约或已保存名称的地点处理。遇到有等待时间的服务商时，它们从不选择名称，也不申请证书：还不存在的名称留给定时运行，卡片上显示待处理。已有名称的记录、开关和监听端口则立即处理。
- **留下的记录。** 远程访问关闭时，节点的监听端口先关闭；然后尽力删除记录，删除失败时，之后的运行按证书的退避机制再试，30 分钟起，每次加倍，最长一天。
- **质询的 RRset。** 同一时间只有一个订单，所以 deSEC 的 `setTxt` 把 RRset 设为只有新值，`clearTxt` 删除它：每个订单两个请求，不需要读取，之前删除失败留下的值会随下一个订单一起消失。

在替身环境里测量，一次依次申请两个名称首张证书的运行，在解析器从不回答时最多约 25 个子请求。

### deSEC 插件

`@useyolo/dns-desec` 是官方插件，但不在 `plugins/official.json` 里：实例只有选用 deSEC 之后才加载它。在加载官方列表的实例上，`provision media-dns --provider desec` 会写一个 `yolo.config.json`，先原样列出官方插件，再加上 `./plugins/dns-desec`；用户本人自己的插件配置从不被改动，`provision` 和 `doctor` 会说明要往里加的那一项。这个插件只有控制面入口，所以节点加载的插件和以前一样。它读取 secret `DESEC_TOKEN`，用 [`edge/names.js`](../../../../service/control/src/edge/names.js) 在任何区域里都使用的标签，在实例的 deSEC 名称下为节点命名，例如 `yolo-lan-3f9a01c2.home.dedyn.io` 和 `yolo-wan-0badcafe.home.dedyn.io`。

插件依赖的事实，来自 deSEC 截至 2026-10-14 的文档和源码：

| 事实 | 来源 | 插件的做法 |
|---|---|---|
| 请求用 `Authorization: Token <secret>` 认证 | [token](https://desec.readthedocs.io/en/latest/auth/tokens.html) | 每个请求都带上它，从不把它写进错误信息 |
| 对 `domains/{name}/rrsets/` 的批量 `PUT` 创建或替换其中列出的 RRset，`records` 为空的 RRset 被删除；对单个 RRset 的 `DELETE` 无论它是否存在都回答 204；URL 里用 `@` 表示顶点；TXT 内容要加引号 | [RRset](https://desec.readthedocs.io/en/latest/dns/rrsets.html) | 每次变更只写一次；质询值与同一名称上的其他 TXT 值并存，删除时只删自己 |
| RRset 的 TTL 不低于域名的 `minimum_ttl`，由 deSEC 设定：dedyn.io 下一级的名称为 60 秒，其他域名为一小时，除非 deSEC 调低 | [域名](https://desec.readthedocs.io/en/latest/dns/domains.html)、[deSEC，2020](https://talk.desec.io/t/dyndns-and-lets-encrypt-using-custom-domain/17) | 随区域一起读取 `minimum_ttl`，每条记录都按它写入，至少 60 秒 |
| 每个账号只能有一个 dedyn.io 下的名称 | [域名](https://desec.readthedocs.io/en/latest/dns/domains.html) | 节点的两个名称是这一个名称下的标签 |
| RRset 写入按域名限速：每秒 2 次、每分钟 15 次、每小时 100 次、每天 300 次；读取每秒 10 次、每分钟 50 次；429 带有 `Retry-After` | [限速](https://desec.readthedocs.io/en/latest/rate-limits.html) | 按 `Retry-After` 等待，最多一分钟；没有这个头时先等 1 秒、再等 2 秒；最多重试两次；需要等更久时以 `rate_limited` 失败，由下一次运行或证书的退避机制再试 |
| 在 dedyn.io 下，A 记录只有落在被封禁的网段里才会被拒绝，而封禁列表从不收录私有网段 | desec-stack 的 [`records.py`](https://github.com/desec-io/desec-stack/blob/main/api/desecapi/serializers/records.py) 和 [`stop-abuse.py`](https://github.com/desec-io/desec-stack/blob/main/api/desecapi/management/commands/stop-abuse.py)、[deSEC，2023](https://talk.desec.io/t/unable-to-add-azure-ip/593) | 为局域网名称发布节点的 RFC 1918 地址 |
| 写入会立即发布，但 deSEC 的任播域名服务器同步时间不一：通常几秒内，有时晚一分钟左右，2026 年 7 月的测量中个别服务器落后约 170 秒；certbot-dns-desec 等待 80 秒 | [deSEC，2021](https://talk.desec.io/t/global-record-propagation-issues/332)、[DNS-01 传播，2026](https://talk.desec.io/t/inconsistent-propagation-between-authoritative-nameservers-during-acme-dns-01-challenge/1790)、[certbot-dns-desec](https://github.com/desec-io/certbot-dns-desec) | `settleMs` 为 150 秒：控制面等到公共解析器答出质询值，再等 150 秒，然后才让 CA 检查 |
| `dedyn.io` 在公共后缀列表上 | [列表](https://publicsuffix.org/list/public_suffix_list.dat) | Let's Encrypt 每周 50 张证书的限额按用户本人自己的名称计算，而不是整个 dedyn.io |

每张证书在每个名称上写入两次（添加和删除质询值），90 天的证书大约每 60 天一次；地址变化写入一次。两者都远在 deSEC 的限额之内。

### 用户本人的设置

| 步骤 | 由谁做 |
|---|---|
| 在 desec.io 注册一个免费的 `<name>.dedyn.io`，并确认邮件 | 用户本人 |
| `npm run yolo -- provision media-dns --provider desec --zone <name>.dedyn.io`，它记下 `media.dns`、列入插件，并打印用户本人要做的步骤 | agent |
| 在 deSEC 的 Token Management 里创建一个 token；没有密码的账号先通过「Forgot password」设置密码 | 用户本人 |
| 在自己的终端里运行 `npm run yolo -- provision media-dns --token-stdin`：token 的输入不回显，用一次对 deSEC 域名的读取检查它，再通过 stdin 交给 `wrangler secret put` 存为 `DESEC_TOKEN`；它从不被打印或写入磁盘 | 用户本人 |
| `npm run yolo -- deploy`，它打包插件并设置 var，然后运行 `npm run yolo -- doctor` | agent |
| 和有域名时一样：在每块屏幕上打开「Play over the home network」，允许浏览器的局域网访问提示，路由器过滤私有地址应答时把 `<name>.dedyn.io` 加入 DNS rebinding 白名单 | 用户本人 |

`doctor` 检查插件在插件配置里（`config.media-dns`）、Worker 有这个 secret（`cloudflare.media-dns`）、公共 DNS 把名称委派给 deSEC 的域名服务器（`dns.delegation`），以及 Worker 的局域网状态：Worker 是否部署于设置 `media.dns` 之前，或者 deSEC 返回的错误（`worker.media-dns`）。[`yolo-deploy`](../../../../skills/yolo-deploy/SKILL.md) 技能带 agent 走完这些设置。

## 曾考虑的替代方案

**默认给每个没有域名的实例一个免费动态 DNS 名称。** 那样每位用户本人的续期和地址更新都会依赖一个他们没有选择的第三方。作为可选项，这个取舍由用户本人决定，默认行为仍如[无域名部署](../feature/2026-10-13-no-domain-deployment.zh.md)所述。

**把控制面放在动态 DNS 名称上。** 仍按[无域名部署](../feature/2026-10-13-no-domain-deployment.zh.md)给出的理由否决：Worker 无法在这种名称上使用自定义域名，而且每次登录都会依赖第三方。只有媒体名称换了地方。

**先做 DuckDNS。** 一个 DuckDNS 名称只有每种类型一个地址和一个 TXT 值，它下面的所有名称共用它们，并通过一个把 token 放在查询参数里的更新网址设置；节点的两个名称无法成为同一个 DuckDNS 名称下的标签。deSEC 有按名称管理 RRset 的记录 API、放在请求头里的 token 认证，以及有文档的限额。

**所有服务商共用一个 secret 名称 `MEDIA_DNS_TOKEN`。** 这会让 `doctor` 和设置页更简单，但在 `media.dns` 改变之后、新的 secret 存入之前，Worker 会把一个服务商的 token 发给另一个服务商的 API。每个服务商各用一个 secret，就不会串用。

**在节点上用服务商的 token 跑 ACME。** 和 Cloudflare 的 token 一样，token 会放在每个节点插件都能读取的地方（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。

**每次运行都写租约。** 那样也能覆盖不申请证书的运行，但 5 分钟一次的定时任务每天要为它花掉 288 次 KV 写入和 288 次删除，而 Workers Free 各只有 1,000 次；只有订单需要它。

**轮询 deSEC 的域名服务器，而不是固定等待。** `ns1.desec.io` 和 `ns2.desec.org` 各是由多台服务器组成的任播组：Worker 发出的查询到达的是离 Cloudflare 最近的服务器，而不是 CA 各个验证点会到达的服务器，所以一次应答说明不了什么；而且 Worker 除了 DNS over HTTPS 之外没有 DNS 客户端。公共解析器的应答加上固定等待，足以覆盖测量到的延迟。

**把 deSEC 的 API 写进运维命令行。** 那只能服务 deSEC；setup 入口把服务商的 API 和用户本人的步骤留在它的插件里，其他服务商的插件可以带上自己的。

**把 deSEC 插件列进 `plugins/official.json`。** 那样每个实例都会打包它，在选用之前不起作用，也没有实例需要为它写 `yolo.config.json`。但官方列表是节点加载并启动的列表，其中每一项都是节点提供的片源；只有控制面入口的插件，应该放在选用它的实例自己的列表里。

## 后果

带来的好处：

- 没有域名的用户本人也能在所有浏览器里使用局域网直连播放，以及按名称的远程直连播放，不用购买任何东西，路由器也不用开放 80 端口。
- 其他实例都不受影响：Cloudflare 服务商还是同一份代码，只是放到了接口后面，它的媒体状态保留原来的名称。

付出的代价：

- **deSEC 成为用户本人直连播放的依赖。** deSEC 的 API 或域名服务器出故障时，续期和地址更新都会失败。证书会一直服务到过期，也就是续期到期之后它剩下的三分之一寿命；没有直连路径可达的屏幕由中转承载。
- **token 的权限范围。** 设置流程创建的是不受限的 token，它能修改用户本人 deSEC 账号里的每条记录。deSEC 的 token 策略可以把它限制在节点的名称和对应的 `_acme-challenge` 记录上。
- **时间。** 因为要等待，deSEC 名称的证书需要大约 4 分钟，而不是几秒，而且只有定时运行才会申请它：首次设置时，局域网名称在一次运行里拿到证书，远程名称在下一次运行里拿到；在此之前，设置里的「Check now」显示证书待签发。
- **公开的信息。** 节点的私有地址、家里的公网地址和这些名称，会以用户本人的名称进入公共 DNS 和证书透明度日志，和使用域名时一样。
- **迁移会留下记录。** 换了服务商或名称之后，之前服务商那里的记录会一直留着，直到用户本人在那里删除。
- **实例有了自己的插件配置。** 在官方列表上选用 deSEC 的实例，从此从 `yolo.config.json` 加载插件，所以之后某个版本加进 `plugins/official.json` 的官方插件，要等它也列进这个文件，才会到达这个实例。
- **TTL。** deSEC 上的自定义域名最低 TTL 为一小时，新地址可能要这么久才能到达屏幕；dedyn.io 名称只需 60 秒。
- **deSEC 没有说明：**它是否会限制来自 Cloudflare Workers 地址的请求。

## 测试

[`plugins/dns-desec/test/`](../../../../plugins/dns-desec/test/) 让服务商对着 deSEC API 的替身运行：认证头、批量写入及其 TTL、重新读取被 deSEC 调高的 TTL、顶点、替换旧值的质询值以及订单之后用两个请求删除的 RRset、拒绝区域外的名称、带和不带 `Retry-After` 的 429、对一次运行来说过长的等待、502、deSEC 对被封禁地址返回的 400、401 和 403，以及无应答，任何信息里都没有 token；还有 setup 入口的步骤及其对名称和 token 的检查。[`plugins.test.js`](../../../../service/control/test/unit/plugins.test.js) 固定注册规则，包括 secret 的名字和归属。[`edge.test.js`](../../../../service/control/test/unit/edge.test.js) 在 workers.dev 实例上运行一个服务商插件的替身：两个名称都在它的区域里、两条记录、CA 检查之前的等待时间、不带 `domain: false` 的 welcome；缺少插件或 secret 时从不退回 Cloudflare；从 Cloudflare 迁移过来时重新命名节点并在新区域写入记录，而 Cloudflare 的状态保持原有结构。它还运行定时任务的各次运行：每次运行一个订单；在另一次运行的订单期间开始的运行沿用第一次运行在订单之前保存的名称，也不申请证书；在另一次运行的租约下远程访问开关立即生效；KV 视图过时的用户本人检查不命名；15 分钟的租约，运行只在租约仍是自己的时候才删除它；某条路径或插件加载失败时照旧记录日志；留下的记录按退避机制重试；解析器从不回答时最多 50 个子请求；用户本人的检查把慢订单留给定时运行；等待时间的上限；作为 secret 被拒绝的绑定；只在选用服务商时才加载插件；以及 DNS 出故障时关闭远程访问，会先关闭监听端口。[`media-dns-plugin.test.js`](../../../../ops/test/media-dns-plugin.test.js) 固定实例文件、通过插件配置找到插件并把它列在官方插件之后，而不改动用户本人自己的配置、预览时也不写任何东西，跳过 setup 入口出错的插件、`provision` 的步骤和不回显、从不显示的 token 读取，以及 `doctor` 的检查。没有任何测试调用 deSEC、Let's Encrypt 或 Cloudflare。
