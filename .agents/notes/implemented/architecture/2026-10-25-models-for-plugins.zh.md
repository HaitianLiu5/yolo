# Agent Note: 插件用用户自己的订阅调用模型

Status: implemented

[English](2026-10-25-models-for-plugins.md) | 中文

## 问题

好几个插件需要语言模型：要认出一个网络投稿是哪一集的元数据插件（[元数据插件](2026-10-25-metadata-plugins.zh.md)），AI 字幕的翻译器（[AI 字幕](../feature/2026-10-18-ai-subtitles.zh.md)），以及以后的插件。没有一项共用的能力，每个插件都得自带模型客户端、自己的 key 和自己的选项名；`subtitles-openai` 就是这样，用一个 URL 和一个 API key 连用户自己跑的服务。

大多数用户已经通过订阅为模型付了钱（ChatGPT Plus 或 Pro、Claude Pro 或 Max、GitHub Copilot），而不是通过 API key，而且很多人已经在节点所在的机器上登录过：Ask 在那里运行用户的 Codex 或 Claude Code，用的就是这份订阅（[屏幕向用户自己的智能体提问](../feature/2026-10-18-agent-from-the-screen.zh.md)）。Magpie 这样的本地网关说明了用户期待什么：Magpie 自己不需要登录，借用 Codex 和 Claude Code 已有的登录，通过一个地址服务一台机器上的所有智能体。用不上这些，Yolo 里的 AI 功能就意味着另一个 API key 和另一份账单，要么就没有。

## 决策

媒体节点有一种**模型**能力（[`service/node/src/models.js`](../../../../service/node/src/models.js)）。插件通过 `yolo.models` 调用它，由一个**模型提供方插件**提供。官方的 `@useyolo/model-subscriptions` 像 Magpie 一样开箱即用：它**借用节点上已有智能体的登录**，先是 Codex，其次是 Claude Code，所以节点在跑 Ask 的用户什么都不用做。和 Magpie 不同，它只借不占：从不写入、刷新或复制别的应用的凭据。节点上没有已登录的智能体时，后备是通过 pi 的模型库让 Yolo 自己登录，或者自定义的服务。Yolo 不依赖 Magpie。

### 插件得到什么

每个节点入口的 API 都有 `yolo.models`，一个 `ModelClient`（[`service/plugin-api/src/index.js`](../../../../service/plugin-api/src/index.js)）。没有提供方能回答、或这个插件当天的调用次数已用完时，`available()` 返回 false，`complete()` 则抛出 `not_found` 或 `rate_limited`，所以每个 AI 功能都是可选的，退回到不用模型的做法。

```js
if (await yolo.models.available()) {
  const answer = await yolo.models.complete({
    purpose: "identify",            // what the answer is for; the provider picks the model
    system: "Identify the film or TV episode this video is a copy of.",
    messages: [{ role: "user", content: JSON.stringify(facts) }],
    schema: IDENTITY_SCHEMA,        // a JSON Schema: the answer is parsed and checked against it
    maxTokens: 400,
  });
  // → { json, text, model: "gpt-…", source: "codex", usage: { input, output } }
}
```

- **所有提供方和来源共用一种调用形式。** 插件只说 `purpose`（`[a-z][a-z0-9-]{0,31}`），从不指定提供方、来源或模型，所以节点有什么就用什么。一个请求有 1 到 50 条消息，最后一条是用户的，连同系统提示最多 100,000 个字符，`maxTokens` 在 1 到 8,000 之间（默认 1,000）。带 `schema` 时，节点解析回答并按 schema 校验（类型、`enum`、`const`、`required`、`properties`、`additionalProperties`、`items`、上下限和长度，以及 `anyOf`）；不符合的回复抛出 `resolve_failed`。
- **只有文字，没有工具。** `complete` 发出消息、拿回一个回答：没有工具调用，不浏览网页，不读文件。插件把模型需要知道的东西放进消息里。这让每次调用的时间和花费都有上限，也不让插件把节点变成一个智能体。
- **节点掌握限额。** 调用最多同时两个，每个超时 60 秒，每个发起调用的插件每天有调用次数上限 `MODEL_CALLS_PER_DAY`（默认 500）。节点自己识别条目的调用算作插件 `metadata`。超过上限的插件在第二天之前拿到 `rate_limited`。节点记录每次调用的插件、用途、提供方和来源、模型、token 数和用时，从不记录内容。

