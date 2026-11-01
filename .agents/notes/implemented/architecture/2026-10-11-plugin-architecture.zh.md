# Agent Note: 片源和所有具体服务商都由插件承载

Status: implemented

[English](2026-10-11-plugin-architecture.md) | 中文

## 问题

Plex 和 yt-dlp 的代码散落在 core、控制面和节点里；每多支持一种片源或客户端，就会多一些这样的代码，核心会越来越重。yt-dlp 更新很频繁，原生 App 审核和 YouTube 条款的风险也大多来自它，而有些用户既不想要它也不想要 Plex。Worker 不能在运行时加载代码，而 Yolo 运行在两个环境（控制面和节点）里，两边都需要能被扩展。

## 决策

片源、元数据、协议、设备、agent、语音服务、模型提供方、DNS provider（DNS 服务商）和代理提供者都是**插件**；核心只保留片库模型（目录、条目、音轨和字幕）、设备和会话（Hub，及其单一队列和播放状态）、播放列表、历史和进度、身份和授权（OAuth、passkey、配对）、媒体签名与转码和 HLS 封装，以及 MCP 服务：插件可以扩展它，但不能关掉它。做法参考 pi 的扩展机制（`badlogic/pi-mono` 的 `packages/coding-agent/docs/extensions.md` 和 `packages.md`）。

| 插件类型 | 作用 | 例子 | 状态 |
|---|---|---|---|
| 片源 | 把内容接进来：列出或扫描条目、认领网址、解析出可播放的流 | 文件夹、WebDAV、Plex、yt-dlp | 已提供文件夹、Plex 和 yt-dlp（[片源插件 API](2026-10-11-source-plugin-api.zh.md)、[文件夹片源](../feature/2026-10-26-folder-source.zh.md)） |
| 元数据 | 说明一个条目是什么（一部电影或某部剧的一集），补充海报、简介和演职员 | 用户自己的 NFO 文件和图片、Wikidata 和 Wikipedia、TVmaze、Bangumi、TMDB；社区可以做豆瓣、AniDB | 已提供本地文件、Wikimedia、TVmaze、Bangumi 和 TMDB（[元数据插件](2026-10-25-metadata-plugins.zh.md)） |
| 协议 | 把 Yolo 暴露给第三方客户端 | 兼容 Jellyfin 的 API；社区可以做 Emby、DLNA | 还没有接口 |
| 设备 | 把第三方播放器变成可以控制的设备 | Jellyfin 会话、Apple TV（pyatv）、Chromecast、Kodi | 还没有接口；Yolo 自己的实时通道留在核心里（[Hub](2026-10-07-hub-and-realtime-channel.zh.md)） |
| Agent | 用用户已经在运行的 agent，通过它自己连到 Yolo 的 MCP，回答屏幕上说出或输入的请求 | Claude Code、Codex | 已提供 Claude Code 和 Codex（[屏幕直接问用户自己的 agent](../feature/2026-10-18-agent-from-the-screen.zh.md)） |
| 转写、翻译 | 把条目的声音转成带时间的文字，再把文字译成用户的语言，用于 AI 字幕；可选，配置之前不启用 | 任何提供 OpenAI 转写和对话接口的服务，例如用户 Mac 上的 Whisper 和本地模型 | 一个插件同时提供两者，默认不加载（[AI 字幕](../feature/2026-10-18-ai-subtitles.zh.md)） |
| 模型提供方 | 用用户自己的订阅给其他插件一个语言模型，用于简短的结构化回答 | 节点所在机器上已登录的 Codex 或 Claude Code、Yolo 自己的登录、本地的服务 | 已提供一个插件，在官方目录（catalog）里（[插件用用户自己的订阅调用模型](2026-10-25-models-for-plugins.zh.md)） |
| DNS provider | 在自己的 zone 里维护节点的媒体名称、它们的地址记录和 DNS-01 质询 | deSEC；社区可以做 DuckDNS、Route 53 | 已提供 deSEC；Cloudflare 的 zone 是内置的（[DNS provider 插件](2026-10-14-dns-provider-plugins.zh.md)） |
| 代理提供者 | 给出代理在哪里，供节点的出口规则把选定的主机经它发出；不知道哪些请求在用它 | 固定的代理地址；用户为付费加速服务自己写的插件 | 已提供固定地址的提供者，默认不加载（[出口代理层](2026-10-13-node-egress-proxy.zh.md)） |

