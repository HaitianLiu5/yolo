# Agent Note: 新用户选择自己在哪里看，插件在任何屏幕上都能开启

Status: proposed

[English](2026-10-31-home-cold-start.md) | 中文

## 问题

新用户配对一块屏幕后，看到的是空首页。上面没有任何东西告诉他 Yolo 能显示什么、怎样才能显示出来，剩下能做的只有让 agent 播一个链接。这是 Yolo 体验的地板，不是 Yolo 的定位：一块只能播 agent 递过来的东西的屏幕，没人有理由去打开。目标是上一层：用户自己的来源填满首页，用户自己发现、自己挑，agent 是辅助。

能填满首页的插件是在家里的机器上选的。节点加载 `yolo.config.json` 里的列表，没有这个文件时加载 `plugins/official.json`（[`service/plugin-api/src/host.js`](../../../../service/plugin-api/src/host.js)），选项来自这个文件或环境变量。改一次就要编辑 JSON、重启节点；插件带 `control` 入口时还要重新部署 Worker（[插件架构](../../implemented/architecture/2026-10-11-plugin-architecture.zh.md)）。没有任何屏幕能看到插件，唯一有引导的路径是 agent 在终端里按 [`yolo-add-source-plugin`](../../../../skills/yolo-add-source-plugin/SKILL.md) 操作。

默认值是围绕一个用户的环境长出来的：Plex、国内出口代理、B 站账号、Tesla。`official.json` 在每个新节点上都加载 Plex、yt-dlp、两个 agent、模型提供方和五个元数据插件，不管用户用不用。登录一个网站要把 cookies 文件放到节点上（`YTDLP_COOKIES_FILE`），屏幕上做不到。一个只用 YouTube、只有 Plex，或者只有硬盘上一个文件夹的新用户，应该不碰家里的机器就能得到一个满的首页。没有 B 站账号的用户说过一次不要之后，就再也不该被问到 B 站。

用户 profile 提案（#110，`feature/owner-profiles`）新增 profile 插件，把用户关注的东西放到每块屏幕的首页上。它把两件事留给这份笔记：插件怎么开启，以及冷启动。

## 提案

配对过的屏幕第一次打开空首页时，问 **"你平时在哪里看？"**，给出可选的地方：用户自己的文件夹、Plex、B 站、YouTube、腾讯体育，最后是"直接问 agent"。选一个地方，就开启它背后的插件并完成连接：用网站的手机 App 扫码、输入关联码，或者选一个文件夹。之后首页就显示这个地方的行。用户每一步都能跳过，所有屏幕都记住这次跳过；首页上和 设置 › 插件 里有一个不打扰的入口，用户想回来随时能回来。Agent 通过 MCP 开启插件，每个请求都要等用户的 passkey。家里机器上的 agent 可以自己写插件。Yolo 校验，用户用 passkey 批准，节点加载；失败时自动回滚。

底下就是现有的插件系统，只是变得看得见，而且能在运行时修改。核心不出现任何站点的名字：地方、它们的名称和登录方式，都来自插件的 manifest 和 `plugins/` 下的官方目录。

```
screen (web, car, TV, Apple TV, iOS)
  │ GET /v1/setup, choices          owner's phone or this screen (passkey)
  │                                   │ /v1/owner/plugins, /v1/owner/setup/…, /v1/owner/approvals
  ▼                                   ▼
control plane ──nodeFetch──▶ node: /internal/v1/plugins  ──▶ writes yolo.config.json, applies it in place
  ▲                                   ▲
  │ MCP list_plugins / change_plugin  │ Unix socket: npm run yolo -- plugins propose <dir>
agents (claude.ai, ChatGPT, …)        agents on the home machine (Ask's Claude Code or Codex, a terminal)
```

### 1.0 交付什么，什么留到 1.x

1.0 交付"有的选"：新用户自己选运行什么、连接什么，登录永远不是必需的，每一步都能跳过、以后再做，agent 在用户批准后也能做同样的事。1.x 交付围绕它的生态。

| | 1.0 | 1.x |
|---|---|---|
| 选择 | 冷启动、设置 › 插件、`npm run yolo -- plugins`，以及每个请求单独批准的 MCP | 不变 |
| 目录 | checkout 里的官方插件、用户的本地插件，以及配置里列出的任何包 | 社区索引，以及从 npm 或 git 按固定版本 `yolo install`（[发行给其他用户](2026-10-11-distribution-to-other-owners.zh.md)） |
| Manifest | 下面的 `yolo` 字段，由宿主读取，用来渲染目录和表单 | 不变；API 发布后才强制检查 `api` 范围 |
| 插件 API | 实验性，在仓库里，加上这里的新增 | `@useyolo/plugin-api` 发布到 npm，遵守 semver |
| 让改动生效 | 在节点上原地生效；原地加载行不通时重启节点 | 不变 |
| 控制面入口 | 列出来，由家里机器上的重新部署生效 | 节点插件自己注册 MCP 工具，只有 DNS provider 还保留控制面入口 |
| Agent 写的插件 | 本地插件：校验、passkey 批准、加载、回滚 | 和其他插件一样发布 |
| 隔离 | 没有。插件在节点进程里运行，拥有节点的权限，每个批准页面都写明这一点 | 每个插件在自己的进程里，通过 RPC 调用；声明的主机通过出口层强制执行；只拿到声明的环境变量，永远拿不到 `NODE_SECRET` |

