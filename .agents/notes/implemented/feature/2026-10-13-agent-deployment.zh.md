# Agent Note: 由 agent 替用户本人部署和升级实例

Status: implemented

[English](2026-10-13-agent-deployment.md) | 中文

## 问题

Yolo 过去由人手工部署给一个用户本人。被跟踪的 `service/control/wrangler.jsonc` 就是这个用户本人的实例（域名，以及 D1、KV 和 VPC 的 id），所以其他人都得修改一个几乎每次提交都在变的被跟踪文件。没有任何地方说明怎样创建隧道、怎样让节点开机运行，没有一个地方汇总部署的状态，也没有升级或回退的流程。用户本人预计会让 agent（智能体）来做这些事，例如朋友的 agent 在一个全新的克隆里操作，所以仓库必须自带脚本、技能，以及需要用户本人介入的停止点。

## 决策

### 实例文件

一个实例的身份是检出目录根部被 git 忽略的 `yolo.instance.json`（或 `YOLO_INSTANCE` 指定的文件），加上节点 `.env` 里的 `NODE_SECRET`。[`yolo.instance.example.json`](../../../../yolo.instance.example.json) 列出了每个字段：

| 字段 | 含义 |
|---|---|
| `domain` | Yolo 对外服务的主机名；除非 `publicOrigin` 另有指定，`PUBLIC_ORIGIN` 就是 `https://<domain>` |
| `accountId`、`worker` | Cloudflare 账号和 Worker 的名称（`yolo-control`） |
| `d1`、`kv` | D1 数据库（`name`、`id`）和 OAuth 用的 KV 命名空间（`title`、`id`） |
| `tunnel`、`vpc` | 隧道（`name`、`id`、cloudflared 的 `metrics` 地址）和 Workers VPC 服务（`name`、`serviceId`） |
| `node.port`、`transport` | 节点端口（9191）和控制面到节点的路径（`vpc`，或者 `tunnel` 加上 `nodePublicOrigin`） |
| `services` | 服务标签：未设置时为 `app.useyolo.node` 和 `app.useyolo.cloudflared` |

`service/control/wrangler.jsonc` 是所有实例共用的模板：没有路由，`PUBLIC_ORIGIN` 为空，D1 和 KV 的 id 是占位值，也没有 VPC 绑定，足够用于 `npm run build`、`npm run dev:control` 和本地 D1。[`ops/lib/wrangler-config.js`](../../../../ops/lib/wrangler-config.js) 把模板加上实例渲染成被忽略的 `service/control/wrangler.instance.jsonc`。`npm run wrangler -- …` 用这个文件运行 wrangler，实例完整后控制面的构建也用它，每次部署都用它。端到端测试从同一个模板渲染本地配置。实例文件旁边被忽略的 `.yolo/` 存放 `deployments.jsonl`（每次部署、迁移、升级和回退）、D1 备份和隧道 token（权限 600）。

### 运维命令行

`npm run yolo -- <command>`（[`ops/yolo.js`](../../../../ops/yolo.js)）在实例的检出目录里设置、检查和变更一个实例。每个命令输出一个结果，加 `--json` 时输出 JSON，其中 `steps` 或 `checks` 的每一项都带 `status`、`message` 和 `fix`。退出码 0 表示完成，1 表示失败，2 表示需要用户本人批准（`approve` 给出批准后要运行的命令），3 表示需要人来操作。命令是幂等的：再次运行时只核对已有的东西，只做缺少的部分。

