# Agent Note: 设备埋点写入 Workers Logs

Status: implemented

[English](2026-10-11-device-telemetry.md) | 中文

## 问题

播放问题发生在车上——睡眠之后、弱网下、在一个不再表明自己身份的浏览器里——那里没人能打开开发者工具。早先家里的服务保存着播放器日志，这些日志也随那个服务一起没了。诊断故障需要设备自己视角下按顺序排列的事件，并和 Hub 的决策放在一起看，同时不把埋点存进 D1，也不把技术细节展示给正在观看的人。

## 决策

配对过的设备把自己的事件发到 `POST /v1/devices/self/events`（[`service/control/src/device-events.js`](../../../../service/control/src/device-events.js)），控制面把每个事件写成 **Workers Logs** 里的一行结构化日志，不写 D1。只接受设备凭据，设备 id 取自凭据，从不信任请求体。一行日志是 `{ kind: "device_event", userId, deviceId, pageId, sessionId, type, at, seq, receivedAt, …fields }`。

**限制。**每批最多 50 个事件、60 KiB；每个事件的字段最多 8 KiB，超出时先丢最大的字段，并在 `truncated` 里列出。每台设备每分钟最多 12 批（按 Worker 实例计，尽力而为），超出时返回 `429 rate_limited`。字段最多嵌套 5 层，数组最多 100 项，字符串最多 500 个字符。两端都会去掉敏感信息：键名含 token、authorization、cookie、ticket、secret、password、credential 的字段整个丢掉；字符串里的 `/m/<token>` 改成 `/m/<redacted>`，`ydt_…`、`Bearer …` 以及查询参数里的 `ticket`、`token`、`code` 也会遮掉。

**客户端**（[`clients/player/src/telemetry/device-events.js`](../../../../clients/player/src/telemetry/device-events.js)）最多每 10 秒发一批。离线时先缓存，最多 400 个事件，满了丢最旧的，并在下一批的 `dropped` 里报数。页面隐藏、`pagehide` 和 `freeze` 时，用 keepalive `fetch` 发出剩下的事件（`sendBeacon` 带不了设备凭据）。

