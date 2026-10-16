# Agent Note: 节点的媒体管线与片源 Input

Status: implemented

[English](2026-10-11-node-media-pipeline.md) | 中文

## 问题

早先的单进程服务把具体服务商的逻辑和媒体交付混在一起：Plex 和 yt-dlp 的代码各自用自己的方式代理字节范围、改写 HLS 清单、拼接分离的音视频、缓存分片。片源迁到[插件](2026-10-11-plugin-architecture.zh.md)之后，如果不改，每个插件都得重新实现 HTTP 服务、缓存、过期和设备处理，而且每个插件都要能看到设备和媒体 token。

## 决策

媒体管线放在节点核心里（[`service/node/src/media/`](../../../../service/node/src/media/)），所有内容都在 `/m/{token}/…` 下提供，既经控制面的[同源透传](2026-10-07-same-origin-media-passthrough.zh.md)，也在节点的局域网监听端口上（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。片源插件只**描述自己的输入**：`prepare(source, context)` 说明从哪里读、怎么读，从不碰 HTTP 服务、缓存或设备。`cache.js` 是磁盘分片缓存，`hls.js` 和 `dash.js` 是播放列表变换，`transcode.js` 是 ffmpeg 兜底，`upstream.js` 负责有上限的上游请求，`hedge.js` 跨多个镜像 URL 对冲读取一段字节范围，`hosts.js` 记住节点对每个上游主机的体验，`playable.js` 是 prepare 上下文里的 `playable()`。

### prepare

```js
yolo.registerSource("example", {
  claim: (url) => ({ id: url, url }),
  async prepare(source, { capabilities, startTime, limits, chooseTracks }) {
    const media = await lookUp(source.url, { maxHeight: capabilities.maxHeight, maxKbps: limits.maxVideoKbps });
    const subtitles = media.captions.map((caption) => ({
      id: `sub_${caption.lang}`, kind: "subtitle", language: caption.lang, name: caption.label, format: "text", delivery: "vtt",
    }));
    const selected = chooseTracks({ subtitles, audio: [] });
    return {
      title: media.title,
      duration: media.seconds,
      startTime: startTime ?? 0,              // null: Yolo has no position; the source decides
      input: { type: "hls", url: media.playlistUrl, headers: { Referer: "https://video.example/" } },
      tracks: { subtitles, audio: [], selected },
      subtitle: async (id) => fetchVtt(media, id),     // WebVTT text
      refresh: async () => ({ type: "hls", url: (await lookUp(source.url)).playlistUrl }),
    };
  },
});
```

| context 字段 | 说明 |
|---|---|
| `capabilities` | 要播放的设备的[能力描述](2026-10-07-capability-negotiation.zh.md)：`maxHeight`、偏好的 `video`/`audio` 编码、`delivery`、`containers`、`subtitles`。特斯拉是 720p，`avc1`/`mp4a` 优先 |
| `viewport` | 设备最近上报的视口，可能是 `null` |
| `startTime` | 从哪里开始；**`null` 表示 Yolo 没有这个条目的进度**，片源用自己的进度（Plex 的 `viewOffset`），没有就从 0 开始 |
| `reason` | `play`、`recovery`、`seek`、`quality`、`transfer`、`tracks`，或 `frame`：没有设备播放，由节点自己读取 `startTime` 处的一帧画面（[视频画面](../feature/2026-10-13-video-frames.zh.md)） |
| `limits` | `{ maxVideoKbps }`：节点为这条媒体路径设的上限（局域网上是 `LAN_MAX_VIDEO_KBPS`，默认 200,000；远程直连播放上是 `WAN_MAX_VIDEO_KBPS`，默认 20,000；中继上是 `STREAM_MAX_VIDEO_BITRATE_KBPS`，默认 4800），设备的[自适应上限](../feature/2026-10-11-adaptive-quality.zh.md)更低时取更低的那个，最低 200 kbps。片源据此选择格式或转码码率；一个格式都放不下时选最小的那个，而不是最好的 |
| `network` | 设备从节点的局域网监听端口播放时为 `"lan"`，这时原文件可能原样播放；否则为 `"tunnel"`，用于所有要经过家里上行带宽的路径：远程直连或中转（[媒体流离开 Worker](2026-10-13-media-off-the-worker.zh.md)） |
| `playable(media)` | 设备能否原样播放某个文件：根据不涉及服务商的 `{ container, video, audio, kbps }` 回答 `{ decision: "direct" \| "remux" \| "audio" \| "transcode", reasons }`（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)） |
| `chooseTracks({ subtitles, audio })` | 按用户明确的选择，否则按保存的偏好（这个条目的，或最近一次的），返回 `{ subtitles: [id…], audio: id \| null }`；`audio: null` 表示片源的默认音轨 |

