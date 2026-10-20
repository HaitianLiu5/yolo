# Agent Note: 屏幕直接问用户自己的 agent

Status: implemented

[English](2026-10-18-agent-from-the-screen.md) | 中文

## 问题

agent 通过 Yolo 的[远程 MCP 服务](2026-10-07-remote-mcp-server.zh.md)控制 Yolo，所以找内容来看要从 ChatGPT 或 Claude 开始。已经在播放器里的人，无论在车里还是浏览器里，都没法说一句「放《老友记》的下一集」或「找个讲新款 Model Y 的视频」：只能离开 Yolo，打开另一个应用。Yolo 需要让人在屏幕上直接问 agent；用户希望这个 agent 就是自己已经在用、已经付费的那个，这样 Yolo 不需要模型的 API key，不保管任何模型凭据，用户也不必在自己的订阅之外多花钱。

## 决策

屏幕上的话交给**媒体节点上的 agent 插件**，由它转给用户已经在这台机器上运行的 agent。官方插件 [`plugins/agent-claude-code`](../../../../plugins/agent-claude-code/) 运行用户已登录的 Claude Code。agent 通过它自己连到 Yolo 的 MCP 来工作，和在终端里一样；播放命令和其他播放一样经 Hub 到达屏幕。

```
screen ──POST /v1/agent──▶ control plane ──nodeFetch──▶ node /internal/v1/agent ──▶ agent plugin ──▶ claude -p
   ▲                                                                                                    │
   └──────────── Hub play command ◀── Yolo's MCP tools (/mcp) ◀───────────────────────────────────────────┘
```

### 请求

- **`POST /v1/agent`** `{ text, language? }` 需要 `control` scope。用配对屏幕自己的凭据请求时，这块屏幕就是 agent 默认的播放目标：控制面查出它的名字，把 `device: { id, name }` 和文字一起传下去。`text` 最多 1,000 个字符。回答是边工作边流式发出的 NDJSON（`application/x-ndjson`）：每调用一个工具发一条 `{ type: "tool", name }`（Yolo 自己的工具用 MCP 名字，例如 `search` 和 `play`），途中写的话发 `{ type: "text", text }`，最后是带一句话的 `{ type: "done", text }` 或 `{ type: "error", error }`。agent 开始之前就被拒绝的请求（没有文字、节点上没有 agent、节点离线）是普通的 `/v1` 错误状态码。
- **`GET /v1/agent`** 从节点读取并回答 `{ available, title?, reason? }`；早于 agent 的节点回答 404，变成 `available: false` 和「升级媒体节点」。
- **在节点上**，[`service/node/src/agents.js`](../../../../service/node/src/agents.js) 保存插件注册的 agent，一次只运行一个请求：新请求会中止还在运行的那个，因为说话的人改了主意，并等那个停下后才开始，所以两个请求不会同时播放或加队列；连接断开也会中止它。`/internal/v1/agent`（GET 取状态，POST 取流）立即发出响应头；`nodeFetch()` 的 15 秒超时只管响应头，cloudflared 写出 NDJSON 时即刻转发。这个端点是新增的，只有新的控制面调用它，所以 `NODE_PROTOCOL` 不变。

<a id="conversations"></a>

### 对话

控制面把用户和 agent 的对话存在 D1 里（`agent_conversations` 和 `agent_messages`，迁移 `0009`，[D1 数据模型](../architecture/2026-10-07-d1-data-model.zh.md)），所以在手机上开始的对话可以在车里接着聊，刷新页面也还在。`POST /v1/agent/conversations/{id}/messages` 接收同样的 `{ text, language? }`；id 用 `new` 表示开始一个新对话，标题就是这个问题。它的流就是节点的流，原样转发，只在前面加一行 `{ type: "conversation", id, title }`。控制面在保存问题时就为回答预留一行，所以晚到的回答仍紧跟在它的问题后面；它边转发边读，在流结束时填好这一行：回答那句话、它调用过的工具，以及结束方式：`done`、出错（`error`），或因为屏幕离开而 `stopped`（用 `waitUntil` 写入）。连不上节点、或节点回答到一半断掉时，记成错误，也按错误流出去，让对话里看得到发生了什么。Worker 没能填好的那一行没有结束方式，面板显示为还没有回答。`GET /v1/agent/conversations` 列出对话，`GET …/{id}` 返回一个对话和它的消息，`DELETE …/{id}` 删除一个。

