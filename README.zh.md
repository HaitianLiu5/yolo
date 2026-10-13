# Yolo

[English](README.md) | 中文

**Yolo 是一个由你的 AI agent（智能体）驱动的私人媒体服务。**对 ChatGPT 或 Claude 说「在车上播 The Gentlemen」，它就会搜索你的片库，在对的屏幕上开始播放，并从你上次停下的地方接着播。Yolo 运行在你自己的 Cloudflare 账号和家里机器上的媒体节点上，它的播放器首先为特斯拉浏览器打造，在其他任何浏览器里也能播放。

> 在车上，请只在停车时或作为乘客使用 Yolo。遵守当地法律，只播放你有权访问的媒体。Yolo 与特斯拉或 Plex 没有任何关联。

<a id="highlights"></a>

## 亮点

- **agent 优先。**一个带 OAuth 的远程 MCP 服务：给 agent 一个 URL，用 passkey 批准一次，它就能搜索、播放、暂停、跳转、切换字幕和管理队列。
- **在特斯拉浏览器里播放。**在车上，播放器用 WebCodecs 解码并画到 `<canvas>` 上，因为车辆行驶时特斯拉可能会冻结普通的 `<video>` 元素。
- **每个浏览器都是一块屏幕，也是一个遥控器。**Yolo Web 就是在电脑或手机浏览器（包括 iPhone）里打开的同一个应用：它可以浏览和搜索你的片库、用浏览器自己的 `<video>` 在浏览器里播放（支持画中画和锁屏控制），并像 Spotify Connect 一样控制正在播放的那块屏幕；它的设置可以管理设备、已连接的 agent 和 passkey（[Yolo Web](.agents/notes/implemented/feature/2026-10-11-yolo-web-client.zh.md)）。
- **你的片库，你的进度。**Plex 片库和网页视频链接（通过 yt-dlp）都是插件；Yolo 只保存一份观看记录，所以每块屏幕都从你停下的地方续播。
- **天生私密。**控制面运行在你的 Cloudflare 账号里；家里的机器不开放任何公网端口，你只用 passkey 登录。
- **可扩展。**片源是 npm 插件，插件 API 为实验性，增加新片源不需要改动核心。

<a id="how-it-works"></a>

## 工作原理

```
 ChatGPT / Claude / Codex          Tesla browser, other screens
          │ MCP + OAuth                    │ HTTPS + WebSocket
          ▼                                ▼
 ┌──────────── Control plane (Cloudflare Worker) ─────────────┐
 │ MCP · /v1 API · OAuth & passkeys · Hub (what plays where)   │
 │ D1: devices, queue, playlists, history                       │
 └──────────────┬──────────────────────────────────────────────┘
                │ Workers VPC (no public address at home)
                ▼
 Media node (your home machine)
   source plugins (Plex, yt-dlp) → media pipeline → /m/* streams
   (at home, screens can also fetch /m/* from the node over the LAN)
```

控制面提供播放器、MCP 服务和 `/v1` API，其中的 Hub 决定哪块屏幕播放什么。媒体节点解析片源，并经 Worker、在播放器自己的源下把媒体流传回来；家庭网络里的屏幕也可以直接从节点在局域网上的 HTTPS 地址取流（[局域网直连播放](.agents/notes/implemented/feature/2026-10-12-lan-direct-play.zh.md)）。[Agent Notes](.agents/notes/README.zh.md) 解释了每一部分以及为什么这样构建；可以从[整体拆分](.agents/notes/implemented/architecture/2026-10-07-control-plane-on-cloudflare-media-node-at-home.zh.md)、[两个播放引擎](.agents/notes/implemented/architecture/2026-10-12-two-playback-engines.zh.md)和[插件架构](.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.zh.md)读起。

<a id="status"></a>

## 状态

Yolo 目前是 0.4 版，运行着用户本人自己的实例。它处于 1.0 之前：协议和插件 API 仍可能不兼容地修改。接下来是文件夹和 NAS 片库、面向 Apple 设备的兼容 Jellyfin 的协议，以及给其他用户用的安装包；见[通往 1.0 的路线](.agents/notes/proposed/feature/2026-10-11-yolo-1-0.zh.md)。

<a id="quick-start"></a>

## 部署你自己的实例

Yolo 由替你工作的 agent 来安装。在家里那台要运行媒体节点的电脑上，在本仓库的克隆里打开 Claude Code 或 Codex 这类编程 agent，让它部署 Yolo：它按照[部署技能](skills/yolo-deploy/SKILL.md)操作，需要你的时候就会停下来。

你需要一个 Cloudflare 账号（免费套餐预计就够用），上面托管一个域名；还需要一台装有 Node.js 22.12 或更新版本、[yt-dlp](https://github.com/yt-dlp/yt-dlp)、[FFmpeg](https://ffmpeg.org/)、[Deno](https://deno.com/) 和 cloudflared 的 Mac 或 Linux 电脑。在 macOS 上：

```bash
brew install node yt-dlp ffmpeg deno cloudflared
```

需要你亲自做的事：选定地址（它是永久的：passkey 绑定在它上面），批准 Cloudflare 登录，在 Cloudflare 控制台里创建隧道并把它的 token 交给 agent，批准部署计划，用 agent 给你的 6 位数字码创建 passkey，扫描二维码配对每块屏幕，以及批准每个接入的 AI 应用。Plex 运行在同一台 Mac 上时会被自动找到；在家时直接从家里的机器播放，需要你自己创建一个 Cloudflare DNS token（[局域网直连播放](.agents/notes/implemented/feature/2026-10-12-lan-direct-play.zh.md)）。

agent 通过 `npm run yolo -- <command>` 完成工作：`init`、`provision`、`migrate`、`deploy`、`service install`，以及检查一切的那条命令 `doctor`。你的实例的地址和 Cloudflare id 保存在不受版本控制的 `yolo.instance.json` 里；请把它和 `.env` 各备份一份。整体如何组合在一起，见 [agent 部署](.agents/notes/implemented/feature/2026-10-13-agent-deployment.zh.md)。

## 升级

发布是一个个标签（`vX.Y.Z`），在 [CHANGELOG.md](CHANGELOG.md) 里说明。让你的 agent 升级 Yolo：它按照[升级技能](skills/yolo-upgrade/SKILL.md)，先告诉你这次发布改了什么并等你批准，再备份数据库、执行迁移、重启节点、部署 Worker 并检查结果。如果出了问题，`npm run yolo -- rollback` 回到上一个发布，同样要先经你批准。

## 接入你的 AI 应用

把 `https://<your-domain>/mcp` 交给你的应用，并用 passkey 批准一次。[接入技能](skills/yolo-connect-agent/SKILL.md)给出了 Claude Code、claude.ai、ChatGPT 和 Codex 的步骤。

<a id="documentation"></a>

## 文档

所有项目知识都在 [Agent Notes](.agents/notes/README.zh.md) 里，有英文和中文两种语言：带依据的决策、协议、插件 API、埋点，以及对未来工作的提案。在代码上工作的 agent 从 [AGENTS.md](AGENTS.md) 开始；通过 MCP 使用 Yolo 的 agent 可以加载 [Yolo 技能](skills/yolo/SKILL.md)。

<a id="development"></a>

## 开发

`npm run check` 运行文档门禁，构建客户端和 Worker，并运行单元、集成和端到端测试（[测试分层](.agents/notes/implemented/testing/2026-07-21-test-layers.zh.md)）。参与贡献请看 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。

<a id="license"></a>

## 许可证

[MIT](LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