| 命令 | 作用 |
|---|---|
| `init --domain <host>` | 写入实例文件和带新 `NODE_SECRET` 的 `.env`；从不替换已有的 secret，改域名需要 `--change-domain`。`--import-wrangler` 读取旧的 wrangler 配置 |
| `provision [d1\|kv\|tunnel\|vpc]` | 核对已记录的 id，或复用同名资源，或新建资源，并记录 id。已有的 VPC 服务从不修改，只报告对应的 `wrangler vpc service update` 命令；这个命令会替换整个服务（名称、类型、隧道、地址和端口），所以也能把服务换到另一条隧道上 |
| `service install\|restart\|status\|logs\|uninstall` | 把节点和 cloudflared 作为服务运行 |
| `migrate` | 先导出 D1 并记录 Time Travel 书签，再执行待执行的迁移 |
| `deploy` | D1 迁移落后时拒绝运行；构建，把 `.env` 里的 `NODE_SECRET` 作为 secrets 文件、把发布版本作为版本标签一起部署，并等待 Worker 上报这个版本 |
| `doctor [--offline]` | 唯一的状态命令，见下文 |
| `upgrade`、`rollback` | [版本与发布](../process/2026-10-13-versions-and-releases.zh.md) |
| `config render\|show`、`version`、`release` | 渲染后的配置、检出目录的版本和协议编号，以及维护者的发布命令 |

会变更 Cloudflare 的命令先检查 wrangler 的登录和账号。wrangler 的 OAuth 登录不包含隧道权限，所以隧道在控制台里创建（Workers VPC，Tunnels），再把它的 token 交给 `provision tunnel --token-file`；也可以用带 Cloudflare Tunnel 权限的 API token 创建。

### 唯一的状态：doctor 和 /.well-known/yolo

`doctor` 依次检查：前置工具（Node.js、git、ffmpeg、yt-dlp、Deno、cloudflared）；实例文件、`.env` 和用户本人命令用的 socket；本机节点带签名的健康状态，包括每个插件的状态、局域网监听端口，以及远程监听端口和它的路由器端口、运营商级 NAT 情况；两个服务；cloudflared 在其 metrics 地址的 `/ready` 上报告的连接（cloudflared 以 `text/plain` 发送的 JSON）；wrangler 的登录、Worker 的 `NODE_SECRET`、D1 已执行的迁移以及 VPC 服务指向哪里；已部署的 Worker，包括从外部看到的远程路径状态和媒体中转是否打开；以及检出目录、Worker 和节点是否运行同一个发布、协议是否兼容。`--offline` 跳过 Cloudflare 和网络。

Worker 用 `GET /.well-known/yolo` 回答它的版本、提交、内部协议编号，以及它的代码需要的和数据库已有的最新 D1 迁移，其中没有任何秘密（[`service/control/src/well-known.js`](../../../../service/control/src/well-known.js)）。用 `NODE_SECRET` 以运维请求头签名的请求还能知道：Worker 能否通过隧道连到节点、节点的版本和协议编号、是否已有用户本人的 passkey、打包进去的控制面插件，以及各媒体路径的状态（[媒体流离开 Worker](../architecture/2026-10-13-media-off-the-worker.zh.md)）；`doctor` 就靠这个端到端地检查隧道和 VPC 服务。带 `?address=1` 时，签名请求只得到 `operator.address`，即请求来源的地址；节点经 IPv4 发这个请求，以得知家里的公网地址。`/healthz` 和 `/health` 由 Worker 回答 `{ ok, version }`，不再返回播放器的 HTML。

<a id="the-node-and-cloudflared-as-services"></a>

### 节点和 cloudflared 作为服务

`service install` 在 macOS 上写入 launchd LaunchAgent（`~/Library/LaunchAgents/<label>.plist`），在 Linux 上写入 systemd 用户单元（`~/.config/systemd/user/<label>.service`），带 `KeepAlive` 或 `Restart=always`、能找到媒体工具的 `PATH`，日志写在运行时目录的 `.logs/` 或 `.yolo/logs/`。节点从检出目录运行 `service/node/src/main.js`；cloudflared 运行 `tunnel --metrics <address> run --token-file .yolo/tunnel-token`。LaunchAgent 在用户本人登录期间运行，可能弹出一次本地网络权限提示。`--daemon` 改为准备一个带 `UserName` 的 LaunchDaemon，供无人登录也要提供服务的 Mac 使用（launchd 守护进程也不受本地网络隐私限制，见 Apple TN3179）；安装它需要管理员，所以命令会打印出 `sudo` 步骤。在 Linux 上，`loginctl enable-linger` 让用户单元在注销后继续运行。

