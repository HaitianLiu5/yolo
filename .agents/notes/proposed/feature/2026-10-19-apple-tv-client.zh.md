# Agent Note: 原生 Apple TV 客户端

Status: proposed

[English](2026-10-19-apple-tv-client.md) | 中文

## 问题

Apple TV 上没有 Yolo 客户端。播放器是一个浏览器应用（[两个引擎](../../implemented/architecture/2026-10-12-two-playback-engines.zh.md)），而 tvOS 不给 App 提供网页引擎：没有 Safari，也没有 `WKWebView`，播放器以任何形式都跑不起来。iPhone 和 iPad 已经能在 Safari 里通过 `<video>` 用原生 HLS 播放并支持 AirPlay，Android TV 和 Fire TV 能在 WebView 里跑播放器；Apple TV 是播放器唯一够不到的常见屏幕。

障碍不在服务端。`/v1` 和实时通道服务任何客户端（[/v1](../../implemented/architecture/2026-10-07-v1-http-api.zh.md)、[Hub](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md)），设备在 `hello` 里声明自己能播什么，`renderer: "native"` 本来就是渲染器之一（[能力协商](../../implemented/architecture/2026-10-07-capability-negotiation.zh.md)），屏幕用电视 App 登录常用的 OAuth 设备授权来配对（[设备码配对](../../implemented/feature/2026-10-07-device-code-pairing.zh.md)）。新平台的成本在客户端：`player.js`、`realtime.js` 和 `missed-commands.js` 为浏览器承担的播放生命周期、恢复和实时通道规则。

## 提案

做一个原生 tvOS App，用 Swift、SwiftUI 和 AVPlayer 编写，以 `kind: "tv"` 的屏幕身份讲 Yolo 自己的协议。代码放在 `clients/apple/`，一个 Xcode 工程，以后 iPhone 和 iPad 的 target 可以加进来，共用协议代码。

**配对。** App 带上自己的名字和 `device_kind: "tv"` 请求 `POST /oauth/device_authorization`，把 `verification_uri_complete` 显示成二维码，旁边显示短码，然后轮询 `POST /oauth/token`。用户本人用手机扫码，用 passkey 批准。设备凭据存进 Keychain；连接以 `4003` 关闭或凭据被拒时，App 回到配对界面。

**能力。** App 声明 `renderer: "native"`、`delivery: ["hls", "mp4"]`、`containers: ["mp4"]`，视频编码是 AVFoundation 在这台设备上能解的（先 `avc1`，再 `hvc1`），音频是 `mp4a`、`ac-3` 和 `ec-3`，`maxHeight` 取电视当前的显示模式（4K 电视上的 Apple TV 4K 是 2160），`subtitles: "client-vtt"`。`readsSplitFiles` 和 `waitsForLiveRunway` 对 `native` 保持 false，所以节点会像对 `<video>` 那样合并分离的文件、隐藏直播的预留段。第一版不需要改服务端。

**播放。** AVPlayer 播放 `load` 里的流，每个 URL 都相对流的 `origin` 解析，和播放器一样。`AVPlayerViewController` 提供系统的进度条、Siri Remote 拖动和“正在播放”；文字字幕（包括 AI 字幕）是 WebVTT，由 App 画在控制器的 `contentOverlayView` 里，因为 AVPlayer 不能给 HLS 流挂外部 WebVTT 文件。App 像播放器的 `media-paths.js` 一样，先探测 welcome 列出的局域网媒体路径，再报告 `network`，所以在家里走局域网直连播放（[局域网直连播放](../../implemented/feature/2026-10-12-lan-direct-play.zh.md)）。

**实时通道。** 用一张票据建一条 WebSocket，每 25 秒发一次 `HEARTBEAT_PING`，不回应广播，被限流后至少退避 30 秒，至少每 5 秒报告一次、状态变化时立即报告，`ended`、`error` 和 `idle` 按 Hub 的 note 定义发送。第一版处理 `load`、`pause`、`resume`、`seek`、`stop`、`tracks` 和 `deactivate`，在 welcome 点名自己的流时恢复它，忽略 `commands` 和 `danmaku`，Hub 允许客户端这样做。它从不把播放器留在首页后面，所以从不发送 `keep`。

**版本。** App 用 Yolo 唯一的版本号。它通过 TestFlight 单独发布，不和 Worker 一起，所以 Worker 可能比电视上的 App 新。`/.well-known/yolo` 增加 `clientProtocol`，当 `/v1` 或实时通道的改动让上一版的 App 跟不上时，像 `NODE_PROTOCOL` 那样升一级；协议较旧的 App 会请用户本人去 TestFlight 更新，而不是播到一半出错（[版本和发布](../../implemented/process/2026-10-13-versions-and-releases.zh.md)）。

