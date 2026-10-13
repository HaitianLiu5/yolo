# Yolo

[English](README.md) | 中文

**Yolo 是一个由你的 AI agent（智能体）驱动的私人媒体服务。**对 ChatGPT 或 Claude 说「在车上播 The Gentlemen」，它就会搜索你的片库，在对的屏幕上开始播放，并从你上次停下的地方接着播。Yolo 运行在你自己的 Cloudflare 账号和家里机器上的媒体节点上，它的第一块屏幕是 Drive-In，一个为特斯拉浏览器打造的播放器。

> 请只在停车时或作为乘客使用 Drive-In。遵守当地法律，只播放你有权访问的媒体。Yolo 与特斯拉或 Plex 没有任何关联。

<a id="highlights"></a>

## 亮点

- **agent 优先。**一个带 OAuth 的远程 MCP 服务：给 agent 一个 URL，用 passkey 批准一次，它就能搜索、播放、暂停、跳转、切换字幕和管理队列。
- **在特斯拉浏览器里播放。**Drive-In 用 WebCodecs 解码并画到 `<canvas>` 上，因为车辆行驶时特斯拉可能会冻结普通的 `<video>` 元素。
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
```

控制面提供特斯拉播放器、MCP 服务和 `/v1` API，其中的 Hub 决定哪块屏幕播放什么。媒体节点解析片源，并经 Worker、在播放器自己的源下把媒体流传回来。[Agent Notes](.agents/notes/README.zh.md) 解释了每一部分以及为什么这样构建；可以从[整体拆分](.agents/notes/implemented/architecture/2026-10-07-control-plane-on-cloudflare-media-node-at-home.zh.md)、[两个播放引擎](.agents/notes/implemented/architecture/2026-10-12-two-playback-engines.zh.md)和[插件架构](.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.zh.md)读起。

<a id="status"></a>

## 状态

Yolo 目前是 0.4 版，运行着用户本人自己的实例。它处于 1.0 之前：协议和插件 API 仍可能不兼容地修改。接下来是文件夹和 NAS 片库、面向 Apple 设备的兼容 Jellyfin 的协议，以及给其他用户用的安装包；见[通往 1.0 的路线](.agents/notes/proposed/feature/2026-10-11-yolo-1-0.zh.md)。

<a id="quick-start"></a>

## 快速开始

下面是运行你自己实例的大致步骤；具体步骤见[部署一节](.agents/notes/implemented/architecture/2026-10-07-control-plane-on-cloudflare-media-node-at-home.zh.md#deployment)。

你需要一个 Cloudflare 账号和托管在它上面的域名，以及一台装有 Node.js 22.12 或更新版本、[yt-dlp](https://github.com/yt-dlp/yt-dlp)、[FFmpeg](https://ffmpeg.org/)、[Deno](https://deno.com/) 和 cloudflared 的家用机器。在 macOS 上：

```bash
brew install yt-dlp ffmpeg deno cloudflared
```

1. 克隆仓库，然后运行 `npm install` 和 `npm run build`。
2. 把 `.env.example` 复制成 `.env` 并设置 `NODE_SECRET`；把同样的值设为 Worker secret `NODE_SECRET`。
3. 在 `service/control` 下，把 `wrangler.jsonc` 指向你的域名、D1 数据库、KV 命名空间和 Workers VPC 服务，应用 D1 迁移，然后部署 Worker。
4. 用 `npm run dev:node`（或作为服务）启动媒体节点。
5. 运行 `npm run owner-code`，在 `/login` 输入 6 位数字码，创建你的 passkey（[用户本人登录](.agents/notes/implemented/architecture/2026-10-08-passkey-owner-sign-in.zh.md)）。
6. 在特斯拉浏览器里打开你的地址，用手机扫描二维码配对这辆车（[配对](.agents/notes/implemented/feature/2026-10-07-device-code-pairing.zh.md)）。
7. 把 MCP 服务加到你的 agent，例如 `claude mcp add --transport http yolo https://<your-domain>/mcp`，然后批准它。

Plex 是可选的：在 `.env` 里设置 `PLEX_URL` 和 `PLEX_TOKEN`。加载哪些插件及其选项，可以在 `yolo.config.json` 里设置（见 `yolo.config.example.json`）。`.env.example` 说明了每一项设置。

在家时直接从家里的机器播放也是可选的：把一个对你的域名区有 Zone Read 和 DNS Edit 权限的 Cloudflare API token 存为 Worker secret `LAN_DNS_TOKEN`，再在每块屏幕的设置里打开 “Play over the home network”（通过家庭网络播放）（[局域网直连播放](.agents/notes/implemented/feature/2026-10-12-lan-direct-play.zh.md)）。

<a id="documentation"></a>

## 文档

所有项目知识都在 [Agent Notes](.agents/notes/README.zh.md) 里，有英文和中文两种语言：带依据的决策、协议、插件 API、埋点，以及对未来工作的提案。在代码上工作的 agent 从 [AGENTS.md](AGENTS.md) 开始；通过 MCP 使用 Yolo 的 agent 可以加载 [Yolo 技能](skills/drive-in/SKILL.md)。

<a id="development"></a>

## 开发

`npm run check` 运行文档门禁，构建客户端和 Worker，并运行单元、集成和端到端测试（[测试分层](.agents/notes/implemented/testing/2026-07-21-test-layers.zh.md)）。参与贡献请看 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。

<a id="license"></a>

## 许可证

[MIT](LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
