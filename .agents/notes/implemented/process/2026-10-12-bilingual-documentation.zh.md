# Agent Note: 双语文档配对

Status: implemented

[English](2026-10-12-bilingual-documentation.md) | 中文

## 问题

阅读 Yolo 文档的人和 agent（智能体）既用英文也用中文。用户本人用中文写设计文档，而代码、提交信息、README 和大部分 agent 工作都用英文。只用一种语言维护的文档，会让另一边的读者各自私下翻译，这些译文逐渐偏离，两个版本说法不一致时也没有任何提示。

## 决策

范围内的每份文档都按下面的约定同时维护英文和简体中文版本。这份约定就是 [DeepSeek Harness 的 i18n 约定](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/i18n/README.md)，范围换成 Yolo 的，是[采用 Agent Notes](2026-10-12-agent-notes-hold-project-knowledge.zh.md) 的一部分。

### 配对约定

- **两种语言具有同等权威。** 文档可以先用任一种语言撰写和评审，对侧文件从它翻译而来。两个文件没有主次之分，约束它们的是两者必须表达相同的内容。
- **一组配对是三个同级文件。** 英文 `foo.md`、中文 `foo.zh.md` 和一致性记录 `foo.i18n.yaml`，都在同一目录。配对整体合并：一个 PR（Pull Request）不会只合入一种语言而缺少另外两个文件。
- **一致性记录。** `foo.i18n.yaml` 为每个含有语言相关内容的标题章节保存一条记录。键是该章节的英文标题 slug 路径（第一个标题之前的文字为 `/`；重复的路径依次加 `~2`、`~3`……），记录保存该章节在围栏代码块和生成区域之外的英文块与中文块各自的 hash。对不同章节的修改会改动记录中不同的行，Git 默认的文本合并就能把它们合在一起；只有两个分支改了同一章节，记录才会冲突。配对不同步时，按被编辑一侧的 diff 修补对侧文件，绝不整篇重译；门禁会指出每个变化的章节。让配对重新一致后，用 `npm run verify-translation-pairing -- --write <pair>` 重新记录；这份 diff 就是可评审的「确认一致」动作，所以 `--write` 要求写明确认过的配对（`--write --all` 是显式的全量形式）。

  ```yaml
  /foo:
    en: 41d772192075e133
    zh: dda91c6c670cfd9d
  /foo/usage:
    en: 86940bea4a3c7ed6
    zh: de78429597783c7f
  ```

- **语言切换栏。** 中文文件紧接 H1 之后用 `[English](foo.md) | 中文` 链回英文；英文文件在同一位置用 `English | [中文](foo.zh.md)` 回链。在 GitHub 之外发布的页面可以改用同一对侧文件的公开 URL `https://github.com/HaitianLiu5/yolo/blob/main/<path>`。
- **结构与对侧文件一致。** 标题层级和顺序、列表类型、有序列表起始值、列表项数、表格行列数、带完整查询串和片段后缀的语义链接目标，以及逐字相同的代码块，都要一一对应。指向双语文档集中文档的相对链接，英文一侧用 `.md`，中文一侧用 `.zh.md`；缺少对侧文件属于完整性错误，不会回退。中文文档要为其他文档链接进来的每个英文标题锚点放一个显式的 `<a id="…">`，因为中文标题生成的 slug 不同。

### 门禁：verify-translation-pairing

`npm run verify-translation-pairing`（`doc-sync`（文档同步门禁）的一环）强制执行这份约定：

1. 范围内的每份文档都有完整的配对。
2. 只要存在任何配对文件，这组配对就必须完整且一致：记录为规范格式，并等于根据当前内容算出的记录；两侧都有语言切换栏；每个相对文档链接都使用本侧的语言；结构签名一致。
3. 列为排除的文档没有 `.zh.md`，也没有 `.i18n.yaml`。归档记录不在这个门禁范围内，由 `verify-archived-agent-notes` 封存它们的三文件组。

`--list` 把范围内的每份文档列为 `ok`、`out-of-sync` 或 `missing`，从不失败。写明配对（配对三个文件中的任意一个，或不带后缀的文件名）时只检查这些配对；`doc-sync` 和 CI 运行的是覆盖全部文档的形式。`--cached <pairs>` 检查暂存区的内容，pre-commit 钩子运行的就是它。

由此得出的实际规则：**修改配对任意一侧的变更，要在同一变更中更新对侧文件，并用 `--write <pair>` 重新记录。** 门禁通过只说明这组配对在这些确切内容下被确认过一致，并不说明确认本身可靠：它检查 hash 和 Markdown 结构，从不检查含义、术语或语气。这些由评审负责。

### 范围与排除

范围：依赖、构建和运行时文件夹之外的每个 README（按文件名匹配，不区分大小写）；根目录的 `CONTRIBUTING.md`；以及 `.agents/notes/` 下的每份活跃文档。[scripts/translation-pairing.manifest.json](../../../../scripts/translation-pairing.manifest.json) 只列出排除项：

- `.agents/notes/AGENTS.md`、`.agents/notes/implemented/AGENTS.md` 及其 `CLAUDE.md` 符号链接：给 agent 的指令，和根目录的 `AGENTS.md` 一样只用英文。