<a id="model-provider-plugins"></a>

### 模型提供方插件

插件用 `yolo.registerModelProvider(id, impl)` 注册提供方；节点使用加载顺序里第一个 `status()` 表示可用的提供方。

| 方法 | 用途 |
|---|---|
| `complete(request)` | 带着节点在 60 秒后中止的 `signal`，用提供方为这个用途选的模型执行一次请求；返回 `{ text, json?, model?, source?, usage? }` |
| `models()` | 可选：它的来源能用的模型，`[{ id, name, source }]` |
| `status()` | 可选：`{ available, reason?, sources? }`，不含密钥，给 `/internal/v1/health` 和 `yolo doctor`；没有它的提供方算作可用 |

`/internal/v1/health` 报告 `models`：`{ provider, providers, callsPerDay, calls }`，即正在用的提供方、每个提供方及其状态，以及当天每个插件的调用次数（[节点内部 API](2026-10-07-node-internal-api.zh.md)）。`yolo doctor` 把它显示为 `node.models`：带当天调用次数的 `ok`，或没有模型回答时的 `info`，从不算失败。

提供方自己的登录由一个 `setup` 入口执行，和 DNS 提供方插件一样（[DNS 提供方插件](2026-10-14-dns-provider-plugins.zh.md)）：运维命令行找到 setup 入口负责 `models` 的已启用插件（[`ops/lib/setup-entry.js`](../../../../ops/lib/setup-entry.js)），在节点所在的机器上导入它（[`ops/commands/models.js`](../../../../ops/commands/models.js)）。

```bash
npm run yolo -- models status                  # each source and whether it answers; the node's provider and today's calls
npm run yolo -- models login [subscription]    # Yolo's own sign-in, for a node with no signed-in agent
npm run yolo -- models logout <subscription>
```

`models login` 需要用户在节点所在机器的终端前（SSH 会话也行）；没有终端时它以 `needs_human` 停下。节点在下一次调用时读到新的登录，不用重启。

核心不出现任何模型厂商或智能体的名字：它们只出现在提供方插件、它的依赖和用户的配置里。`scripts/provider-names.js` 把 `model-subscriptions` 列为不指向服务商的插件目录，因为用户的订阅在哪个厂商，它就服务哪个厂商。

### 官方提供方

`@useyolo/model-subscriptions`（[`plugins/model-subscriptions`](../../../../plugins/model-subscriptions/src/node.js)）在官方目录（catalog）里，用户选择自己的文件夹或 Plex 时一起打开（[从任何屏幕选择插件](../../proposed/feature/2026-10-31-home-cold-start.zh.md)），注册提供方 `subscriptions`。一个请求交给第一个可用的来源，这个来源失败时再交给下一个。默认顺序是 `codex`、`claude-code`、`own`、`custom`；`sources` 选项可以调整顺序或限定来源，`[]` 关闭所有来源。

| 来源 | 怎么调用 | 设置 | 实测 |
|---|---|---|---|
| `codex`：借用 Codex 的登录 | 读取 Codex 的凭据，调用 Codex 自己用的 Responses 接口 | Codex 已登录时无需设置 | 2026-10-26 在用户的笔记本上约 10 秒、252 个 token；更早的一次试验 4.8 秒、174 个 token |
| `claude-code`：驱动 Claude Code | 运行 `claude -p`，不带工具，带上 schema，提示从 stdin 传入 | Claude Code 已登录时无需设置 | 4 到 10 秒，约 1,400 个输入 token |
| `own`：Yolo 自己的登录 | 用 pi 的模型库和 `models login` 存下的凭据 | `npm run yolo -- models login` | 取决于订阅 |
| `custom`：用户自己跑的服务 | OpenAI 的 Chat Completions：Ollama、LM Studio、用户自己跑的 Magpie | `custom.url` 和 `custom.model` | 取决于服务 |