D1 只存屏幕上显示的内容：从不存 agent 的工具结果、推理过程或提示词。一条回答最多保留 4,000 个字符和 20 个步骤；每开始一个对话，就只保留用户最新的 500 个，并删掉 90 天没动过的；一直在用的对话只保留最新的 200 条消息。agent 自己的会话 id 存在对话旁边，下一个问题以 `session` 带下去（第一个问题为 null），节点的 `done` 行把会话和 agent 的 id 带回来。所以对话里的追问不管隔了多久都接着 agent 的会话，「新对话」则重新开始。不带对话的 `POST /v1/agent` 照旧可用，给不保存对话的客户端。对话功能之前的节点会忽略 `session`，也不带回会话，它的插件退回按屏幕的短暂记忆；它照样能回答，所以 `NODE_PROTOCOL` 不变，因为提高它会让这样的节点拒绝所有请求，连播放也一起拒绝。[和用户的任何 agent 对话](../../proposed/feature/2026-10-18-multi-agent-conversations.zh.md) 规划了其余部分：多个 agent，以及用 token 取代每个 CLI 自己的 Yolo 连接。

### agent 插件

agent 插件在节点入口的工厂函数里调用 `yolo.registerAgent(id, { title?, health?, ask })`（[`@useyolo/plugin-api`](../../../../service/plugin-api/src/index.js)）；屏幕问的是第一个注册的 agent。`ask(request, { signal, emit })` 收到 `{ text, device, language }`，请求属于某个对话时还有 `session`；它用 `emit` 报告 `tool` 和 `text` 事件，`signal` 中止时停下，最后给出 `{ text, session? }`，`session` 是追问要接上的会话。插件启动失败时，它的 agent 和它的片源一起移除。

`agent-claude-code` 为每个请求在插件的缓存目录里运行一次 `claude -p --output-format stream-json --verbose`，请求从 stdin 传入，所以人说的任何话都不会被当成参数：

