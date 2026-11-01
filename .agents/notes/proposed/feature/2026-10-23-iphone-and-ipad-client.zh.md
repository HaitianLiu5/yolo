# Agent Note: 原生 iPhone 和 iPad 客户端

Status: proposed

[English](2026-10-23-iphone-and-ipad-client.md) | 中文

## 问题

在 iPhone 或 iPad 上，Yolo 是 Safari 里的浏览器播放器（[Yolo Web](../../implemented/feature/2026-10-11-yolo-web-client.zh.md)）：它通过 `<video>` 用原生 HLS 和 AirPlay 播放，也能当其他屏幕的遥控器。Safari 给不了的，恰恰是手机该做的事。用户本人切到别的 App 或锁屏，播放就停了；没有带 Yolo 自己字幕的画中画；锁屏上没有可控制的东西；Safari 一挂起标签页，实时连接就断开，智能体发给手机的命令要等下一次 welcome。给电视配对要用相机扫二维码、再到 Safari 里批准，和 Yolo 是分开的。

[Apple TV 客户端](2026-10-19-apple-tv-client.zh.md)已经用 Swift 实现了[客户端协议](../../implemented/architecture/2026-10-19-client-protocol.zh.md)：YoloKit 包含发现、配对、`/v1`、实时通道、媒体路径、播放补齐、浏览、字幕、弹幕、自适应画质和 Ask，tvOS App 也通过了 conformance kit。它的第四阶段就是 iPhone 和 iPad 的 target，只为 Safari 给不了的东西才值得做。本说明就是这个 target。

## 提案

在同一个 Xcode 工程 `clients/apple/Yolo.xcodeproj` 里加一个 iOS target，在 iPhone 和 iPad 上运行，用 Swift、SwiftUI 和 AVPlayer 编写，以 `kind: "phone"` 的屏幕身份实现客户端协议。和电视 App 一样，它不带任何内容，也没有任何提供方的名字。它既是能播放的屏幕，也是用户本人其他屏幕的遥控器。

### 共用 YoloKit 和 App 层

YoloKit 保持原样：用 Swift 写的协议，和任何界面分开，已经为 `.iOS(.v18)` 构建，并在 macOS 上用 `swift test` 测试。iOS target 像 tvOS target 一样链接它。YoloKit 里有两处从常量改成参数：OAuth 的 `client_id`（现在是 `yolo-apple-tv`，iPhone App 用 `yolo-apple-ios` 配对）和设备类型（`tv` 或 `phone`），由 App 传给 `PairingClient` 和 `hello`。`Capabilities` 增加 `.iPhone(maxHeight:decodesHEVC:)`。

tvOS App 自己的代码大多和电视无关：`AppModel.swift` 负责发现、配对、实时通道、媒体路径探测、welcome 之后的补齐，以及弹幕和 Ask 的模型；`TVPlayer.swift` 用 AVPlayer 播放 `load`、汇报、画文字字幕、为自适应画质取样，并在当前路径上放弃卡住的流。这一层搬到 `clients/apple/Shared/`，两个 target 都编译它，这样电视和手机用同一份经过 conformance kit 验证的代码从断开的连接里恢复。和设备有关的部分留在各自的 target：`ThisDevice`（名字、显示尺寸、能力）、播放器的控制器（电视的进度条菜单，手机的画中画和菜单），以及所有界面。`TVPlayer` 拆成共用的 `Player` 和电视的 `PlayerScreen`。共用文件在平台之间有差别时用 `#if os(tvOS)`，尽量少用。

### 界面

App 用 SwiftUI 的 `TabView` 加 `.sidebarAdaptable`：首页、搜索、Ask 和设置在 iPhone 上是底部标签栏，在 iPad 上是侧边栏，每个标签有自己的 `NavigationStack`（首页 → 片库 → 条目 → 剧集）。点卡片的封面打开条目的详情页（它的图片、基本信息、按 Yolo 记录的位置“播放”或“继续播放”、简介、评分和演职人员，来自 `GET /v1/library/items/:id`，它给屏幕的就是 MCP 的 `get_item` 给智能体的），点卡片上的播放按钮直接播放；剧集的封面打开它的分集。行和网格用自适应列，所以同一套界面从竖着拿的手机到横屏的 iPad、分屏和台前调度都能排好。

