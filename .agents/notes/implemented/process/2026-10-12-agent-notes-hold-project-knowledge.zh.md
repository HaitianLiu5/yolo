# Agent Note: 项目知识全部放在 Agent Notes 里

Status: implemented

[English](2026-10-12-agent-notes-hold-project-knowledge.md) | 中文

## 问题

Yolo 的知识分散在互不相关的地方，没有规则规定哪条事实放在哪里。`docs/` 里有一张编号的 25 条决策表、一份 500 行的协议草案（把协议约定和实现状态、部署步骤、一次事故记录混在一起）、一份路线图、一份插件指南，以及三份 Drive-In 时期的记录。另有测试架构 README、实验 README 和一份设计背景文件散落在别处，`AGENTS.md` 还要求 agent（智能体）在提议改动前先读四份文档。状态行逐渐过时，同一条规则（例如播放器为什么需要 COOP/COEP）在三个文件里各写一遍；约一百处代码注释引用「decision 15」或「yolo-v1.md §7」，表格一重新编号或章节一移动就失效。这些内容都没有任何检查，而且设计文档只有中文，代码、提交信息和 README 却是英文。

## 决策

Yolo 原封不动地照搬 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent Notes 机制，包括其双语体系，并把它作为项目知识的唯一存放处（用户本人决定，2026-10-12）：

