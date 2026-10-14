# Agent Note: 渲染到 canvas，不用 video 元素

Status: implemented

[English](2026-04-04-canvas-playback-engine.md) | 中文

## 问题

车辆行驶时，特斯拉浏览器可能会冻结原生 `<video>` 元素，车载播放器（给乘客用，或在停车时用）因此失效。播放器必须自己解码和呈现画面，在不依赖浏览器媒体管线的情况下保持音画同步，并且在移动网络下控制在车机浏览器的内存范围内。

## 决策

在车的 profile 下，客户端用 Mediabunny 和 WebCodecs 解码媒体，把每一帧画到 `<canvas>` 上（[`clients/player/src/engine/mediabunny-player.js`](../../../../clients/player/src/engine/mediabunny-player.js) 及同一目录下的辅助模块）。车机从不通过 `<video>` 播放。Yolo Web，也就是在电脑或手机浏览器里打开的同一个应用，改用浏览器自己的 `<video>` 元素播放，放在同一个引擎接口后面（[两个引擎](2026-10-12-two-playback-engines.zh.md)）。

- **音频时钟。** 解码后的 PCM 经过一个基于 `SharedArrayBuffer` 和 `Atomics` 的无锁环形缓冲区（[`audio-ring-buffer.js`](../../../../clients/player/src/engine/audio-ring-buffer.js)）：主线程写入采样，AudioWorklet 读出并播放，已播放的采样数就是整个播放器的时钟。因为时钟数的是采样，每个解码后的缓冲都按它的时间戳放置（[`audio-timeline.js`](../../../../clients/player/src/engine/audio-timeline.js)）：超过 20 ms 的空缺补成静音，重叠的部分裁掉，超过 10 秒的跳变直接重新对齐、不补静音，引擎把这些计为 `audioDiscontinuities`。没有音频的流，或音频提前结束的流，从同一位置改用墙上时钟继续。
- **跨源隔离。** 浏览器只允许跨源隔离的页面使用 `SharedArrayBuffer`，所以页面带 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: credentialless`：生产环境由 [`clients/player/public/_headers`](../../../../clients/player/public/_headers) 设置，开发时由 `clients/player/vite.config.js` 设置。少了这两个头，`mediabunny-player.js` 的 `load()` 会直接抛错，没有兜底方案。应用的每个页面都保留这两个头，Yolo Web 通过 `<video>` 播放的页面也一样，因为页面要加载之后才知道自己的 profile。客户端与 `/m/*`、`/v1/realtime` 同源，所以媒体响应不需要 CORP（[同源透传](2026-10-07-same-origin-media-passthrough.zh.md)）；唯一的另一个媒体源，即节点的局域网监听端口，回答时带 CORS 和 `Cross-Origin-Resource-Policy: cross-origin`（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。
- **内存有上限。** 解码后的视频队列保留 6 到 16 帧，按约 0.2 秒确定容量。网络抖动改由缓冲编码后的分片来吸收：HLS 预取器在 128 MiB 以内最多提前缓冲 210 秒。
- **起播要快。** 缓冲到 3 秒编码媒体就开始播放，跳转后也一样；画面动起来之后，预取器继续向目标缓冲（[`playback-buffer-policy.js`](../../../../clients/player/src/engine/playback-buffer-policy.js)）。播放中卡顿时，如果缓冲里还有媒体（例如解码器一时跟不上），帧一解码出来就继续；如果网络缓冲已经空了，就等缓冲到 5 秒，免得跟不上码率的连接马上又卡住。
- **提前打开音频设备。** 页面创建的第一个 AudioContext 会打开系统的音频输出，这会让页面卡住最多 2 秒（macOS 上的 Chrome 实测 1.8 秒）。页面的第一次点按会在这次点按自己的处理程序跑完之后再打开它（[`audio-output.js`](../../../../clients/player/src/audio-output.js)）：点按要播放时，请求先发出去，Yolo 准备流的同时设备打开。`<video>` 引擎不需要 AudioContext。
- **单路预取。** HLS 预取器一次只取一个分片，所以后台缓冲从不和播放器当下需要的分片争抢。
- **保留播放位置。** 切换清晰度或视口时，在当前位置替换流。
- **有界重试。** 一个持续失败的分片会结束这条流，而不是被无休止地重试。HLS 预取器对一个分片只重试有限次数。之后遇到 403、410 或重试次数已用完的分片，Mediabunny 立即放弃；其他错误（例如网络错误，或被一次跳转取消的下载）再试三次后放弃。`player.js` 在同一位置请求一条新的流来恢复，局域网失败后改走隧道；来源回答 403 时显示为错误。

## 曾考虑的替代方案

**原生 `<video>` 元素。** 车辆行驶时它会被冻结，而这正是本项目要解决的问题。

**15 秒的起播缓冲**，引擎最早的规则，起播、跳转和卡顿都用它。在 10 Mbit/s 的连接上播 720p 流时，第一帧解码出来之后画面还要静止 5 秒；在刚好够这个码率的连接上要 20 秒以上，长到[自适应清晰度](../feature/2026-10-11-adaptive-quality.zh.md)把这段等待当成卡顿，在流还没播起来时就重建了它（2026-10-14 实测）。让车开过信号盲区的是 210 秒的目标缓冲，而不是起播门槛。

**libmedia 的 AVPlayer**（WebAssembly 解码加 WebGL 渲染），播放器最早用的就是它，它同样需要 `SharedArrayBuffer`。2026-07-13 改用 Mediabunny 和浏览器的 WebCodecs 解码器替换了它；这次变更没有记录更多理由。

## 后果

车辆行驶时也能播放，代价是要自己承担 `<video>` 元素原本负责的事：解封装、音频输出、音画同步、缓冲和恢复。跨源隔离是永久性的：COOP 会切断页面与它打开的任何弹窗之间的联系，所以播放器页面不能用弹窗方式登录，屏幕改用扫码配对（[设备码配对](../feature/2026-10-07-device-code-pairing.zh.md)）。每个媒体响应都必须来自播放器所在的源，或者带上 CORS 和 CORP 头，而只有节点的局域网监听端口会这样做（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。去掉 COOP/COEP 头，或把客户端移到与 `/m/*` 不同的源，都会让播放直接失败。
