# Agent Note: 原生 Apple TV 客户端

Status: proposed

[English](2026-10-19-apple-tv-client.md) | 中文

## 问题

Apple TV 上没有 Yolo 客户端。播放器是一个浏览器应用（[两个引擎](../../implemented/architecture/2026-10-12-two-playback-engines.zh.md)），而 tvOS 不给 App 提供网页引擎：没有 Safari，也没有 `WKWebView`，播放器以任何形式都跑不起来。iPhone 和 iPad 已经能在 Safari 里通过 `<video>` 用原生 HLS 播放并支持 AirPlay，Android TV 和 Fire TV 能在 WebView 里跑播放器；Apple TV 是播放器唯一够不到的常见屏幕。

障碍不在服务端。`/v1` 和实时通道服务任何客户端（[/v1](../../implemented/architecture/2026-10-07-v1-http-api.zh.md)、[Hub](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md)），设备在 `hello` 里声明自己能播什么，`renderer: "native"` 本来就是渲染器之一（[能力协商](../../implemented/architecture/2026-10-07-capability-negotiation.zh.md)），屏幕用电视 App 登录常用的 OAuth 设备授权来配对（[设备码配对](../../implemented/feature/2026-10-07-device-code-pairing.zh.md)）。新平台的成本在客户端：`player.js`、`realtime.js` 和 `missed-commands.js` 为浏览器承担的播放生命周期、恢复和实时通道规则。

## 提案

做一个原生 tvOS App，用 Swift、SwiftUI 和 AVPlayer 编写，以 `kind: "tv"` 的屏幕身份实现 [Yolo 的客户端协议](../../implemented/architecture/2026-10-19-client-protocol.zh.md)。它不带任何内容：没有片源、没有目录，也没有任何提供方的名字，显示的一切都来自用户本人自己的服务器。代码放在 `clients/apple/`，一个 Xcode 工程，以后 iPhone 和 iPad 的 target 可以加进来，共用协议代码。

**配对。** 配对就是扫码：电视显示二维码，用户本人在手机上批准。App 先要拿到服务器地址。在家里的网络上，节点用 Bonjour 广播它；只有一台 Yolo 服务器响应时，App 显示它的主机名，按一下确认后显示二维码，所以在家配对就是打开 App、按一下、扫码；有几台时列出来让人选，一台都没有时由用户本人输入域名，也可以用 iPhone 的键盘输入。它用 `/.well-known/yolo` 确认地址，然后带上自己的名字和 `device_kind: "tv"` 请求 `POST /oauth/device_authorization`，把 `verification_uri_complete` 显示成二维码，旁边显示短码，然后轮询 `POST /oauth/token`。用户本人用手机扫码，用 passkey 批准。设备凭据存进 Keychain；连接以 `4003` 关闭或凭据被拒时，App 回到配对界面。

**能力。** App 声明 `renderer: "native"`、`delivery: ["hls", "mp4"]`、`containers: ["mp4"]`，视频编码是 AVFoundation 在这台设备上能解的（先 `avc1`，再 `hvc1`），音频是 `mp4a`、`ac-3` 和 `ec-3`，`maxHeight` 取电视当前的显示模式（4K 电视上的 Apple TV 4K 是 2160），`subtitles: "client-vtt"`。`readsSplitFiles` 和 `waitsForLiveRunway` 对 `native` 保持 false，所以节点会像对 `<video>` 那样合并分离的文件、隐藏直播的预留段。App 需要的两处服务端改动已经发布：客户端协议的服务端部分（`clientProtocols`、`hello` 里的版本协商、节点的 Bonjour 广播），以及 Plex 插件的转码：它对 `native` 也像对 `html5-video` 一样按 `maxHeight` 定画面大小，而不再给车上固定的 720p 配置，这样电视上的 Plex 转码能到 2160p。播放的其他部分不用改。

**播放。** AVPlayer 播放 `load` 里的流，每个 URL 都相对流的 `origin` 解析，和播放器一样。`AVPlayerViewController` 提供系统的进度条、Siri Remote 拖动和“正在播放”；文字字幕（包括 AI 字幕）是 WebVTT，由 App 画在控制器的 `contentOverlayView` 里，因为 AVPlayer 不能给 HLS 流挂外部 WebVTT 文件。App 像播放器的 `media-paths.js` 一样，先探测 welcome 列出的局域网媒体路径，每收到一条 `media` 消息再探测一次，探测时把服务器的源地址放进 `Origin` 头（URLSession 不会自己带），再报告 `network`，所以在家里走局域网直连播放（[局域网直连播放](../../implemented/feature/2026-10-12-lan-direct-play.zh.md)）。

**实时通道。** 第一版实现协议的必须部分，包括 welcome 之后的补齐，省掉可选部分（`danmaku`、`keep`、Ask、遥测）。它从不把播放器留在首页后面，所以从不发送 `keep`。