- **用它自己的登录和 Yolo 连接。** Yolo 不传任何 key 或 token。CLI 用用户的 Claude Code 登录，和它名为 `yolo` 的 MCP server（`server` 选项）；[`yolo-connect-agent`](../../../../skills/yolo-connect-agent/SKILL.md) 用 user scope 添加它。插件从 Claude Code 的用户配置（`~/.claude.json`，或 `CLAUDE_CONFIG_DIR` 下）读出这一项，再用 `--mcp-config` 传回去；名字、类型、URL 和 headers 都相同，就能找到 Claude Code 已经为它保存的 OAuth token。没有这一项时，agent 报告不可用，屏幕上不出现提问按钮；CLI 的第一条消息显示连不上这个 server 时，请求失败，消息说明要先把它连上。
- **只有 Yolo 的 server，工具收窄，不弹询问。** `--strict-mcp-config` 去掉用户的其他 MCP server 和插件，`--setting-sources ""` 去掉用户的设置文件，否则其中的允许规则会叠加到这里的规则上；一个请求，或它读到的网页，都碰不到别的集成。`--tools WebSearch,WebFetch` 让内置工具只剩网页搜索和读网页：没有能运行命令或改文件的工具。`--allowedTools mcp__yolo,WebSearch,WebFetch` 加上 `--permission-mode dontAsk`，其余一律拒绝而不询问；`--disallowedTools` 去掉 Yolo 的删除类工具（`remove_device`、`queue_remove`、`queue_clear`、`playlist_delete`）。它从不跳过权限检查。
- **告诉它什么。** `--append-system-prompt` 说明：它在为一块 Yolo 屏幕做事，那可能是正在行驶的车里的屏幕；除非另有说明，就在发话的屏幕上播放；先搜片库再搜网页；自己挑最合适的，不要追问；最后用对方的语言回一句短话。
- **会话。** 对话里的请求用 `--resume` 接着它的 `session`，为 null 时开一个新的，最后给出 CLI 的会话 id；接着会话的请求开头加一行，写明是在哪块屏幕上问的，因为对话可以从手机移到车里。不带会话的请求来自对话功能之前的控制面，它在 `memoryMinutes`（10 分钟）以内接着同一块屏幕上次的会话，所以「下一个」能听懂；每块屏幕各有一段，因为会话保留它开始时的系统提示，里面写着它的屏幕。CLI 明确说已经没有的会话（「No conversation found」）就重新开始，回答带回新的 id；其他失败保留会话、直接报错，因为新会话会永久替换对话原来的会话；调用过工具之后才失败的请求不会再问一次，因为它可能已经播放或加了队列。
- **它的环境。** 子进程拿到节点的环境变量，但去掉名字像密钥的（`SECRET`、`TOKEN`、`PASSWORD`、`API_KEY`、`CREDENTIAL`、`COOKIE`），所以 `NODE_SECRET` 和片源的凭据留在节点里；Claude Code 自己的登录 `CLAUDE_CODE_OAUTH_TOKEN` 保留。`CLAUDE_CODE_DISABLE_CLAUDE_MDS` 和 `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 不加载 CLAUDE.md 和自动记忆，因为缓存目录在 Yolo 的代码目录里，那里的编码说明不是给屏幕用的。
- **找到 CLI。** `command`（`CLAUDE_CODE_COMMAND`，默认 `claude`）先在 `PATH` 上找，再找安装程序常放的位置（`~/.local/bin`、`~/.claude/local`、Homebrew、`/usr/local/bin`），因为 launchd 或 systemd 服务不读登录配置。找不到时 agent 报告不可用，屏幕上也不出现按钮。`model`（`CLAUDE_CODE_MODEL`）选模型；`timeoutSeconds`（180）结束运行太久的请求：先发 SIGTERM，5 秒后发 SIGKILL，发给 CLI 自己的进程组，所以包装脚本启动的子进程也会停下。

这个插件列在 [`plugins/official.json`](../../../../plugins/official.json) 的最后；在没有 Claude Code 的机器上，它照常加载，并回答 `available: false`。

### 在屏幕上

当 `GET /v1/agent` 说有 agent 可用时，主页的顶栏有一个**提问**按钮（标签是 agent 的名字，例如「Ask Claude Code」）；播放器每次收到 welcome 都检查一次（[`clients/player/src/ask.js`](../../../../clients/player/src/ask.js)）。它打开一个靠近顶部、不被屏幕键盘挡住的面板：对话标题夹在「历史」和「新对话」两个按钮中间，下面是消息（问题在右，回答在左），再下面是输入框。正在进行的回答先说 agent 正在做哪一步（「Searching the web…」「Starting it…」），然后显示它的那句话或错误。「历史」列出用户最近的对话和时间；「新对话」开始一个新的。面板重新打开时回到这块屏幕上次的对话，除非它已超过六小时（存在 `localStorage`）。调用了会改变本屏幕播放内容的工具后，面板在回答出现 1.5 秒后自己关闭。关掉面板不会停止回答；回答进行时发送按钮变成「停止」，再问一次也会停止它。手机键盘的语音听写可以直接用在输入框里；车机的麦克风还没有用上。

## 曾考虑的替代方案

**在控制面里跑 agent 循环，直接调模型 API。** 回答最快，因为 Yolo 的工具就在 Worker 里；但每个用户都要一个按量付费的 API key，还得交给 Yolo 保管。用户自己的 agent 不多花钱，Yolo 里也不需要任何凭据。

**用模型 API 的远程 MCP 连接器指向 Yolo 的 `/mcp`。** 一样要 key，还要 Yolo 自己签发 token，绕一圈又回到同一个 Worker。

**每段对话一个常驻的 Claude Code 进程（`--input-format stream-json`）。** 省掉每次请求的 CLI 启动，但节点要管进程和内存上限；每个请求运行一次加 `--resume` 更简单，对话也能接上。

**像一些网关那样用 `--dangerously-skip-permissions` 加严格的 MCP 配置。** 这会让 CLI 能运行它有的任何工具；收窄工具、拒绝其余的，才能让 agent 只做搜索和播放。

**在车机浏览器里用语音。** 特斯拉从 2026.26 起只允许 AMD Ryzen 车机上的网页使用车内麦克风，每次请求都要确认；要等确认用户的车有这个能力。

## 后果

用户在正在看的屏幕上就能要内容，用的是自己已经有的 agent 和订阅；Yolo 不保存模型凭据，也不为模型付费。每个请求都要启动 CLI，第一步显示出来之前要等几秒；节点或它所在的机器关着时没有人回答。agent 能做的，就是它的 Yolo 连接和两个网页工具允许的，减去删除；车里任何人说的一句话，都会交给一个能搜网页、能在任何屏幕上播放的 agent。屏幕只看到 Yolo 的事件和 agent 的最后一句话，从不看到它的推理。
