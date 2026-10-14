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

零成本实例的用户本人拿到完整的控制面：站点根路径上的播放器、用 6 位数字码完成的 passkey 登录、屏幕配对、通过 MCP 和 OAuth 接入的 agent、`/v1`，以及 Hub。媒体路径归 [媒体流离开 Worker](../architecture/2026-10-13-media-off-the-worker.zh.md) 管。没有 zone 就没有局域网名称和远程名称，也没有 `MEDIA_DNS_TOKEN`，所以定时任务无事可做；实例文件记录 `media.wan.certificate: "ip"`：节点的远程监听端口用自己的公网地址而不是名称取得证书，具体见那篇媒体笔记。

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
| 没有域名 | | 约 155：没有媒体名称的状态 |

### doctor 在 workers.dev 上报告什么

- `config.workersdev` 每次运行都警告：重命名会改变地址，用户本人随后要重做哪些事，以及域名可以消除这个风险。
- `cloudflare.workersdev` 把账号子域名与实例的主机名比较，被重命名后报告失败，并给出修复方法：`init --change-domain`、部署、新的 passkey、重新接入 agent、重新配对屏幕。

## 曾考虑的替代方案

**必须有域名。** 这样只有一档，但在用户本人看到 Yolo 运行之前就要付款、找注册商、设置 DNS，而控制面根本不需要 zone 提供的任何东西。想要局域网直连和稳定的地址，仍然建议用域名。

**给控制面用免费的动态 DNS 名称，例如 deSEC 或 DuckDNS。** Cloudflare 只能为公共后缀下一级的顶点托管 zone，子域名 zone 是 Enterprise 功能，所以 Worker 无法在这种名称上使用自定义域名；而且每次登录都会依赖第三方的可用性。

**用 WebAuthn 相关源请求（Related Origin Requests）把 passkey 带到新地址。** 那样会让 Cloudflare 可能重命名的 workers.dev 主机名永久成为 passkey 依赖方的一部分。6 位数字码已经能让用户本人在家里的机器上恢复。

**同时在 workers.dev 和域名上提供服务。** passkey 和 token 都绑定在一个源上，第二个源只会提供一个无法完成登录的页面。

**必须用 Workers Paid。** 一次连接不再消耗 KV 写入之后，一个家庭用 Free 就够了。每月 5 美元的 Paid 仍然推荐给打开中转或接入很多 agent 的用户本人，它也去掉了 `doctor` 报告的每日上限。

**无状态的签名票据。** 用 `NODE_SECRET` 签名的票据不需要存储，但"只能用一次"仍然需要记住已经用过的票据；而连接本来就要去的那个 Hub 正好能保存这份记录。

## 后果

只有一个 Cloudflare 账号的用户本人也能零成本部署 Yolo，并拿到完整的控制面。零成本档放弃的是：

- **地址可能改变。** 无论是 Cloudflare 还是用户本人重命名，都意味着用 6 位数字码注册新的 passkey、重新接入每个 agent、重新配对每块屏幕；`doctor` 每次运行都会警告，并能发现重命名。
- **没有按名称的局域网直连**，所以家里的 Safari 和 Firefox 只能走远程路径或中转播放，具体见媒体笔记。
- **workers.dev 是共享的后缀。** Cloudflare 把它定位为个人或业余项目的去处。一些学校、公司和 DNS 过滤器会拦截或标记 workers.dev 主机名，账号子域名也一直公开在证书透明度日志里。Cache API 在那里不起作用（Yolo 没有用它），超过每日上限的请求得到 Error 1027，没有放行选项。
- **同一账号里的另一个 Worker 与 Yolo 同站**；专用账号可以消除这一点。

在 Workers Free 上，一个家庭的 KV 写入不再随重连增长。Free 上剩下的风险是：每个请求 10 毫秒的 CPU 时间（在 Node 里实测，热的 MCP 请求为 1–2.4 毫秒；冷 isolate 的第一个请求可能超过 10 毫秒，Cloudflare 允许偶尔超出；请留意 Workers Logs 里的 `exceededCpu`）；重新排序超过 50 项的播放列表时会碰到每次调用 50 个查询的上限；以及 Workers VPC 测试期结束后的价格尚未公布。部署期间由上一版 Worker 签发的票据会失败一次，客户端随后申请新的票据。