**构建和安装。** 用用户本人的 Apple 开发者账号签名，通过 TestFlight 内部测试装到用户本人的 Apple TV 上，不需要 App 审核；每个构建有效 90 天。构建需要 macOS 和 Xcode，所以在用户本人的 Mac 上进行，不在 Linux 容器里。团队 ID 和签名设置放在被忽略的本地 `xcconfig` 里，从不进入被跟踪的文件。根目录的说明为 `clients/apple/` 增加一条“纯 JavaScript”规则的例外。

### 阶段

1. 配对、首页（历史、搜索、片库、剧集）、带续播的播放、媒体路径探测和实时控制，让 agent（智能体）能通过 MCP 在电视上播放、暂停、跳转，并把播放移到电视上。
2. 字幕和音轨菜单、随生成不断重读的 AI 字幕，以及自适应上限（[自适应画质](../../implemented/feature/2026-10-11-adaptive-quality.zh.md)）。
3. 按播放器的排布规则画在画面上的弹幕（[弹幕](../../implemented/feature/2026-10-13-danmaku.zh.md)），以及用 Siri Remote 语音输入的 Ask（[从屏幕询问 agent](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)）。
4. iPhone 和 iPad 的 target，只为 Safari 给不了的东西才值得做：后台播放、锁屏控制，以及手机锁屏后不断开的连接。

## 曾考虑的替代方案

**兼容 Jellyfin 的协议插件**，让 Infuse 和 Swiftfin 从 Yolo 播放（[已否决](../../rejected/feature/2026-10-11-jellyfin-protocol-plugin.zh.md)）。它要实现 40 到 60 个端点，外加还没有任何兼容服务器实现过的会话推送；Infuse 不接受遥控命令，Swiftfin 的遥控还没验证。即使做成了，它也没有弹幕、AI 字幕、Ask，以及 Yolo 自己的音轨和画质选择，agent 对电视的控制也只到 Swiftfin 肯听的程度。原生 App 沿用其他所有屏幕都讲的那一套协议。

**从 iPhone 上的 Yolo Web 用 AirPlay 投屏。** 今天不写代码就能用，因为 Safari 原生播放 Yolo 的 HLS。但 Yolo 的设备仍是手机：Apple TV 只是一块显示屏，agent 无法指定它；手机锁屏时 Safari 可能断开实时连接，agent 的控制也随之失去（推断，未实测）。

**节点上用 AirPlay 驱动 Apple TV 的设备插件**（pyatv，[插件架构](../../implemented/architecture/2026-10-11-plugin-architecture.zh.md)里列过）。电视上不用装 App，但也就没法用 Siri Remote 浏览，没有 Yolo 绘制的字幕，节点多一个 Python 依赖，而且非 Apple 设备通过 AirPlay 推送 URL 播放还没验证。

**跨平台框架（React Native for tvOS、Flutter）。** 视频仍然由 AVPlayer 播放，所以框架只是多了一层桥接和第二套工具链，并没有省掉播放所需的 Swift，它对 tvOS 的支持也落后于 Apple 自己的焦点引擎。

## 验收标准

在用户本人的 Apple TV 上、从 TestFlight 安装：App 通过二维码和用户本人的 passkey 完成配对；用 Siri Remote 浏览历史、搜索和片库；通过局域网直连播放 `hls`、`direct`、`dash_split` 和 `plex` 流；agent 通过 MCP 播放、暂停、跳转，并把播放移到 Apple TV 或从它移走；在电视上的进度能在车上续播；在 Yolo 设置里移除这台设备后，App 回到配对界面。

## 风险

- **两个客户端遵循同一套协议。** 实时通道的恢复规则在播放器里修了很多次，App 要用 Swift 满足同样的约定；以后实时通道每改一次，都多了一个客户端要更新和测试。`clientProtocol` 把损失限制在提示更新，而不是电视坏掉。
- **仓库里出现 Swift。** 它只能在 macOS 上构建，Linux 容器里的 `npm run check` 从不编译它；需要一个 macOS 的 CI 任务构建 App 并跑它的单元测试，否则 App 坏了也没人发现。
- **分发给用户本人以外的人。** TestFlight 内部测试只覆盖用户本人自己的设备。其他用户本人（[分发](2026-10-11-distribution-to-other-owners.zh.md)）需要 App 审核，而条款 5.2.3 禁止从 YouTube 这类第三方来源下载媒体；在这件事解决之前，每个用户本人用自己的开发者账号构建 App。
- **没有域名时远程直连的证书。** 在没有域名的实例上离家播放时，远程源用的是 IP 地址证书，还没有对 App Transport Security 测试过；在家里的 Apple TV 走局域网直连，不依赖它。
- **HDR。** 能力里没有动态范围，所以片源仍然选择 SDR；能播 HDR10 或杜比视界的 Apple TV 4K 只能拿到 SDR，直到能力能说明屏幕显示什么。
