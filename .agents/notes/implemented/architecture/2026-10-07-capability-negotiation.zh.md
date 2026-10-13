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

协商分两层。片源插件的 `prepare(source, context)` 拿到能力描述、视口、起播位置和选轨函数，决定从上游取什么；然后节点的媒体管线把这个 Input 变成设备能读的交付方式，全部在 `/m/{token}/…` 下（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）。在局域网路径上，上下文还回答 `playable(media)`：设备能否原样播放片源的原文件，依据是 `containers`、编码和 `maxHeight`（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。字幕也按这两层分工：文本字幕以 WebVTT 交付，由设备绘制，可以同时显示几条；图片字幕由片源烧录进画面，选它会重建会话。

**车的能力描述**（`@useyolo/core` 里的 `CAR_CANVAS_CAPABILITIES`）是车机 profile 发送的能力描述，被特斯拉指纹识别出的页面不论处于哪个 profile 也发送它（[两个引擎](2026-10-12-two-playback-engines.zh.md)）：播放器只接收 `hls` 和 `mp4` 两种交付方式，用 canvas 和 WebCodecs 渲染（`avc1` 视频、`mp4a` 音频、720p）；带分片索引的分离音视频先拼成 fMP4 HLS 再交给它；Plex 固定转码成 720p；文本字幕在浏览器里绘制，图片字幕由 Plex 烧录进画面。普通浏览器或手机发送另一份能力描述，插件和节点据此选择格式、码率和字幕处理方式。

**Yolo Web 的能力描述。**在 `<video>` 元素能播 Yolo 的流的电脑或手机浏览器里，Yolo Web 通过它播放，并发送 `WEB_NATIVE_CAPABILITIES`（`renderer: "html5-video"`，`hls` 和 `mp4`），其中 `video` 和 `audio` 换成浏览器为它的 HLS 路径报告的编码，avc1 和 mp4a 排在最前（[两个引擎](2026-10-12-two-playback-engines.zh.md)），`maxHeight` 按显示屏决定：屏幕短边至少 1800 物理像素时为 2160，至少 1300 时为 1440，否则为 1080。没有这条路径、但能运行 canvas 引擎的浏览器（跨源隔离，并且有 WebCodecs 和 AudioWorklet）发送 `WEB_CANVAS_CAPABILITIES`：交付方式和编码与车的能力描述相同，最高 1080p。两个引擎都不能用的浏览器发送 `REMOTE_CAPABILITIES`（`renderer: "remote"`）：它能显示和控制播放，但自己从不播放。没有指定设备的播放请求，Hub 永远不会选中遥控器；Hub 也拒绝在遥控器上播放或把播放切到遥控器上（[Hub](2026-10-07-hub-and-realtime-channel.zh.md)）。

**只有 canvas 引擎能读的东西。**节点会调用 `@useyolo/core` 里的 `readsSplitFiles` 和 `waitsForLiveRunway`，二者只对 `canvas-webcodecs` 为真。没有分片索引的分离音视频文件，交给 canvas 引擎时是 `split-mp4`，交给其他渲染器时是 ffmpeg 合成的一路流；带有尚未发布分片预留区的直播播放列表只交给 canvas 引擎（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）。

## 曾考虑的替代方案

**写死成特斯拉的行为。** 浏览器和手机需要不同的格式和字幕处理方式，每个写死的选择以后都得找出来再改成通用的。

## 后果

新的屏幕类型就是一份新的能力描述，而不是对服务的修改。`external` 渲染器留给无法经过节点的媒体：Spotify 的音频有 DRM，也不允许转发，所以 Yolo 只能通过 Spotify Connect 控制它，由 Spotify 自己的设备播放（音乐不在 [1.0](../../proposed/feature/2026-10-11-yolo-1-0.zh.md) 范围内）。每个片源插件都必须遵守它拿到的能力描述，而且每个流由两层共同决定，所以画面不对可能出在插件的选择上，也可能出在节点的交付上；`stream_selected` 和 `stream_first_frame` 事件会把两者都报上来（[设备埋点](../feature/2026-10-11-device-telemetry.zh.md)）。
