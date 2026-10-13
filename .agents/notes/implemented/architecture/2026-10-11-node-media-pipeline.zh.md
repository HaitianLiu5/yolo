# Agent Note: 节点的媒体管线与片源 Input

Status: implemented

[English](2026-10-11-node-media-pipeline.md) | 中文

## 问题

Drive-In 的服务把具体服务商的逻辑和媒体交付混在一起：Plex 和 yt-dlp 的代码各自用自己的方式代理字节范围、改写 HLS 清单、拼接分离的音视频、缓存分片。片源迁到[插件](2026-10-11-plugin-architecture.zh.md)之后，如果不改，每个插件都得重新实现 HTTP 服务、缓存、过期和设备处理，而且每个插件都要能看到设备和媒体 token。

## 决策

媒体管线放在节点核心里（[`service/node/src/media/`](../../../../service/node/src/media/)），所有内容都在同源的 `/m/{token}/…` 下提供（[同源透传](2026-10-07-same-origin-media-passthrough.zh.md)）。片源插件只**描述自己的输入**：`prepare(source, context)` 说明从哪里读、怎么读，从不碰 HTTP 服务、缓存或设备。`cache.js` 是磁盘分片缓存，`hls.js` 和 `dash.js` 是播放列表变换，`transcode.js` 是 ffmpeg 兜底，`upstream.js` 负责有上限的上游请求。

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
| `capabilities` | 要播放的设备的[能力描述](2026-10-07-capability-negotiation.zh.md)：`maxHeight`、偏好的 `video`/`audio` 编码、`delivery`、`subtitles`。特斯拉是 720p，`avc1`/`mp4a` 优先 |
| `viewport` | 设备最近上报的视口，可能是 `null` |
| `startTime` | 从哪里开始；**`null` 表示 Yolo 没有这个条目的进度**，片源用自己的进度（Plex 的 `viewOffset`），没有就从 0 开始 |
| `reason` | `play`、`recovery`、`seek`、`quality`、`transfer`、`tracks` |
| `limits` | `{ maxVideoKbps }`：节点的上限（`STREAM_MAX_VIDEO_BITRATE_KBPS`，默认 4800），设备的[自适应上限](../feature/2026-10-11-adaptive-quality.zh.md)更低时取更低的那个，最低 200 kbps。片源据此选择格式或转码码率；一个格式都放不下时选最小的那个，而不是最好的 |
| `chooseTracks({ subtitles, audio })` | 按用户明确的选择，否则按保存的偏好（这个条目的，或最近一次的），返回 `{ subtitles: [id…], audio: id \| null }`；`audio: null` 表示片源的默认音轨 |

| 流描述字段 | 说明 |
|---|---|
| `input` | 从哪里读（必填），见下文 |
| `title`、`duration`（秒）、`isLive`、`thumbnail` 或 `artwork` | 同 `describe` |
| `startTime` | 设备实际从哪里开始，默认 0 |
| `profile` | `{ width, height, fps, videoKbps, audioKbps, split }`，设备用来判断带宽够不够 |
| `tracks` | `{ subtitles, audio, selected }`；每条字幕的 `delivery` 是 `vtt`（交给设备渲染，可以同时显示几条）或 `burn`（由片源画进画面；选它会重建会话） |
| `subtitle(trackId)` | 一条 `vtt` 字幕的 WebVTT 文本；还在准备时返回 `{ pending: true, retryAfter }` |
| `refresh()` | 上游链接过期时（快到 `expire` 参数的时间，或被拒 403）返回新的 `input`；Yolo 按角色替换链接，30 秒内最多一次 |
| `health()` | 上游会话是否还在：`alive`、`expired` 或 `unknown`。对 `input.transcoder`，分片缺失时会问它；`expired` 时 Yolo 返回 `410 SESSION_EXPIRED`，设备重建会话 |
| `progress({ position, duration, status })` | 播放进度，大约每 30 秒和每次状态变化时一次，片源可以写回自己的进度 |
| `stop()` | 会话结束时释放上游资源（例如停止转码）；可能被调用多次 |

`prepare` 可以慢（yt-dlp 加上探测要几十秒），但必须可以重复调用：恢复、跳到流开始之前和换音轨都会再调一次。插件不知道是哪台设备在播，也拿不到媒体 token。

### Input 与交付方式