### 部署检出目录

正在运行的节点从一个专用的克隆运行，它停在某个发布标签上（detached HEAD），实例的被忽略文件就放在里面。`upgrade` 在标签之间移动这个克隆，并拒绝处理处于分支上或有改动的检出目录，所以开发用的检出目录永远不会在运行中的节点下被移动。[`skills/yolo-upgrade`](../../../../skills/yolo-upgrade/SKILL.md) 给出这个布局，以及节点原本从开发检出目录运行的实例怎样迁移过去。

### 技能

[`skills/`](../../../../skills/) 里交付的技能带 agent 完成每项任务，并标出每个需要人介入的检查点：`yolo-deploy`（从空的 Cloudflare 账号到配对好的屏幕和连上的 agent）、`yolo-upgrade`、`yolo-connect-agent`（Claude Code、claude.ai、ChatGPT、Codex）、`yolo-add-source-plugin`（配合 [`plugins/source-example`](../../../../plugins/source-example/)），以及 `yolo`（使用 MCP 服务）。`.claude/skills/` 链接每个交付技能和仓库技能，让 Claude Code 能找到它们；`ops/test/skills.test.js` 保证链接齐全。交付的技能都不带任何实例的地址。

## 曾考虑的替代方案

**把实例的值放进 `yolo.config.json`。** 这个文件决定加载哪些插件，而它一存在，节点就从官方插件列表改用文件里的列表，所以把实例 id 放进去会迫使每个用户本人维护一份插件列表。两者的读取方也不同：插件配置由节点和 Worker 的构建读取，实例文件只由运维命令读取。

**把用户本人的值留在被跟踪的配置里，让其他人 fork 后修改。** 其他每个实例都会带着一个被改过的被跟踪文件，而且是仓库里变化最快的部署文件，每次升级都变成一次合并。

**wrangler 的自动资源创建。** 省略 D1 和 KV 的 id 时，`wrangler deploy` 会创建它们，但会把 id 写回配置文件，在这里就是被跟踪的模板；而且路由和 VPC 服务仍然需要实例的值。

**wrangler 的重定向配置（`.wrangler/deploy/config.json`）。** 它把目录里的每个 wrangler 命令都指向渲染后的配置，包括 `wrangler dev`，而后者必须继续使用本地模板。

**用 `current` 链接指向的发布目录。** 每个发布在自己的目录里准备好再切换链接，升级和回退都能瞬间完成，代价是每个发布一份完整的 `node_modules`，以及会变化的服务路径。原地检出的代价是每次升级节点停大约一分钟；这些命令以后可以改用发布目录，而不改变接口。

**先做安装向导或安装程序。** 向导以后可以包装这些命令；agent 现在就需要这些命令以及机器可读的结果。

**默认使用 LaunchDaemon。** 每次安装和改动都需要管理员，而用户本人保持登录的家用 Mac 用 LaunchAgent 就运行良好。

## 后果

agent 在全新克隆里就能部署、检查、升级和回退一个实例，只在列出的需要人介入的检查点停下：Cloudflare 账号和套餐、域名、登录、隧道 token、计划批准、macOS 提示、passkey、配对以及连接 agent。被跟踪的仓库不带任何实例的值，所以升级永远不会和用户本人的配置冲突，用户本人自己的实例也走同一条路径。在 wrangler 没有 JSON 输出的地方（VPC 服务的列表和详情），这些命令解析的是文本输出，所以 wrangler 升级可能让它们失效；`doctor` 和 `doctor` 的端到端测试会暴露这一点。wrangler 拒绝参数时会打印用法说明而不执行命令，无论退出码是什么，这些命令都把它算作失败。创建隧道仍然需要控制台或 API token，原地升级在节点重启时会中断播放。
