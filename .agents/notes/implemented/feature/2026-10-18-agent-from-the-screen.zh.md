# Agent Note: 屏幕直接问用户自己的 agent

Status: implemented

[English](2026-10-18-agent-from-the-screen.md) | 中文

## 问题

agent 通过 Yolo 的[远程 MCP 服务](2026-10-07-remote-mcp-server.zh.md)控制 Yolo，所以找内容来看要从 ChatGPT 或 Claude 开始。已经在播放器里的人，无论在车里还是浏览器里，都没法说一句「放《老友记》的下一集」或「找个讲新款 Model Y 的视频」：只能离开 Yolo，打开另一个应用。Yolo 需要让人在屏幕上直接问 agent；用户希望这个 agent 就是自己已经在用、已经付费的那个，这样 Yolo 不需要模型的 API key，不保管任何模型凭据，用户也不必在自己的订阅之外多花钱。

## 决策

屏幕上的话交给**媒体节点上的 agent 插件**，由它转给用户已经在这台机器上运行的 agent。官方插件 [`plugins/agent-claude-code`](../../../../plugins/agent-claude-code/) 和 [`plugins/agent-codex`](../../../../plugins/agent-codex/) 分别运行用户已登录的 Claude Code 和 Codex，每块屏幕自己选问哪一个。agent 通过它自己连到 Yolo 的 MCP 来工作，和在终端里一样；播放命令和其他播放一样经 Hub 到达屏幕。

```
screen ──POST /v1/agent──▶ control plane ──nodeFetch──▶ node /internal/v1/agent ──▶ agent plugin ──▶ claude -p
   ▲                                                                                                    │
   └──────────── Hub play command ◀── Yolo's MCP tools (/mcp) ◀───────────────────────────────────────────┘
```

### 请求

- **`POST /v1/agent`** `{ text, language?, agent? }` 需要 `control` scope；`agent` 是屏幕选的 agent。用配对屏幕自己的凭据请求时，这块屏幕就是 agent 默认的播放目标：控制面查出它的名字，把 `device: { id, name }` 和文字一起传下去。它还传 `playing`，即 Hub 记录的发问那块屏幕自己会话里的播放（来自 agent 客户端、没有指定屏幕时，是用户本人唯一一个在用的会话）：`{ itemId, title, position, duration, status, device, profile? }`，其中 `device` 是正在播放的屏幕，直播的 `duration` 为 null，会话的档案不是用户本人的时用 `profile` 写明；那里什么都没播时为 null。每块屏幕各播各的，所以它还传 `others`，即其他在用的会话，形状相同，最多 8 个，这样「这个」仍然指发问那块屏幕的，「电视上在放什么」也不用再查（[每屏会话](../architecture/2026-10-31-screen-sessions.zh.md)）。屏幕不用为此发送任何东西，所以每种客户端都一样拿到。`text` 最多 1,000 个字符。回答是边工作边流式发出的 NDJSON（`application/x-ndjson`）：每调用一个工具发一条 `{ type: "tool", name }`（Yolo 自己的工具用 MCP 名字，例如 `search` 和 `play`），途中写的话发 `{ type: "text", text }`，最后是带一句话的 `{ type: "done", text }` 或 `{ type: "error", error }`。agent 开始之前就被拒绝的请求（没有文字、节点上没有 agent、节点离线）是普通的 `/v1` 错误状态码。
- **`GET /v1/agent`** 从节点读取并回答 `{ available, id?, title?, reason?, agents? }`：屏幕不指定时被问的 agent，以及 `agents` 里屏幕可选的每一个 `{ id, title, available, reason? }`；早于 agent 的节点回答 404，变成 `available: false` 和「升级媒体节点」。
- **在节点上**，[`service/node/src/agents.js`](../../../../service/node/src/agents.js) 保存插件注册的 agent，问请求指定的那个（`agent`），没指定时问第一个 `health()` 说能回答的，一次只运行一个请求：新请求会中止还在运行的那个，因为说话的人改了主意，并等那个停下后才开始，所以两个请求不会同时播放或加队列；连接断开也会中止它。`/internal/v1/agent`（GET 取状态，POST 取流）立即发出响应头；`nodeFetch()` 的 15 秒超时只管响应头，cloudflared 写出 NDJSON 时即刻转发。这个端点是新增的，只有新的控制面调用它，所以 `NODE_PROTOCOL` 不变。