| Input | 字段 | 交给设备的方式 | 节点做什么 |
|---|---|---|---|
| `file` | `url`、`headers?`、`cacheKey?`、`cache?`、`alternates?` | `{ type: "mp4", url }` | 按字节范围代理渐进式文件（MP4、WebM），写入磁盘缓存 |
| `hls` | `url`、`headers?`、`cacheKey?`、`cache?`、`manifest?`、`maxBandwidth?`、`trimToStart?`、`transcoder?`、`live?` | `{ type: "hls", url }` | 改写清单里的每个 URI，经节点代理分片。`manifest` 是片源已经取到的主清单（再取一次可能又起一个转码）；`maxBandwidth`（bit/s）去掉更大的变体，全部超过时留最小的那个；`trimToStart` 裁掉 `EXT-X-START` 之前的占位分片；`transcoder` 表示上游分片可能还没生成，Yolo 会短暂重试并问 `health()`；`cache: false` 不进磁盘缓存；`live.parse(body)` 把直播 DVR 播放列表解析成按序号寻址的索引，提供一个有界的直播窗口：对 canvas 引擎，窗口围绕播放游标，并带一段尚未发布分片的预留区；对其他播放器，窗口以最新的分片结尾，往回覆盖 5 分钟 |
| `split` | `video` 和 `audio`，各有 `url`、`headers?`、`cacheKey?`、`codec?`、`width?`、`height?`、`fps?`、`kbps?`、`alternates?`；`transcode?` | `{ type: "hls", url }`：分片是原文件字节范围的 fMP4 HLS；没有 `sidx` 时，对 canvas 引擎为 `{ type: "split-mp4", videoUrl, audioUrl }`，对其他播放器为 ffmpeg 输出的 HLS；转码时为 ffmpeg 输出的 HLS | 探测 MP4 结构、生成播放列表、校验分片完整性并预取；`transcode: true` 或节点设置了 `DASH_TRANSCODE=1` 时使用 ffmpeg |

`headers` 跟着这个 input 的每个上游请求，包括 HLS 子播放列表和分片。`cacheKey(url)` 说明上游 URL 背后是什么内容，所以签名不同但指向同一文件的 CDN 链接可以共用节点的磁盘缓存；拿不准时返回 `null`，Yolo 用 URL 本身，并在标识后面加上字节范围。

`alternates`（`file` 和 `split` 的每一路都可以有）是同一份字节的其他 URL，按优先顺序排列，例如同一个签名链接在 CDN 其他镜像主机上的地址。某个请求卡住（6 秒没有新字节）、超时或出错（5xx、403、404、429）时，节点**在同一次设备请求里**换到下一个 URL，而不是原地重试，之后这一路一直用换过去的那个；所有 URL 都失败后，才退回 `refresh()` 和退避重试。官方 yt-dlp 插件为 Bilibili 的 upos 链接（`upos-*.bilivideo.com`）使用了它：候选是 yt-dlp 给的主机、`upos-sz-mirrorali`、`upos-sz-mirrorhw` 以及 yt-dlp 列出的备用链接（Akamai 的除外，它的签名绑定主机）；`prepare` 用 512 KB 的范围请求并行探测它们（最多 3 秒；最快的一个完成后，其余的再等一半时间），按稳定吞吐排序，最快的作为 `url`，其余作为 `alternates`。

标为 `vtt` 的字幕由插件的 `subtitle(id)` 提供，节点在 `/m/{token}/sub/{n}.vtt` 交付；`burn` 字幕由片源画进画面。

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
  limits: { maxVideoKbps, ceilingKbps, capped },  // the cap used; capped: the device's cap is below the node's
  tracks: {
    subtitles: [Track & { delivery: "vtt" | "burn", url? }],
    audio: [Track & { detail? }],
    selected: { subtitles: [id…], audio: id | null },
  },
}
```

## 曾考虑的替代方案

**每个片源自己提供 HTTP 服务、自己缓存分片**，就像 Drive-In 的服务按服务商各写一套那样。每个插件都得重新实现字节范围代理、清单改写、缓存和过期处理，还要能看到设备和媒体 token；管线放在核心里，插件只需描述一个 Input 就能得到这一切。

**用 `refresh()` 而不是 `alternates` 来挽救卡住的请求。** `refresh()` 要重新解析条目（yt-dlp 要好几秒），30 秒内最多一次，而且只能按角色整体替换链接，赶不上救一个卡住的分片。

## 后果

每个片源都能用上同一套字节范围代理、磁盘缓存、HLS 改写、分离音视频拼成 HLS、ffmpeg 兜底、WebVTT 交付和带类型的过期处理，插件则保持小巧、只管具体服务商。节点因此承载了 Yolo 里最重的代码，而 Input 的结构是插件依赖的约定，修改时要顾及插件 API 的实验性状态。无论是哪个服务商，设备看到的都是一种同源交付，特斯拉客户端也因此能保持与具体服务商无关。
