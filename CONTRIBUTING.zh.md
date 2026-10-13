# 贡献

[English](CONTRIBUTING.md) | 中文

感谢你关注 Yolo。这是一个处于早期阶段的个人项目，所以提交较大的 PR（Pull Request）之前，请先开一个 issue 讨论改动。

<a id="setup"></a>

## 环境准备

Yolo 需要 Node.js 22.12 或更新版本；媒体节点还需要 yt-dlp、FFmpeg 和 Deno，端到端测试需要 FFmpeg 和 Chromium（或 Google Chrome）。

```bash
git clone https://github.com/HaitianLiu5/yolo.git
cd yolo
cp .env.example .env
npm install
npm run build
```

`npm run dev:control` 用 wrangler 运行控制面，`npm run dev:node` 运行媒体节点，`npm run dev` 用 Vite 运行播放器。仓库布局和代码地图见 [AGENTS.md](AGENTS.md)。

<a id="making-changes"></a>

## 提交改动

- 使用纯 JavaScript ES 模块和 2 空格缩进；Yolo 不用 TypeScript，也不用转译器。
- 具体服务商的代码放在 `plugins/` 里；`service/` 与具体服务商无关（[插件架构](.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.zh.md)）。
- 不要提交 `.env`、运行时数据库、日志、缓存、诊断报告、`yolo.config.json` 或 `clients/tesla/dist/`。
- 把长期有效的决策记在 [Agent Notes](.agents/notes/README.zh.md) 里，同时写英文和中文；Yolo 没有其他文档文件夹。
- 在 PR 里说明行为变化和兼容性影响。

提交之前运行完整检查：

```bash
npm run check
```

它运行文档门禁，构建客户端和 Worker，并运行单元、集成和端到端测试。播放和代理相关的改动还需要用受影响的流类型（`hls`、`direct`、`dash_split` 或 `plex`）手动检查一遍，方法见[测试分层](.agents/notes/implemented/testing/2026-07-21-test-layers.zh.md)。

<a id="bug-reports"></a>

## 报告 bug

请提供复现步骤、受影响的 URL 或流类型、你的操作系统和 Node.js 版本、`yt-dlp --version` 和 `ffmpeg -version` 的输出、相关的浏览器和媒体节点日志，以及直接运行 yt-dlp 是否出现同样的失败。

安全问题请按 [SECURITY.md](SECURITY.md) 的说明私下报告，不要开公开的 issue。

<a id="license"></a>

## 许可证

贡献的内容按本仓库的 [MIT 许可证](LICENSE)授权。