**版本。** App 用 Yolo 唯一的版本号。它不和 Worker 一起发布，所以 Worker 可能比电视上的 App 新；客户端协议的版本号告诉 App 什么时候该请用户本人更新，而不是播到一半出错。

**构建和安装。** 用用户本人按年付费的 Apple Developer Program 会员资格签名，通过 TestFlight 内部测试装到用户本人的 Apple TV 上，不需要 App 审核；每个构建有效 90 天。免费的 Apple 账号只能从 Xcode 直接安装，这样装的构建 7 天后就打不开了。因为 App 不带任何内容，也不从任何第三方下载，以后可以作为播放自己服务器的播放器上架 App Store，和其他媒体服务器的客户端一样。构建需要 macOS 和 Xcode，所以在用户本人的 Mac 上进行，不在 Linux 容器里。团队 ID 和签名设置放在被忽略的本地 `xcconfig` 里，从不进入被跟踪的文件。根目录的说明为 `clients/apple/` 增加一条“纯 JavaScript”规则的例外。

### 阶段

1. 通过地址或 Bonjour 配对、首页（历史、搜索、片库、剧集）、带续播的播放、媒体路径探测和实时控制，让 agent（智能体）能通过 MCP 在电视上播放、暂停、跳转，并把播放移到电视上。
2. 字幕和音轨菜单、随生成不断重读的 AI 字幕，以及自适应上限（[自适应画质](../../implemented/feature/2026-10-11-adaptive-quality.zh.md)）。
3. 按播放器的排布规则画在画面上的弹幕（[弹幕](../../implemented/feature/2026-10-13-danmaku.zh.md)），以及用 Siri Remote 语音输入的 Ask（[从屏幕询问 agent](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)）。
4. iPhone 和 iPad 的 target，只为 Safari 给不了的东西才值得做：后台播放、锁屏控制，以及手机锁屏后不断开的连接。

## 开始做 App

做 App 的 agent 在各个主笔记之外还需要知道什么。App 在用户本人的 Mac 上构建，那台机器有 Xcode 和用户本人的 Apple Developer 会员；那边的工作通过 Remote Control 或那台 Mac 上的 agent 进行。

**服务端和检查。** App 需要服务端提供什么，写在[客户端协议](../../implemented/architecture/2026-10-19-client-protocol.zh.md)笔记里。早于这套协议的服务器在 `/.well-known/yolo` 里不返回 `clientProtocols`，App 把它当作 `[1]`。App 通过一致性测试套件之后，阶段 1 才发布；恢复、限流和丢消息的规则要靠套件来证明（客户端协议笔记的「推迟的部分」）。套件用 Node 写在 `test/` 下，可以和 App 同时做，App 的调试版要带上套件用的调试 socket。没有套件时，App 对着用户本人的实例手动检查：浏览器播放器展示正确的屏幕怎么做，agent 通过 Yolo 的 MCP 工具操控电视。