- **iPhone 竖屏：** 底部标签栏；首页是几行带标题的横排：Recent（来自片库的观看记录）、Videos（观看记录里其余的视频，例如网页链接，卡片写着人们对网站的叫法，如 Bilibili、YouTube，以及上次播放的时间）、Movies 和 Shows；正在播放条在标签栏上方。See All 页每行三张海报（视频两张），可按添加时间、标题、年份、未看或随机排序，按标题排序时侧边有 A 到 Z 的索引。卡片在标题旁用一个圆点标出从没播过的，在图片底边用一条线标出播了一部分的；看完的两样都没有。详情页隐藏标签栏。剧集的页面是“接下来看”那一集（第一集看了一半的，否则第一集没播过的）的详情页，标题是剧名，下面按季列出各集，可以选。
- **iPhone 横屏：** 同样的标签，网格更宽。播放器总是横屏播放，因为手机上不竖着看视频。点下去就打开，不等流的 `load`，加载也在播放器里显示：手机还竖着时一块黑屏从右边滑进来，手机在黑屏后面转成横屏，播放器再淡入；关闭时先变黑，转回竖屏，再滑出去。之后浏览保持竖屏，直到手机本身竖起来。
- **iPad：** 侧边栏、更大的网格，播放器全屏，或者在浏览时用画中画放在一旁。

播放器是 App 自己的：全屏弹出一个 `AVPlayerLayer`，控件画在画面上，因为 iOS 上的 `AVPlayerViewController` 不接受自定义菜单。顶部是关闭、填充或适应、画中画和系统音量滑块；中间是后退、前进十秒和播放或暂停；底部是分集信息和标题、一条细的时间轴（显示已播放、已缓冲和其余部分）、已播放和剩余时间、接下来播放的列表（条目所在的那一串，来自 `GET /v1/library/items/:id/sequence`：一部剧从这一集往后的各集，一个视频的分 P）、设置菜单（速度、画质、音轨、字幕）以及系统的 AirPlay 选择器。画质默认“自动”，像电视一样自适应；用户也可以选一个码率，一直保持到改回“自动”（[自适应画质](../../implemented/feature/2026-10-11-adaptive-quality.zh.md)）。点一下显示或隐藏控件，播放时控件会自己隐藏。双击左边或右边三分之一后退或前进十秒，竖着滑动在左半边调亮度、在右半边调音量。画面可以在两侧安全区之间完整显示、铺满整个屏幕完整显示，或者裁切填满。弹幕横跨整个屏幕，从屏幕边缘进入。在这里暂停、播放或跳转是用户本人自己的操作，就像按电视遥控器一样。文字字幕（包括 AI 字幕）和电视一样画在画面上，因为 AVPlayer 不能给 HLS 流挂外部 WebVTT 文件。配对、设置和更新提示沿用电视界面的逻辑，换成手机的布局。

### 播放：画中画、AirPlay 和后台音频

