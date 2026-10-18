# Agent Note: 一个播放器、两个引擎：车上用 canvas，网页上用 `<video>`

Status: implemented

[English](2026-10-12-two-playback-engines.md) | 中文

## 问题

canvas 引擎（Mediabunny 和 WebCodecs 画到 `<canvas>` 上，用 `SharedArrayBuffer` 做音频时钟）之所以存在，是因为车辆行驶时特斯拉可能会冻结 `<video>` 元素（[canvas 引擎](2026-04-04-canvas-playback-engine.zh.md)）。Yolo Web 以前在所有浏览器里也用它（[Yolo Web](../feature/2026-10-11-yolo-web-client.zh.md)）。电脑和手机浏览器不会冻结 `<video>`，在那里 canvas 引擎纯粹是开销：用 JavaScript 解封装、维护解码帧队列、画 canvas、自带一条音频管线，而浏览器本身就有带硬件解码的原生媒体管线。它还需要跨源隔离，而 Safari 不给页面跨源隔离（它忽略 `Cross-Origin-Embedder-Policy: credentialless`），所以 iPhone 和 iPad 只能当遥控器。`<video>` 自带的东西——画中画、锁屏上的媒体控制、AirPlay——也都用不上。

## 决策

客户端有一个播放器和两个接口相同的引擎。[`player.js`](../../../../clients/player/src/player.js) 负责引擎之上的一切：播放器的控件、进度、菜单和错误面板；向 Hub 汇报状态和进度；恢复；遥测；自适应清晰度；续播；以及 Hub 的命令（load、pause、resume、seek、tracks、stop）。它通过 [`engine/mediabunny-player.js`](../../../../clients/player/src/engine/mediabunny-player.js) 的接口驱动任一引擎：`load`、`play`、`pause`、`seek`、`stop`、`destroy`，状态 `loading`、`paused`、`playing`、`buffering`、`seeking`、`ended` 和 `error`，`getCurrentTime`、`getStats`、`getSeekableRange`、`getLiveTimeline`、`setVolume`、`enableAudioOutput` 和 `audioOutputState`。 `<video>` 引擎另有 `setPlaybackRate`，供按住画面时的两倍速播放使用（[车载界面的设计原则](2026-07-13-in-car-design-principles.zh.md)）；canvas 引擎没有，因为它的画面跟随它的音频时钟。

### 由哪个引擎播放

由设备的 [profile](../feature/2026-10-11-yolo-web-client.zh.md) 选择（[`engine/native-support.js`](../../../../clients/player/src/engine/native-support.js)）：

| Profile | 引擎 | 否则 |
|---|---|---|
| `car` | canvas 引擎，没有任何变化 | 浏览器跑不了它时，是遥控器 |
| `web` | 浏览器的 `<video>` 元素（[`engine/native-video-player.js`](../../../../clients/player/src/engine/native-video-player.js)），只要它能播 Yolo 的流 | 只能跑 canvas 引擎时用 canvas 引擎；两个都不行时是遥控器 |

**特斯拉从不通过 `<video>` 播放。**特斯拉指纹认出的页面（[设备码配对](../feature/2026-10-07-device-code-pairing.zh.md)）用 canvas 引擎播放，并在 `hello` 里声明 `CAR_CANVAS_CAPABILITIES`，不管用户本人给设备选的是什么类型。被配对成浏览器的车保留 web profile 的布局和「点一下在哪里播放」的规则，但不用 `<video>` 引擎；跑不了 canvas 引擎的特斯拉是遥控器。