**先读这些，按这个顺序。** 线上契约在各个主笔记里，不在这里。客户端协议笔记给出各部分、必需和可选的消息、带 `Yolo-Protocol` 头的版本，以及发现。[设备码配对](../../implemented/feature/2026-10-07-device-code-pairing.zh.md)给出配对请求和轮询。[OAuth 服务器](../../implemented/architecture/2026-10-07-oauth-authorization-server.zh.md)讲 bearer 凭据和实时通道的 ticket。[Hub 和实时通道](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md)有消息表、准确的心跳，以及[失效的连接吞掉的消息](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md#what-a-dead-connection-takes)。[/v1](../../implemented/architecture/2026-10-07-v1-http-api.zh.md)列出设备凭据能调用的路由。[能力协商](../../implemented/architecture/2026-10-07-capability-negotiation.zh.md)给出能力字段。[媒体流离开 Worker](../../implemented/architecture/2026-10-13-media-off-the-worker.zh.md)给出路径、探测和它的超时。代码上以浏览器播放器为参照：`clients/player/src/pairing.js`、`api.js`、`realtime.js`、`media-paths.js`、`missed-commands.js` 和 `player.js`。

**Apple App 的选择。** 它用 `client_id: "yolo-apple-tv"` 和 `device_kind: "tv"` 配对，发送上面**能力**一段里的能力。它自己在每次媒体探测上设置 `Origin`。它的 Info.plist 在 `NSBonjourServices` 里列出 `_yolo._tcp`，并写上 `NSLocalNetworkUsageDescription`。有域名的实例上，LAN 和远程源用的是公开受信任的域名证书，所以 App Transport Security 不需要例外。

**仓库。** App 放在 `clients/apple/`，一个带 tvOS target 的 Xcode 项目；协议代码（配对、`/v1`、实时通道、媒体路径）放在里面的一个 Swift package 里，和界面分开，这样 iPhone target 能复用，它的单元测试用 `swift test` 跑。团队 id 和 bundle id 前缀放在被忽略的 `clients/apple/Local.xcconfig` 里，`.gitignore` 写明它，并跟踪一个 `Local.xcconfig.example`。加入 App 的那次改动同时在根 `AGENTS.md` 的纯 JavaScript 规则里加上 `clients/apple/` 例外和一行代码地图，并把这篇笔记移到 `implemented/`，把阶段 1 写成已上线。

**只有用户本人能做的事。** 用开发者账号的 Apple ID 登录 Xcode；在 App Store Connect 里创建 bundle id 和 App 记录；把自己加为内部测试员，并在 Apple TV 上安装 TestFlight；在手机上用 passkey 批准第一次配对；以及在 Yolo 的设置里移除电视，检查它回到配对。App 记录建好之前，Xcode 可以把调试版装到通过网络配对的 Apple TV 上（Xcode 的 Devices 窗口，同时打开 Apple TV 的“遥控器 App 与设备”设置）。

## 曾考虑的替代方案

**兼容 Jellyfin 的协议插件**，让 Infuse 和 Swiftfin 从 Yolo 播放（[已否决](../../rejected/feature/2026-10-11-jellyfin-protocol-plugin.zh.md)）。它要实现 40 到 60 个端点，外加还没有任何兼容服务器实现过的会话推送；Infuse 不接受遥控命令，Swiftfin 的遥控还没验证。即使做成了，它也没有弹幕、AI 字幕、Ask，以及 Yolo 自己的音轨和画质选择，agent 对电视的控制也只到 Swiftfin 肯听的程度。原生 App 保留 Yolo 自己的协议，每块屏幕都讲它。

**从 iPhone 上的 Yolo Web 用 AirPlay 投屏。** 今天不写代码就能用，因为 Safari 原生播放 Yolo 的 HLS。但 Yolo 的设备仍是手机：Apple TV 只是一块显示屏，agent 无法指定它；手机锁屏时 Safari 可能断开实时连接，agent 的控制也随之失去（推断，未实测）。

**节点上用 AirPlay 驱动 Apple TV 的设备插件**（pyatv，[插件架构](../../implemented/architecture/2026-10-11-plugin-architecture.zh.md)里列过）。电视上不用装 App，但也就没法用 Siri Remote 浏览，没有 Yolo 绘制的字幕，节点多一个 Python 依赖，而且非 Apple 设备通过 AirPlay 推送 URL 播放还没验证。

**跨平台框架（React Native for tvOS、Flutter）。** 视频仍然由 AVPlayer 播放，所以框架只是多了一层桥接和第二套工具链，并没有省掉播放所需的 Swift，它对 tvOS 的支持也落后于 Apple 自己的焦点引擎。

## 验收标准

在用户本人的 Apple TV 上、从 TestFlight 安装：App 在家里通过 Bonjour 找到用户本人的服务器，或者接受输入的域名，再通过二维码和用户本人的 passkey 完成配对；它通过客户端协议的一致性测试套件；用 Siri Remote 浏览历史、搜索和片库；通过局域网直连播放 `hls`、`direct`、`dash_split` 和 `plex` 流；agent 通过 MCP 播放、暂停、跳转，并把播放移到 Apple TV 或从它移走；在电视上的进度能在车上续播；在 Yolo 设置里移除这台设备后，App 回到配对界面。

## 风险

- **两个客户端遵循同一套协议。** 实时通道的恢复规则在播放器里修了很多次，App 要用 Swift 满足同样的约定；以后实时通道每改一次，都多了一个客户端要更新和测试。客户端协议的版本号和一致性测试套件把损失限制在提示更新，而不是电视坏掉。
- **仓库里出现 Swift。** 它只能在 macOS 上构建，Linux 容器里的 `npm run check` 从不编译它；需要一个 macOS 的 CI 任务构建 App 并跑它的单元测试，否则 App 坏了也没人发现。
- **分发给用户本人以外的人。** TestFlight 内部测试只覆盖用户本人自己的设备。其他用户本人（[分发](2026-10-11-distribution-to-other-owners.zh.md)）需要 App Store，它的审核需要一台能登录的演示服务器，并按条款 5.2.3 检查是否从第三方来源下载媒体；不带内容、不带提供方名字的 App 只播放用户本人服务器发来的东西，但审核是否接受还没有验证。
- **没有域名时远程直连的证书。** 在没有域名的实例上离家播放时，远程源用的是 IP 地址证书，还没有对 App Transport Security 测试过；在家里的 Apple TV 走局域网直连，不依赖它。
- **HDR。** 能力里没有动态范围，所以片源仍然选择 SDR；能播 HDR10 或杜比视界的 Apple TV 4K 只能拿到 SDR，直到能力能说明屏幕显示什么。
