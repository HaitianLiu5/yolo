# Agent Note: 和主人的任意一个 agent 对话

Status: proposed

[English](2026-10-18-multi-agent-conversations.md) | 中文

## 问题

[屏幕向主人自己的 agent 提问](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)让屏幕可以向一个 agent（Claude Code）提问，一次一个问题。还有三个缺口：

- **只有一个 agent。** 主人在家里还装了 Codex、Gemini CLI、Copilot、Kimi 等，并且都已登录。`registerAgent` 能登记多个，但 `/v1/agent` 只报告第一个，屏幕也从不显示是哪个 agent 在回答。
- **没有对话。** 面板只显示一个问题和一句回答，关掉就都没了。十分钟内的追问会续接 CLI 的会话，但看不到之前说过什么，也没法重新开始。
- **每个 agent 都要单独接入。** 每个 CLI 都得自己添加 Yolo 的 MCP 服务器，并用 OAuth 登录，Ask 按钮才会出现。每加一个 agent，都要在家里的机器上重复一遍。

## 提案

整体结构不变：屏幕 → 控制面 → node → agent 插件 → 主人的 CLI。变化有四处：控制面保存对话；控制面为每个问题签发一个短期 agent 令牌；node 同时登记多个 agent；插件按对话工作。

### agent 插件