| 事件 | 记录什么 |
|---|---|
| `health_heartbeat`、`mediabunny_state`（canvas 引擎）或 `native_video_state`（`<video>` 引擎）、`stall_start`、`playback_recovery_*` | 播放器的运行日志（[两个引擎](../architecture/2026-10-12-two-playback-engines.zh.md)）；`health_heartbeat.danmaku` 是弹幕层自上次心跳以来的绘制情况（[弹幕](2026-10-13-danmaku.zh.md#telemetry)）。在 canvas 引擎里，`health_heartbeat.buffer.hlsPlaylists` 描述每个 HLS 播放列表的预读：`name`（播放列表 URL 的最后一段路径，不含媒体令牌）、`current`（读取最后把它推到的分片）、`segments`、`scheduledThrough`（它最近一次预读窗口的终点；直播播放列表被新版本替换后为 null，直到下一次读取安排出窗口）、`ahead`（`current` 之后连续缓存的秒数），以及按状态计的任务数（`queued`、`pending`、`retry`、`failed`）；`hlsEvictions` 统计字节上限淘汰的分片：在各自播放列表位置及之前的（`behind`）、在它之后的（`ahead`），以及它们的 `bytes`；`hlsOrphanJobs` 统计不属于任何已知播放列表的任务。它们大约增加 350 字节（[canvas 引擎](../architecture/2026-04-04-canvas-playback-engine.zh.md)） |
| `realtime_open`、`realtime_close`（`code`、`reason`、`wasClean`）、`realtime_ticket_failed`、`realtime_welcome`、`realtime_probe` | 实时连接 |
| `stream_request_waited`、`stream_request_joined`、`stream_request_retry`、`stream_request_ok`、`stream_request_failed` | 流请求，带错误码和消息（[醒来时的请求顺序](../bug-fix/2026-10-11-wake-request-ordering.zh.md)） |
| `page_start`、`visibilitychange`、`pagehide`/`pageshow`、`freeze`/`resume`、`online`/`offline` | 页面生命周期 |
| `page_wake`、`wake_to_playback` | 一次醒来（`resume`、`pageshow`，或定时器晚到 20 秒以上），以及到画面重新走动所用的毫秒数 |
| `session_expired`、`resume_decision`（`why`：`playing`、`interrupted`、`paused`；`interruptedForMs`；`pausedHere`：Yolo 没听到的车主暂停） | 一次 `410`，以及页面回来时做出的决定（[进度和续播](2026-10-11-yolo-owns-progress-and-resume.zh.md)） |
| `hub_stream_rejoined`（`lost`、`seekTo`）、`hub_item_rejoined`（`lost`、`hubStatus`）、`hub_stream_rejoin_skipped`、`hub_item_rejoin_skipped` | welcome 里出现一条 `load` 随重连丢掉的流（屏幕上正在播的项目的，或另一个项目的），以及为替换它发出的请求；Yolo 拒绝了这个请求、屏幕上的流继续播时记为 skipped（[Hub 和实时通道](../architecture/2026-10-07-hub-and-realtime-channel.zh.md)） |
| `hub_missed`（`pause`、`resume`、`resumeHeld`、`seek`、`seekHeld`、`subtitles`、`kept`、`ended`、`idle`） | welcome 让屏幕补做或不做的、被失效连接拦下的事，只在有这样的事时记录：它从没处理过的暂停、继续或跳转（`resumeHeld`、`seekHeld`：因车主自己还没被听到的暂停或跳转而不做的继续或跳转；`kept`：针对留着的播放器），Hub 选的字幕，或重发的 `ended`、`idle`（[Hub 和实时通道](../architecture/2026-10-07-hub-and-realtime-channel.zh.md)） |
| `autoplay_result`（`sound`、`muted`、`blocked`；`userActivated`、`audioContextState`）、`audio_unlocked` | 不靠点击开始的播放有没有声音，以及静音播放了多久 |
| `stream_selected` | 每次加载或重建流：`reason`、播放它的 `engine`（`canvas` 或 `native`）、片源插件、交付方式、片源给出的宽、高、帧率、编码和码率、`formatId`、`maxVideoKbps`/`ceilingKbps`/`capped`、视口，以及路径：`network`（`lan`、`wan` 或 `relay`）、`mediaHost`（`lan` 和 `wan` 上监听端口的主机名）和 `original`（片源的原文件） |
| `stream_first_frame` | `engine`、解码器实际给出的画面尺寸和编码、画布尺寸（`<video>` 引擎报的是 `<video>` 元素的尺寸，字段为 `video`），以及它们和片源给出的是否一致；每个流一次，流内每次跳转后再一次，带 `seeks` |
| `quality_change_requested`、`quality_change_failed`、`bandwidth_insufficient`、`network_unstable` | [自适应码率](2026-10-11-adaptive-quality.zh.md)的决定，以及卡住 8 秒的原因（可用和需要的 kbps）；一个决定还带着最新吞吐样本的时间（`sampleAgeMs`）、当时有没有下载在进行（`downloading`）和条目剩下的秒数（`remainingSeconds`） |
| `playback_error_shown`、`playback_retry_requested` | 播放器放弃时的错误码和原文，以及用户本人的重试 |
| `media_probe`（`path`、`outcome`、`trigger`、`elapsedMs`、`permission`、`host`，在家里的公网地址上还有 `home` 和 `hairpin`）、`media_path`（`path`、`from`、`reason`、`probes`）、`media_path_fallback`（`from`、`to`、`code`、`message`、`position`） | [媒体路径](../architecture/2026-10-13-media-off-the-worker.zh.md)：每次探测节点局域网源或远程源的结果及失败原因，这块屏幕每次换路径时每次探测的结果，以及每个往下移到下一条路径的流（[局域网直连播放](2026-10-12-lan-direct-play.zh.md)列出了局域网的探测结果）；`hairpin`（`ok` 或 `failed`）说明路由器能否回环到家里的公网地址（[没有域名时的媒体](2026-10-13-no-domain-deployment.zh.md#media-without-a-domain)） |
| `display_scale`、`env` | [显示大小](2026-10-11-display-size.zh.md)生效之后的情况，以及浏览器本身（见下文） |

**`env` 事件**描述浏览器本身，每次加载页面发一次，实时连接重连后只在内容变化时再发；整个事件不超过 8 KiB（[`clients/player/src/telemetry/environment.js`](../../../../clients/player/src/telemetry/environment.js)）。它包含 user agent 和 `userAgentData`（brands、mobile、platform，以及 `getHighEntropyValues` 的 platformVersion、architecture、bitness、model、fullVersionList、wow64、formFactors）；屏幕和视口尺寸；`devicePixelRatio`；`(pointer: coarse)`、`(hover: none)` 和 `(display-mode: fullscreen)`；maxTouchPoints、hardwareConcurrency、deviceMemory 和 language；跨源隔离和 SharedArrayBuffer；MSE 和 WebCodecs 对 avc1、hevc、mp4a、opus 的支持；`<video>` 元素能提供什么（`nativeVideo`：它对原生 HLS 的回答，以及 `<video>` 引擎会用的 HLS 路径、编码、画中画、全屏和 AirPlay）；特斯拉指纹的得分明细（`tesla`，见[设备码配对](2026-10-07-device-code-pairing.zh.md)）；以及一个有上限的原生桥探测：window 上去掉标准名字之后剩下的全局名（最多 100 个）、已知桥接名（`qt`、`qt.webChannelTransport`、`cefQuery`、`chrome.webview`、`webkit.messageHandlers`、`external`、`tesla`、`QtCarBrowser`、`android`、`JSBridge` 等）的类型和键名，以及 `navigator` 上的非标准属性。探测只读名字、类型和键，从不调用找到的函数。从 2026.26 起，车机的 user agent 里不再有「Tesla」，收集这些数据就是为了设计识别它的方法。

**在屏幕上**，播放器不显示技术细节。从点按到画面动起来，屏幕显示这个条目自己的图片，稍微调暗，上面一个小转圈，没有文字；只有等待超过 8 秒，才多出一行安静的文字：Yolo 准备流时是「Connecting to the home server…」，流到了之后是「Still loading…」（[`loading.js`](../../../../clients/player/src/loading.js)）。跳转或卡顿时，画面上显示转圈；恢复时保留最后一帧画面，转圈在上面；放弃时只有一句话（「This video can't play right now.」）和 **Try again**、**Back** 两个按钮。同一浏览器最近一次播放的细节——选了哪个流、吞吐、缓冲、上限的变化、最后一个错误——存在 `localStorage` 的 `yolo.playback.diagnostics` 里，在 `/diag` 的「Last Playback」中查看。

### 查看日志

Workers Logs 已开启（`wrangler.jsonc` 的 `observability`），但不记调用日志：调用日志会记下每个请求的 URL，也就记下了 `/m/{token}/…` 里的媒体 token、realtime ticket 和配对码。仍然进入日志或 trace 的 URL 也会去掉查询字符串。在 Cloudflare 后台的 **Workers & Pages → yolo-control → Observability**（或账户级的 **Observability**）里查询。免费计划保留 3 天。Yolo 写以下几类结构化日志，每条都是 `console.log` 一个对象，字段可以直接筛选：

| `kind` | 谁写 | 内容 |
|---|---|---|
| `device_event` | `POST /v1/devices/self/events` | 每行一个设备事件：`deviceId`、`sessionId`、`pageId`、`type`、`at`（设备时间，毫秒）、`receivedAt`，以及事件自己的字段 |
| `hub` | Hub Durable Object | `event` 为 `socket_accept`、`socket_hello`、`socket_close`（带 `code`、`reason`、`wasClean`）、`state`（只在 `status`、`sessionId` 或 `deviceId` 变化时写，`cause` 说明原因，例如 `play:recovery`、`report`、`disconnect`）、`hello_wait`（设备的请求在等它自己的 hello，`outcome` 为 `hello` 或 `timeout`）、`device_error`（设备的消息，其中的媒体 token 和 ticket 已脱敏）、`decision`（`device_offline`、`node_offline`、`superseded`、`rate_limited`，带 `reason` 和 `why`）、`stream`（每次 prepare：请求的 `asked` 和节点实际提供的 `network`、`reason`、`deliveryType`、`maxVideoKbps`），`history_write_failed`（一次播放的历史记录没写成，带 `sourceKey` 和 `code`；流照常播放），或 `network`（设备关于其媒体路径的报告，带每次探测的结果） |
| `lan` | 局域网维护（cron trigger，或用户本人的检查） | `event` 为 `certificate`（`name`、`notAfter`）、`address_changed`（`from`、`to`）或 `error`（`step`、`message`、`failures`、`retryAt`） |
| `edge` | 远程名字的维护，带 `path: "wan"`（[媒体流离开 Worker](../architecture/2026-10-13-media-off-the-worker.zh.md)） | `event` 为 `certificate`、`address_changed`（`type`、`from`、`to`）、`cgnat`（`reason`）、`unreachable`（`reason`）、`off` 或 `error`（`step`、`message`、`failures`、`retryAt`） |
| `security` | 用户本人的设置 | `event` 为 `relay_mode`，带 `userId`、`from` 和 `to`（`auto`、`on` 或 `off`）；0.5 和 0.6 写的是 `relay_on` 和 `relay_off` |
| `frame` | `get_frame`、`get_storyboard` 及其 `/v1` 路由 | `event` 为 `served` 或 `storyboard_served`，带 `userId`：只记录送出了一帧或一张故事板，从不记录是哪个条目、哪个时间或哪个 agent（[视频画面](2026-10-13-video-frames.zh.md)） |

在 Observability 的搜索栏里写查询（Query Builder 的筛选器会与它同步）：

```text
kind = "device_event" AND deviceId = "dev_…"
kind = "device_event" AND type = "wake_to_playback"
kind = "device_event" AND (type = "session_expired" OR type = "stream_request_failed")
kind = "hub" AND event = "decision"
kind = "hub" AND deviceId = "dev_…" AND (event = "socket_close" OR event = "socket_hello" OR event = "state")
kind = "device_event" AND deviceId = "dev_…" AND (type = "media_probe" OR type = "media_path" OR type = "media_path_fallback" OR type = "stream_selected")
kind = "hub" AND event = "stream" AND deviceId = "dev_…"
kind = "lan"
```

`deviceId` 可以用 `list_devices` 或 `GET /v1/devices` 查到。排查车上的一次问题时，先按 `deviceId` 和时间范围筛 `device_event`，按 `at` 排序看设备那边的经过（`page_wake` → `realtime_close`/`realtime_open`/`realtime_welcome` → `session_expired` → `stream_request_*` → `wake_to_playback`），再看同一时间段的 `kind = "hub"`，了解 Hub 那边的连接和决策。`pageId` 每次加载页面都不同，可以用它区分刷新前后。

**日志量。**播放时设备大约每 30 秒有一条心跳，再加上状态变化和网络事件；Hub 只在状态变化时写日志，不为每 5 秒一次的 `report` 写。免费计划每天 20 万条日志事件（2026-12-01 起改为每天 0.5 GB）；媒体分片请求不写日志。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 后果

车上的一次故障，可以用设备按顺序排列的事件和 Hub 的决策重建出来，不需要任何额外的基础设施，而正在观看的人只会看到一个转圈或一句话。免费计划只保留 3 天埋点，所以出了问题要尽快排查。Cloudflare 不为 `/m/*` 的每个请求留日志，所以一个媒体请求只出现在设备的事件和节点自己的日志里。
