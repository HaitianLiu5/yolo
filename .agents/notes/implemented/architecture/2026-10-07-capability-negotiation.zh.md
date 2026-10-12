# Agent Note: 设备按能力描述协商播放方式

Status: implemented

[English](2026-10-07-capability-negotiation.md) | 中文

## 问题

Drive-In 的服务是为一个播放器写的：特斯拉 canvas 播放器。普通浏览器、手机或电视需要不同的格式、编码、分辨率和字幕处理方式，而写死成特斯拉的格式选择散落在各处，以后都得一个个拆出来。

## 决策

每台设备在 `hello` 消息里声明自己的**能力描述**，播放方式据此协商；特斯拉 canvas 播放器只是其中一份能力描述（[`service/core/src/capabilities.js`](../../../../service/core/src/capabilities.js)）：

```js
{
  renderer: "canvas-webcodecs" | "html5-video" | "native" | "external",
  delivery: ["hls", "mp4"],
  video: ["avc1", "hvc1", "av01", "vp09"],   // preferred first
  audio: ["mp4a", "opus"],
  maxHeight: 720,
  subtitles: "client-vtt" | "native-vtt" | "burn-in",
  audioOnly: false,
}
```

设备在每条 `report` 里上报自己的**视口**；Hub 记下每台设备最近的视口，在下次 `prepare` 时交给节点。特斯拉客户端上报的是物理像素（`devicePixelRatio: 1`）：它的[显示大小](../feature/2026-10-11-display-size.zh.md)会改变 CSS 视口，但不能让 Yolo 以为屏幕变大了。切换清晰度或视口时保留播放位置。

协商分两层。片源插件的 `prepare(source, context)` 拿到能力描述、视口、起播位置和选轨函数，决定从上游取什么；然后节点的媒体管线把这个 Input 变成设备能读的交付方式，全部在同源的 `/m/{token}/…` 下（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）。字幕也按这两层分工：文本字幕以 WebVTT 交付，由设备绘制，可以同时显示几条；图片字幕由片源烧录进画面，选它会重建会话。

**特斯拉的能力描述就是 Drive-In 一直以来的行为**（`@useyolo/core` 里的 `TESLA_CANVAS_CAPABILITIES`）：播放器只接收 `hls` 和 `mp4` 两种交付方式，用 canvas 和 WebCodecs 渲染（`avc1` 视频、`mp4a` 音频、720p）；分离的音视频先拼成 fMP4 HLS 再交给它；Plex 固定转码成 720p；文本字幕在浏览器里绘制，图片字幕由 Plex 烧录进画面。普通浏览器或手机是另一份能力描述，插件和节点据此选择格式、码率和字幕处理方式。

## 曾考虑的替代方案

**写死成特斯拉的行为。** 浏览器和手机需要不同的格式和字幕处理方式，每个写死的选择以后都得找出来再改成通用的。

## 后果

新的屏幕类型就是一份新的能力描述，而不是对服务的修改。`external` 渲染器留给无法经过节点的媒体：Spotify 的音频有 DRM，也不允许转发，所以 Yolo 只能通过 Spotify Connect 控制它，由 Spotify 自己的设备播放（音乐不在 [1.0](../../proposed/feature/2026-10-11-yolo-1-0.zh.md) 范围内）。每个片源插件都必须遵守它拿到的能力描述，而且每个流由两层共同决定，所以画面不对可能出在插件的选择上，也可能出在节点的交付上；`stream_selected` 和 `stream_first_frame` 事件会把两者都报上来（[设备埋点](../feature/2026-10-11-device-telemetry.zh.md)）。