实测数字是识别一个《Nathan for You》S01E08 的 B 站投稿。每次回答的剧、季和集都对；Claude Code 的 Haiku 有一次编造了分集标题，所以节点在描述条目之前要用记录确认模型的回答。

**只读地借用 Codex 的登录。** `codex` 来源（[`codex.js`](../../../../plugins/model-subscriptions/src/codex.js)）在 Codex 主目录（`$CODEX_HOME`，否则是 `~/.codex`）里 `auth.json` 的修改时间变化时重新读取它，用 `fetch` 带着其中的访问令牌和 `ChatGPT-Account-Id` 把请求直接发到 `https://chatgpt.com/backend-api/codex/responses`，以流式方式、`store: false`、低推理强度。这个令牌在 OpenAI 的公开 API 上不能用，所以这个来源调用 Codex 的接口。模型取插件的 `codex.models` 为这个用途指定的，否则取 Codex 的 `config.toml` 顶层的 `model`，再否则取 Codex 模型列表给出的第一个。插件从不写这个文件，也从不刷新令牌：刷新会轮换 refresh token，第二个刷新者会让 Codex 掉线，Magpie 自己刷新就有这个风险。令牌离过期不到 60 秒、或请求得到 401 时，插件运行 `codex exec --skip-git-repo-check --ephemeral --sandbox read-only "Reply with OK."`，关闭 stdin，十分钟最多一次，让 Codex 按它自己的规则续上登录，然后重新读文件。如果 Codex 续不上，这个来源以"run codex login on the media node's machine"失败，由下一个来源回答。

**驱动 Claude Code，而不是借它的令牌。** Claude Code 把凭据存在钥匙串里，而 Anthropic 以前限制过在 Claude Code 之外使用订阅凭据，所以插件不读它。`claude-code` 来源（[`claude-code.js`](../../../../plugins/model-subscriptions/src/claude-code.js)）在临时目录里运行 Ask 本来就在运行的 `claude` 命令：`claude -p --model <model> --tools "" --strict-mcp-config --no-session-persistence --output-format json --system-prompt <system> [--json-schema <schema>]`，提示从 stdin 传入，读取回答的 `structured_output`。模型取 `claudeCode.models` 指定的，否则是 `haiku`。回答的就是 Claude Code 本身，遵守 Claude Code 自己的条款；它在 Claude Code 能读到登录的地方都能用，也就是 Ask 运行它的节点服务里。普通的 SSH 会话可能读不到钥匙串，用户的 Mac mini 上就回答了 "Not logged in"；得到这个回答后，这个来源十分钟内不可用。这个来源每次调用都要带上 Claude Code 自己的提示，所以排在 Codex 之后。

**通过 pi 的模型库，Yolo 自己登录。** 节点上没有已登录的智能体时，`npm run yolo -- models login` 通过 `@earendil-works/pi-ai` 1.4.0（MIT）登录，即 pi 的模型库；Yolo 的插件本来就沿用 pi 的扩展模型（[插件架构](2026-10-11-plugin-architecture.zh.md)）。它首先提供 OpenAI 的 Sign in with ChatGPT，因为 OpenAI 写明了套餐额度可用于开源项目和在本地运行的个人项目，而 Yolo 节点正是如此；然后是 GitHub Copilot 和 OpenRouter。它不提供 Anthropic 的登录：Claude 订阅走 `claude-code` 来源。`own` 来源（[`own.js`](../../../../plugins/model-subscriptions/src/own.js)）把 schema 放进系统提示，由节点校验回答。

- **节点所在的机器不需要浏览器。** pi-ai 的登录会打印授权 URL，同时接受粘贴回终端的重定向地址，与它自己在 `127.0.0.1` 上的回调服务竞速。用户在手机或笔记本上登录，再把浏览器打不开的那个 `127.0.0.1` 地址粘贴回来。
- **凭据留在节点上**，是插件 `stateDir`（`<运行目录>/.yolo/plugins/useyolo-model-subscriptions/`，被 Git 忽略，Yolo 从不删除，这一点和 `cacheDir` 不同）里的 `credentials.json`，权限 0600。每次写入都在旁边的锁文件 `credentials.lock` 下读、改、写，所以节点和 `models login` 从不重复刷新或互相覆盖。这份凭据是 Yolo 自己的，刷新它不会让别的应用掉线。
- **只有这个来源需要 Node.js 22.19**，这是 pi-ai 的最低要求。插件只在用到 `own` 来源时才导入 pi-ai，所以它的 `engines` 仍是 Yolo 的 22.12，其他来源在 Yolo 支持的任何 Node.js 上都能用。