冻结的 `.agents/notes/archived/` 目录不在这个持续演进的门禁范围内。文档集之外的文档——`AGENTS.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、技能、GitHub 模板和代码注释——只用英文。

### 翻译规则

- **忠实。** 对侧文件表达的内容与撰写一侧相同：不增加行为、前提、警告或示例，也不删减。两侧在实质内容上不一致时，修正错误的一侧，并在同一变更中把另一侧同步过来。译意义而非逐字，保持作者的语体：简洁的仍然简洁。
- **语气。** 以母语技术作者的身份重述内容。中文句子要有明确的主语，不用含糊的被动句；优先使用约定俗成的工程用语，避免生硬直译。
- **结构。** 保持标题层级、列表形态、表格（表头翻译）、逐字相同的代码块、行内代码和链接目标。标题文字和链接文字要翻译。
- **中文排版。** 中文与英文单词或数字之间加一个半角空格；中文正文使用全角标点，并列项用顿号（、）；优先用逗号、冒号或括号，少用破折号；用「你」而不是「您」；专有名词保持规范的大小写。
- **术语。** 两个方向都遵循下表。中文对侧文件使用「中文」列，术语首次出现时写「首次出现」列的形式。没有约定俗成译法的新术语保留英文，并在同一变更中加入下表。

### 术语

| English | 中文 | 首次出现 | 备注 |
|---|---|---|---|
| agent | agent | agent（智能体） | ChatGPT、Claude、Codex 这类 AI agent |
| Agent Note | Agent Note | | H1 前缀 `# Agent Note: ` 保持英文 |
| MCP | MCP | | |
| control plane | 控制面 | | 即 Cloudflare Worker |
| media node | 媒体节点 | | 简称「节点」 |
| Hub | Hub | | 每个用户一个的 Durable Object |
| owner | 用户本人 | | Yolo 唯一的用户 |
| device | 设备 | | |
| active device | 当前设备 | | |
| capabilities | 能力描述 | | |
| source plugin | 片源插件 | | |
| DNS provider | DNS provider | DNS provider（DNS 服务商） | 维护媒体节点 DNS 名称的服务，内置或由插件提供 |
| Source, sourceKey, Input | Source、sourceKey、Input | | 协议中的数据结构保留英文名 |
| session | 会话 | | 一次播放会话 |
| stream | 流 | | |
| segment | 分片 | | |
| delivery | 交付方式 | | |
| transcode | 转码 | | |
| burn in | 烧录 | | 把图片字幕画进画面 |
| queue, playlist | 队列、播放列表 | | |
| passkey | passkey | | |
| owner pairing code | 配对码 | | 节点签发的 6 位数字码 |
| device code flow | 设备码流程 | | RFC 8628 |
| device credential | 设备凭据 | | `ydt_…` |
| media token | 媒体 token | | |
| realtime channel | 实时通道 | | |
| the player | 播放器 | | Yolo 唯一的浏览器应用（`clients/player`），在站点根路径下提供 |
| car mode, web mode | 车机模式、网页模式 | | 播放器的两种模式（`car`、`web`） |
| canvas engine, `<video>` engine | canvas 引擎、`<video>` 引擎 | | 播放器的两个播放引擎 |
| Tesla | 特斯拉 | | 只指车辆和车上的浏览器，从不指应用 |
| doc-sync | doc-sync | doc-sync（文档同步门禁） | |
| gate | 门禁 | | |
| fixture | fixture | fixture（测试前置数据） | |
| manifest | manifest | manifest（元数据清单） | |
| PR | PR | PR（Pull Request） | |

### 分工

日常的对侧文件由正在工作的 agent 直接更新：读过术语表后一次改完；不生成翻译简报，不另做一轮翻译，也不委派给别人。门禁检查配对完整性、记录的 hash、语言切换栏、链接语言和结构签名。翻译质量、术语以及结构签名没有覆盖的结构由评审负责。

## 曾考虑的替代方案

**按语言分目录、单独的翻译仓库，或把两种语言交织在一个文件里。** 同级文件让一组配对留在同一目录，作为一个整体移动、链接和合并，每个文件也能单独阅读。

**像 Yolo 原来的设计文档那样只用中文。** 这会让项目的英文一侧——README、代码注释、提交信息和用英文工作的 agent——看不到决策依据。

**只用英文。** 这会丢掉用户本人撰写设计时使用的语言。

**用整份文件的 blob hash 作为记录。** 这种记录在任何修改后两行都会变，所以两个分支修改同一配对的不同章节时总会冲突。归档记录仍用这种格式做封存，因为它们永远不会再变。

**harness 的翻译简报和提示词工具。** 它服务于只在显式调用时才运行的扩展翻译工作流，配对门禁也不依赖它；Yolo 没有移植。

## 后果

两边的读者读到的是相同且经过确认的内容，配对也不会在无人察觉的情况下偏离：修改一侧会让门禁变红，直到另一侧跟上并重新记录。每次文档改动都要多一次另一种语言的编辑和一次记录更新，而门禁通过之后，仍需要评审人判断译文本身。