`<video>` 元素能播 Yolo 的流，指的是它能通过其中一条路径播 HLS，并且能播 H.264 加 AAC。Apple 的 WebKit（Safari，以及 iPhone 和 iPad 上的所有浏览器）原生播放 HLS，这样保留了 AirPlay 和系统的媒体管线。其他浏览器（Chrome、Edge、Firefox、Android）用 [hls.js](https://github.com/video-dev/hls.js) 喂给 Media Source Extensions。渐进式文件直接播放。hls.js 是单独的一个代码块，通过它播放 HLS 的页面在首页显示出来之后就去取，所以第一次点按不必等它；车机从不下载它。在特斯拉之外，设备类型改变后，从下一个流开始换引擎。

### `<video>` 引擎做什么

- **能力描述。** 页面声明 `renderer: "html5-video"`，并列出它的 HLS 路径能播的编码（hls.js 用 `MediaSource.isTypeSupported`，原生 HLS 用 `canPlayType`），avc1 和 mp4a 排在最前，并按显示屏给出 `maxHeight`（[能力协商](2026-10-07-capability-negotiation.zh.md)）。
- **位置是条目的位置。** `<video>` 元素从流的第一个分片开始计时。用 hls.js 时，引擎会加上媒体自身的第一个时间戳（`INIT_PTS_FOUND`），这正是 canvas 引擎读取的时间线。原生 HLS 不提供这个时间戳：对于节点可能已裁剪到起播位置的流（流描述里的 `trimToStart`，即从中途恢复的转码），用流缺少的那部分条目时长来代替，精度取决于片源对时长的取整（Plex 取整到秒）。在这种流的起点之前 seek，会向 Yolo 要一个新流，与 canvas 引擎相同。
- **等待就是时间停住。** 只看元素的事件判断不了：WebKit 的原生 HLS 会发出 `waiting`，或在跳转结束时停在 `HAVE_FUTURE_DATA` 以下，然后不发 `playing` 也不发 `canplay` 就接着播放。所以时间一动，等待就结束，不管事件怎么说；`waiting` 要等时间停住 750 毫秒才算缓冲；播放中时间停住 5 秒，是浏览器没有报告的卡顿。不是 Yolo 发出的 `pause`，如果来时元素前面已经没有可播的数据（低于 `HAVE_FUTURE_DATA`，或已经在一次等待中），就是浏览器因卡顿自己暂停，不是主人的暂停：显示转圈，数据回来后引擎按原来的声音接着播。
- **失败。** 节点返回的 410 是 `SESSION_EXPIRED`，403 是 `UPSTREAM_ACCESS_DENIED`；hls.js 对单一变体的分片会一直重试，这时也一样。`<video>` 元素从不报告是哪个状态码导致失败，所以在元素出错后、以及等待 8 秒后，引擎会自己去问节点：对流做一次 `HEAD`，原生 HLS 还会对它的第一个变体播放列表做一次 `HEAD`，节点会去片源那里取这个播放列表。网络错误、解码错误，或 30 秒没有新数据（`MEDIA_NETWORK_ERROR`、`MEDIA_DECODE_ERROR`、`MEDIA_STALLED`），会通过播放器的恢复机制重建流；浏览器不支持的流（`MEDIA_UNSUPPORTED`）显示错误面板。
- **字幕仍由 Yolo 绘制。** [`subtitles.js`](../../../../clients/player/src/subtitles.js) 把字幕画在画面之上，按元素的画面尺寸排版，按引擎的位置计时。引擎关闭浏览器自己的字幕：hls.js 不渲染任何字幕或隐藏式字幕，浏览器显示出来的文本轨道会被禁用。例外是 iPhone 上系统自己的全屏播放器（见下文），Yolo 的字幕层在那里显示不出来。选中的字幕同时也是元素的文本轨道：用 Yolo 已经解析好的字幕条目生成，并移到流的时间线上（用 `<track>` 加载 WebVTT 文件会漏掉中途恢复的流的偏移），内嵌播放时保持隐藏。系统播放器占着画面时，显示第一个选中的字幕；Yolo 没有它的字幕条目时，改为显示流自带的同语言字幕轨道。用户在那个播放器的字幕菜单里做的选择，在它关闭前一直有效。
- **音轨。** 片源列出的音轨（Plex 的）照旧通过 Yolo 切换，由 Yolo 重建流。HLS 播放列表里有、但片源没有列出的音频版本，由引擎直接切换（hls.js 的音轨、元素的 `audioTracks`），不需要新流。
- **声音。** 浏览器允许时带声音开始播放；否则静音播放并显示「Tap for sound」（没有画面的流等用户点一下），第一次点击在手势仍有效时取消静音（[进度与续播](../feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)）。每个流都在上一个流用过的元素里播放：WebKit 只有在某个元素被一次手势启动过之后，才允许它不经手势出声，所以每来一个新流就换一个新元素时，iPad 上的画质切换或恢复会静音播放，直到再点一下。Yolo 的字幕轨道跟着元素留下，处于停用状态，下一个流再接着用。元素按系统音量播放；canvas 引擎的增益提升不适用。
- **`<video>` 自带的东西。** 硬件解码。浏览器提供时，显示全屏按钮（[`picture-controls.js`](../../../../clients/player/src/picture-controls.js)）；画中画不再有 Yolo 自己的按钮（主人觉得多余），仍可从浏览器自己的菜单和系统播放器进入；全屏作用于整个播放器，所以 Yolo 的控件和字幕仍在。iPhone 上的所有浏览器都没有元素全屏，只能把 `<video>` 元素本身放进系统自己的播放器里全屏（`webkitEnterFullscreen`）：在那里，这个按钮打开那个播放器，和 YouTube 移动网站一样；iPad 和电脑仍然是播放器全屏。弹幕在系统播放器里显示不出来，它关闭后接着显示。回来时，引擎接手那个播放器做过的事（暂停、播放、seek、关掉或打开声音），不管每个事件是否传到了页面，控件、Hub 和进度随即跟上。新流会关闭那个播放器，所以画质升档要等用户回来，卡顿时仍会降档；队列的下一个条目和恢复也会关闭它。把手机横过来不会打开它：iOS 只在点击时打开它，而转动手机不算点击。通过 Media Session 接入系统的媒体控制（锁屏、手机的通知），带条目封面和 seek。Safari 上的 AirPlay。在画中画或系统控制里暂停或播放，会成为用户本人的意图并上报给 Hub。
- **直播流**在浏览器可 seek 的窗口边缘播放，seek 也限制在窗口内。节点给 `<video>` 元素的直播播放列表以最新发布的分片结尾，往回覆盖 5 分钟，没有 canvas 引擎那段尚未发布分片的预留区（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）。

### 每个页面都保持跨源隔离

应用的每个页面都保留 COOP 和 COEP（[canvas 引擎](2026-04-04-canvas-playback-engine.zh.md)）。一个页面同时服务两个 profile，页面要加载之后才知道自己的 profile（用户本人为设备选的类型，或特斯拉指纹），而这两个头必须随文档本身一起下发；如果车机拿到的页面不带这两个头，就完全无法播放。`<video>` 引擎既不需要跨源隔离，也不受它影响：它的媒体是同源的，或者来自回答 CORS 的节点局域网源（这时元素用 `crossorigin="anonymous"` 加载）。字幕字体来自页面自己的源 `/lib/fonts/`，所以没有字体服务器能看到屏幕的地址；播放器的构建产物或用户本人的页面一旦引用别的主机，[`third-party-origins.test.js`](../../../../service/control/test/integration/third-party-origins.test.js) 就会失败。图片也来自同一个源：别的主机上的缩略图（例如网页视频的）经过 `/v1/thumbnail`，由节点获取（[节点内部接口](2026-10-07-node-internal-api.zh.md)）；页面一旦请求别的主机，[`player-ui.test.js`](../../../../test/e2e/player-ui.test.js) 里的首页测试就会失败。两个引擎都按流的源解析流的每个媒体 URL（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。Safari 忽略 `credentialless`，照样通过 `<video>` 播放。Web 应用清单（manifest）和主屏幕图标也是页面自己的文件，这两个头不会拦住它们：「添加到主屏幕」后，Yolo 单独打开，没有浏览器的地址栏和工具栏，也不需要 service worker，Yolo 本来就没有。iOS 把主屏幕应用的存储和 Safari 的分开，所以它要作为一块单独的屏幕配对。

### 自适应清晰度与浏览器的 ABR

Yolo 的上限仍是天花板，浏览器在它之下自适应（[自适应清晰度](../feature/2026-10-11-adaptive-quality.zh.md)）。对每个设备，节点都只保留多变体播放列表中符合设备 `maxVideoKbps` 的变体；hls.js 和原生 HLS 自己在这些变体之间切换。Yolo 的清晰度控制器仍会以另一个上限重建流，单一变体的流（Plex 的转码、合并的分离文件、单个文件）就是靠它自适应。它用 hls.js 的带宽估计来测量；没有 hls.js 时，用浏览器下载期间缓冲增长的速度来测量。hls.js 自己切换变体时，缓冲下降交给它处理，Yolo 只在卡顿之后才降低上限。

### 测试

[`test/e2e/web-playback.test.js`](../../../../test/e2e/web-playback.test.js) 在桌面 Chromium 里通过 `<video>` 引擎播放 `direct`、`hls`、`dash_split` 和 Plex fixture（测试前置数据）：seek、暂停与继续、画在画面上的字幕、切换音轨、410 之后的恢复和全屏；同一个文件还用返回离开一个条目，再从正在播放栏接着播放。设置 `YOLO_E2E_WEBKIT=1` 后，各种流类型和 Plex 也会在 Playwright 的 WebKit（Safari 的引擎）里运行，那里 HLS 原生播放，页面也没有跨源隔离；Plex 还会在那里像在 iPhone 上一样播放：没有元素全屏，全屏按钮打开系统的播放器（用替身代替，因为 Playwright 的 WebKit 是 Mac 上的），它把字幕作为元素的文本轨道显示，直到关闭。车机的端到端测试以车的类型配对，继续测试 canvas 引擎；一辆以浏览器类型配对的特斯拉也仍然用它播放。单元测试覆盖按 profile 选择引擎、用假的元素和假的 hls.js 测试 `<video>` 引擎的位置、失败、自动播放规则，以及它在系统全屏播放器前后的文本轨道和接手，全屏按钮打开哪种全屏，以及节点按渲染器选择的交付方式。

## 曾考虑的替代方案

**所有地方都用 canvas 引擎**，即以前的做法。它在 Chrome 里能播，但要花浏览器自身管线不需要的 CPU，在 Safari 里根本跑不了（iPhone 和 iPad 只能当遥控器），还放弃了画中画、AirPlay 和系统的媒体控制。

**所有地方都用 `<video>`，包括车上。** 车辆行驶时特斯拉可能会冻结 `<video>`，这正是 canvas 引擎存在的原因。

**只由用户本人选的类型决定引擎。**类型是在批准页上选的一个标签，车也可能被标成浏览器；那样它就会通过 `<video>` 播放。指纹测量的是浏览器本身，所以在特斯拉里由它决定引擎和能力描述，类型继续决定布局。

**单独的网页播放器。** 它要重复控件、汇报、恢复、遥测、清晰度和续播，两边还会慢慢分叉；放在同一个接口后面，两个引擎共享这些。

**Safari 里也用 hls.js**（Safari 有 Media Source Extensions，iPhone 有 ManagedMediaSource）。原生 HLS 保留 AirPlay，用系统省电的管线，并且在 iOS 的所有浏览器里都能用；在那里用 hls.js 会多一次下载，还会失去 AirPlay。

**只给车机页面下发 COOP 和 COEP。** 页面加载之后才决定 profile，而这两个头随文档一起下发。按 profile 下发需要一个服务器在页面运行前就能信任的信号，一旦猜错，车机就无法播放。

**每个流都给多变体播放列表，自适应完全交给浏览器。** Yolo 合并的分离文件和转码只有一个变体：节点要合并并探测片源提供的每种格式，或者片源要同时转出好几路，而 Plex 不这样做。以 Yolo 的上限为天花板，每个片源都能照原样工作，播放列表有多个变体的地方浏览器也能自适应。

**用浏览器的字幕显示字幕。** Yolo 的渲染器用自己的字体排版双语字幕，还能同时显示多条字幕；浏览器的字幕在各个浏览器里做不到同样的效果。

## 后果

电脑和手机用浏览器自己的媒体管线播放。在 Apple 芯片 Mac 上的桌面 Chrome 里，同一路 H.264 加 AAC 的 HLS 流，按 Chrome 各进程合计，CPU 约为 canvas 引擎的一半：720p30 和 1080p30 都是约占一个核心的 9% 对 17%，两个引擎都是每秒 30 帧、几乎不丢帧（2026-10-12 在可见窗口里测得；无头 Chrome 的帧节奏和真实显示器不同，不能用来测量）。iPhone 和 iPad 上的 Safari 能播放了，不再只能控制其他屏幕；Yolo Web 也有了画中画、全屏（播放器全屏，在 iPhone 上是系统自己的播放器）、系统的媒体控制和 AirPlay。iPhone 上的系统播放器不显示弹幕，从中途恢复的流从这个流开始的地方计时，每来一个新流都会关闭。车机的行为没有变化，类型标成浏览器时也一样。指纹是这道防线：如果特斯拉的 user agent 和窗口尺寸都不再符合指纹，它就会按类型播放。播放器要在一个接口后面维护两个引擎，有些失败的表现也不同：`<video>` 元素从不报告失败的状态码，所以引擎要去问节点；浏览器没有报告的卡顿，要靠观察时间和缓冲来发现。在原生 HLS 下，从中途恢复的流的位置精度取决于片源的时长。预留区直播播放列表、分离文件交付和增益提升仍只属于 canvas 引擎。hls.js 是一个 180 kB（gzip）的代码块，只有通过 Media Source Extensions 播放 HLS 的页面才加载，在首页时加载。
