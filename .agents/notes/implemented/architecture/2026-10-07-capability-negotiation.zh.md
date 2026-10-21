# Agent Note: 设备按能力描述协商播放方式

Status: implemented

[English](2026-10-07-capability-negotiation.md) | 中文

## 问题

早先的单进程服务是为一个播放器写的：最初只面向特斯拉的播放器，它画在 canvas 上。普通浏览器、手机或电视需要不同的格式、编码、分辨率和字幕处理方式，而写死成特斯拉的格式选择散落在各处，以后都得一个个拆出来。

## 决策

每台设备在 `hello` 消息里声明自己的**能力描述**，播放方式据此协商；车里的 canvas 引擎只是其中一份能力描述（[`service/core/src/capabilities.js`](../../../../service/core/src/capabilities.js)）：

```js
{
  renderer: "canvas-webcodecs" | "html5-video" | "native" | "external" | "remote",
  delivery: ["hls", "mp4"],
  containers: ["mp4"],                       // progressive files it plays as they are
  video: ["avc1", "hvc1", "av01", "vp09"],   // preferred first
  audio: ["mp4a", "opus", "flac", "ac-3", "ec-3"],
  maxHeight: 720,
  subtitles: "client-vtt" | "native-vtt" | "burn-in",
  audioOnly: false,
}
```

设备在每条 `report` 里上报自己的**视口**；Hub 记下每台设备最近的视口，在下次 `prepare` 时交给节点。播放器上报的是物理像素（`devicePixelRatio: 1`）：在车机 profile 下，它的[显示大小](../feature/2026-10-11-display-size.zh.md)会改变 CSS 视口，但不能让 Yolo 以为屏幕变大了。切换清晰度或视口时保留播放位置。

