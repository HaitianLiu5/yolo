# Agent Note: 在已登录的屏幕上连接家里机器上的 agent

Status: proposed

[English](2026-10-22-remote-agent-approval.md) | 中文

## 问题

家里机器上的 agent CLI（如 Codex 或 Claude Code）用[授权服务器](../../implemented/architecture/2026-10-07-oauth-authorization-server.zh.md)发的 OAuth 令牌连接 Yolo 的 MCP 服务器。它的 MCP 登录是带 PKCE 的授权码流程，靠回环地址跳转：CLI 在 `127.0.0.1` 上开一个监听，打印授权链接，然后等浏览器跳回这个监听。MCP 授权规范只定义了这一种流程，所以这些 CLI 不提供连接 MCP 服务器的 device code 登录（Codex 的 `--device-auth` 只用于登录 OpenAI）。

主人通常不在家里那台机器旁边。在手机上批准后，手机浏览器会跳到手机自己的 `127.0.0.1`，打不开；主人只能把这个打不开的地址手动抄回家里的机器。Codex 0.144.4 固定只等 300 秒，所以用手机登录常常超时。凡是靠回环跳转登录的 agent 都是这样，[屏幕向主人的 agent 提问](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)也一样，因为它用的就是这个 agent 自己对 Yolo 的登录。

## 提案

家里机器上的一条命令通过 device grant 向 Yolo 申请 agent 令牌；主人在任何一个已登录的屏幕上批准，命令再把令牌写到 agent 读取的位置。

### 流程

1. 主人（或替主人干活的 agent）在家里的机器上运行 `npm run yolo -- connect <agent>`（例如 `codex`）。它向 `POST /oauth/device_authorization` 申请授权，带上 `grant=agent`、agent 的 id 和机器名，然后像 `cf` 和 `npm run yolo -- auth` 那样打印一个短码和 `verification_uri_complete`。
2. Yolo 把待批准的请求展示给已登录的主人：链接打开的批准页上有；每个已连接的播放器和 Apple TV 应用上通过实时通道弹出横幅；设置里有待批准请求列表。请求写明 agent、机器、短码和权限范围，每个范围都能像在授权页上一样关掉。
3. 主人核对短码与命令打印的一致，用 passkey 会话按 **Allow**。和屏幕配对一样，批准只接受同源提交。
4. 命令用 device code grant 轮询 `POST /oauth/token`，拿到 Yolo 源站的访问令牌和刷新令牌。受众和权限范围与 agent 走授权码流程拿到的相同，所以 `/mcp` 和 `/v1` 无需改动就能接受。
5. agent 的插件把令牌写进 agent 自己的凭据存储，并用一次只读的 MCP 调用检查。对 Codex 来说是 `$CODEX_HOME/.credentials.json`（或钥匙串），键由服务器名和其配置的哈希组成，并填上 issuer，让 Codex 自己续期令牌。

一次授权只能用一次，10 分钟后过期，所以不再受 CLI 自身超时的限制。

### 各部分放在哪里

- 控制面在 `service/control/src/auth/device.js` 里扩展[设备码授权](../../implemented/feature/2026-10-07-device-code-pairing.zh.md)，加一种 agent 授权，最终得到由 provider 持有的 OAuth 授权，而不是设备凭据。首先要确认 `workers-oauth-provider` 能否为不经跳转完成的授权签发令牌；如果不能，控制面就在内部为这个请求完成一次普通授权。
- 待批准的请求作为实时消息经主人的 Hub 送到已登录的屏幕；没有主人会话的屏幕什么也不显示。
- 写令牌因 agent 而异，所以每个 agent 插件导出一个 `connect` 入口供命令调用；命令和控制面都不出现任何 agent 的名字。
- 推送到锁屏手机的通知（Web Push，iOS 只允许已添加到主屏幕的网页应用使用）放到以后；先做横幅和设置里的列表。

## 考虑过的替代方案

**粘贴打不开的地址。** 主人在手机上批准，再把 `127.0.0.1` 地址发回家里的机器。现在就能用，但要手动复制一个带凭据的 URL，而且对 Codex 来说必须在 300 秒内完成。自己完成授权码交换的脚本能去掉时间限制，但去不掉复制这一步。

**环境变量里的长期 bearer 令牌。** Codex 能从 `bearer_token_env_var` 读取 bearer 令牌。Yolo 就得签发一个永不过期、没有刷新的令牌，而授权服务器正是要为 agent 避免这种令牌；主人还得在 agent 运行的每个 shell 里设置这个变量。

**通过 Yolo 中转跳转。** 把 CLI 的回调地址设成 Yolo 的一个路由，由它经节点把授权码转发到 CLI 的回环监听。这不用改 agent 的凭据存储，但只在 agent 运行在节点所在机器上时可行，CLI 的 300 秒限制仍在，授权链接也仍要从家里的机器传到手机上。

**等 agent 支持 MCP 的 device code 登录。** MCP 授权规范里没有任何地方要求这一点。

**只用每个问题的令牌。** [和主人的任意一个 agent 对话](2026-10-18-multi-agent-conversations.zh.md)提议由 Yolo 为屏幕的每个问题签一个短期令牌，这样 Ask 就不需要任何登录。但它不覆盖主人自己和 agent 的会话，而本提案覆盖。

## 验收标准

- 主人在外面用手机就能连接家里机器上的 Codex：运行命令或让 agent 去运行，在 Yolo 页面或播放器的横幅里用 passkey 批准，之后 Codex 就能调用 Yolo 的 MCP 工具，全程不用复制任何地址。
- 令牌一小时后无需主人操作即可续期。
- 10 分钟内未批准或被拒绝的请求，不改动 agent 的凭据存储。
- `service/` 下没有任何文件出现 agent 的名字。

## 风险

- 写入 agent 的凭据存储依赖 agent 没有公开的格式，agent 升级可能让它失效。插件写入后的检查能发现并报告这一点，格式由插件负责。
- 每个已登录屏幕上都出现待批准请求，容易让主人批准一个不是自己发起的请求。短码、机器名和 10 分钟有效期限制了这一点；被拒绝或过期的请求不会再显示。
- agent 授权给 agent 的权限与授权码流程相同，所以批准时保留同样的 passkey 会话和权限范围控制。