**自定义的服务。** `custom` 来源（[`custom.js`](../../../../plugins/model-subscriptions/src/custom.js)）调用 `custom.url` 上的 OpenAI Chat Completions 服务，模型是 `custom.model`，或按用途的 `custom.models`；服务需要 key 时用 `MODEL_CUSTOM_API_KEY`。

### 选择模型

每个来源有自己的选项，把用途映射到模型，没写到的用途用默认值：

```json
{
  "source": "./plugins/model-subscriptions",
  "options": {
    "sources": ["codex", "claude-code", "own", "custom"],
    "codex": { "models": { "default": "<model>" }, "reasoning": "low", "command": "codex" },
    "claudeCode": { "models": { "default": "haiku" }, "command": "claude" },
    "own": { "models": { "default": "<provider>/<model>" } },
    "custom": { "url": "http://127.0.0.1:11434/v1", "model": "qwen3:8b" }
  }
}
```

没有指定模型时，`codex` 用 Codex 自己的模型，`claude-code` 用 Haiku，`own` 选订阅提供的一个小模型（名字带 `mini`、`nano`、`haiku`、`flash`、`small` 或 `lite` 的），因为 Yolo 现有的用途都是简短的结构化回答。`codex.command` 和 `claudeCode.command` 没有时取 `CODEX_COMMAND` 和 `CLAUDE_CODE_COMMAND`，和智能体插件一样。

### 隐私

一次调用把插件放进消息里的东西，以用户自己的账号发给模型厂商：对元数据来说，是条目的标题、简介、上传者、网站、时长、日期和文件名，以及同一投稿其他分 P 的标题，从不包括媒体本身或用户的历史。借用默认开启，所以 Codex 或 Claude Code 已登录的节点不需要额外步骤就会发送这些；用的是 Ask 本来就在发送用户请求的同一个账号和厂商。隐私政策（`site/public/privacy.html` 和 `site/public/zh/privacy.html`）和 `yolo-deploy` 技能会说明这一点，`"sources": []` 关闭所有来源，把插件移出加载列表就去掉了这项能力。

## 曾考虑的替代方案

**只用 Yolo 自己的登录。** 这份说明的早先版本要求用户先用 `models login` 为 Yolo 登录，AI 功能才能用。这是有文档的做法，仍然作为后备，但它要求每个用户多做一步，而大多数节点已经为 Ask 登录了一个智能体。

**经 pi-ai 调用 Codex 的接口。** pi-ai 有 Codex 接口，但让 `codex` 来源经过它，每个用户的模型调用都要加载 pi-ai 和它带进来的厂商 SDK，还要 Node.js 22.19，而要做的只是一个带 bearer 令牌的 HTTP 请求。这个来源用 `fetch` 调用接口；只有 Yolo 自己登录时才加载 pi-ai。

**像 Magpie 那样刷新借来的令牌。** Magpie 读取 Codex 的 `auth.json` 和 Claude Code 的钥匙串条目，并自己刷新它们的令牌。刷新会轮换 refresh token，所以 Yolo 刷新 Codex 的凭据可能让 Codex 掉线，连带用户的 Ask。Yolo 只读，让 Codex 自己刷新。

**读取 Claude Code 的令牌，直接调 Anthropic 的 API。** 这样和 `codex` 来源一样快，但 Anthropic 以前把订阅凭据限制在自己的应用里，而且不是每个进程都读得到钥匙串。运行 `claude` 让调用留在 Claude Code 里面。出于同样的原因，`own` 来源不提供 Anthropic 的登录。

**每次调用都驱动 `codex exec`。** 在用户的 Mac mini 上它能用，12 秒答对，但 Codex 的智能体提示让一次识别花了 25,820 个 token，借用令牌只要几百个。插件只在需要 Codex 续上登录时运行它。