- **Claude Code** 继续用 `claude -p --output-format stream-json`，用 `--resume` 续接。它的 MCP 配置不再用主人自己的 `yolo` 条目，改为 `{ "type": "http", "url": "<origin>/mcp", "headers": { "Authorization": "Bearer <agent 令牌>" } }`。
- **Codex** 是新的官方插件。它运行 `codex exec --json --ignore-user-config --skip-git-repo-check -s read-only -C <它的目录>`，用 `codex exec resume <会话> --json` 续接。Yolo 的服务器通过 `-c mcp_servers.yolo.url=…` 和 `-c mcp_servers.yolo.bearer_token_env_var=YOLO_AGENT_TOKEN` 传入，令牌放在环境变量里，不出现在命令行上。这些选项和 `--ignore-user-config` 只对一次调用有效，所以每次续接都要重复；否则追问会加载主人的 `config.toml`，丢掉 Yolo 的服务器。
- **ACP agent** 共用一个新的官方插件，讲 [Agent Client Protocol](https://agentclientprotocol.com/protocol/overview)：依次发 `initialize`、`session/new` 或 `session/load`、`session/prompt`，再把 `session/update` 通知转成 Yolo 的事件。`mcpServers` 里只放 Yolo 的服务器（HTTP 加令牌头）。客户端不声明文件系统和终端能力，`session/request_permission` 只批准 Yolo 的工具。内置目录写明每个 agent 的启动命令；在 `yolo.config.json` 里加一项就能再登记一个：

```json
{ "plugin": "agent-acp", "options": { "agents": ["gemini", { "id": "my-agent", "title": "My Agent", "command": "my-agent", "args": ["--acp"] }] } }
```

目录先只放 Gemini CLI（`gemini --acp`，来自它的帮助）。Copilot（`copilot --acp`）、Kimi（`kimi acp`）、Kiro（`kiro-cli acp`）和 Qoder（`qodercli --acp`）的命令来自 Multica 和 Paseo 的源码，要先在家里的机器上运行，并确认它们用自己的工具前会先请求许可，才加入目录。

`registerAgent(id, { title, icon?, health, ask, forget? })` 扩展如下：`health()` 返回 `{ available, reason?, version? }`；`ask({ text, language, device, session, mcp }, { signal, emit })` 返回 `{ session }`，即 CLI 的会话 id，所以 node 不保存任何状态；`forget({ sessions })` 删除这些会话的文件。同一个 agent 一次只回答一个问题；不同 agent 可以同时回答，总数最多两个，第三个排队。

### agent 令牌

控制面为每个问题用 `NODE_SECRET` 签一个令牌，内容包括主人、提问的设备、对话、密钥版本，以及过期时间（插件超时加一些余量，约十分钟）。令牌随 `nodeFetch()` 请求到达 node，再通过 MCP 配置交给 CLI。`/mcp` 已经通过 `resolveExternalToken` 接受配对设备的凭证（[`service/control/src/index.js`](../../../../service/control/src/index.js)），同样接受这种令牌，但只给 `read` 和 `control` 两个权限范围，并在服务端拒绝 `remove_device`、`queue_remove`、`queue_clear` 和 `playlist_delete`，不再依赖各 CLI 的参数。提问的设备是默认目标，审计记录里的调用方是 `agent:<id>`。主人轮换密钥版本时，所有未过期的令牌立即失效，和图片链接一样。

这样新加一个 agent，家里的机器上只需要它自己的模型登录：不用 `mcp add`，也不用 OAuth。

### 对话和接口

控制面把对话存在 D1（迁移 `0009`，按 [D1 数据模型](../../implemented/architecture/2026-10-07-d1-data-model.zh.md)两张表都带 `user_id`）：

- `agent_conversations(id, user_id, agent_id, agent_session, title, device_id, created_at, updated_at)`
- `agent_messages(id, user_id, conversation_id, role, text, steps, status, created_at)`

控制面把 node 的流转给屏幕，同时累积内容，流结束时用 `waitUntil` 写入；屏幕中途断开，已经收到的部分也会保存。`agent_session` 由 node 的 `done` 行和 agent 的 id 一起带回，下一个问题再带出去。

| 路由 | 用途 |
|---|---|
| `GET /v1/agents` | 每个 agent 的状态卡：`id`、`title`、`icon`、`available`、`reason`、`version`、`busy` |
| `GET /v1/agent/conversations` | 最近的对话 |
| `GET /v1/agent/conversations/{id}` | 一个对话的全部消息 |
| `POST /v1/agent/conversations/{id}/messages` | `{ agent, text, language }`，返回 NDJSON 流；id 为 `new` 时新建对话 |
| `DELETE /v1/agent/conversations/{id}` | 删除一个对话及其消息 |
| `GET /internal/v1/agents` | 每个插件 `health()` 的结果，缓存约一分钟 |
| `POST /internal/v1/agent` | `{ agent, text, language, device, session, token, mcpUrl }`，返回的 NDJSON 中 `done` 行带 `agent` 和 `session` |
| `POST /internal/v1/agent/forget` | `{ agent, sessions }`：Yolo 删除或过期的对话的会话，交给那个插件的 `forget()` |

播放器和 Worker 一起部署。node 没有 `/internal/v1/agents` 时，退回现有的 `/internal/v1/agent` 状态，只显示一个 agent。node 只新增接口，所以 `NODE_PROTOCOL` 不变。

### 面板

Ask 按钮打开对话面板：

- **顶部是 agent 栏**，每个 agent 一个片子，带图标和状态点：可用、不可用、正在回答。不可用的片子写明原因和解决办法（“Codex 没登录：在家里运行 codex login”）。每块屏幕记住上次的选择；只有一个 agent 时，这一栏收成一个标签。
- **对话**在标题（第一句问题）下面，旁边有**新对话**和**历史**；历史列出最近的对话，带 agent 和时间。
- **消息**：问题靠右，回答靠左；每个步骤一行小字，回答结束后折叠；agent 播放的内容显示成一张卡片（缩略图加标题）。
- **输入框**紧跟在消息下面。回答进行中显示停止按钮；浏览器支持语音识别时显示麦克风。车机上面板从顶部展开，输入框始终在键盘上方。

对话属于主人，不属于某块屏幕：在手机上开始的对话，到车上可以接着问；“这里”永远指提问的屏幕。一个对话只属于一个 agent，因为各家的会话不能共享；换 agent 就开新对话。重新打开面板时回到上次的对话，超过六小时则开新对话。系统提示词要求回答控制在一两句话。

### 数据量和保留期

D1 只存屏幕上显示的内容：问题、回答和步骤标签，不存工具参数和结果、思考过程、系统提示词、搜索结果或缩略图。续接所需的完整上下文由家里的 CLI 保存，D1 只存它的会话 id。

一份 7.9 MB 的 Claude Code 记录样本中，工具结果占 39%，附带的上下文占 30%，工具参数占 18%，思考过程占 9%，双方看得见的文字不到 1%（0.07 MB）。问题上限 1000 字，回答上限 4000 字，步骤最多 20 条、每条 120 字，因此一轮问答不超过约 20 KB；常见的一轮约 1 KB。每天 50 轮，一年约 18 MB；免费版每个数据库 500 MB，每天可写 10 万行。每天的定时任务删除 90 天前的对话，并让每个主人最多保留 500 个对话，因此即使每轮都达到上限，总量也封顶在约 90 MB。

真正会变大的是家里 CLI 自己的记录。每个插件在自己的一个固定目录里运行（Claude 只能在会话开始时的目录里续接），和主人写代码的会话分开；Yolo 删除对话或对话过期时，插件删除对应的会话文件，不碰那个目录以外的任何东西。控制面收集它删掉的对话的会话，发到 `/internal/v1/agent/forget`；node 关机时发出的会丢失，所以每个插件还会删掉自己目录里超过 90 天保留期没动过的文件。

### 计划

每一步一个 PR，合入后部署：

1. 只用 Claude Code 实现对话和历史：迁移、路由、`done` 里的会话、面板的历史和新对话。它的约定见 [屏幕直接问用户自己的 agent](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md#conversations)。
2. agent 令牌：Claude Code 改用令牌，破坏性工具在服务端拒绝。
3. 多个 agent：`/internal/v1/agents`、`GET /v1/agents`、agent 栏、扩展后带 `forget` 的插件接口。
4. Codex 插件：先在家里的机器上确认 `exec` 调用 MCP 工具不会卡在审批上。
5. ACP 插件：先接 Gemini，再逐个加入目录里的其他 agent。
6. 以后的可选插件：用量和额度、语音、多块屏幕通过 Hub 实时同步同一个对话。

## 其他产品怎么做

2026 年 10 月读源码所得：

| 产品 | Claude Code | Codex | 其他 agent | 对话存储 | 保留期 |
|---|---|---|---|---|---|
| [Multica](https://github.com/multica-ai/multica) | 双向 stream-json | `codex app-server` | ACP 或各 CLI 的 JSON 模式 | 服务器 Postgres：每个事件都存，工具输出限 8 KB | 数据库不清理；本机任务目录 24 小时，Codex 会话文件 14 天 |
| [Paseo](https://github.com/getpaseo/paseo) | Claude Agent SDK | `codex app-server` | ACP | 磁盘只存 agent 元数据；时间线在内存，从 CLI 的历史重建 | 无 |
| [Happy](https://github.com/slopus/happy) | Claude Agent SDK | `codex app-server` | Gemini 走 ACP | 服务器 Postgres，端到端加密：文字、思考、工具参数，不存工具输出 | 无 |
| [AionUi](https://github.com/iOfficeAI/AionUi) | ACP 适配器 | ACP 适配器 | ACP | 本机 SQLite：文字、工具调用、思考、权限请求、diff | 无 |

它们都靠 CLI 自己的会话续接。agent 状态卡参照 Paseo 的 provider 快照（是否可用、原因、模型、模式、能力）；ACP 目录参照 [ADHDev](https://github.com/vilmire/adhdev) 把 provider 写成数据的做法。

## 考虑过的替代方案

**像 AionUi 那样，所有 agent 都走 ACP，包括 Claude Code 和 Codex。** 只有一条代码路径，但要多装两个适配器包（`claude-agent-acp`、`codex-acp`），它们本身又包装了 Agent SDK 和 `codex app-server`。Multica、Paseo、Happy 对这两家都保留了原生路径。

**用 `codex app-server` 代替 `codex exec`。** 它适合中途要审批的长会话。Yolo 的一个问题就是一轮，每轮一个进程、用 `exec resume` 续接，和 Claude Code 插件一样简单。

**嵌入 Paseo、AionUi 或 Multica。** 它们是写代码的工作台，会把整台机器交给 agent；Yolo 要的是只能碰 Yolo 的 agent。

**像现在这样，每个 CLI 自己 `mcp add` 并 OAuth 登录。** ACP 传 HTTP MCP 服务器时只能带 URL 和请求头，CLI 存的 OAuth 令牌在那里用不上；而且每加一个 agent，都要在家里重新配置一遍。

**历史只存在屏幕的浏览器里，或像 Paseo 那样只存在 CLI 的文件里。** 对话就没法从手机跟到车上，家里的机器关机时也什么都看不到。

**像 Multica 和 AionUi 那样存完整记录。** 它们服务于写代码，用户要回看改动和命令；屏幕只需要问了什么、放了什么，而体积正是来自完整记录。

**把一个对话的文字带给另一个 agent。** 这等于宣称新 agent 的会话有它其实没有的上下文。

## 验收标准

- 关掉面板、刷新页面，或同一个主人在另一块屏幕上打开 Ask 后，问题和回答都还在。
- 在对话里追问会续接 agent 的会话；新对话会开始一个新会话。
- agent 栏列出每个登记的 agent，带可用状态和原因；Claude Code、Codex、Gemini 都能各自找到并播放内容。
- 新装的 agent 只需要它自己在家里的登录就能用。
- 令牌无法删除设备、队列条目或播放列表，过期或密钥轮换后失效。
- D1 里没有工具结果和思考过程；在家里的机器上实测一轮，用 D1 和磁盘上的实测值替换上面的估算。

## 风险

- **不经询问就运行自己工具的 agent。** 有的 agent 可能读取空目录以外的文件。目录里的每一项都先在家里的机器上试过；无视拒绝的不进目录。
- **网页里的提示词注入。** 受令牌限制：只能搜索和控制播放。
- **主人的订阅额度。** 每个问题消耗主人自己的 Claude、ChatGPT 或 Gemini 额度；没有新增费用，但会占用额度。
- **CLI 变化。** 参数和事件格式会随版本变化；每个插件固定自己解析的格式，读不懂的版本报告为不可用。
- **未实测的数字。** 数据量在实测替换之前都是估算。