| 流描述字段 | 说明 |
|---|---|
| `input` | 从哪里读（必填），见下文 |
| `title`、`duration`（秒）、`isLive`、`thumbnail` 或 `artwork` | 同 `describe` |
| `startTime` | 设备实际从哪里开始，默认 0 |
| `profile` | `{ width, height, fps, videoKbps, audioKbps, split }`，设备用来判断带宽够不够 |
| `maxVideoKbps` | 片源选格式时用的、比 `limits.maxVideoKbps` 更低的上限，例如因为它测到上游很慢；流随后以这个上限报告 `limits.capped: true`，设备的[自适应画质](../feature/2026-10-11-adaptive-quality.zh.md)可以从这里往上升 |
| `tracks` | `{ subtitles, audio, selected }`；每条字幕的 `delivery` 是 `vtt`（交给设备渲染，可以同时显示几条）或 `burn`（由片源画进画面；选它会重建会话） |
| `subtitle(trackId)` | 一条 `vtt` 字幕的 WebVTT 文本；还在准备时返回 `{ pending: true, retryAfter }`；网站限制它的下载时抛出带 `details.retryAfter`（秒）的 `rate_limited` |
| `refresh()` | 上游链接过期时（快到 `expire` 参数的时间，或被拒 403）返回新的 `input`；Yolo 按角色替换链接，30 秒内最多一次。一个请求被拒时，如果它开始之后已有一次刷新换掉了它用的链接，就用新链接再请求一次，在这 30 秒内也一样 |
| `health()` | 上游会话是否还在：`alive`、`expired` 或 `unknown`。对 `input.transcoder`，分片缺失时会问它；`expired` 时 Yolo 返回 `410 SESSION_EXPIRED`，设备重建会话 |
| `progress({ position, duration, status })` | 播放进度，大约每 30 秒和每次状态变化时一次，片源可以写回自己的进度 |
| `stop()` | 会话结束时释放上游资源（例如停止转码）；可能被调用多次 |

`prepare` 可以慢（yt-dlp 加上探测要几十秒），但必须可以重复调用：恢复、跳到流开始之前和换音轨都会再调一次。插件不知道是哪台设备在播，也拿不到媒体 token。

### Input 与交付方式

