# 贡献

[English](CONTRIBUTING.md) | 中文

感谢你关注 Yolo。这是一个处于早期阶段的个人项目，所以提交较大的 PR（Pull Request）之前，请先开一个 issue 讨论改动。

<a id="setup"></a>

## 环境准备

Yolo 需要 Node.js 22.12 或更新版本；媒体节点还需要 yt-dlp、FFmpeg 和 Deno，端到端测试需要 FFmpeg 和 Chromium（或 Google Chrome）。

```bash
git clone https://github.com/HaitianLiu5/yolo.git
cd yolo
npm install
npm run build
```

`npm install` 同时会安装 [Git hooks](#git-hooks)。仓库布局和代码地图见 [AGENTS.md](AGENTS.md)。

<a id="run-it-locally"></a>

## 在本机运行

这是一份教程：不用 Cloudflare 账号，在一台机器上跑起整套服务。

想最快看到全部功能跑起来，就运行 `npm run test:e2e`：它在空闲端口上启动一个媒体节点，并用 `wrangler dev --local` 启动控制面，使用本地的 D1 和 KV，不向 Cloudflare 发送任何东西，然后在 Chromium 里播放每一种流类型（[测试分层](.agents/notes/implemented/testing/2026-07-21-test-layers.zh.md)）。

自己逐个运行各部分：

1. 把 `.env.example` 复制成 `.env`，把 `NODE_SECRET` 设为 `openssl rand -base64 32` 的输出。如果这台机器上已经在运行另一个 Yolo 节点，还要设置 `NODE_PORT`、`NODE_LOCAL_SOCKET` 和 `YOLO_RUNTIME_DIR`，让两者不共用端口或目录，并在下面的 `NODE_PUBLIC_ORIGIN` 里使用这个端口。`NODE_LOCAL_SOCKET` 必须是短于 104 字节的绝对路径，否则 `npm run owner-code` 连不上节点。
2. 把 `service/control/.dev.vars.example` 复制成 `service/control/.dev.vars`（Git 会忽略它），把其中的 `NODE_SECRET` 设为同一个值。在 `wrangler dev` 里，这些值会替换 Worker 的 vars 和 secrets；`NODE_TRANSPORT=tunnel` 让控制面通过 `NODE_PUBLIC_ORIGIN` 用普通 HTTP 访问节点，因为 Workers VPC 没有本地模拟器。
3. 用 `npm run db:migrate:local -w service/control` 创建本地 D1 数据库。
4. 在两个终端里分别用 `npm run dev:node` 启动媒体节点、用 `npm run dev:control` 启动控制面。控制面运行的是模板 `wrangler.jsonc`，其中没有任何实例的绑定，使用本地的 D1 和 KV。
5. 运行 `npm run owner-code`，打开 `http://localhost:8787/login`（用 `localhost` 而不是 `127.0.0.1`：passkey 不能绑定到 IP 地址上），输入这个码，创建用户本人的 passkey（[用户本人登录](.agents/notes/implemented/architecture/2026-10-08-passkey-owner-sign-in.zh.md)）。
6. 打开 `http://localhost:8787`，用这个 passkey 配对页面。站点提供的是 `npm run build` 构建出的播放器；改动之后要重新构建，或者运行 `npm run dev`，用带热更新的 Vite，它把 Yolo 的路由转发到 `YOLO_CONTROL_URL`（默认 `http://127.0.0.1:8787`）。

<a id="making-changes"></a>

## 提交改动

- 使用纯 JavaScript ES 模块和 2 空格缩进；Yolo 不用 TypeScript，也不用转译器。
- 具体服务商的代码放在 `plugins/` 里；`service/` 与具体服务商无关（[插件架构](.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.zh.md)）。
- 不要提交 `.env`、`.dev.vars`、运行时数据库、日志、缓存、`yolo.config.json` 或 `clients/player/dist/`。
- 把长期有效的决策记在 [Agent Notes](.agents/notes/README.zh.md) 里，同时写英文和中文；Yolo 没有其他文档文件夹。改动路径、默认值或契约时，在同一个提交里更新负责它的记录，并用 `npm run verify-translation-pairing -- --write <note>.md` 重新记录这对文件。
- 在 PR 里说明行为变化和兼容性影响。

提交之前运行完整检查：

```bash
npm run check
```

它运行文档门禁，构建客户端和 Worker，并运行单元、集成和端到端测试。播放和代理相关的改动还需要用受影响的流类型（`hls`、`direct`、`dash_split` 或 `plex`）手动检查一遍，方法见[测试分层](.agents/notes/implemented/testing/2026-07-21-test-layers.zh.md)。

<a id="branches-and-commits"></a>

## 分支和提交

- 从 `main` 拉分支，分支名为 `<kind>/<topic>`，topic 是简短的 kebab-case。kind 跟随 Agent Note 的分类：`feature/`、`fix/`（修 bug）、`simplification/`、`architecture/`、`process/` 和 `testing/`，另外 `chore/` 用于不记录决策的维护工作。例如 `fix/av-sync`、`feature/lan-direct-play`。
- 提交标题用英文祈使句、句首大写，不加类型前缀，不加句号，最多约 72 个字符，例如「Play Plex originals as they are on the home network」。正文按 72 列换行，说明为什么改、放弃了什么；`Co-Authored-By:` 之类的 trailer 放在最后。
- 每个提交只做一件事，本身就能通过 `npm run check`，并带上它更新的记录；一个 PR 可以包含多个提交。

<a id="git-hooks"></a>

## Git hooks

`npm install` 会安装 `lefthook.yml` 里定义的 [lefthook](https://lefthook.dev) hooks；`npx lefthook install` 重新安装它们，`npm install --ignore-scripts` 则会跳过安装。

| Hook | 运行什么 |
|---|---|
| pre-commit | 对暂存的 `.i18n.yaml` 记录运行 `verify-translation-pairing --cached`；暂存了归档记录时运行 `verify-archived-agent-notes`；`git diff --cached --check` |
| pre-merge-commit | 同样的配对检查和归档检查 |
| pre-push | `npm run doc-sync` |

这些 hooks 是快速的本地检查。CI 在每次推送到 `main` 和每个 PR 上，用 Node 22 和 24 运行 `npm run check:core`；除非改动只涉及 Markdown、翻译记录或 Apple 客户端，也运行端到端测试。

<a id="writing-a-source-plugin"></a>

## 编写片源插件

片源插件是一个实现了[片源插件 API](.agents/notes/implemented/architecture/2026-10-11-source-plugin-api.zh.md) 的 npm 包。它的[编写指南](.agents/notes/implemented/architecture/2026-10-11-source-plugin-api.zh.md#writing-a-source-plugin)从 [`plugins/source-example`](plugins/source-example/) 开始，[插件架构](.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.zh.md)说明插件如何配置、排序以及信任边界。在 1.0 之前，这套 API 是实验性的。

给自己实例用的插件放在检出目录之外，做法见 [`yolo-add-source-plugin`](skills/yolo-add-source-plugin/SKILL.md) 技能。`plugins/` 下的官方插件还要按 [`yolo-add-official-plugin`](.agents/skills/yolo-add-official-plugin/SKILL.md) 清单操作。

<a id="bug-reports"></a>

## 报告 bug

请提供：复现步骤；受影响的 URL 或流类型；在哪里播放的（车机 profile 的 canvas 引擎，还是浏览器的 `<video>` 引擎）；你的操作系统和 Node.js 版本；`yt-dlp --version` 和 `ffmpeg -version` 的输出；相关的浏览器和媒体节点日志（先去掉 token 和签名 URL）；以及直接运行 yt-dlp 是否出现同样的失败。

安全问题请按 [SECURITY.md](SECURITY.md) 的说明私下报告，不要开公开的 issue。

<a id="license"></a>

## 许可证

贡献的内容按本仓库的 [MIT 许可证](LICENSE)授权。