<a id="conversations"></a>

### 对话

控制面把用户和 agent 的对话存在 D1 里（`agent_conversations` 和 `agent_messages`，迁移 `0009`，[D1 数据模型](../architecture/2026-10-07-d1-data-model.zh.md)），所以在手机上开始的对话可以在车里接着聊，刷新页面也还在。`POST /v1/agent/conversations/{id}/messages` 接收同样的 `{ text, language?, agent? }`，不带 `agent` 时由回答过这段对话的 agent 继续回答。agent 之间不共享会话，所以一段对话只有一个 agent：屏幕换了 agent 时，播放器开一段新对话；agent 和对话原来的不一样时，控制面给它开它自己的会话；id 用 `new` 表示开始一个新对话，标题就是这个问题。它的流就是节点的流，原样转发，只在前面加一行 `{ type: "conversation", id, title }`。控制面在保存问题时就为回答预留一行，所以晚到的回答仍紧跟在它的问题后面；它边转发边读，在流结束时填好这一行：回答那句话、它调用过的工具，以及结束方式：`done`、出错（`error`），或因为屏幕离开而 `stopped`（用 `waitUntil` 写入）。连不上节点、或节点回答到一半断掉时，记成错误，也按错误流出去，让对话里看得到发生了什么。Worker 没能填好的那一行没有结束方式，面板显示为还没有回答。`GET /v1/agent/conversations` 列出对话，`GET …/{id}` 返回一个对话和它的消息，`DELETE …/{id}` 删除一个。

D1 只存屏幕上显示的内容：从不存 agent 的工具结果、推理过程或提示词。一条回答最多保留 4,000 个字符和 20 个步骤；每开始一个对话，就只保留用户最新的 500 个，并删掉 90 天没动过的；一直在用的对话只保留最新的 200 条消息。agent 自己的会话 id 存在对话旁边，下一个问题以 `session` 带下去（第一个问题为 null），节点的 `done` 行把会话和 agent 的 id 带回来；只有在没有更新的回答已经完成时，一条回答才能更新对话的会话，所以晚记下的回答不会把会话退回去，而更新的回答失败了也不会挡住它。所以对话里的追问不管隔了多久都接着 agent 的会话，「新对话」则重新开始。不带对话的 `POST /v1/agent` 照旧可用，给不保存对话的客户端。对话功能之前的节点会忽略 `session`，也不带回会话，它的插件退回按屏幕的短暂记忆；它照样能回答，所以 `NODE_PROTOCOL` 不变，因为提高它会让这样的节点拒绝所有请求，连播放也一起拒绝。[和用户的任何 agent 对话](../../proposed/feature/2026-10-18-multi-agent-conversations.zh.md) 规划了其余部分：多个 agent，以及用 token 取代每个 CLI 自己的 Yolo 连接。

<a id="the-agent-plugin"></a>
### agent 插件

agent 插件在节点入口的工厂函数里调用 `yolo.registerAgent(id, { title?, health?, ask })`（[`@useyolo/plugin-api`](../../../../service/plugin-api/src/index.js)）；屏幕问它在设置里选的那个，没选时问第一个能回答的。`ask(request, { signal, emit })` 收到 `{ text, device, playing, others?, language }`，请求属于某个对话时还有 `session`；它用 `emit` 报告 `tool` 和 `text` 事件，`signal` 中止时停下，最后给出 `{ text, session? }`，`session` 是追问要接上的会话。插件启动失败时，它的 agent 和它的片源一起移除。