| Input | 字段 | 交给设备的方式 | 节点做什么 |
|---|---|---|---|
| `file` | `url`、`headers?`、`cacheKey?`、`cache?`、`alternates?` | `{ type: "mp4", url }` | 按字节范围代理渐进式文件（MP4、WebM），写入磁盘缓存 |
| `hls` | `url`、`headers?`、`cacheKey?`、`cache?`、`manifest?`、`maxBandwidth?`、`trimToStart?`、`transcoder?`、`live?` | `{ type: "hls", url }` | 改写清单里的每个 URI，经节点代理分片。`manifest` 是片源已经取到的主清单（再取一次可能又起一个转码）；`maxBandwidth`（bit/s）去掉更大的变体，设备的 `maxHeight` 也去掉更高的变体（`RESOLUTION` 高于它），因为播放器会取给它的最好变体，canvas 引擎总是如此；全部超过时留最小的那个；`trimToStart` 裁掉 `EXT-X-START` 之前的占位分片；`transcoder` 表示上游分片可能还没生成，Yolo 会短暂重试并问 `health()`；`cache: false` 不进磁盘缓存；`live.parse(body)` 把直播 DVR 播放列表解析成按序号寻址的索引，提供一个有界的直播窗口：对 canvas 引擎，窗口围绕播放游标，并带一段尚未发布分片的预留区；对其他播放器，窗口以最新的分片结尾，往回覆盖 5 分钟 |
| `split` | `video` 和 `audio`，各有 `url`、`headers?`、`cacheKey?`、`codec?`、`width?`、`height?`、`fps?`、`kbps?`、`alternates?`；`transcode?` | `{ type: "hls", url }`：分片是原文件字节范围的 fMP4 HLS；没有 `sidx` 时，对 canvas 引擎为 `{ type: "split-mp4", videoUrl, audioUrl }`，对其他播放器为 ffmpeg 输出的 HLS；转码时为 ffmpeg 输出的 HLS | 同时探测两个文件的 MP4 结构、生成播放列表，按[分片读取](#segment-reads)所述读取每个分片，字节一到就流式交给设备，校验分片完整性并预取；`transcode: true` 或节点设置了 `DASH_TRANSCODE=1` 时使用 ffmpeg |

`headers` 跟着这个 input 的每个上游请求，包括 HLS 子播放列表和分片。`cacheKey(url)` 说明上游 URL 背后是什么内容，所以签名不同但指向同一文件的 CDN 链接可以共用节点的磁盘缓存；拿不准时返回 `null`，Yolo 用 URL 本身，并在标识后面加上字节范围。一个缓存条目要么完整出现，要么不出现：它的字节先写进一个临时文件，改名到位之后才写它的描述；失败的、被放弃的、或者长度与 `Content-Length` 不符的响应体都不保留。同一时间只有一个请求写同一个条目；这期间对同一条目的另一个请求直接读上游，不写缓存。

`alternates`（`file` 和 `split` 的每一路都可以有）是同一份字节的其他 URL，例如同一个签名链接在 CDN 其他镜像主机上的地址，排列顺序是节点没有更好依据时的尝试顺序。节点按最近对每个主机的体验给它们排序，跨会话、跨资源共用（`hosts.js`）：一次故障（出错、连接被重置、响应体不完整，或者某次尝试卡住或太慢、输给了对冲请求）会让这个主机排到后面，故障分数每 3 分钟减半，所以一次故障大约降级 3 分钟，反复故障降级更久；故障数相同的主机里，对同一个文件测得更快的排在前面，因为边缘缓存可能对一个文件很快、对下一个文件却是冷的（相差 25% 以内视为相同；还没对这个文件测过的主机按最快的那个算，所以新文件沿用给定的顺序）。节点不按名字偏好任何主机，因为镜像的好坏随时段和字节范围变化。`split` 的分片和探测在排好序的 URL 之间用对冲请求读取（[分片读取](#segment-reads)）；`file` 请求在某个 URL 出错或 6 秒内没有响应头时，**在同一次设备请求里**换到下一个 URL。只有所有 URL 都拒绝了请求，节点才退回 `refresh()`。

官方 yt-dlp 插件为 Bilibili 的 upos 链接使用 `alternates`。候选是 yt-dlp 给的 URL、同一路径和查询参数在 `upos-sz-mirrorcosov`、`upos-sz-mirrorali`、`upos-sz-mirrorhw` 上的地址，以及 yt-dlp 列出的备用链接。为 Akamai 主机（`upos-*.akamaized.net`）签名的 URL 这些镜像也能提供，但 Akamai 拒绝为 bilivideo 主机签名的 URL，所以从不加入 Akamai。`prepare` 在文件里播放开始的位置用 512 KB 的范围请求并行探测这些候选（最多 3 秒；最快的一个完成后，其余的再等一半时间，至少 300 毫秒），按整个探测期间的吞吐排序，最快的作为 `url`，其余作为 `alternates`。最快的那个的探测速率（含等待首字节的时间）低于所选视频加音频码率时，播放、恢复、跳转、转移或换轨会改从同编码里放得下的最好的更小视频格式开始（都放不下就用最小的），并用流描述的 `maxVideoKbps` 说明；设备自己升画质（`reason: "quality"`）和 `refresh()` 保持原格式。

<a id="segment-reads"></a>

### 分片读取

`hedge.js` 从排好序的 URL 读取一段字节范围，每个字节一到就交给所有读取者，所以设备等到第一个字节的时间是上游的首字节时间，而不是整个分片的下载时间。每个分片只有一次读取，由设备的请求、它的重试和节点的预读共用，读完的分片进入磁盘缓存。一次尝试从还没收到的第一个字节读起；下一个 URL 上的新尝试从这个偏移开始，和正在进行的尝试赛跑，先读到末尾的那个完成分片，另一个被取消。

这些阈值从 canvas 引擎的分片超时推导：它在 12 秒没有网络进展后放弃请求，等待响应头也算在内（[`hls-segment-prefetcher.js`](../../../../clients/player/src/engine/hls-segment-prefetcher.js) 里的 `DEFAULT_INACTIVITY_TIMEOUT_MS`，[`hedge.js`](../../../../service/node/src/media/hedge.js) 里的 `DEVICE_SEGMENT_TIMEOUT_MS`），下面节点的每个阈值都在它之内结束，给透传和车上的网络留出 2 秒。

| 阈值 | 取值 | 结果 |
|---|---|---|
| 没有首字节 | 1.5 秒 | 在下一个 URL 上发起对冲 |
| 没有新字节 | 2 秒 | 从已读到的字节偏移起，在下一个 URL 上发起对冲 |
| 太慢 | 按领先尝试的速度，剩余部分要超过 5 秒 | 从已读到的字节偏移起，在下一个 URL 上发起对冲 |
| 尝试失败 | 立即 | 新的尝试接替它；已经失败过的 URL 先等 250 毫秒，每次翻倍，最多 2 秒 |
| 完全没有进展 | 10 秒（12 秒 − 2 秒） | 读取失败：还没发出字节时设备收到带 `UPSTREAM_TIMEOUT` 代码的 `504`，发出部分字节后响应体中断，设备随后重试 |
| 上限 | 同时 2 个尝试，总共 6 个 | 一个分片任何时候最多花掉剩余字节的两倍 |

三个镜像都能在 4.5 秒内各得到一次首字节机会，远早于读取放弃。

标为 `vtt` 的字幕由插件的 `subtitle(id)` 提供，节点在 `/m/{token}/sub/{n}.vtt` 交付；`burn` 字幕由片源画进画面。还在准备的字幕回答 `425`，网站限制下载的字幕回答 `429 rate_limited`，两者都带 `Retry-After`；播放器在不超过 2 分钟的等待后再请求一次这样的字幕，它的提示写出始终没能加载的字幕（[`subtitle-loading.js`](../../../../clients/player/src/subtitle-loading.js)）。

片源实现了 `comments` 的条目，其会话还在 `/m/{token}/comments?start=&end=` 以 JSON 提供条目的时间轴评论，数据来自节点的评论缓存，内部 API 的 `/internal/v1/comments` 也用它；直播流没有评论（[弹幕](../feature/2026-10-13-danmaku.zh.md)）。

agent 要的画面和故事板由 [`frames.js`](../../../../service/node/src/media/frames.js) 从同样的 Input 读取，不经过任何会话：ffmpeg 读 `file` Input 的 URL、`split` Input 的视频轨，或 `hls` Input 播放列表中的一个变体，并带上 Input 的请求头。取正在播放条目的画面时，先用会话自己的数据：`frameSource()` 给出带有会话当前所用 URL 的 Input，以及磁盘缓存里分离流的视频分段和会话探测时留下的初始化分段（[视频画面](../feature/2026-10-13-video-frames.zh.md)）。

### 发给设备的流描述

节点 `prepare` 的回答就是实时 `load` 消息里的 `stream`：

```js
{
  sessionId: "ses_…",
  delivery: { type: "hls" | "mp4" | "split-mp4", url: "/m/{token}/…" },  // split-mp4 has videoUrl + audioUrl
  profile: { width, height, fps, videoKbps, audioKbps, split } | null,
  title, duration, isLive,
  liveDvr: { available: true, defaultLatencySeconds: 30 } | null,
  thumbnail,
  startTime,                        // the real start (the source may change it, e.g. Plex's viewOffset)
  trimToStart,                      // an hls Input with trimToStart: the stream may begin at startTime, not at 0
  limits: { maxVideoKbps, ceilingKbps, capped },  // the cap used; capped: the device's or the source's cap is below the node's
  network: "tunnel" | "lan",        // "lan": serve from the node's LAN listener
  origin: "https://yolo-lan-….example:9443" | null,  // the LAN origin, or null for the page's own
  tracks: {
    subtitles: [Track & { delivery: "vtt" | "burn", url? }],
    audio: [Track & { detail? }],
    selected: { subtitles: [id…], audio: id | null },
  },
  comments: "/m/{token}/comments" | null,  // the item's timed comments, when its source can have them
}
```

## 曾考虑的替代方案

**每个片源自己提供 HTTP 服务、自己缓存分片**，就像早先的单进程服务按服务商各写一套那样。每个插件都得重新实现字节范围代理、清单改写、缓存和过期处理，还要能看到设备和媒体 token；管线放在核心里，插件只需描述一个 Input 就能得到这一切。

**用 `refresh()` 而不是 `alternates` 来挽救卡住的请求。** `refresh()` 要重新解析条目（yt-dlp 要好几秒），30 秒内最多一次，而且只能按角色整体替换链接，赶不上救一个卡住的分片。

**只在卡住之后切换镜像，并且每个资源各自记住切换。** 6 秒的卡顿或响应头超时、从下一个镜像整段重新下载，再加上重试，加起来超过设备的 12 秒超时，于是节点还在切换时设备已经放弃。切换结果也不会传给另一路音视频、下一个会话或一次 refresh，refresh 还会回到探测选出的那个主机。

**先把整个分片缓存在节点，再回答设备。** 这样设备等到第一个字节的时间就是整个上游下载时间，一个慢但仍在传输的镜像也会触发设备的响应头超时。

**按名字偏好某个镜像主机。** 从家里的节点测量，同一个主机前一天只有 172 kbps，第二天最高 70 Mbps；同一天里它对文件开头很快，读到文件深处却会卡住。只有实时测量和最近的体验才能把主机排对。

## 后果

每个片源都能用上同一套字节范围代理、磁盘缓存、HLS 改写、分离音视频拼成 HLS、ffmpeg 兜底、WebVTT 交付和带类型的过期处理，插件则保持小巧、只管具体服务商。节点因此承载了 Yolo 里最重的代码，而 Input 的结构是插件依赖的约定，修改时要顾及插件 API 的实验性状态。对冲进行时，一个分片剩余的字节可能同时来自两个镜像。一个分片在发出首批字节之后失败，设备看到的是中断的响应体，而不是错误状态码。节点对主机的记忆保存在进程里，重启后从零开始。无论是哪个服务商，设备看到的都是同一种交付，来自它自己的源或节点的局域网源，播放器也因此能保持与具体服务商无关。