- **插件是导出工厂函数的 npm 包。** 清单写在 `package.json` 的 `yolo` 字段里，分 `node` 入口（节点启动时加载）和 `control` 入口（部署时打包进 Worker）；插件可以只有其中一个，也可以两个都有。DNS provider 插件和模型提供方插件还可以声明一个 `setup` 入口：运维命令行在用户本人的机器上导入的模块。宿主提供的包（`@useyolo/plugin-api`）写在 `peerDependencies` 里。1.0 之前接口为实验性，可以不兼容地修改。
- **yt-dlp 也是插件。** 核心不认识 `url` 这种片源类型：收到网址时，按加载顺序请片源插件认领。
- **具体服务商的代码只放在 `plugins/` 里。** `service/` 下被 Git 跟踪的文件都不提具体服务商，只有转换 0.1 数据的 D1 迁移和迁移测试例外；插件从 Yolo 只导入 `@useyolo/plugin-api`，从不导入 `@useyolo/core` 或服务内部模块。[`scripts/provider-names.test.js`](../../../../scripts/provider-names.test.js) 在 `npm run check` 里强制执行第一条规则。它从插件取得服务商名，所以新增官方插件时不用改这个测试：每个 `plugins/<kind>-<provider>` 目录给出它的服务商（`source-plex` 给出 `plex`），[`scripts/provider-names.js`](../../../../scripts/provider-names.js) 列出服务商的其他名字（`ytdlp` 的 `youtube`、`tmdb` 的 `themoviedb`），完整拼写的名字出现在任何地方都算（`plexToken`），字母之间带连字符或下划线的拼写只在作为一个完整的词时才算（`yt-dlp`、`YT_DLP_PATH`，但 `NODE_SECRET` 里的 `DE_SEC` 不算），模板 `source-example` 和通用的 `proxy-url` 提供者不给出任何名字，`metadata-local` 和 `model-subscriptions` 也不给出，因为它们服务的是用户自己的文件和订阅，不管由谁提供。
- **控制面入口在构建时打包。** `wrangler.jsonc` 的构建命令运行 `service/control/scripts/generate-plugins.js`，它读取和节点同一份插件配置，生成被 Git 忽略的 `service/control/src/plugins.generated.js`，用静态 `import` 引入每个启用插件的 `control` 入口；配置里的插件找不到时构建直接失败。控制面入口可以用 Yolo 的 scope 添加 MCP 工具，也可以添加由实例的 `media.dns` 选用的 DNS provider（[`service/control/src/plugins.js`](../../../../service/control/src/plugins.js)）。控制面插件的 `options` 会被打包进 Worker 代码，所以密钥要放在 Worker secret 里。
- **能用配置解决的就不写插件。** 加一个 WebDAV 地址只是 WebDAV 插件的一条选项，而不是一个新插件。

### 配置

| 情况 | 加载什么 |
|---|---|
| 设置了 `YOLO_CONFIG` | 这个文件（绝对路径，或相对仓库根目录的路径；也可以写在 `.env` 里） |
| 仓库根目录有 `yolo.config.json` | 这个文件（被 Git 忽略；可以从 `yolo.config.example.json` 复制） |
| 都没有 | `plugins/official.json`：只有内置的链接播放（`source-ytdlp`），选项取自环境变量，直到用户选择更多 |

配置格式为 `{ "plugins": [ { "source", "enabled"?, "options"?, "builtIn"? } ] }`。`source` 是相对配置文件的路径（以 `.` 或 `/` 开头），或从配置文件所在目录解析的 npm 包名；只写字符串等于只给 `{ "source": … }`。列表是完整且有序的：没列出的插件（包括官方插件）都不会加载，`"enabled": false` 也可以关掉一个插件。`options` 原样交给插件。`builtIn` 标出官方列表在每个节点上都加载的那一项，即内置的链接播放，任何屏幕上都没有它的开关。用户手动改了文件，要重启节点；涉及 `control` 入口时还要重新部署控制面。从屏幕或终端做的更改会自己生效（见下）。

<a id="the-catalog-and-plugins-turned-on-from-a-screen"></a>
### 目录，以及从屏幕打开插件

用户选择什么、怎么选，见[冷启动提案](../../proposed/feature/2026-10-31-home-cold-start.zh.md)；其中已经实现的是：

