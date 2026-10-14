# Agent Note: agent 能看到视频的画面

Status: implemented

[English](2026-10-13-video-frames.md) | 中文

## 问题

agent 能播放、控制视频，却看不到画面。要回答「屏幕上现在是什么」或「12:34 发生了什么」，用户只能拍下车里的屏幕，再把照片发给 agent。agent 需要的是某一时刻的视频画面，由 Yolo 直接给出，不用用户动手；还需要一种不必一张张要几十幅画面就能浏览整部视频的办法。

## 决策

MCP 工具 `get_frame` 和 `GET /v1/frame` 返回视频某一时刻的一张 JPEG，`get_storyboard` 和 `GET /v1/storyboard` 返回由均匀分布的多个时刻排成网格的一张 JPEG（[故事板](#storyboards)）。画面由媒体节点从片源读取，读法和串流这个条目时一样；不经过任何屏幕，所以所有屏幕都休眠时也能取，没在播放的条目也能取。

### agent 传什么

| 参数 | 含义 |
|---|---|
| `time` | 秒数、`"mm:ss"` 或 `"hh:mm:ss"`，可带小数（core 的 `parseTimestamp`，见 [`service/core/src/timestamp.js`](../../../../service/core/src/timestamp.js)）。不传时，用 Hub 对正在播放条目的位置，按 Hub 的方式推算（`currentPosition`），并保持在结尾前一秒以内 |
| `item_id` | 要取画面的条目，片库条目 id 或网址；不传时，用 Hub 当前持有的条目，无论在播放还是暂停。别的条目必须带 `time` |
| `width` | 最大宽度，160 到 1920 像素，默认 1280。画面同时限制在这个边长的正方形内，保持宽高比，绝不放大 |

工具返回一个 MCP 图片内容块（`image/jpeg`）和一个文本块：标题、实际使用的时间（`h:mm:ss.mmm` 和秒数，附条目时长）、片源插件和画面从哪里读出、画面尺寸，以及这个条目是不是正在播放。`/v1/frame?source=&time=&width=` 返回 JPEG，并带响应头 `x-yolo-frame-time`、`x-yolo-frame-title`（URI 编码）、`x-yolo-frame-source` 和 `x-yolo-frame-input`。两者都需要 `read` scope。

### 节点怎样读一帧

Worker 通过 `nodeFetch()` 调用 `POST /internal/v1/frame`，参数是 `{ source, time, width, sessionId }`；条目正是 Hub 当前在播的那个时，才带 `sessionId`。节点（[`service/node/src/media/frames.js`](../../../../service/node/src/media/frames.js)）按下面的顺序读：

1. **正在播放的会话自己的数据**（[`pipeline.js`](../../../../service/node/src/media/pipeline.js) 的 `frameSource`）。分离音视频流在 `time` 处的视频分段已在磁盘缓存里时，ffmpeg 用会话探测时留下的初始化分段解码它，所以屏幕此刻显示的画面不需要任何上游请求。否则 ffmpeg 读会话的 Input，用的是会话现在使用的 URL（经过 `refresh()` 之后的）。边播边转码的片源（`transcoder: true`）跳过这一步：它的分段只在设备播放位置附近存在。
2. **重新 `prepare()`**，带 `reason: "frame"`（[片源插件 API](../architecture/2026-10-11-source-plugin-api.zh.md)）：`startTime` 是取画面的时间；`network` 是 `"lan"`，`playable()` 对任何文件都答 `direct`，因为是节点自己读，ffmpeg 能解任何封装；`chooseTracks()` 不选字幕；能力声明要的画面高度大致够 `width` 用。画面读完马上调用片源的 `stop()`；`prepare()` 超时后才完成时也照样调用。
3. **ffmpeg** 在打开输入之前定位（`-ss` 放在 `-i` 前面，精确到帧），带上 Input 的请求头，用 `-frames:v 1` 解出一帧，缩放，转成全范围 YUV，编码为 JPEG。`file` Input 读它的 URL，`split` Input 读视频轨，`hls` Input 读播放列表；遇到主播放列表时，节点选宽度不小于 `width` 的最小变体，没有就选最大的。

官方 Plex 插件对 `reason: "frame"` 返回家庭网络里这个 part 的原始文件：不启动转码，不转换字幕，Plex 里这个 part 的音轨和字幕选择保持用户原来的设置。yt-dlp 插件跳过字幕查询，格式照常选择。不认识这个 reason 的插件把它当作一次播放处理，返回的 Input 照样能用。

<a id="storyboards"></a>

### 故事板

`get_storyboard` 让 agent 一次调用就能浏览一部视频（[`frames.js`](../../../../service/node/src/media/frames.js)、[`storyboard-image.js`](../../../../service/node/src/media/storyboard-image.js)）。参数是 `item_id`，即条目 id 或网址（默认是正在播放的条目）、`from` 和 `to`（默认是整个条目）、`count`（2 到 30，默认 12），以及 `width`，即每张小图的宽度（80 到 480，默认 320）。小图取的是范围平分成 `count` 段后每段的中点，所以既不会出现开头的黑帧，也不会取到最末尾；它们排成大约 16:9 的网格，每张在变暗的方框里用白字标出时间。标签由节点用内置的 5×7 数字字体绘制，不需要字体文件，也不需要 ffmpeg 的文字滤镜。返回结果列出各小图的时间；读不出的小图保持黑色，并列为缺失。

小图来自两处之一：

1. **片源自己的故事板图片**：插件实现了 `storyboard(source)` 并返回了拼图时使用（[片源插件 API](../architecture/2026-10-11-source-plugin-api.zh.md)）。每张拼图由 `columns` × `rows` 张缩略图组成，覆盖从 `start` 起的 `duration` 秒，每隔 `interval` 秒一张。节点把需要的每张拼图只下载一次（每张最多 4 MiB），为每个时间切下最近的那张小图，并标上这张小图自己的时间。这样完全不用读取视频。yt-dlp 插件在 yt-dlp 把网站的故事板拼图列为格式时提供它们，选尺寸最大的一组。片源的故事板最多等 10 秒，失败或一张小图都没给出时改为读取画面。
2. **节点读取的画面**，和 `get_frame` 的读法一样（先用正在播放的会话的数据，否则用带 `reason: "frame"` 的 `prepare()`），同时读 3 张，每张都在准确的时间。

### 限制

| 限制 | 数值 | 位置 |
|---|---|---|
| 时间 | 节点上 `prepare()` 和 ffmpeg 合计 15 秒，故事板 30 秒；Worker 分别等 18 秒和 36 秒 | `frames.js` 和 `services.js` 的 `FRAME_TIMEOUT_MS` 和 `STORYBOARD_TIMEOUT_MS` |
| 上游读取卡住 | 8 秒（`-rw_timeout`） | `frames.js` |
| 图片 | 最大 1.5 MiB，故事板 2 MiB：JPEG 质量 3，超出时用 9 重新编码 | `MAX_FRAME_BYTES`、`MAX_STORYBOARD_BYTES` |
| 同时进行 | 节点上同时 2 个取帧或故事板请求；第 3 个立刻得到 `rate_limited`，不排队。一张故事板同时读 3 帧 | `MAX_FRAME_REQUESTS`、`TILE_CONCURRENCY` |
| 每个 agent | 每分钟 20 帧和 20 张故事板，由 `FRAME_LIMIT` 限流绑定按用户加 OAuth 客户端计数，配对设备则按设备计数；没有这个绑定时，按 Worker 的 isolate 各自计数 | [`rate-limit.js`](../../../../service/control/src/rate-limit.js) 的 `frameLimiter` |

### 错误

| 情况 | 错误码 |
|---|---|
| 没有在播放，也没指定条目 | `invalid_request` |
| 别的条目没带 `time`，或 `time` 既不是秒数也不是时钟格式 | `invalid_request` |
| `time` 超过结尾 | `invalid_request`，并说出条目时长 |
| 条目时长未知却没带 `to` 的故事板，或 `to` 早于 `from` | `invalid_request` |
| 直播流，没有固定的画面 | `invalid_request` |
| 节点连不上 | `node_offline` |
| 节点版本还不支持取帧 | `not_found`，提示升级节点 |
| 片源拒绝、ffmpeg 没找到画面，或超过 15 秒 | `resolve_failed` |
| 超过限制 | `rate_limited` |

### 隐私

- **Scope。** 一帧画面是对用户自己片库和播放的读取，和 `search`、`list_tracks`、`get_status` 一样，所以需要 `read`，而所有现有授权都有 `read`：agent 不用重新授权就能用 `get_frame`。授权页把 `read` 描述为「What's playing, your library and history, and pictures from your videos」（[`auth/pages.js`](../../../../service/control/src/auth/pages.js)），不想让 agent 看到画面的用户在那里关掉 `read`。
- **不保存任何东西。** JPEG 只经过节点和 Worker 的内存，随响应离开；`/v1` 上标 `no-store`。ffmpeg 从网络或管道读取，不往磁盘写。
- **日志只记「送出了一帧」。** Worker 往 Workers Logs 写 `{ kind: "frame", event: "served", userId }`（故事板写 `storyboard_served`），不含条目、时间或 agent（[设备遥测](2026-10-11-device-telemetry.zh.md)）。ffmpeg 的错误输出可能带签名的上游 URL，所以节点只用它判断错误类型，从不记录或返回它。

## 曾考虑的替代方案

**截取屏幕显示的内容。** 屏幕是一个浏览器页面，不弹出权限提示、不经点击就无法截取显示内容（`getDisplayMedia`）。截取 Yolo 自己的页面，要么在车里的浏览器里把页面 DOM 渲染成图片，要么把 DOM 快照发给节点用无头浏览器渲染；还要每块屏幕一个同意开关，每次截取时显示提示。它只在那块屏幕醒着时可用，也只能拍到屏幕此刻显示的内容。从片源取帧既能回答「屏幕上现在是什么」，也能回答「12:34 发生了什么」，不需要屏幕，也不需要屏幕端的同意。代价是看不到播放器的控件和字幕，也看不到屏幕自己出的问题，比如画面卡住。

**为取帧新增一个 scope。** 画面是用户自己的视频，`read` 本来就能列出、描述这些视频并给出缩略图；新增 scope 会让每个已连接的 agent 为一个只读工具重新授权。代价是用户无法只授权读取状态而不授权取帧。

**通过节点自己的 `/m/*` URL 读取。** 每取一帧都要开一个管线会话，可以复用会话的缓存和故障切换，但会占用节点的会话上限，而超限时会让最早的会话退役，可能正是在播放的那个；分离 Input 的会话还要先探测两个文件。直接对 Input 运行一个 ffmpeg 进程读得更少，而正在播放的会话已缓存的分段照样能用上。

**单帧画面用片源自己的静态图片。** 有些服务器按固定间隔生成缩略图或索引图片，但不是每个片源都有，尺寸也小，还无法对应精确的时间；Input 对每个片源都适用。故事板不一样：它的小图本来就小，只需接近各自的时间，所以那里优先用片源自己的图片，读取画面作为后备。

**故事板总是读取画面。** 每张小图都要在视频里定位一次：从片源服务器读索引和一个关键帧间隔的数据，最多 30 张就要读 30 次。网站的故事板拼图用几张小图片就覆盖了整部视频。

**用 ffmpeg 画标签。** ffmpeg 的 `drawtext` 滤镜需要字体文件，而字体路径因系统而异，还要求 ffmpeg 编译时带 FreeType。节点自带的数字字体只有几行代码，在哪里都一样。

## 后果

agent 一次调用就能看到正在播放的画面，或任意条目任意时刻的画面，再一次调用就能浏览整个条目，用户不再需要拍屏幕。用片源自己的图片拼成的故事板显示的是片源手头最近的小图，可能和均匀间隔差几秒，返回的时间会如实标出。画面来自片源而不是屏幕：没有播放器控件和字幕，也看不到屏幕上发生的卡顿或解码错误。给没在播放的条目取帧要做一次 `prepare()`，有些片源要几秒钟，还要从上游读一个关键帧间隔的数据。所有带 `read` 的 agent 都能看到用户视频的画面。`FRAME_LIMIT` 绑定写在 Worker 模板里，部署一次 Worker 就会带上；节点需要重启才能提供 `/internal/v1/frame`。