协商分两层。片源插件的 `prepare(source, context)` 拿到能力描述、视口、起播位置和选轨函数，决定从上游取什么；然后节点的媒体管线把这个 Input 变成设备能读的交付方式，全部在 `/m/{token}/…` 下（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）。在局域网路径上，上下文还回答 `playable(media)`：设备能否原样播放片源的原文件，依据是 `containers`、编码和 `maxHeight`（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。字幕也按这两层分工：文本字幕以 WebVTT 交付，由设备绘制，可以同时显示几条；图片字幕由片源烧录进画面，选它会重建会话。文本字幕永远不烧录，片源还在准备它时也不烧录，因为烧录一条字幕会让片源把整个画面转码。需要先提取的文本字幕（比如大媒体文件里的一条轨道），片源以增长中的轨道提供：设备每隔几秒再读一次它当前位置附近的一个窗口，片源立即读出这一段，整条轨道在后台随后完成（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）。Plex 插件对文件里内嵌的文本字幕这样做，并且按文件的路径和大小以及流的索引缓存它们的 WebVTT，而不是按 Plex 的 id，所以媒体库重新扫描后缓存仍然有效（[片源插件](2026-10-11-source-plugin-api.zh.md#the-official-plugins)）。

**车的能力描述**（`@useyolo/core` 里的 `CAR_CANVAS_CAPABILITIES`）是车机 profile 发送的能力描述，被特斯拉指纹识别出的页面不论处于哪个 profile 也发送它（[两个引擎](2026-10-12-two-playback-engines.zh.md)）：播放器只接收 `hls` 和 `mp4` 两种交付方式，用 canvas 和 WebCodecs 渲染（`avc1` 视频、`mp4a` 音频、720p）；带分片索引的分离音视频先拼成 fMP4 HLS 再交给它；Plex 转码成 720p，上限低于它配置的码率时转成 480p（[自适应码率](../feature/2026-10-11-adaptive-quality.zh.md)）；文本字幕在浏览器里绘制，图片字幕由 Plex 烧录进画面。普通浏览器或手机发送另一份能力描述，插件和节点据此选择格式、码率和字幕处理方式。

**Yolo Web 的能力描述。**在 `<video>` 元素能播 Yolo 的流的电脑或手机浏览器里，Yolo Web 通过它播放，并发送 `WEB_NATIVE_CAPABILITIES`（`renderer: "html5-video"`，`hls` 和 `mp4`），其中 `video` 和 `audio` 换成浏览器为它的 HLS 路径报告的编码（用 hls.js 时问 `MediaSource.isTypeSupported`，用原生 HLS 时问 `canPlayType`）：avc1 和 mp4a 排在最前，然后是浏览器能解码的 `hvc1`、`vp09` 和 `av01`（[两个引擎](2026-10-12-two-playback-engines.zh.md)）。`maxHeight` 是屏幕短边的物理像素数，取整到 2160（从 1800 起）、1440（从 1300 起）、1080（从 900 起）或 720；浏览器不报告屏幕尺寸时为 1080。没有这条路径、但能运行 canvas 引擎的浏览器（跨源隔离，并且有 WebCodecs 和 AudioWorklet）发送 `WEB_CANVAS_CAPABILITIES`：交付方式和编码与车的能力描述相同，最高 1080p。两个引擎都不能用的浏览器发送 `REMOTE_CAPABILITIES`（`renderer: "remote"`）：它能显示和控制播放，但自己从不播放。没有指定设备的播放请求，Hub 永远不会选中遥控器；Hub 也拒绝在遥控器上播放或把播放切到遥控器上（[Hub](2026-10-07-hub-and-realtime-channel.zh.md)）。

**片源怎样使用上限。**`maxHeight` 是值得发给设备的最高画面，流的 `limits.maxVideoKbps` 是它的媒体路径能承载的码率，设备的[自适应上限](../feature/2026-10-11-adaptive-quality.zh.md)会把它调低。yt-dlp 插件在这个码率之内以 `maxHeight` 为目标：快速运动（50 fps 及以上）最高 1440p，因为 2160p60 的码率约为两倍，画质却提升不多，软件解码器也可能跟不上；低于 50 fps 时至少 1080p，和车一直以来的规则相同。在每个高度区间里，它先取 H.264，再按设备的顺序取设备的其他编码，但这些编码只取节点能按字节范围拼接的 MP4 文件，并且是 SDR：WebM 或 HLS 会让节点转码成 H.264。YouTube 的 H.264 最高只到 1080p，更高的 VP9 是 WebM，所以 Chrome 里的 1440p 屏幕拿到 YouTube 的 AV1，不支持 AV1 的 Safari 拿到 1080p H.264。设备没有声明的编码家族永远不会被选中。Plex 插件在上限能承载 720p 以上画面时（8 Mbps 起 1080p，12 Mbps 起 1440p，20 Mbps 起 2160p），给 `<video>` 或原生设备它自己的画面尺寸，原文件的视频放得下时由 Plex 的 direct stream 直接复制；低于 8 Mbps 时（比如中继），它拿到车的已检查档位：720p 或 480p。节点也只保留 HLS 主播放列表里不高于 `maxHeight` 的变体，所以车在每条路径上都保持 720p H.264，远程上限本来能放进 1080p 或 2160p 变体的地方也是如此（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）。

**只有 canvas 引擎能读的东西。**节点会调用 `@useyolo/core` 里的 `readsSplitFiles` 和 `waitsForLiveRunway`，二者只对 `canvas-webcodecs` 为真。没有分片索引的分离音视频文件，交给 canvas 引擎时是 `split-mp4`，交给其他渲染器时是 ffmpeg 合成的一路流；带有尚未发布分片预留区的直播播放列表只交给 canvas 引擎（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）。

## 曾考虑的替代方案

**写死成特斯拉的行为。** 浏览器和手机需要不同的格式和字幕处理方式，每个写死的选择以后都得找出来再改成通用的。

**内嵌文本字幕在提取完成前先烧录。** 0.9.3 及之前，Plex 插件这样做，因为提取整条轨道要读完整个文件，大文件要几分钟。烧录让 Plex 把整个视频转码，而不是直接复制：在用户本人的 Mac mini 上把一部 4K 电影转成 20 Mbps，用户本人的屏幕要转，每个朋友通过分享链接看的流也要转。提取出的 WebVTT 按条目的 Plex id 缓存，所以媒体库重新扫描给条目换了新 id 后，字幕又会被烧录。

**等整条内嵌轨道提取完。** 它的 URL 可以像还在准备的字幕那样一直回答 `425`，直到提取结束，但大文件开头的几分钟里屏幕上就没有字幕。

**图片字幕也在浏览器里绘制，像 Infuse 那样。** 暂不实现。这需要片源交出位图轨道本身，而不是把它烧录：PGS（蓝光）或 VobSub（DVD）的数据包，用 ffmpeg 直接复制流（`-c:s copy`），按当前位置附近的窗口读取，就像现在读取文本窗口一样。需要在 `vtt` 之外加一种新的交付方式，比如带时间、并标明在原始尺寸画面上位置的位图；还需要一个解码器来解它们的游程编码图像和调色板，放在播放器里或节点上都可以，节点也可以把每条字幕渲染成 PNG。两个引擎都要把它们画在叠加层上，按画面缩放。这样选择图片字幕就能原地切换，Plex 对这些字幕也能直接复制视频。iPhone 的全屏系统播放器仍然显示不了它们，因为它只接受文本字幕。

**所有设备都以 720p 为目标。** 0.5.0 及之前，yt-dlp 插件把每台设备都限制在车的 720p 并优先选 H.264，Plex 把离家时的每个流都转码成 720p，节点把远程直连播放也限制在中继的 4.8 Mbps。于是 1440p 显示器或手机上的画面发虚，尽管它的媒体路径能承载更多。

## 后果

新的屏幕类型就是一份新的能力描述，而不是对服务的修改。`external` 渲染器留给无法经过节点的媒体：Spotify 的音频有 DRM，也不允许转发，所以 Yolo 只能通过 Spotify Connect 控制它，由 Spotify 自己的设备播放（音乐不在 [1.0](../../proposed/feature/2026-10-11-yolo-1-0.zh.md) 范围内）。文本字幕不再让片源转码；图片字幕仍然要转码。还没提取的内嵌文本字幕，在屏幕第一次请求几秒后才有第一批字幕；不会重新读取增长中轨道的客户端，只显示它加载轨道时已经做出的字幕。每个片源插件都必须遵守它拿到的能力描述，而且每个流由两层共同决定，所以画面不对可能出在插件的选择上，也可能出在节点的交付上；`stream_selected` 和 `stream_first_frame` 事件会把两者都报上来（[设备埋点](../feature/2026-10-11-device-telemetry.zh.md)）。