`agent-claude-code` 为每个请求在插件的缓存目录里运行一次 `claude -p --output-format stream-json --verbose`，请求从 stdin 传入，所以人说的任何话都不会被当成参数：

- **用它自己的登录和 Yolo 连接。** Yolo 不传任何 key 或 token。CLI 用用户的 Claude Code 登录，和它名为 `yolo` 的 MCP server（`server` 选项）；[`yolo-connect-agent`](../../../../skills/yolo-connect-agent/SKILL.md) 用 user scope 添加它。插件从 Claude Code 的用户配置（`~/.claude.json`，或 `CLAUDE_CONFIG_DIR` 下）读出这一项，再用 `--mcp-config` 传回去；名字、类型、URL 和 headers 都相同，就能找到 Claude Code 已经为它保存的 OAuth token。没有这一项时，agent 报告不可用，屏幕上不出现提问按钮；CLI 的第一条消息显示连不上这个 server 时，请求失败，消息说明要先把它连上。
- **只有 Yolo 的 server，工具收窄，不弹询问。** `--strict-mcp-config` 去掉用户的其他 MCP server 和插件，`--setting-sources ""` 去掉用户的设置文件，否则其中的允许规则会叠加到这里的规则上；一个请求，或它读到的网页，都碰不到别的集成。`--tools WebSearch,WebFetch` 让内置工具只剩网页搜索和读网页：没有能运行命令或改文件的工具。`--allowedTools mcp__yolo,WebSearch,WebFetch` 加上 `--permission-mode dontAsk`，其余一律拒绝而不询问；`--disallowedTools` 去掉 Yolo 的删除类工具（`remove_device`、`queue_remove`、`queue_clear`、`playlist_delete`）。它从不跳过权限检查。
- **告诉它什么。** `--append-system-prompt` 说明：它在为一块 Yolo 屏幕做事，那可能是正在行驶的车里的屏幕；除非另有说明，就在发话的屏幕上播放；先搜片库再搜网页；把「这个」「这里」「现在」理解为正在播的内容和位置（用 `get_transcript` 和 `get_frame` 去看，而不是反问）；只有一个明显合适时直接播放，有几个都可能时自己什么都不播，而是为提问的屏幕调用 `offer`，最多给三个，这些选项显示在那块屏幕的 [agent 画布](../../proposed/architecture/2026-10-21-agent-canvas.zh.md)上，选中的直接播放；然后说一句放了什么（`chosen`），或者说选项已经在屏幕上了（`waiting`）。只有 `offer` 返回 `unsupported`（屏幕没有画布）时，才说出这几个并问是哪一个，对方的下一句就是回答；最后用对方的语言回一句短话。
- **会话。** 对话里的请求用 `--resume` 接着它的 `session`，为 null 时开一个新的，最后给出 CLI 的会话 id；接着会话的请求开头加一行，写明是在哪块屏幕上问的，因为对话可以从手机移到车里；正在播放时，每个请求开头都加一行，写明在播什么、播到哪（`1:02:05 of 1:30:00`）、状态，以及是在这块屏幕上还是在另一块指名的屏幕上播放，之后每块其他在用的屏幕再加一行，写明屏幕、不是用户本人的档案时是谁的档案，以及那里在播什么。不带会话的请求来自对话功能之前的控制面，它在 `memoryMinutes`（10 分钟）以内接着同一块屏幕上次的会话，所以「下一个」能听懂；每块屏幕各有一段，因为会话保留它开始时的系统提示，里面写着它的屏幕。CLI 明确说已经没有的会话（「No conversation found」）就重新开始，回答带回新的 id；其他失败保留会话、直接报错，因为新会话会永久替换对话原来的会话；调用过工具之后才失败的请求不会再问一次，因为它可能已经播放或加了队列。
- **它的环境。** 子进程拿到节点的环境变量，但去掉名字像密钥的（`SECRET`、`TOKEN`、`PASSWORD`、`API_KEY`、`CREDENTIAL`、`COOKIE`），所以 `NODE_SECRET` 和片源的凭据留在节点里；Claude Code 自己的登录 `CLAUDE_CODE_OAUTH_TOKEN` 保留。`CLAUDE_CODE_DISABLE_CLAUDE_MDS` 和 `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 不加载 CLAUDE.md 和自动记忆，因为缓存目录在 Yolo 的代码目录里，那里的编码说明不是给屏幕用的。
- **找到 CLI。** `command`（`CLAUDE_CODE_COMMAND`，默认 `claude`）先在 `PATH` 上找，再找安装程序常放的位置（`~/.local/bin`、`~/.claude/local`、Homebrew、`/usr/local/bin`），因为 launchd 或 systemd 服务不读登录配置。找不到时 agent 报告不可用，屏幕上也不出现按钮。`model`（`CLAUDE_CODE_MODEL`）选模型；`timeoutSeconds`（180）结束运行太久的请求：先发 SIGTERM，5 秒后发 SIGKILL，发给 CLI 自己的进程组，所以包装脚本启动的子进程也会停下。

`agent-codex`（[`plugins/agent-codex`](../../../../plugins/agent-codex/)）用用户的 Codex CLI 做同样的事：每个请求运行一次 `codex exec --json`，追问时运行 `codex exec resume <session> --json`，请求从 stdin（`-`）传入：

- **用它自己的登录和 Yolo 连接。** 它从 Codex 的用户配置里读 Yolo 的服务器，也就是 `$CODEX_HOME/config.toml`（默认 `~/.codex`）里 `codex mcp add yolo --url …` 写下的 `[mcp_servers.yolo]`，只把它的 URL 用 `-c mcp_servers.yolo.url=…` 传回去，同时加上 `--ignore-user-config` 和 `--ignore-rules`：用户的其他服务器、profile 和规则都不加载，而 Codex 仍从 `CODEX_HOME` 登录，也能找到 `codex mcp login yolo` 存下的令牌。这些选项只对一次调用有效，所以每次接着会话也都带上。没有这一项或它被关掉时，agent 报告自己不可用；运行中出现关于这个服务器的错误时，请求失败并说明该怎么做。
- **工具很窄，从不询问。** 它以只读方式运行（`sandbox_mode`），从不询问（`approval_policy = "never"`），实时搜索网页（`web_search = "live"`），用 `mcp_servers.yolo.disabled_tools` 去掉 Yolo 的删除类工具，并关掉会运行命令、改文件、操作浏览器或电脑、或连到用户其他应用和插件的功能（`shell_tool`、`unified_exec`、`code_mode_host`、`apps`、`plugins`、`browser_use`、`computer_use` 等）；在家里的机器上让它运行命令，它会说做不到。给它的指示和 Claude Code 的一样，用 `developer_instructions` 传入。
- **事件。** `thread.started` 给出会话，每个 `mcp_tool_call` 和 `web_search` 条目是一个步骤（Codex 会在调用开始和完成时各报一次，只显示一次），每个 `agent_message` 是一段文字，最后一段就是回答；`turn.completed` 表示结束，`turn.failed` 表示失败。Codex 已经没有的会话会重新开始，和 Claude Code 一样。
- **其余和 Claude Code 插件一样**：同样去掉机密的环境，其中只保留 `CODEX_API_KEY`；`command`（`CODEX_COMMAND`，默认是 `PATH`、Homebrew 或 `/usr/local/bin` 里的 `codex`）、`server`（`CODEX_YOLO_SERVER`）、`model`（`CODEX_MODEL`）、`timeoutSeconds` 和 `memoryMinutes`。

两个插件都列在 [`plugins/official.json`](../../../../plugins/official.json)，Claude Code 在前；在没有对应 CLI 的机器上，它照常加载，并回答 `available: false`。

<a id="voice-input"></a>
### 语音输入

媒体节点上有转录器（[AI 字幕](2026-10-18-ai-subtitles.zh.md)用的那种插件）时，屏幕可以把请求说出来，不用打字；这时 `GET /v1/agent` 多一个 `speech: true`（节点的 `GET /internal/v1/agent` 在注册了转录器时这样说）。屏幕通过 Web Audio 而不是 MediaRecorder 用浏览器的麦克风录音，发出去的正是转录器要的格式：16 kHz 单声道 16 位 WAV，最长 30 秒（[`clients/player/src/voice.js`](../../../../clients/player/src/voice.js)）。

- **`POST /v1/agent/transcriptions`**（`control` scope）以请求体接收录音（`audio/wav`，最多 1,000,000 字节），`?language=` 带这块屏幕的语言（设置里选的，否则是浏览器的；[播放器的语言](2026-10-26-player-language.zh.md)），返回 `{ text, language }`。控制面把它转成 base64，连同用户说的几种语言，放进 `POST /internal/v1/speech/transcribe` 的 `{ audio, languages, language, device }` 交给节点，最多等 40 秒。
- **在节点上**（[`service/node/src/voice.js`](../../../../service/node/src/voice.js)）先检查 WAV，不到 0.3 秒就返回空文字，然后直接调用第一个转录器，不排在 AI 字幕的队列后面，最多 30 秒。录音按什么语言来听，由用户说的几种语言决定。它们在 **设置 › 你的 Yolo › 语音语言** 里设一次，所有屏幕通用（`GET` 和 `PUT /v1/owner/voice`，最多四种，排第一的在前，存在 D1 的 `voice_settings`）。只有一种时直接按它转录，不做识别。有几种时，由转录器的 `detectLanguage` 给出每种语言的可能性，Yolo 只在用户的语言里选，所以一两秒的噪音不会再被听成韩语或冰岛语（以前让转录器在所有语言里选时就会这样）。后面的语言只有在可能性超过一半、并且高过排第一的语言时才胜出，因为排第一的语言录得很短时常被认成别的。转录器不会识别时，就让它边识别边转录，结果不在用户的语言里时，再按排第一的语言转录一次。中文带上对应字形的提示词，简体是「以下是普通话的句子。」，繁体是「以下是普通話的句子。」，因为 Whisper 一类模型跟着提示词的字形走，没有提示词就写繁体字；中文里夹的英文单词怎样都会保留成拉丁字母，在提示词里说明可能夹英文，测下来也没有更好。用户没选语言时，中文屏幕按中文、带简体提示词来听，其他屏幕的语言自动识别。各段文字拼接时，两个汉字之间不加空格，其他情况加一个，最多 1,000 个字符。每块屏幕同时只有一个请求在转录，新的请求（无论是目前说的话还是整段录音）会停掉旧的（`superseded`）；节点上最多同时两段（`rate_limited`）。
- **什么都不保存。** 声音经过 Worker 和节点交给转录器，从不写盘、不进日志、不存进 D1；D1 只保存屏幕随后用这些文字问出的问题。语音输入之前的节点返回 404，屏幕会提示升级节点；两个接口都是新的，所以 `NODE_PROTOCOL` 和 `CLIENT_PROTOCOL` 都不变。

在屏幕上，当 `speech` 为 true 且浏览器能录音（安全页面、有 `getUserMedia` 和 Web Audio）时，主页顶栏的 Ask 旁边有一个麦克风（在左侧，车上驾驶位够得着），剧集页的返回旁边、播放器的标题旁边各有一个，面板里输入框前面还有一个。点面板外的那些，面板打开时已经在听，不弹出键盘；面板里的那个一按下就开始：第一次浏览器会请求麦克风权限，按钮变红，外圈随声音大小变化，播放器把音量降到十分之一。由用户发送：再点一下麦克风，或点发送，就发出说的话；停顿从不发送，因为人会在请求说到一半时停下来想，车里的噪音又会盖住说完的那一刻，所以安静多久都分不清这两种情况。说话后安静 10 秒，或到 30 秒，会自己停止听，但不发送；文字留在输入框里，下面一行提示可以发送，或点麦克风接着说，新说的话接在后面。开始后 8 秒内没人说话，就停下并提示什么也没听到。是不是在说话，按环境噪音判断，而不是固定音量：前四分之一秒里最安静的一刻定下噪音，之后遇到更安静的声音立刻降，变吵则慢慢升；超过噪音三倍（限定在 RMS 0.01 到 0.12 之间）才算说话，上一句话之后 0.8 秒内到这个值的 0.6 倍就算；说话加起来不到 0.12 秒就算没说话。像聊天软件那样按住 0.35 秒以上，中间停顿也一直录，松开就发送；松开前手指滑离按钮就取消。录音期间，大约每秒把目前说的话再发一次，同时只有一个请求，文字边说边以灰色出现在输入框里，接在开始时输入框里已有的内容后面。录音结束，麦克风立刻释放：如果最后一次请求听到了最后一句话之后 0.3 秒以上，就用它的结果，否则把整段录音发出去。点一下某个问题，它会回到输入框里供编辑；如果它的回答正在进行，就停掉。输入框下面那一行也说明出了什么错（权限被拒、没有麦克风、什么也没听到、语音服务的错误，这时已经出现的文字留在输入框里）。每次尝试都记一条 `voice_input` 设备事件，记下怎么结束的、有没有发送、录了几秒、出字花了多久、边说边出字显示了几次，从不记文字或声音（[设备遥测](2026-10-11-device-telemetry.zh.md)）。

**在车里。** 特斯拉 2026.26 的更新说明允许 AMD 车机上的浏览器在车主点按授权后使用车内麦克风；Intel 车机不在列表里，说明里也只把摄像头限制在驻车时。`env` 事件的 `microphone` 字段不弹授权框就能说明车机浏览器有没有麦克风；**设置 → 这块屏幕 → 麦克风 → 测试** 会录三秒并试一下浏览器自带的语音识别，两项结果都作为 `mic_test` 事件上报，所以车机能力是测出来的，不是假定的。没有麦克风的车机不显示按钮，车主改用手机来问。

### 在屏幕上

当 `GET /v1/agent` 说有 agent 可用时，主页的顶栏有一个**提问**按钮（标签是 agent 的名字，例如「Ask Claude Code」）；播放器每次收到 welcome 都检查一次（[`clients/player/src/ask.js`](../../../../clients/player/src/ask.js)）。它打开一个靠近顶部、不被屏幕键盘挡住的面板：对话标题夹在「历史」和「新对话」两个按钮中间，下面是消息（问题在右，回答在左），再下面是输入框。正在进行的回答先说 agent 正在做哪一步（「Searching the web…」「Starting it…」），然后显示它的那句话或错误。「历史」列出用户最近的对话和时间；「新对话」开始一个新的。面板重新打开时回到这块屏幕上次的对话，除非它已超过六小时（存在 `localStorage`）。调用了会改变本屏幕播放内容的工具后，面板在回答出现 1.5 秒后自己关闭。关掉面板不会停止回答；回答进行时发送按钮变成「停止」，再问一次也会停止它。手机键盘的语音听写也可以直接用在输入框里，[语音输入](#voice-input)再加上 Yolo 自己的麦克风。**设置 › 这块屏幕 › Ask with** 在「自动」后面列出节点上的 agent，说明哪个为什么不能回答，并把这块屏幕的选择存在 `localStorage`（[`clients/player/src/agent-choice.js`](../../../../clients/player/src/agent-choice.js)）；Ask 的标签写着这块屏幕问的 agent，所以车里可以问 Codex，手机上问 Claude Code。

## 曾考虑的替代方案

**在控制面里跑 agent 循环，直接调模型 API。** 回答最快，因为 Yolo 的工具就在 Worker 里；但每个用户都要一个按量付费的 API key，还得交给 Yolo 保管。用户自己的 agent 不多花钱，Yolo 里也不需要任何凭据。

**用模型 API 的远程 MCP 连接器指向 Yolo 的 `/mcp`。** 一样要 key，还要 Yolo 自己签发 token，绕一圈又回到同一个 Worker。

**每段对话一个常驻的 Claude Code 进程（`--input-format stream-json`）。** 省掉每次请求的 CLI 启动，但节点要管进程和内存上限；每个请求运行一次加 `--resume` 更简单，对话也能接上。

**像一些网关那样用 `--dangerously-skip-permissions` 加严格的 MCP 配置。** 这会让 CLI 能运行它有的任何工具；收窄工具、拒绝其余的，才能让 agent 只做搜索和播放。

**语音输入用浏览器自带的语音识别（Web Speech API）。** 它能流式地边说边出字（Yolo 则是每秒重新问一次），但 Chrome 把声音发给 Google，Safari 发给 Apple，Firefox 没有；没有 Google 语音服务的 Chromium 构建（车机很可能就是）要么没有，要么报错；手机上键盘听写已经能做同样的事。录音加用户自己的转录器，在麦克风能用的地方都能用，声音也留在家里。麦克风测试会报告车机上的浏览器识别实际表现，以防它其实能用。

**由屏幕的语言决定录音按什么语言来听。** 语音最初跟着屏幕走：中文屏幕按中文听，其他屏幕在所有语言里识别。说中文、有时夹英文单词的用户，屏幕却还是英文，结果出来的是繁体字，一两秒的录音还被听成韩语、冰岛语或日语。屏幕的语言是它显示什么，不是它的主人说什么，而所有屏幕都是同一个人在说，所以这个选择该由用户来做，而且只做一次。用合成的请求测下来，在用户的几种语言里选，中文和固定按中文一样准，英文和自动识别一样准（错字 3%，固定按中文则是 20% 到 30%）；固定按英文听中文则一团糟。识别每次多花约 0.4 秒，所以只有选了不止一种语言的用户才付这个代价。

**把片名放进提示词。** 把用户最近看的片名和播放器的常用动词放进转录器的提示词，想让名字写对，结果录音一短或一吵，Whisper 一类模型就把这串词复读出来（「三十秒、二十秒、二十秒……」）。像把「湖人」听成「胡仁」这样的错，留给 agent 去处理，它会对照片库理解请求。

**说话人一停顿就发送。** Ask 最初在说话后安静 0.8 秒就发送。用户停下来想一想，请求就只发出去一半；车里噪音大，安静常常等不到，所以大多数请求反正还是靠点一下结束的。停顿定得更长，只是把一种失败换成另一种：三秒对用户来说仍然太短，而且每个请求都要等这么久。像手机助手那样从文字判断请求说完没有，照样会打断人，还要在每次停顿时多调一次模型。点一下或松开只是一个动作，文字又是边说边出现，用户知道什么时候该点。

**用 MediaRecorder 录音。** 它支持的格式因浏览器而异，车机支持哪些不清楚，节点还得用 ffmpeg 解码；Web Audio 在所有浏览器里都直接给出转录器要的 WAV，每秒 32 KB。

## 后果

用户在正在看的屏幕上就能要内容，用的是自己已经有的 agent 和订阅；Yolo 不保存模型凭据，也不为模型付费。每个请求都要启动 CLI，第一步显示出来之前要等几秒；节点或它所在的机器关着时没有人回答。agent 能做的，就是它的 Yolo 连接和两个网页工具允许的，减去删除；车里任何人说的一句话，都会交给一个能搜网页、能在任何屏幕上播放的 agent。屏幕只看到 Yolo 的事件和 agent 的最后一句话，从不看到它的推理。语音输入需要用户自己运行一个转录器，默认没有加载；有人说话时，边说边出字让转录器大约每秒多处理一个请求；听错的请求会马上发出去，要点一下它才能停下来改。