- **清单向屏幕描述插件。** 除了入口，`yolo` 字段还可以写 `title` 和 `summary`（一个字符串，或按语言给出的文字，例如 `{ "en", "zh" }`）、`kinds`、`place`（`{ id, title?, summary?, icon?, group: "files" | "site" | "agent", languages? }`；`id` 相同的插件是同一个地方）、`connect`、`options`（`[{ key, type, title, help?, secret?, env?, default? }]`）、`privacy`、`terms`、`hosts`、`reload: "restart"` 和 `api`。[`readManifest()`](../../../../service/plugin-api/src/host.js) 不导入代码就能读出它们，格式不对的字段会被丢掉。
- **`plugins/official.json` 里有目录。** 它的 `plugins` 是没有配置的节点加载的内容；`catalog` 按加载顺序列出用户可以打开的每个官方插件（元数据插件按合并顺序），`with` 列出一个地方会一起带上的插件（Plex 和文件夹会带上模型提供方和不需要 key 的元数据插件）。`source-example` 不在其中。
- **屏幕一旦改动配置，配置就由节点管理。** [`plugin-manager.js`](../../../../service/node/src/plugin-manager.js) 在 `GET /internal/v1/plugins` 提供目录，在 `PATCH /internal/v1/plugins/:name` `{ enabled?, options? }` 和 `PUT /internal/v1/plugins/places/:id` `{ enabled?, without? }` 接受更改；Unix socket 上也有这些路由，供 `npm run yolo -- plugins list | on | off` 使用。[`changePluginConfig()`](../../../../service/plugin-api/src/host.js) 写的是节点加载的那个文件（用默认值的节点会从官方列表生成 `yolo.config.json`），只改那一项，保留其他字段和顺序；新的一项放在第一个内置项之前，并在其余各项中按目录的顺序排列；写入是原子的；如果节点读过之后文件被手动改过，就拒绝写入。标为 `secret` 的选项改写到 `.yolo/plugin-options/<plugin>.json`（权限 600），加载时合并进 `yolo.options`。
- **更改就地生效。** 加载器的 `apply()`（[`plugins.js`](../../../../service/node/src/plugins.js)）让没变的插件继续运行；打开的插件加载并启动；关掉的插件立即离开注册表，它的 shutdown 处理器等它的流放完再运行（最多 4 小时）；改选项就是卸载再加载。认领顺序始终是配置顺序。清单写了 `reload: "restart"` 的插件要等重启；由服务管理器运行的节点（`npm run yolo -- service` 设置的 `YOLO_SERVICE`）会在没有播放时自己重启。
- **内置的链接播放从来不是一个选项。** 官方列表以 `builtIn: true` 加载 `source-ytdlp`，屏幕把它列在“内置”下，没有开关；用户仍然可以手动设 `"enabled": false`。

### 信任模型

和 pi 一样，1.0 之前插件没有权限系统。节点插件运行在节点进程里，拥有它的全部权限：能读 `.env` 和 `NODE_SECRET`、文件系统，也能访问家庭网络。控制面插件运行在 Worker 里，能用所有 binding，包括 D1 和 OAuth 数据。安装插件之前先审查代码，并固定版本。

## 曾考虑的替代方案

**在核心里逐个支持片源和客户端。** 每多一个服务商，核心就重一分；插件把这份成本留在插件内部，Emby、DLNA 这类协议还可以留给社区去做。

**运行时插件市场。** Worker 不能在运行时加载代码，而且每个用户都自己部署实例，所以部署时打包就够了。

**进程外的插件协议，类似 Stremio 的 HTTP 插件。** 和插件市场一同被否决：每个用户都自己部署实例，所以在进程内加载（节点上）或在部署时打包（Worker 里）的包就够了，而且进程内的插件和宿主共用 `@useyolo/plugin-api`，包括它的 `YoloError` 类。

**1.0 就做权限系统。** pi 也用这种信任模型；在插件生态值得投入更多之前，安装前审查代码就是保障。

**把 yt-dlp 留在核心里。** 作为插件，它可以随 yt-dlp 的变化单独发版，不想要它的用户可以关掉它；应用审核和 YouTube 条款的风险都只落在这一个插件上。

## 后果

增加一种片源就是增加一个包，而不是修改服务，核心也始终与具体服务商无关。接口是由两个插件塑造的，以后的插件未必合用；它保持实验性，0.5 和 0.6 计划中的插件会检验它（[1.0 路线图](../../proposed/feature/2026-10-11-yolo-1-0.zh.md)）。改动控制面的插件需要重新部署，节点插件可以从任何屏幕改动而不必重启，目前还没有 `yolo install` 命令，恶意插件拥有它所在进程的全部权限。
