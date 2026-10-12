# Agent Note: 渲染到 canvas，不用 video 元素

Status: implemented

[English](2026-04-04-canvas-playback-engine.md) | 中文

## 问题

车辆行驶时，特斯拉浏览器可能会冻结原生 `<video>` 元素，车载播放器（给乘客用，或在停车时用）因此失效。播放器必须自己解码和呈现画面，在不依赖浏览器媒体管线的情况下保持音画同步，并且在移动网络下控制在车机浏览器的内存范围内。

## 决策

特斯拉客户端用 Mediabunny 和 WebCodecs 解码媒体，把每一帧画到 `<canvas>` 上（[`clients/tesla/src/engine/`](../../../../clients/tesla/src/engine/)）。它从不通过 `<video>` 播放。

- **音频时钟。** 解码后的 PCM 经过一个基于 `SharedArrayBuffer` 和 `Atomics` 的无锁环形缓冲区（[`audio-ring-buffer.js`](../../../../clients/tesla/src/engine/audio-ring-buffer.js)）：主线程写入采样，AudioWorklet 读出并播放，已播放的采样数就是整个播放器的时钟。没有音频的流，或音频提前结束的流，从同一位置改用墙上时钟继续。
- **跨源隔离。** 浏览器只允许跨源隔离的页面使用 `SharedArrayBuffer`，所以页面带 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: credentialless`：生产环境由 [`clients/tesla/public/_headers`](../../../../clients/tesla/public/_headers) 设置，开发时由 `clients/tesla/vite.config.js` 设置。少了这两个头，`mediabunny-player.js` 的 `load()` 会直接抛错，没有兜底方案。客户端与 `/m/*`、`/v1/realtime` 同源，所以媒体响应不需要 CORP（[同源透传](2026-10-07-same-origin-media-passthrough.zh.md)）。
- **内存有上限。** 解码后的视频队列保留 6 到 16 帧，按约 0.2 秒确定容量。网络抖动改由缓冲编码后的分片来吸收：HLS 预取器在 128 MiB 以内最多提前缓冲 210 秒。
- **单路预取。** HLS 预取器一次只取一个分片，所以后台缓冲从不和播放器当下需要的分片争抢。
- **保留播放位置。** 切换清晰度或视口时，在当前位置替换流。

## 曾考虑的替代方案

**原生 `<video>` 元素。** 车辆行驶时它会被冻结，而这正是本项目要解决的问题。

**libmedia 的 AVPlayer**（WebAssembly 解码加 WebGL 渲染），Drive-In 最早用的就是它，它同样需要 `SharedArrayBuffer`。2026-07-13 改用 Mediabunny 和浏览器的 WebCodecs 解码器替换了它；这次变更没有记录更多理由。

## 后果

车辆行驶时也能播放，代价是要自己承担 `<video>` 元素原本负责的事：解封装、音频输出、音画同步、缓冲和恢复。跨源隔离是永久性的：COOP 会切断页面与它打开的任何弹窗之间的联系，所以播放器页面不能用弹窗方式登录，屏幕改用扫码配对（[设备码配对](../feature/2026-10-07-device-code-pairing.zh.md)）。每个媒体响应都必须来自播放器所在的源。去掉 COOP/COEP 头，或把客户端移到与 `/m/*` 不同的源，都会让播放直接失败。