Agent 写的本地插件放在 1.0。它们和官方插件用同一套目录、批准和加载，让"agent 能教会 Yolo 一个新网站"保持为一次请求就能做完的事。不等隔离先做：在隔离到来之前，由批准和警告来承担风险（[agent 写的插件](#plugins-an-agent-builds)）。

1.0 不能堵住 1.x 的路。社区索引要显示的每个字段，现在就是 manifest 字段。`hosts` 现在声明，以后再强制执行。插件只把状态放在自己的目录和节点的网站登录里，从不放进别的插件的目录，所以以后加进程边界时能把它搬走。批准绑定在所批准代码的哈希上，所以以后 npm 上的一个版本也能用同样的方式批准。核心不把任何东西标成内置：由 `official.json` 来标。

### 冷启动

引导出现在首页从没设置过的配对屏幕上：`GET /v1/setup` 回答 `state: "new"`。它是挡在首页前面的一个全屏步骤，只有一个标题 **"你平时在哪里看？"**（"Where do you usually watch?"），官方目录里的每个地方一张卡片。每张卡片显示图标、地方的名字和一行说明它能带来什么。卡片可以多选。用户在家里机器上做的、声明了地方的插件排在官方地方之后。每一步都有 **暂时跳过**。

- **地方。** 用户自己的文件排在最前：**这台电脑上的文件夹** 和 **Plex**。网站在后面，没有任何一个预先选中，顺序跟屏幕语言走（中文时 B 站和腾讯体育在前，英文时 YouTube 在前）。**直接问 agent** 排在最后，样式是次要的：它是引导要把用户推离的地板，不是第一个建议。
- **选一个就开启并连接。** 用户 passkey 之后（[谁能改插件](#who-may-change-plugins)），每个选中的地方在节点上开启自己的插件，然后走它的连接步骤，一次一个地方。
  - **B 站**：用 B 站 App 扫码。这次登录同时用于首页上的关注和登录后的播放画质（[登录永远不是必需的](#signing-in-is-never-required)）。
  - **YouTube**：说明怎么用家里机器上浏览器的 cookies，或者用 Google Takeout 文件。两者都没有时链接也能播。
  - **腾讯体育**：付费比赛用微信扫码。回放和免费比赛不用登录也能播。
  - **Plex**：Plex 和节点在同一台机器上时什么都不用做，节点会读到它的地址和令牌。否则就找家庭网络上的服务器，再用 Plex 自己的关联码。
  - **文件夹**：一个浏览节点所在机器的文件夹选择器。
  - **直接问 agent**：开启节点在本机找到 CLI 的那些 agent 插件。一个都没有时，说明怎么从手机连接一个 agent。
- **每个连接步骤也都能跳过。** 跳过一个，它的插件保持开启但未连接。插件什么都不读，这个地方的卡片显示"连接后能看到你关注的内容"，这个网站的链接照样能播。
- **行马上出来。** 一个地方连接好时，引导后面的首页就开始填：profile 读列表、文件夹扫描时先显示骨架（带已找到的文件数），然后是行。完成引导后落在这个首页上。
- **所有屏幕都记住。** 至少选了一个地方或"直接问 agent"后完成，记为 `done`；跳过记为 `skipped`。两者都按用户存在 D1 里，所以别的屏幕不会再显示引导。跳过后的首页处在地板这一层（历史、agent 播过的东西、队列），并保留一张不打扰的卡片 **添加你在哪里看**：排在首页所有行的最后，首页为空时就只有它。它从不弹出，也不显示角标。设置 › 插件 里有同样的入口和 **再次显示引导**。
- **没选的地方保持安静。** 没有任何提示、角标或行会提到用户没选的网站。只有用户选了某个地方又跳过了它的登录，才会有卡片请他连接；他把这个地方关掉，卡片就消失。

#### 各类屏幕上

- **手机或电脑，web profile。** passkey 提示就在页面上弹出，和现在在设置里登录一样（[passkey 用户登录](../../implemented/architecture/2026-10-08-passkey-owner-sign-in.zh.md)）。Plex 地址这类字段在这里输入。手机上显示的网站二维码，同一部手机扫不了。页面在网站有"在 App 中打开"链接时提供这个链接；没有时请用户用另一台设备扫码。B 站的码能不能这样打开它的 App，是下面的检查 C3。
- **电视或车机，只有遥控器或触摸屏，没有键盘。** 这些屏幕从不要求用户打字，也不跑 passkey 流程，因为不能指望 Tesla 的浏览器或电视 App 支持它。**继续** 显示一个二维码：`POST /v1/setup/handoff` 返回一个绑定在这块屏幕上的短时链接。用户在手机上打开它，用 passkey 登录，看到同样的选择已经选好。手机负责授权，大屏幕继续负责显示。网站给自家 App 扫的二维码出现在电视或车机上，手机去扫；某一步在等待时，屏幕每 2 秒请求一次 `GET /v1/setup` 来跟进，和配对时的轮询一样。所有需要打字的选项都在手机上填。车机版遵守[车内设计原则](../../implemented/architecture/2026-07-13-in-car-design-principles.zh.md)：大按钮，一步一个决定，二维码大到能从副驾驶座扫到。
- **Apple TV 和三星电视。** [Apple TV App](2026-10-19-apple-tv-client.zh.md) 在 YoloKit 里原生绘制同样的 `/v1/setup` 选项和二维码，用 Siri Remote 移动焦点。[三星电视 App](2026-10-26-tv-web-client.zh.md) 打开的是播放器，所以用的是网页版，焦点由 `tv-remote.js` 移动。
- **iOS。** 原生 App 绘制引导，passkey 那一步在系统浏览器里打开 handoff 页面，所以网站登录从不在 App 自己的 web view 里发生。

### 设置 › 插件

设置里新增 **插件**，是用户回来的地方。它按用户的思路分组：

1. **等你处理**：待批准的请求，来自 agent 的 MCP 请求，或 agent 写的本地插件（[agent 开启插件](#agents-turn-plugins-on-with-the-owners-approval)）。
2. **你在哪里看**：和引导里一样的地方，每个带状态（关闭、开启、已连接、需要登录、失败、过期）、连接或断开，以及 #110 里它各行的开关。
3. **内置**：网页链接。没有开关（[内置的链接播放](#built-in-link-playback-and-the-default-load-list)）。
4. **更多**：其余的一切，比如名称和海报（元数据插件）、AI 字幕、给插件用的模型、agent 和代理。
5. **在这台电脑上做的**：本地插件，每个标着"未经 Yolo 审查"，带版本号和 **用上一个版本**。

插件的页面显示：它的说明；它读什么、存什么、发出什么（`privacy`）；manifest 里有时，一条关于网站条款的提醒；按 manifest 生成的选项表单（秘密选项只显示有没有设置）；来自 `/internal/v1/health` 的健康状态；版本和来源（官方、本地或包）；以及开关。带 `control` 入口的插件会写明需要怎样重新部署（[带控制面入口的插件](#plugins-with-a-control-entry)）。只有用户本人能在这里改东西。没有用户会话的屏幕显示同一个只读页面，带 **登录后修改**，在电视或车机上就是 handoff 二维码。

这是做选择的方式，不是插件管理后台。引导、首页的卡片和设置是同一个目录的三个视图，用的是同一组路由。

### 目录和 manifest

每个插件在 `package.json` 的 `yolo` 字段里描述自己。下面的字段加在 `node`、`control` 和 `setup` 之外；文本字段取 `{ "en", "zh" }`，缺少时回退到英文。

| 字段 | 含义 |
|---|---|
| `title`、`summary` | 它的名字和一行说明它能带来什么，按屏幕上显示的样子写 |
| `kinds` | 它注册什么（`source`、`profile`、`metadata`、`agent`、`model`、`speech`、`proxy`、`dns`），让目录不加载它就能分组 |
| `place` | 可选：`{ id, title?, icon }`，在引导里作为一个地方提供；`id` 相同的插件算一个地方 |
| `connect` | 屏幕怎么连接它：`qr`（网站的 App 扫码）、`code`（在网站的关联页面输入的码，同时显示一个通往那个页面的二维码）、`folder`、`fields`（在手机或电脑上输入的选项）、`instructions`，或者没有 |
| `options` | 表单显示的选项：`[{ key, type, title, secret?, env?, default? }]`，`type` 是 `string`、`number`、`boolean`、`folder`、`folders` 或 `url`，`env` 是插件现在读取的环境变量名 |
| `privacy` | 它读什么、在节点上存什么、发出什么、发给谁，一两句话 |
| `terms` | 可选：一条关于网站条款的简短提醒，开启时显示 |
| `hosts` | 它访问的主机，显示在它的页面和批准页面上；1.x 强制执行 |
| `reload` | 插件不能原地加载时为 `restart`（[改动怎么生效](#how-a-change-takes-effect-on-the-node)） |
| `api` | 它按哪个插件 API 范围编写 |
| `samples` | 可选：校验用的 URL 或 id（[agent 写的插件](#plugins-an-agent-builds)） |

**目录** 是节点能提供的东西：checkout 的 `plugins/` 里、被 `official.json` 列在 `catalog` 中的每个官方插件，节点 `.yolo/local-plugins/` 下的每个本地插件，以及配置里已经列出的任何包。`GET /internal/v1/plugins` 返回它，带每个插件的 manifest 字段、是否开启、加载状态和错误、连接状态，以及去掉秘密值的选项。节点读取 manifest 时不导入代码，所以目录很轻，坏掉的插件也照样显示。

`plugins/official.json` 保留原来的作用，并加上目录：

```json
{
  "plugins": [{ "source": "./source-ytdlp", "builtIn": true }],
  "catalog": [
    "./source-folder", "./source-plex", "./profile-bilibili", "./profile-youtube", "./source-tencent-sports",
    "./agent-claude-code", "./agent-codex", "./model-subscriptions",
    "./metadata-local", "./metadata-wikimedia", "./metadata-tvmaze", "./metadata-bangumi", "./metadata-tmdb",
    "./subtitles-openai", "./proxy-url", "./dns-desec"
  ],
  "with": {
    "folders": ["./metadata-local", "./metadata-wikimedia", "./metadata-tvmaze", "./metadata-bangumi", "./model-subscriptions"],
    "plex": ["./metadata-wikimedia", "./metadata-tvmaze", "./metadata-bangumi", "./model-subscriptions"]
  }
}
```

`with` 列出一个地方随带开启的插件。选文件夹或 Plex 时，也会开启不需要密钥的元数据插件和模型提供方，这样用户的电影不用再问一次就有名称和海报。这个地方的卡片按名字列出它们，各带一行说明发出什么（"把你的文件标题发给 Wikidata、TVmaze 和 Bangumi"），每个都有开关可以不开。它们各自也是 **更多** 里的一行。`source-example` 不在目录里。

<a id="built-in-link-playback-and-the-default-load-list"></a>

### 内置的链接播放和默认加载列表

**播放网页链接是内置的。** yt-dlp 片源是地板的前提：agent 把一个 URL 交给 Yolo，节点按顺序问各个片源插件，由其中一个认领。它从来不是一个选项。它不出现在引导和地方里，设置把它放在 **内置** 下，没有开关。代码上它仍然是 `plugins/` 里的插件，所以 `service/` 下没有文件出现它的名字，服务商名字检查照样成立。`official.json` 在每个没有自己配置的节点上加载它，并标为 `builtIn`。不想要它的用户仍然可以在自己的配置里手动写 `"enabled": false`，[插件架构](../../implemented/architecture/2026-10-11-plugin-architecture.zh.md)允许这样做。没有任何屏幕提供这个开关。

因为它认领所有 http(s) URL，节点总是把从屏幕上开启的插件插在第一个内置片源之前，让针对某个网站的片源先看到它的 URL。

**其他一切都由用户选。** 新节点只加载内置的链接播放。Plex、文件夹、profile、腾讯体育、元数据、AI 字幕、代理、模型和 agent，都要等用户选了才加载：在引导里、在设置里、在终端里（`npm run yolo -- plugins on <name>`），或者通过 agent 的、已批准的请求。这取代 [1.0 路线图](2026-10-11-yolo-1-0.zh.md)里把 yt-dlp 移出默认列表、在安装时再提供的那一行。

### 插件粒度

包保持小而单一：每个网站、每种插件类型一个包，比如 `profile-bilibili` 和链接播放分开。用户选的是 **地方**，它通过 `place` 和 `with` 对应一个或多个包。代码拆得再细，引导也保持简短；想自己掌控的用户仍然能在设置里看到每个包。

有一条规则决定什么留在内置的链接播放里：不需要登录、也不提供选择的网站处理留下。这包括 B 站的弹幕、番剧季、分 P 列表和 upos 镜像，Vimeo 的嵌入回退，YouTube 的字幕，以及让腾讯视频给 H.264 的 yt-dlp 扩展。凡是需要登录、或者用户会去选的东西，都成为单独的插件。

**腾讯体育变成 `plugins/source-tencent-sports`。** 它从 `source-ytdlp` 里拿走比赛页面（`sports.qq.com/kbsweb/game.htm`）、它们的回放列表、腾讯直播 API 的直播频道，以及 Yolo 自己的腾讯登录（`tencent-account.js` 和 setup 入口的微信扫码）（[腾讯体育回放和直播](../../implemented/feature/2026-10-26-tencent-sports-replays.zh.md)）。回放是一个腾讯视频页面，链接播放本来就能播。所以插件 API 新增一种通用的回答：`prepare()` 可以返回 `{ delegate: url }`，节点让排在这个片源之后、认领这个 URL 的片源来播放它，同时保留比赛作为条目的 Source，让历史和续播以比赛为键。腾讯登录保存为腾讯各主机的网站登录，所以链接播放照旧用它播放腾讯视频页面。

<a id="signing-in-is-never-required"></a>

### 登录永远不是必需的

加载插件和连接账号是两回事，连接永远是可选的。不登录的地方，在网站允许的范围内照样能用。B 站链接以网站给匿名用户的画质匿名播放，腾讯体育的回放和免费比赛能播。

- **`connect` 不只属于 profile。** #110 给 profile 插件 `connect: { start(), poll(attempt), forget() }`。现在任何插件都可以提供它，由 manifest 里的 `connect` 说明方式。节点在 `/internal/v1/plugins/:name/connect` 提供它，用户路由取代 #110 里按 profile 分的那些路由（[路由](#routes-data-and-protocol-versions)）。一次连接可以指定由哪块屏幕显示，这样网站的二维码出现在电视上，而用户在手机上批准。
- **网站登录由节点保存。** 以网站会话结束的连接，用 `yolo.signIns.save(cookies)` 把 cookies 交给节点，范围限于插件 manifest 里的主机。节点把它们存在被忽略的 `.yolo/sign-ins/` 里（权限 600）。从这个网站播放的插件用 `yolo.signIns.cookieFile(url)` 读取：返回这个 URL 主机的 Netscape cookie 文件，yt-dlp 用 `--cookies` 接收；没有就返回 null。内置的链接播放可以读所有主机。其他插件只能读它声明的主机。所以扫一次 B 站码，profile 的关注和登录后的播放（字幕、更高画质）就都有了；扫一次微信码，腾讯的付费比赛和腾讯视频页面就都有了。断开会删除这个登录，会话由网站自己的安全设置结束。在隔离之前，这个主机限制只防止插件无意中误用彼此的登录，挡不住恶意插件。
- **用户自己的 cookies 文件仍然优先。** `cookiesFile`、`cookiesFromBrowser` 和 `YTDLP_COOKIES_FILE` 照旧工作，对它们覆盖的主机优先于节点的网站登录。
- **不登录时一个地方能给什么。** profile 要有账号才能读关注。这份笔记请 #110 增加一点：标为 `account: false` 的列表放网站的公开列表，比如 B 站的热门视频，选了这个地方就读取，这样不登录也选 B 站，首页仍然有一行。没有这一项时，不登录选的地方只带来链接播放和它的连接卡片，别的没有。

<a id="how-a-change-takes-effect-on-the-node"></a>

### 改动怎么在节点上生效

插件配置归节点管。`PATCH /internal/v1/plugins/:name` `{ enabled?, options?, connect? }` 写入配置，并原地应用改动。

- **哪个文件。** 节点加载的那个文件：`YOLO_CONFIG`，否则是 `yolo.config.json`。用默认值运行的节点在第一次改动时从 `official.json` 生成 `yolo.config.json`。节点原子地写入（先写临时文件再重命名），用 2 空格缩进的 JSON，只改被要求改的那一项，保留其他所有字段（包括 `egress`）和顺序，新条目放在第一个内置片源之前。标为 `secret` 的选项从不写进配置：它写到 `.yolo/plugin-options/<plugin>.json`（权限 600），加载时合并进 `yolo.options`。节点写不了配置文件时，开关变成一条写明文件名的提示。
- **默认原地生效。** 节点保留正在运行的集合，并和新配置比较差异：
  - 开启的插件：导入，调用工厂函数，运行 `start` 处理函数，它注册的东西按它在配置里的位置加入各个注册表，因为认领顺序就是加载顺序（[片源插件 API](../../implemented/architecture/2026-10-11-source-plugin-api.zh.md#lifecycle)）。
  - 关闭的插件：立即退出认领顺序，不再接新的 `prepare`。它正在提供的流继续播放，直到屏幕停下，最多 4 小时。然后运行它的 `stop()` 和 `shutdown` 处理函数，并移除它的注册。
  - 选项改了：先停止，再用新选项启动。工厂函数在已经导入的模块上再调用一次，所以插件不在模块作用域保存状态，这也是生命周期已经要求的。
  - 新代码总是来自新路径。本地插件批准过的版本放在以哈希命名的目录里（[agent 写的插件](#plugins-an-agent-builds)），所以它的文件在新 URL 下重新加载，否则 Node 的模块缓存会保留旧代码。官方插件只在升级时换代码，而升级本来就会重启节点。
- **只有原地加载行不通时才重启。** 也就是 manifest 写了 `reload: "restart"` 的插件（比如安装进程级钩子的插件），或者原地步骤失败、让某个注册表不一致的情况。这时节点在没有流播放时自己重启，用户按 **立即重启** 时马上重启，由 `npm run yolo -- service` 安装的服务管理器把它拉起来。不是作为服务运行的节点会说明这一点并给出命令。通过节点播放的屏幕像在任何一次节点重启后一样恢复它们的流。
- **失败只影响自己。** 加载或启动失败的插件是 `failed` 并带错误，其他插件照常运行，和启动时一样。设置、`yolo doctor` 和 `list_plugins` 显示这个错误。

<a id="plugins-with-a-control-entry"></a>

### 带控制面入口的插件

Worker 不能在运行时加载代码，所以插件的 `control` 入口在构建时打包进 Worker（[插件架构](../../implemented/architecture/2026-10-11-plugin-architecture.zh.md)）。现在只有 `dns-desec` 有，而 DNS provider 是在部署实例时选的，不在引导里。

- **1.0。** 节点和其他改动一样写入配置。插件页面写"在家里的机器上重新部署后生效"，给出 `npm run yolo -- deploy` 和 **让我的 agent 重新部署**，后者把请求交给家里机器上的屏幕 agent（[屏幕直接问用户自己的 agent](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)）。Worker 的构建信息列出它打包的控制面入口，所以在部署的 Worker 和配置一致之前，页面能显示"等待重新部署"。带控制面入口的本地插件会被拒绝，因为它们会带着所有绑定在 Worker 里运行。构建跳过 `.yolo/local-plugins/` 下的路径，所以从另一个 checkout 部署时不会因为它们失败。
- **1.x。** 节点插件自己注册 MCP 工具。控制面通过 `nodeFetch()` 列出它们并转发调用，所以只加工具的插件不需要控制面入口。只有 DNS provider 还保留，因为它们要在节点离线时运行。

<a id="agents-turn-plugins-on-with-the-owners-approval"></a>

### Agent 在用户批准后开启插件

两个 MCP 工具，在 [`service/control/src/mcp/tools.js`](../../../../service/control/src/mcp/tools.js) 里，不出现任何站点名字：

- **`list_plugins`**（`read`）返回目录：每个插件的名称、说明、类型、地方、状态、连接和错误，所有地方，以及待处理的请求和它们的状态。agent 被要求"把 YouTube 也连上"时，在这里找到这个地方的插件。
- **`change_plugin`**（`manage`）`{ plugin | place, enabled, options?, connect? }`。**关闭** 插件立即生效，并写一条 `kind: "security"` 日志：它从节点上移除代码，一个开关就能撤回。**开启** 插件或修改选项时，创建一个 **请求**，什么都不应用。返回 `{ request: { id, code, url, expiresAt } }`，工具说明告诉 agent 把链接和短码交给用户。

请求写明改动、发出请求的 agent（它的 OAuth 客户端名称），以及对一个地方而言它随带开启的插件。它 10 分钟有效，只能用一次，用户有三种方式批准：任何设备上的链接；每块以用户身份登录的屏幕上的横幅（一条实时 `approval` 消息，在[客户端协议](../../implemented/architecture/2026-10-19-client-protocol.zh.md)里是可选的，没有用户会话的屏幕忽略它）；或者 设置 › 插件 里的 **等你处理**。**允许** 当场跑一次 passkey 流程，而不只是检查会话，因为它改变家里机器上运行的代码。带 `connect: true` 时，请求批准后直接在批准它的设备上进入这个地方的连接步骤。被拒绝或过期的请求什么都不改，也不再显示。

待处理请求列表和横幅，与[在已登录的屏幕上连接家里机器上的 agent](2026-10-22-remote-agent-approval.zh.md)为 agent 授权提出的是同一套机制。两者谁先实现，谁就把这套机制做出来。

<a id="who-may-change-plugins"></a>

#### 谁能改插件

| 谁 | 能做什么 |
|---|---|
| 任何配对过的屏幕（设备凭据） | 读目录和地方（`GET /v1/setup`），跳过引导或再次显示，发起 handoff |
| 用 passkey 登录的用户本人 | 设置 › 插件 里的一切，选地方，连接和断开，批准请求 |
| 通过 MCP 的 agent | 读（`read`），关闭（`manage`），请求其他一切（`manage`），等用户批准 |
| 家里机器的终端 | `npm run yolo -- plugins` 的 `list`、`on`、`off`、`check`、`propose` 和 `rollback`：能以节点用户身份拿到 shell 的人本来就能改配置，所以这些不需要 passkey；`propose` 例外，它的批准会留下记录 |

<a id="plugins-an-agent-builds"></a>

### Agent 写的插件

用户随时可以让自己的 agent 写一个插件：在屏幕上通过 Ask（它连到家里机器上的 Claude Code 或 Codex），或者在那台机器的终端里。"让 Yolo 能播这个网站"就变成一个用户批准的插件，之后作为一个地方出现在引导和设置里。

- **写在哪里。** 在 checkout 之外的工作区，默认是 `~/yolo-plugins/<name>/`（[`yolo-add-source-plugin`](../../../../skills/yolo-add-source-plugin/SKILL.md) 已经在用的位置），从 [`plugins/source-example`](../../../../plugins/source-example/) 复制出来，只从 Yolo 导入 `@useyolo/plugin-api`。升级从不碰它。
- **校验。** `npm run yolo -- plugins check <dir>` 在子进程里运行：
  1. Manifest：有 `node` 入口、没有 `control` 入口，带上面的字段，`api` 范围宿主能满足，名字不和官方插件或已安装的包重复。
  2. 导入：除了 `@useyolo/plugin-api` 不从 Yolo 导入任何东西。
  3. 工厂函数：用一个记录调用的 `yolo` 来调用，和 `source-example` 的测试一样；它注册的东西通过节点自己的检查（`checkSourceImpl` 等），`start` 和 `shutdown` 在节点的时限内完成。
  4. 按它注册的每种类型跑插件一致性套件：对片源，`claim` 不联网也很快回答，`describe` 和 `prepare` 对它的 `samples` 返回合法的结构。对 profile，`lists` 和 `entries` 返回合法的结构。
  5. 它自己有 `npm test` 时也跑。
- **一个版本就是一份快照。** `npm run yolo -- plugins propose <dir>` 跑校验，把目录连同 `node_modules`（不含 `.git`）复制到节点被忽略的 `.yolo/local-plugins/<name>/<hash>/`，`<hash>` 是对每个文件的路径和内容算的 SHA-256；然后通过节点的 Unix 套接字把提议交给节点，和签发用户配对码的方式一样（[passkey 用户登录](../../implemented/architecture/2026-10-08-passkey-owner-sign-in.zh.md)）。它打印批准链接和短码，和 `npm run yolo -- auth` 打印 Cloudflare 的一样。agent 把它们转给用户，请求出现在 **等你处理** 和横幅里。
- **批准。** 批准页面显示：
  - 插件的名称和说明、它注册什么、它提供的地方；
  - 它的 `hosts` 和 `privacy`；
  - 每项校验的结果、它的文件和大小、它的哈希；
  - 对新版本，和当前运行版本相比改了哪些文件；
  - 谁发起的：哪台机器，以及由 Ask 发起时是哪个 agent。

  页面顶部写着："Yolo 没有审查过这段代码。它在媒体节点里运行，拥有节点对这台电脑、它的文件、你的家庭网络以及 Yolo 保存的各个登录的全部访问权限。" **允许** 要走一次 passkey 流程。节点记录 `{ hash, approvedAt, passkey, requestedBy }`，把插件加到配置里内置链接播放之前，并原地加载。
- **运行的就是批准的。** 每次加载时，节点重新计算快照的哈希，不一致就拒绝（`failed: changed after approval`）。改一次就是一份新快照、一次新批准。
- **回滚。** 节点为每个本地插件保留最近三份批准过的快照。
  - **自动。** 加载或启动失败的版本回到上一个批准过的版本，没有就关闭，并在设置、`yolo doctor` 和 `list_plugins` 里说明。
  - **崩溃保护。** 加载新版本前，节点写一个试用标记。如果节点进程在 5 分钟内结束，下次启动加载上一个版本，并把新版本标为 `failed: the node stopped while it ran`。
  - **手动。** 设置里的 **用上一个版本** 和 `npm run yolo -- plugins rollback <name>` 随时能回退，不需要重新批准，因为那份代码以前批准过。
- **安全边界，说清楚。** 在 1.0 里，本地插件和所有插件一样，是节点进程里受信任的代码（[插件架构](../../implemented/architecture/2026-10-11-plugin-architecture.zh.md)）。它能读 `.env` 和 `NODE_SECRET`，给节点的内部请求签名，通过节点的套接字签发用户配对码（拿到这个码的人能重置用户的 passkey），读所有网站登录和每个插件的状态，访问家庭网络。passkey 批准防的是只通过 MCP 连到 Yolo 的 agent 发来的请求，以及误加载的代码，并记录谁批准了哪个哈希。它挡不住已经以节点用户身份在那台机器上运行的进程：这样的进程可以直接改节点的文件。隔离、强制执行声明的主机和过滤后的环境变量都在 1.0 之后。
- **两个 skill。** `yolo-add-source-plugin` 变成 agent 写插件的路径：复制 `source-example`，实现，测试，`plugins check`，`plugins propose`，转交链接，然后用 `list_plugins` 或 `yolo doctor` 确认。手动改配置再重启，只保留给 npm 包，直到 1.x 有了 `yolo install`。[`yolo-add-official-plugin`](../../../skills/yolo-add-official-plugin/SKILL.md) 加上 manifest 字段、目录条目、适用时的地方和 `with`、两种语言，以及 `privacy`。值得分享的本地插件通过它成为官方插件。

### 已有实例升级

升级的实例保留它运行的插件，也永远看不到引导。

- **有自己配置的**（`YOLO_CONFIG` 或 `yolo.config.json`），配置保持原样。配置里列了 `source-ytdlp` 时，升级在它前面插入 `source-tencent-sports`，并把腾讯登录从 `source-ytdlp` 的状态目录移到新插件的状态目录，让腾讯体育继续可用。
- **没有配置的**，升级在节点重启前用上一个版本的默认列表写出 `yolo.config.json`，所以加载的还是同样的插件。有旧运行状态的节点用新默认值运行时，`yolo doctor` 会警告，这覆盖了没用升级命令的升级。
- **引导。** 一个 D1 迁移把每个已有用户的冷启动标为 `done`，所以升级过的实例的任何屏幕都不显示它。设置里有 **添加你在哪里看** 和 **再次显示引导**。
- `npm run yolo -- plugins migrate` 做配置这几步。这个版本 `CHANGELOG.md` 的 `yolo-upgrade` 块运行它，并写明已有实例保留它们的插件（[版本和发布](../../implemented/process/2026-10-13-versions-and-releases.zh.md)）。

<a id="routes-data-and-protocol-versions"></a>

### 路由、数据和协议版本

节点：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/internal/v1/plugins` | 目录、地方、每个插件的状态，以及待处理的本地提议 |
| PATCH | `/internal/v1/plugins/:name` | `{ enabled?, options?, connect? }`：写入配置并应用 |
| POST、GET、DELETE | `/internal/v1/plugins/:name/connect`、`…/connect/:attempt`、`…/connection` | 插件的连接，和 #110 为 profile 定义的一样 |
| GET | `/internal/v1/folders?path=` | 给文件夹选择器用的、节点所在机器上的目录：用户主目录、挂载的卷和它们的子目录，只有名字 |
| GET、POST | `/internal/v1/plugins/proposals/:id`、`…/approve`、`…/deny` | 一个本地提议和它的结果 |
| POST | `/internal/v1/plugins/:name/rollback` | 回到上一个批准过的版本 |
| POST | `/local/v1/plugins/proposals` | 只在 Unix 套接字上：来自 `plugins propose` 的提议 |

控制面，用 `read` scope 或设备凭据：`GET /v1/setup` 返回 `{ state, available, choices, step? }`，`step` 是手机为这块屏幕发起的连接步骤。`PUT /v1/setup` 接收 `{ state: "skipped" | "new" }`，需要 `manage` scope。`POST /v1/setup/handoff` 返回 `{ url, code, expiresAt }`。在 passkey 会话后面的[用户路由](../../implemented/architecture/2026-10-07-v1-http-api.zh.md#owner-routes)：

- `GET /v1/owner/plugins` 和 `PATCH /v1/owner/plugins/:name`
- `POST /v1/owner/setup/places/:id` `{ without? }`，开启一个地方和它的 `with` 插件，去掉没勾选的
- `/v1/owner/plugins/:name/` 下的连接路由，带 `display: <deviceId>`
- `GET /v1/owner/folders`
- `GET /v1/owner/approvals` 和 `POST /v1/owner/approvals/:id` `{ allow }`，带一次新的 passkey 断言
- `POST /v1/owner/plugins/:name/rollback`

handoff 页面是[用户网页](../../implemented/architecture/2026-10-12-owner-web-pages.zh.md)之一，所以在从没配对过的手机上也能用。

D1 在下一个迁移里新增两张表，都带 `user_id`（[D1 数据模型](../../implemented/architecture/2026-10-07-d1-data-model.zh.md)）。`home_setup` 存 `state`（`skipped` 或 `done`）和 `updated_at`，每个用户一行；迁移为每个已有用户插入 `done`。`plugin_requests` 存 MCP 请求：`id`、`plugin` 或 `place`、改动、客户端、短码的哈希、`expires_at` 和 `status`。本地提议留在节点上。上一个版本的代码两张表都不读。

每个路由和消息都是新的，旧的一端回答 404 或忽略它：旧节点的 404 变成 `available: false` 和"请升级媒体节点"。所以 `NODE_PROTOCOL` 和 `CLIENT_PROTOCOL` 都不变（[客户端协议](../../implemented/architecture/2026-10-19-client-protocol.zh.md)）。`site/public/privacy.html` 和 `site/public/zh/privacy.html` 这对隐私页面加上 D1 里保存的设置状态和插件请求，以及节点上保存的网站登录。

### 计划

1. 用户跑检查 C1 到 C3。
2. 宿主：
   - manifest 字段、`official.json` 里的目录，以及 `GET /internal/v1/plugins`；
   - 带排空的原地生效、作为后备的重启，以及带秘密选项的配置写入；
   - `yolo.signIns`、通用的 `connect`，以及文件夹列表；
   - `npm run yolo -- plugins` 的 `list`、`on`、`off` 和 `migrate`；
   - 测试顺序、排空、重启后备和写出的配置。
3. 控制面：`/v1/setup`、handoff 页面、用户路由、`home_setup` 和 `plugin_requests` 的迁移、`list_plugins` 和 `change_plugin`、带实时横幅的批准，以及构建跳过本地插件。
4. Web 播放器：web 和车机 profile 以及电视上的引导、首页的 **添加你在哪里看**，以及 设置 › 插件。Apple TV App 和 iOS 在各自的改动里用同样的路由绘制。
5. 拆出 `source-tencent-sports`，带 `prepare` 的 `delegate`。每个官方插件的 manifest。`official.json` 缩减到内置的链接播放，加上目录和 `with`。升级步骤。
6. 本地插件：`plugins check`、插件一致性套件、`plugins propose`、批准、加载时的哈希检查、回滚和崩溃保护。重写两个 skill。
7. `CHANGELOG.md` 条目和它的 `yolo-upgrade` 块，以及隐私页面这一对。

#110 的 profile 插件按第 2 步的 `connect` 落地，它提出的首页行填进引导的"行马上出来"。文件夹片源（#93）就是文件夹这个地方。Web 播放器的首页要显示所有片库，而不是像现在这样只显示第一个电影库，文件夹和 Plex 才能把首页填好；web 播放器上的"不留死胡同"工作正在修这一点。

### 用户检查

| 检查 | 步骤 | 决定 |
|---|---|---|
| C1，Plex 的关联码 | 没有令牌时，向 plex.tv 申请一个 PIN（`POST /api/v2/pins`，`strong=false`），在手机上到 `plex.tv/link` 输入它的码，然后轮询这个 PIN 拿令牌 | Plex 这个地方能不能用电视上的一个码连接远程服务器，不用打字 |
| C2，电视上的网站二维码 | 在 Apple TV 和车机上按引导的尺寸显示 B 站网页登录二维码（#110 的 P5），从沙发上和副驾驶座上用 B 站 App 扫 | 这些屏幕上二维码的大小和对比度 |
| C3，手机本身上的网站二维码 | 在同一部手机上用 Safari 和 Chrome 打开 B 站二维码里的登录 URL | 手机版能提供"在 App 中打开"，还是只能请用户换一台设备 |

## 考虑过的替代方案

**只有插件管理后台，没有引导。** 只靠 设置 › 插件，每个插件都能找到，但打开空首页的新用户不会知道去那里找，也不知道该选什么。引导用用户自己的话问一个问题，底下用的是管理后台的路由。

**默认全部加载，让用户自己关。** 这就是现在的 `official.json`，第一天就有满的首页也很容易。但每个新节点都会为用户从不用的网站运行代码：Plex 探测、B 站请求、把文件标题发给公共数据库的元数据查询。首页也会以默认值偏向的网站为中心。运行哪些插件由用户选，每个插件都是。

**让链接播放也成为选项。** 目录更纯粹，但跳过它的用户会得到一个播不了 agent 递来的链接的 Yolo。那比地板还低。

**把 B 站、腾讯和 YouTube 的处理放进核心。** 能省掉插件这一跳，但核心不能出现站点名字，而且针对网站的代码跟着网站的节奏变。

**腾讯体育留在链接播放里。** 工作量小。但这样内置插件就带着一个网站的登录和一个没有用户做过的选择。`delegate` 回答让拆出来的插件保持很小：它只说出回放页面，由链接播放来播。

**元数据作为引导里单独的一步，或者只放在设置里。** 多一个问题会让引导变慢，而大多数用户都会接受这个选择。只放在设置里，一个文件夹的文件就会显示成原始文件名。让元数据插件随文件夹和 Plex 一起开启，在卡片上写出名字、各带开关，既只问一个问题，也让用户能说不。

**每次改动都重启节点。** 比原地生效简单，服务管理器本来也会重启节点。但每拨一个开关都会打断每块屏幕的流，丢掉节点的缓存，重启要花的几秒在引导里看起来就是卡住。插件已经有加载、启动和关闭的生命周期，能干净地开启和关闭。重启留作后备。

**在原地用查询字符串重新导入改过的代码。** Node 的模块缓存以 URL 为键，所以 `node.js?v=2` 会重新加载入口，但它的相对导入解析到旧 URL，留着旧代码。每个批准过的哈希一个目录，让每个文件都有新 URL，同时还能当回滚的存储。

**为插件新增一个 OAuth scope。** 在授权页面上授予一次，agent 以后开启插件就不用再问。但持有 Yolo 令牌的 agent 很多（claude.ai、ChatGPT、各个 CLI），而开启插件会改变家里机器上运行的代码。每个请求一次 passkey，让用户始终参与这个决定；关闭插件只是移除代码，不需要批准。

**等隔离之后再做 agent 写的插件。** 等待意味着进程内代码的风险永远不用经过批准来承担。但在隔离之前，所有插件本来就在进程内运行，官方插件也一样，而用户的 agent 现在就能写一个插件再手动改配置。一条有校验、有哈希、要批准、能撤回、警告写得明白的路径比那样更安全，也让"教 Yolo 一个网站"保持在一次请求之内。

**让 MCP agent 上传插件。** claude.ai 上的 agent 没法把文件放到家里的机器上，而从互联网进入节点的代码，暴露面比在那台机器上写的代码更大。提议只通过节点的 Unix 套接字进来。

**每块屏幕各自保存冷启动的状态。** 不用改 D1，但每块新屏幕都会再问一次，在电视上跳过在车机上不算。

**网站登录留在各个插件里面。** #110 把 profile 的会话存在它自己的 `stateDir` 里。这样扫一次 B 站码能读关注，播放却还是匿名的，要么用户就得登录两次。由节点保存、限于声明主机的登录存储，两边都能用，又不需要一个插件读另一个插件的目录，而隔离本来也需要这样。

**在 1.0 就把控制面入口移到节点。** 能免掉只加工具的插件的重新部署，但现在没有官方插件需要它（只有 `dns-desec` 有控制面入口，而它在部署时选）。可以等到 1.x，不会堵住任何东西。

## 验收标准

- 新实例只加载内置的链接播放。它第一块配对的屏幕显示"你平时在哪里看？"。选 B 站并扫码后，几秒内显示关注的行，之后 B 站链接以登录后的画质播放，节点上不需要任何 cookies 文件。
- 三个各只有一个来源的新用户（只用 YouTube、只有 Plex、只有一个文件夹），在电视上用遥控器和手机走完引导，不在电视上打字。每个人都到达有自己来源的行的首页，并从首页播放。
- 没有 B 站账号的用户跳过 B 站，或者跳过整个引导。Yolo 完全可用，之后没有任何屏幕再提到 B 站。在电视上跳过后，车机和浏览器都不会显示引导；**添加你在哪里看** 在任何屏幕上都能把它找回来。
- 在设置里或用 `npm run yolo -- plugins` 开启或关闭插件，不重启节点就生效。来自别的插件的流继续播放，来自被关闭插件的流播到屏幕停下为止。
- claude.ai 上用 `change_plugin` 开启 YouTube，在用户通过链接或屏幕横幅用 passkey 批准之前什么都不应用。关闭插件立即生效，并写一条安全日志。
- 家里机器上的 agent 从 `source-example` 为一个新网站写插件。`plugins check` 通过，用户在手机上批准，这个网站作为一个地方出现并能播放。坏掉的下一个版本自己回滚到上一个版本，让节点崩溃的版本在下次启动时被跳过。批准后修改快照会让它变成 `failed`。
- 升级后，用户的实例加载的插件和以前完全一样（包括腾讯体育），没有屏幕显示引导。
- `service/` 或 `clients/` 下没有文件出现站点名字。地方、名称和登录来自 manifest 和 `official.json`，`scripts/provider-names.test.js` 通过。

## 风险

- **用户不看代码就批准。** 批准页面没法让用户审查代码。警告、校验、哈希、记录和回滚能限制失误的损害。它们挡不住恶意插件，在隔离之前它拥有节点的全部权限。
- **插件能把节点卡住。** 插件里的死循环会阻塞节点的事件循环。服务管理器不会重启卡住的进程，崩溃保护只覆盖进程退出。用户重启节点后，试用标记会跳过那个版本。隔离会解决这个问题。
- **节点会写用户的配置。** 用户在节点写入的同时手动编辑 `yolo.config.json`，可能丢掉一处编辑。节点每次写之前重新读文件，文件在加载后被改过就拒绝写入，并请用户重新加载。
- **登录保存在家里的机器上。** 从屏幕上做的网站登录，是用户账号的一个完整会话，存在 `.yolo/sign-ins/` 里。能读那台机器的人都能用它。
- **开箱即用的东西变少了。** 什么都跳过的新用户只有链接播放，没有元数据，也没有 Ask。引导、首页的卡片和设置是他们得到更多的方式。
- **网站条款。** 开启网站插件时显示它的 `terms` 提醒。每个账号都由用户自己连接，Yolo 只读取和播放用户自己的账号能访问的东西。
- **放弃的：** 社区目录、从 npm 安装、隔离和节点注册的 MCP 工具，都要到 1.x；带控制面入口的插件仍然需要在家里的机器上重新部署。