- [Agent Note 规则](../../README.zh.md)规定布局、封闭的类别集合、头部与正文格式、生命周期、取代关系检查、带内容封存 manifest（元数据清单）的冻结归档，以及禁止集中索引。每份记录都是三个文件：英文文件、`.zh.md` 对侧文件和 `.i18n.yaml` 一致性记录，遵循[双语约定](2026-10-12-bilingual-documentation.zh.md)。
- 没有 `docs/` 文件夹，也没有零散的记录：分类门禁拒绝 `docs/` 文件夹。实质上属于已交付结构决策的参考资料——`/v1` 协议、插件 API、媒体管线的 Input 约定、埋点、测试分层、设计原则——放在持有该决策的 implemented 记录里，一份记录一个决策。未来工作和待定问题放在 `proposed/`。
- Agent Notes 以外的根目录文件只保留 GitHub 期望的内容：`README.md`（项目首页，和 harness 的 README 一样双语）、`CONTRIBUTING.md`（和 harness 的一样双语）、`SECURITY.md` 和 `CODE_OF_CONDUCT.md`（只有英文；harness 没有这两个文件）、`LICENSE`、`THIRD_PARTY_NOTICES.md`，以及 `CHANGELOG.md`（只有英文：每次发布的改动和升级命令读取的升级事实，[版本与发布](2026-10-13-versions-and-releases.zh.md)）。`AGENTS.md`（`CLAUDE.md` 是指向它的符号链接）存放常设规则，每条规则都链接到持有其依据的记录。`skills/` 存放交付给部署、运维和使用实例的 agent 的产品技能，不属于项目文档。
- 文档用相对路径链接记录，代码注释用 `Agent Note <file stem>` 引用记录；任何地方都不引用决策编号或其他文档的章节编号。
- [文档规范和 slop 检查清单](../../AGENTS.md#the-documentation-standard)放在 Agent Notes 自己的 `AGENTS.md` 里。

### 门禁

`npm run doc-sync` 通过 `scripts/run-gates.js` 并发运行六个门禁，`npm run check` 在构建和测试之前先运行它：

| 脚本 | 检查内容 |
|---|---|
| `verify-agent-note-classification` | 生命周期和类别文件夹、带日期的文件名、没有 `INDEX.md`、没有 `docs/` |
| `verify-agent-note-format` | 头部块、各生命周期的状态语法、必需和禁用的章节、替代方案 |
| `verify-archived-agent-notes` | 归档三文件组、归档元数据、伴随记录的 blob hash、仅追加的 manifest |
| `verify-translation-pairing` | 配对完整、章节记录、链接语言、语言切换栏、结构签名 |
| `verify-md-links` | 相对链接的目标和标题锚点 |
| `verify-md-wrap` | 每个正文段落只占一个物理行 |

CI 运行 `doc-sync` 时把拉取请求的基准提交设为 `YOLO_ARCHIVE_BASE_REF`，并检出完整历史，所以复用的浅克隆无法掩盖被改动的封存。`lefthook.yml` 在提交或合并之前检查暂存的配对记录和归档改动，在推送之前运行 `doc-sync`。门禁自身的测试和其他单元测试一起运行（`node --test scripts/*.test.js`）。

### 与 harness 的不同之处

机制来自 harness；以下差异是为 Yolo 所做的适配，任何一方变化时都要同步更新：

- 每个脚本都是纯 JavaScript，测试用 Node 的测试运行器，因为 Yolo 不允许 TypeScript 或转译器。移植后的章节记录代码与 harness 记录的 fixture（测试前置数据）hash 完全一致。
- harness 专有的名称换成 Yolo 的名称：`yolo-archive-agent-notes` 技能、`YOLO_ARCHIVE_BASE_REF`、`yolo-translation-target:` 链接标记，以及 `HaitianLiu5/yolo` 公开 URL。npm 只转发 `--` 之后的脚本参数，所以命令写作 `npm run verify-translation-pairing -- --write <pair>`。
- 格式在 Yolo 于 2026-10-12 生效，所以豁免注释只对日期早于这一天的记录有效。
- 配对范围是所有 README、根目录的 `CONTRIBUTING.md` 和 `.agents/notes/`；harness 的 `docs/` 和 `python/` 根目录在这里不存在。
- 归档里某个类别的文件夹可以不存在，因为 Git 不保存空目录；门禁拒绝已存在文件夹中的未知类别。不存在封存哈希转换例外。
- 配对门禁用按名称判断的回调函数跳过依赖和运行时文件夹，因为 Node 22.12（Yolo 支持的最低版本）的 `globSync` 的 `exclude` 不接受 glob 模式。
- `doc-sync` 是一个只运行这六个门禁的小运行器，不是 harness 的通用门禁调度器。
- 没有移植：harness 的翻译简报和提示词工具，配对门禁并不导入它们（它们服务于需要显式调用的扩展翻译工作流）；harness 的字数预算、生成目录和包相关门禁，它们管理的文档 Yolo 没有；以及 harness 的按 worktree 安装钩子的安装器（见「后果」）。

## 曾考虑的替代方案

**在 Agent Notes 之外保留 `docs/`。** 两个存放处会重新带来「这条事实该放哪」的问题，以及随之而来的重复；用户本人选择只保留一个存放处。

**按 Yolo 的规模改造这套机制**，例如去掉归档或中文对侧文件。没有采用：这套机制原样照搬，这样规则和门禁与 harness 一致，上游后续的修正也能顺利移植。harness 在它自己的记录里写明了格式、归档和按章节记录配对的依据：[统一的、受门禁检查的文件内格式](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/archived/process/2026-07-05-uniform-agent-note-format.md)、[冻结归档](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/process/2026-07-26-frozen-agent-note-archive.md)和[按章节键记录](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/archived/process/2026-09-23-section-keyed-translation-pairing-records.md)。

**移植 Agent Notes，但仍在一张表里保留编号决策。** 表格拆分或重新编号之后，编号无法说明依据在哪里，也没有任何东西能检查它；相对链接可以检查，并且在生命周期文件夹之间移动时依然有效。

**同时移植按 worktree 安装钩子的安装器。** harness 按 worktree 安装钩子，是因为共享钩子会让一个 worktree 的安装改写其他所有 worktree 的钩子。在 npm 下，lefthook 包自己的安装脚本在任何根目录脚本之前运行，并安装到共享的钩子文件夹，所以根目录的安装器做不到这种隔离；它还会在第一次安装时迁移共享的仓库配置。

## 后果

每条事实都有一个受门禁检查的存放处：链接能解析，记录保持格式，归档记录不能改动，两种语言始终互相确认一致。agent 和读者浏览生命周期和类别文件夹就能找到决策，不用再读四份长文档。

代价是每次文档改动都要涉及两种语言和一份记录；链接失效或译文未确认时，`npm run check` 会像测试失败一样失败。lefthook 的 npm 包安装的 Git 钩子由这个检出的所有 worktree 共享；没有 `lefthook.yml` 的 worktree 只会打印一条提示，照常提交。