音频会话设为 `.playback` 并打开 `audio` 后台模式，所以用户本人锁屏或离开 App 时声音继续，“正在播放”和锁屏控制跟随播放器。后台播放时进程一直在运行，实时连接和汇报也一直在。后台暂停后，iOS 几秒内挂起 App，连接断开；Hub 这时看到手机离线，智能体在这期间发的命令，会在下一次 welcome 后由协议本来就要求的补齐来弥补（[断开的连接带走了什么](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md#what-a-dead-connection-takes)）。

画中画是播放器图层上的 `AVPictureInPictureController`，音频会话能在后台播放之后就可以用；播放时离开 App 就会进入画中画。覆盖层不会进入画中画窗口，也不会出现在 AirPlay 显示器上，所以要等节点把文字字幕作为 WebVTT 轨道列进 HLS 播放列表，那里才有字幕，这一步推后。AirPlay 通过 `allowsExternalPlayback` 播放，手机仍然是 Yolo 设备。用户本人有已配对的 Yolo 屏幕（比如 Apple TV App）时，“移到”会把会话移过去，在那里作为那块屏幕自己的会话播放（见下文）。

能力和电视一样，只是换成手机的屏幕：`renderer: "native"`、`delivery: ["hls", "mp4"]`、`containers: ["mp4"]`，先 `avc1`，机型能解时再 `hvc1`，音频 `mp4a`、`ac-3` 和 `ec-3`，`subtitles: "client-vtt"`，`maxHeight` 取屏幕短边的像素数，现在的 iPhone 和 iPad 上是 1080。

### 其他屏幕的会话

从客户端协议 2 起，每块屏幕都播放自己的会话（[屏幕会话](../../implemented/architecture/2026-10-31-screen-sessions.zh.md)），所以在手机上点一下就在手机上播放。YoloKit 的 `Sessions.swift` 读取 welcome 里本屏的 `state`、`sessions`、`profile` 和 `profiles`，按 `deviceId` 读取每条 `state` 和 `queue`，以及 `devices` 列表，和播放器的 `store.js` 一样；App 层只对自己的会话动手。有两个操作会涉及另一块屏幕，两个 App 里相同：

- **从另一块屏幕继续**是首页的第一行：最多三个其他屏幕的会话，属于用户本人的档案或本屏自己的档案，最新的在前，停着的车上的也算，每个都带屏幕名、位置和多久以前（`continueCandidates()`）。按一下就是 `PUT /v1/playback/device` `{ deviceId: <本屏>, from }`：Hub 在这里播放那个条目，带上它的音轨、接下来播放的内容和它的队列，另一块屏幕暂停。第一个会在它将要开始的位置预热。另一块屏幕接走了本屏自己的会话时，那一个排在最前面，标题是“已在……上继续”。
- 播放器里的**移到**（手机的顶部栏、电视的进度条菜单）用同一个调用从另一侧把本屏的会话送到另一块在线、能播放的屏幕。有别人在那里观看时，Hub 回答 `screen_busy`，App 先问“Family 正在客厅电视上看《片名》。”，再发 `replace: true`。

被另一块屏幕接走的会话已经暂停：它的 `state` 带有 `handedTo`，播放器关闭，之后的 welcome 也不会恢复它。用正在播放条控制另一块屏幕的会话（带播放控制，暂停时的画面取自 `/v1/frame`）放在后面的阶段。

### 配对，以及用手机批准电视

手机自己配对的方式和电视一样：在家里的网络上用 Bonjour（完整显示，点一下确认），或者输入地址，然后是 `/.well-known/yolo` 和设备授权。因为显示配对码的设备就在用户本人手里，扫码没有意义：App 立刻在 `ASWebAuthenticationSession` 里打开 `verification_uri_complete`，用户本人用手机已经为自己的域名记住的 passkey 登录，同时 App 按协议要求继续轮询 `/oauth/token`，就像浏览器播放器批准自己的配对码一样（[设备码配对](../../implemented/feature/2026-10-07-device-code-pairing.zh.md)）。有一个按钮可以再次打开面板，二维码和短码收在“用另一台设备”下面，供在别处批准。

批准另一块屏幕就是扫码。设置里有“给屏幕配对”，打开相机（VisionKit 的 `DataScannerViewController`）读取二维码，只接受这台 App 已配对的源地址上的 `https` 网址，然后在 `ASWebAuthenticationSession` 里打开它，用 passkey 批准。别的服务器的配对码会被拒绝，并显示它的主机名，所以手机从不在没配对过的服务器上批准。系统相机照样能用，因为二维码就是普通的网址。

### 用语音 Ask

Ask 和电视一样，通过 YoloKit 的 `Agent.swift` 把用户本人的话发给 `/v1/agent`。`/v1/agent` 的状态表明媒体节点有转写器时，输入框旁边有麦克风：用 `AVAudioEngine` 录 16 kHz 单声道 WAV，听的时候把播放器音量调低，点一下或停顿时停止，带上设备的语言发到 `/v1/agent/transcriptions`，填进输入框，两秒后发送，除非用户本人去改它，和浏览器播放器的 Ask 一样（[从屏幕上找智能体](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)）。没有转写器时，输入框的键盘听写就是语音输入，不用申请权限。Info.plist 带上 `NSMicrophoneUsageDescription`。

<a id="stages"></a>

### 阶段

1. **能播放的屏幕。** 共用层从 `TV/` 搬出，电视 App 的行为不变；iOS target 有首页、搜索和设置三个标签；用 Bonjour 或输入地址配对，在手机上当场批准或用另一台设备批准；观看记录、片库、搜索和剧集；播放支持 AirPlay、续播、汇报、`ended`、媒体路径探测和实时协议的必须部分；conformance kit 在 iPhone 模拟器上通过。
2. **Safari 给不了的。** 后台音频、画中画、锁屏、字幕和音轨菜单、随生成重读的 AI 字幕、自适应画质，以及按电视的布局画在画面上的弹幕。
3. **客户端协议 2。** 两个 App 都播放自己的会话，首页有“从另一块屏幕继续”，播放器里有“移到”，kit 的协议 2 场景在两个模拟器上都通过。
4. **遥控器。** 控制另一块屏幕会话的正在播放条和列出所有会话的面板，以及扫码“给屏幕配对”。
5. **播放器的其余界面。** 带麦克风的 Ask、智能体放到屏幕上的东西（[智能体画布](../architecture/2026-10-21-agent-canvas.zh.md)）、编辑队列、分享链接、错误面板和片尾画面。

第一到第三阶段已经做完。

### 用 conformance kit 证明

kit 已经能通过 `YOLO_CONFORMANCE_LAUNCH` 在模拟器里启动客户端。iOS 的调试构建和电视的调试构建一样，通过共用的 `Conformance.swift` 接受 `-YoloConformanceURL`，把配对保存在内存里，并在 kit 的 `/debug` 上用同样的字段回答 `debug_state`：

```bash
YOLO_CONFORMANCE_KIND=phone YOLO_CONFORMANCE_LAUNCH='xcrun simctl terminate <udid> <bundle id>; sleep 1; xcrun simctl launch <udid> <bundle id> -YoloConformanceURL {url}' npm run test:conformance
```

kit 的配对场景从 `YOLO_CONFORMANCE_KIND` 读取预期的类型，默认是 `tv`。其他场景对手机都原样成立，协议 2 的场景也是：提供其他屏幕的会话、它们的广播不影响本屏的会话、在这里继续、被别处接走的会话，以及带 `screen_busy` 的“移到”；这些场景里 kit 通过调试 socket 的 `debug_action` 代用户本人按键。第一阶段只有在 kit 于 iPhone 模拟器上通过、而且共用层搬走后电视 App 再次通过时才算完成。

### 仓库和构建

`clients/apple/iOS/` 放 iOS 的界面和 `ThisDevice`，`clients/apple/Shared/` 放共用的 App 层，`Config/` 在 `Base.xcconfig` 之上加 `TV.xcconfig` 和 `iOS.xcconfig`，`Base.xcconfig` 只留两者共用的设置，这样 `SDKROOT` 和设备类别按 target 设置。两个 App 用同一个 bundle id `$(BUNDLE_ID_PREFIX).yolo` 签名，这样一条 App Store Connect 记录和一个 TestFlight 组同时带上两个平台（通用购买，和其他媒体服务器的客户端一样）；团队和前缀来自被忽略的 `Local.xcconfig`，从不进入被跟踪的文件。bundle id 的记录一旦建立就不能改名，所以电视 App 离开它最早发布时用的记录，改用这一条。用 `YoloiOS` scheme 构建 iOS App，`archive.sh` 接受平台作为参数（`tvos` 或 `ios`）。iOS 的 Info.plist 在 `NSBonjourServices` 里列出 `_yolo._tcp`，并带上 `NSLocalNetworkUsageDescription`、`NSCameraUsageDescription`、`NSMicrophoneUsageDescription` 和 `UIBackgroundModes: audio`。

## 曾考虑的替代方案

**继续用 Safari。** 不花任何成本，也已经能播放，但到后台就停，锁屏上没有 Yolo 的控制，标签页挂起时丢掉实时连接，给电视配对还得靠相机和 Safari。这些正是要做 App 的理由。

**用网页视图包住浏览器播放器。** 可以只保留一套界面，但 `WKWebView` 在后台播放和挂起时的连接上和 Safari 有同样的限制，canvas 引擎的 SharedArrayBuffer 需要的跨源隔离在网页视图里不可靠，而画中画和锁屏仍然需要 AVPlayer。

**把 App 层搬进 YoloKit。** 这样所有东西在一个包里，但这一层依赖 AVKit、UIKit 和 SwiftUI 的观察机制，macOS 上的 `swift test` 不会以同样方式构建它们，而 YoloKit 的价值就在于协议能脱离任何界面单独测试。两个 target 都编译的 `Shared/` 文件夹保住了这一点。

**把电视 App 的模型复制进 iOS target。** 起步最快，但 welcome 之后补齐的逻辑会有两份并逐渐分叉，而这段逻辑在播放器里修得最多。

**用关联域名的原生 passkey。** `ASAuthorizationPlatformPublicKeyCredentialProvider` 不用网页面板就能批准，但它需要为每位用户本人的域名配置 `webcredentials:` 授权，还要 Worker 提供写明团队和 bundle id 的 `apple-app-site-association` 文件。`ASWebAuthenticationSession` 已经能用 Safari 为该域名记住的 passkey，服务端不用改。

**Ask 用设备上的语音识别（`SFSpeechRecognizer`）。** 节点没有转写器时也能用，但要再申请一项权限，而节点没有转写器时键盘听写已经能在设备上识别；用节点的转写器，每块屏幕上听到的话都一样。

**iOS 用单独的 bundle id，电视 App 保留原来的记录。** 电视 App 不用换记录，但一个从同一台服务器播放的 App 要为 iPhone 多一条记录和一个 TestFlight 组，而且电视的 id 以 `.tv` 结尾。

## 验收标准

在用户本人的 iPhone 和 iPad 上，从 TestFlight 安装：App 在家里用 Bonjour 找到用户本人的服务器，或者接受输入的地址，配对后在手机上直接用 passkey 批准；在 iPhone 模拟器上通过 conformance kit，电视 App 也仍然通过；在 iPhone 的竖屏和横屏以及 iPad 的侧边栏里浏览观看记录、搜索、片库和剧集；通过局域网直连播放 `hls`、`direct`、`dash_split` 和 `plex` 流，离家时通过远程直连或中继播放；汇报的进度能在车上和电视上续播；锁屏后继续带声音播放，显示锁屏控制，能用画中画播放；智能体通过 MCP 让手机播放、暂停、跳转，并把播放移到手机或从手机移走；手机一按就继续 Apple TV 上的会话，能把自己的会话移过去，并能从正在播放条控制电视上的会话；在 App 里扫描电视的配对二维码就能批准；Ask 能接受用户本人的语音。

## 风险

- **搬动电视的代码。** 共用层在第一阶段离开 `TV/`，搬错了就会弄坏已经能用的电视 App。合并前 conformance kit 对两个 target 都要跑。
- **被挂起的 App 是离线的。** 后台暂停后，手机几秒内断开连接，设备列表显示它离线，直到用户本人打开它；智能体无法在连不上的手机上开始播放。用推送通知唤醒需要服务端支持 APNs，不在范围内。
- **画中画和 AirPlay 上的字幕。** 覆盖层不在画中画窗口里，也不在 AirPlay 显示器上，所以在节点把 WebVTT 轨道放进 HLS 播放列表之前，那里没有文字字幕。
- **没有域名时的远程直连。** 手机离家的时间比电视多得多，而没有域名的实例上，远程源地址用的是 IP 地址的证书，还没有在 App Transport Security 下测试过；测试之前，这样的手机离家时走中继播放。
- **App 审核。** TestFlight 内部测试覆盖用户本人的设备；App Store 的问题和电视说明里的一样，涉及同一条准则。
- **要维护的界面更多。** 每个到达客户端的功能都多了一种屏幕布局（手机、iPad、电视），而 `npm run check` 一个都不构建；在 macOS CI 任务里构建两个 target 并运行 `swift test` 能覆盖这一点，这也是电视说明要求的那个任务。