**依赖 Magpie。** 把插件指向 Magpie 的本地网关（`127.0.0.1:3425`，key 为 `magpie`）不用写代码，作为 `custom` 来源也仍然可行。但如果只有这一条路，每个 AI 功能都要求装一个独立的桌面应用，无显示器的 Mac mini 或 NAS 也不例外，而 Yolo 对它依赖的登录一无所知。

**为每个提供方自己写 OAuth 客户端。** 每个提供方的流程、客户端注册、令牌刷新和 API 都不一样，还在变化；pi-ai 为 `own` 来源维护着它们。

**每日上限按提供方算，写在提供方的选项里。** 上限属于节点：不管哪个提供方回答，节点都要统计每个插件的调用。节点环境里的一个数字覆盖所有提供方，包括社区插件加入的。

**把模型能力放进核心而不是插件。** 那样核心就要带上一个 LLM 库，还要出现厂商和智能体的名字。作为提供方插件，它和 Plex 一样可选：不想用 AI 的用户不加载，另一个库或网关也能取代它。

**每个问题都运行用户的智能体（Claude Code 或 Codex 插件）。** 智能体插件的一次运行会启动带 Yolo MCP 工具的完整智能体，要几十秒到几分钟，而且和屏幕的 Ask 请求一次只能跑一个。`claude-code` 来源运行同一个命令，但不带工具和 MCP 服务，只要一个回答，也不进 Ask 的队列。

**从控制面发起调用。** 借用的登录和 pi-ai 的 OAuth 流程都在节点所在的机器上，OpenAI 的套餐额度面向本地运行的软件，而需要模型的插件也都在节点上。Worker 用不到它们。

**给插件工具或浏览能力。** 能搜索网页的模型能认出更多投稿，但每次调用都会变成时间和花费都没有上限的智能体运行。由插件收集模型需要的东西（比如数据库的搜索结果），再请它做决定。

## 后果

节点在跑 Ask 的用户不做任何额外步骤，每个插件就都有了模型，用的是他们本来就在付费的订阅；没有智能体的用户从任何设备为 Yolo 登录一次即可。插件只调用一个接口，从不知道是哪个厂商回答的；测试固定了节点的限额和 schema 校验（[`service/node/test/models.test.js`](../../../../service/node/test/models.test.js)），以及每个来源的请求和回答（[`plugins/model-subscriptions/test/sources.test.js`](../../../../plugins/model-subscriptions/test/sources.test.js)）。

- **`codex` 来源用的是 OpenAI 没有向第三方公开的接口**，令牌也是发给 Codex 的。OpenAI 随时可能改掉这个接口或拒绝其他调用者。那时这个来源失败，`models status` 会说明，由下一个来源回答；`models login` 的 Sign in with ChatGPT 是有文档的做法，OpenAI 反对时就改用它。
- **每个厂商的条款决定它的订阅能不能在这里用。** 驱动 `claude` 让 Claude 的调用留在 Claude Code 里面，插件自己的登录也只提供给允许第三方使用的厂商。
- **订阅的额度是共用的。** Yolo 的调用计入用户在 ChatGPT、Claude、Codex 和 Ask 里用的同一个套餐。每日调用次数上限和默认的小模型限制了用量，`yolo doctor` 显示当天的调用次数。
- **借用依赖别的应用的文件格式和命令行**，Codex 和 Claude Code 的任何一个版本都可能改。插件检查它读到的东西，读不懂时让这个来源失败，并在消息里说明怎么修。
- **pi-ai 还年轻、变化快**，而且会带进好几个厂商的 SDK（[第三方声明](../../../../THIRD_PARTY_NOTICES.md)）。插件固定它的版本，并且是唯一导入它的地方，所以它不兼容的新版本只影响一个来源。
- **内容会离开家里**：插件每次调用模型，内容都以用户的账号发给模型厂商，默认经过用户本来就在用的智能体。
- **这个能力由最早的使用者塑造**，即元数据，和插件 API 的其余部分一样在 1.0 之前保持实验性。
