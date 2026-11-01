# Agent Note: 片源插件 API

Status: implemented

[English](2026-10-11-source-plugin-api.md) | 中文

## 问题

[插件架构](2026-10-11-plugin-architecture.zh.md)把所有具体服务商移出了核心，所以核心需要一份片源插件要实现的约定：插件怎么打包和加载，怎么给内容命名才能让历史和续播生效，可以提供哪些能力，怎么启动和停止，以及控制面入口怎么添加工具。这份约定还必须容得下出错的插件，不能让一个坏插件拖垮节点。

## 决策

API 就是 `@useyolo/plugin-api`（[`service/plugin-api/src/index.js`](../../../../service/plugin-api/src/index.js)）；1.0 之前为实验性。三个官方片源插件 `plugins/source-plex`、`plugins/source-ytdlp` 和 `plugins/source-folder`（[文件夹片源](../feature/2026-10-26-folder-source.zh.md)）就是按它写的，官方 DNS provider 插件 `plugins/dns-desec`（[DNS provider 插件](2026-10-14-dns-provider-plugins.zh.md)）、官方模型提供方 `plugins/model-subscriptions`（[插件用用户自己的订阅调用模型](2026-10-25-models-for-plugins.zh.md)），以及官方元数据插件 `plugins/metadata-local`、`plugins/metadata-wikimedia`、`plugins/metadata-tvmaze`、`plugins/metadata-bangumi` 和 `plugins/metadata-tmdb`（[元数据插件](2026-10-25-metadata-plugins.zh.md)）也是；默认配置不加载的 `plugins/source-example` 是编写新插件的起点（[编写片源插件](#writing-a-source-plugin)）。

### 包和入口

```json
{
  "name": "@someone/yolo-source-example",
  "type": "module",
  "yolo": { "node": "./src/node.js", "control": "./src/control.js" },
  "peerDependencies": { "@useyolo/plugin-api": "*" }
}
```

| 入口 | 跑在哪里 | 什么时候加载 | 能注册什么 |
|---|---|---|---|
| `node` | 媒体节点（Node.js） | 节点启动时 | 片源：`yolo.registerSource`；元数据：`yolo.registerMetadata`；模型提供方：`yolo.registerModelProvider` |
| `control` | 控制面（Worker） | 部署时打包进 Worker | MCP 工具：`yolo.registerTool`；DNS provider（DNS 服务商）：`yolo.registerDnsProvider` |

每个入口都是 ES 模块，默认导出一个工厂函数 `(yolo) => void | Promise<void>`，Yolo 用对应一侧的 API 调用它一次。宿主提供的包写在 `peerDependencies` 里：节点会把插件里的 `import "@useyolo/plugin-api"` 指向它自己的那一份，所以插件装在哪个目录都能加载，并且和节点共用同一个 `YoloError` 类。

### 节点入口

```js
import { YoloError } from "@useyolo/plugin-api";

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function (yolo) {
  yolo.registerSource("example", {
    claim: (url) => (new URL(url).hostname === "video.example" ? { id: new URL(url).pathname, url } : undefined),
    describe: async (source) => ({ title: `Video ${source.id}`, thumbnail: null, duration: 60 }),
  });
}
```

`yolo` 上有 `plugin`（`{ name, version }`）、`options`（配置里这个插件的选项，只读，默认 `{}`）、`env`（节点的环境变量，已包含 `.env`）、`log`（`debug`/`info`/`warn`/`error`，每行自动带插件名）、`cacheDir`（插件自己的缓存目录，在节点的 `.media-cache/plugins/` 下，被 Git 忽略，用到时创建，Yolo 随时可以删除，某些测试里为 `null`）、`stateDir`（插件自己存放必须保留的状态（比如凭据）的目录，在节点的 `.yolo/plugins/` 下，被 Git 忽略，用到时创建，Yolo 从不删除，某些测试里为 `null`）、`models`（用用户自己的订阅调用的语言模型 `yolo.models`，约定见[插件用用户自己的订阅调用模型](2026-10-25-models-for-plugins.zh.md)）、`fetch`（按用户出口规则发请求的 fetch()，用于插件自己对片源的请求）、`egressProxy()`（节点在回环地址上的代理，给自己发请求的子进程用，没有出口规则时为 `null`；[出口代理层](2026-10-13-node-egress-proxy.zh.md)）、`registerSource(id, impl)`（id 只能用小写字母、数字和 `-`，以字母开头，在节点内唯一），`registerMetadata(id, impl)` 和 `registerModelProvider(id, impl)`（id 规则相同；约定见[元数据插件](2026-10-25-metadata-plugins.zh.md#the-metadata-entry)和[插件用用户自己的订阅调用模型](2026-10-25-models-for-plugins.zh.md#model-provider-plugins)），以及返回取消订阅函数的 `on("start" | "shutdown", fn)`。插件的 `cacheDir` 和 `stateDir` 按包名命名：`@useyolo/model-subscriptions` 的状态放在 `.yolo/plugins/useyolo-model-subscriptions/`。

### Source 和 sourceKey

一个条目就是一个 **Source**：`{ plugin: "example", id: "/v/123", url: "https://video.example/v/123?ref=share" }`。Yolo 把 `plugin` 填成片源的 id；`id` 是条目在这个片源里的身份（数字会转成字符串）；其他字段都归插件所有，Yolo 原样存进队列、播放列表和历史，从不读取。一个 Source 的 JSON 最多 4KB。`<plugin>:<id>` 是条目的 **sourceKey**：历史、续播进度和音轨偏好都按它保存，片库条目的 id 也是它。所以对同一个内容，插件每次都必须给出同一个 `id`；官方 yt-dlp 插件用规范化后的网址，同一个视频的不同写法因此共用一条历史。即便如此，片源还是不再认得某个片库条目的 id 时（例如片库重新扫描之后），`prepare` 回答 `not_found`，Hub 会在这个片源的 `search` 结果里按标题和 `duration` 重新找到这个条目，并把它的历史和音轨偏好移到新 id 下（[片库条目换了 id](../feature/2026-10-21-moved-library-items.zh.md)）。插件认领之前，网址是一个未认领的 `{ url }`，节点离线时加进队列的网址就这样保存。

<a id="methods"></a>

### 方法

所有方法都是可选的；片源没实现的能力 Yolo 不会调用，并且在插件的 `start` 处理器执行完之前什么也不调用。

| 方法 | 用途 | 返回 |
|---|---|---|
| `claim(url)` | 认领一个 http(s) 网址 | 不含 `plugin` 的 Source，或 `undefined` 交给下一个 |
| `expand(url)` | 展开播放列表或合集网址（`playlist_import`） | `{ title, items: [{ source, title, thumbnail, duration }] }`，或 `undefined` |
| `describe(source)` | 标题、封面、时长 | `{ title, thumbnail?, artwork?, duration?, isLive? }` |
| `tracks(source)` | 字幕和音轨 | `{ subtitles: Track[], audio: Track[] }`；不实现就当作没有 |
| `libraries()` | 片库列表 | `[{ id, title, type }]` |
| `items(libraryId, { offset, limit })` | 浏览片库，分页 | `{ total, offset, items: LibraryItem[] }` |
| `children(itemId)` | 季、剧集等子项 | `{ parent?, items: LibraryItem[] }` |
| `sequence(source)` | 这个条目所属的那一串，按播放顺序：一部剧跨季的所有集、一个多 P 视频的各个分 P、URL 指定的播放列表。条目播完且队列为空时，Yolo 播其中的下一项；每个直接播放的条目都会在后台调用一次（[接下来播什么](../feature/2026-10-23-up-next.zh.md)） | `{ title?, items, index }`，items 的形式同 Collection，片源不知道的标题省略，可选的 `label` 是条目在这一串里的简短位置（"S1 · E3"、"P3"）；或 null |
| `search(query, { type, limit })` | 搜索 | `LibraryItem[]` |
| `artwork(itemId, variant)` | 封面图 | 一个图片 `Response` |
| `prepare(source, context)` | 播放：把条目解析成节点媒体管线能提供的 Input（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）；带 `reason: "frame"` 时，返回节点从中读取一帧画面的 Input，最好是原始文件，片源不改动自己的任何状态（[视频画面](../feature/2026-10-13-video-frames.zh.md)） | 流描述 |
| `health()` | 状态，显示在 `/internal/v1/health` 里 | 任意对象 |
| `subtitle(source, trackId)` | 条目没在播放时，`tracks()` 里某条文字字幕的 WebVTT 文本；条目播放时，增长中轨道的完整文本；用于文字稿 | 字符串，或 `{ pending: true, retryAfter? }`；网站限制它的下载时抛出带 `details.retryAfter`（秒）的 `rate_limited` |
| `chapters(source)` | 章节，以及片头和片尾标记 | `Chapter[]`（`{ start, end?, kind?, title? }`，单位秒），或 `{ chapters, duration? }` |
| `details(source)` | agent 可能想知道的信息：简介、人员（每人可带 `photo`）、日期、类型、标签、评分、剧集信息，以及按插件自己的名字给出的外部 `ids`（`{ imdb: "tt…" }`），元数据插件按它们查找作品（[元数据插件](2026-10-25-metadata-plugins.zh.md)） | `Details` |
| `file(source)` | 条目在节点所在机器上播放的文件，用绝对路径表示，让元数据插件读取它旁边的东西；它从不离开节点 | `{ path, size? }`，或 null |
| `roots()` | 片源的 `local` Input 可以读取的、节点所在机器上的文件夹，用绝对路径表示；文件解析链接后在这些文件夹之外，或片源没有 `roots()` 时，节点拒绝该 `local` Input（[文件夹片源](../feature/2026-10-26-folder-source.zh.md)） | `string[]` |
| `storyboard(source)` | 片源已有的故事板图片，例如网站的缩略图拼图，供 agent 生成缩略图总览；只有比读取视频画面更省时才提供（[视频画面](../feature/2026-10-13-video-frames.zh.md#storyboards)） | `{ title?, duration?, sheets: [{ url, headers?, start, duration, columns, rows, tileWidth, tileHeight, interval? }] }`，或 `null` |
| `comments(source, { start, end })` | 屏幕叠加在画面上显示、agent 也能读取的时间轴评论（弹幕）（[弹幕](../feature/2026-10-13-danmaku.zh.md)） | `{ comments: [{ t, text, mode?, color?, size?, weight? }], start?, end? }`：本次回答完整覆盖的那一段里的评论，至少从 `start` 起，例如一个分段或整个条目（`end: null`），提供方给评论打了分时带上这个分数（`weight`，0 到 10）；条目没有评论时为 `null` |
| `warm(source, context)` | 某台设备的首页先列出这个条目时，提前为这台设备解析它，`context` 里有这台设备的 `prepare` 会拿到的 `capabilities`、`viewport`、`limits` 和 `network`，让随后的 `prepare` 少花时间；它不启动会话，也不启动来源之后必须停止的东西。节点一次只运行一个，在后台运行，忽略失败（[节点内部 API](2026-10-07-node-internal-api.zh.md)） | 无 |

规则：

- **认领按顺序进行。** 节点按配置的加载顺序、同一插件内按注册顺序调用 `claim`；第一个返回 Source 的胜出。`expand` 也一样。官方 yt-dlp 插件认领所有 http(s) 网址，所以需要先处理网址的插件必须排在它前面。
- **`claim` 要快，而且不联网。** 控制面每次播放网址前都会先调用它；需要联网的事放到 `describe` 里做。`claim` 抛错时，错误直接返回给调用方，而不是交给下一个片源。
- **片库 id 是本地的。** `libraries`、`items`、`children` 和 `search` 返回和接收的 id 都是插件自己的；Yolo 对外加上前缀 `<片源 id>:`。播放某个条目，就是播放 Source `{ plugin: <片源 id>, id }`。片库条目和 `prepare()` 的结果可以给出 `parents`：它所属条目的本地 id，从外到内，最多两个（一集的剧，再是季；一季的剧），Yolo 按它们统计一部剧、一季在 Yolo 里看过的集数，并把一部剧的历史并成一条来继续观看（[进度和续播](../feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)）。
- **封面**可以是 http(s) 的 `thumbnail`，也可以是 `artwork` 里的变体名（例如 `"poster"`）；Yolo 把变体名换成 `/v1/library/items/<id>/artwork?variant=…`，由片源的 `artwork(itemId, variant)` 提供。屏幕通过节点获取 `thumbnail`，而节点只访问公网地址（[节点内部接口](2026-10-07-node-internal-api.zh.md)），所以图片在家庭网络上的片源要用 `artwork`。
- **报错**用 `YoloError(code, message)`，错误码同 `/v1`，例如 `not_found` 或 `resolve_failed`；其他异常都会变成 `internal`。
- **搜索跨片源。** `libraries` 和 `search` 会问所有实现了它们的片源；只要有一个成功就返回结果，失败的片源列在 `unavailable` 里。
- **agent 读取的能力都有退路。** `subtitle`、`chapters` 和 `details` 让用户本人的 agent 通过节点的 `/internal/v1/transcript`、`/chapters` 和 `/details` 读取条目（[节点内部接口](2026-10-07-node-internal-api.zh.md)）。条目正在播放时，文字稿来自流描述的 `subtitle(trackId)`，但增长中的轨道除外，它的流描述只回答片源目前已做出的内容；所以没在播放的条目和增长中的轨道需要 `subtitle(source, trackId)`。没有 `chapters` 的条目就没有章节；没有 `details` 时，agent 得到的是 `describe` 返回的内容；没有 `storyboard`，或它失败、超过 10 秒、一张小图都没给出时，节点为 `/internal/v1/storyboard` 读取视频的画面（[视频画面](../feature/2026-10-13-video-frames.zh.md#storyboards)）。两者都由 Yolo 统一整理：章节的 `kind` 是 `chapter`（默认）、`intro` 或 `credits`，其他 kind 或结束不晚于开始的条目会被丢掉；详情只保留 [`service/plugin-api/src/index.js`](../../../../service/plugin-api/src/index.js) 里 `Details` 类型的字段，最多 20 个人员、10 个类型、15 个标签和 1,500 字符的简介。请填写人员的 `role`（`cast`、`director`、`writer`、`channel` 等），最重要的放在前面。
- **评论由节点保存。** 节点每次向 `comments` 要一个 6 分钟的窗口，按条目保存回答（有上限，最久未用的先淘汰），通过 `/m/{token}/comments` 提供给正在播放的屏幕，通过 `/internal/v1/comments` 提供给 agent；片源自己不缓存评论。`t` 以秒计，`mode` 是 `scroll`（默认）、`top` 或 `bottom`，`color` 是 `#rrggbb`，`size` 是相对正常大小的倍数（0.5 到 2）；Yolo 丢掉没有时间或文字的评论，把文字截到 100 个字符，每次回答最多保留 20,000 条。没有 `comments` 的片源，条目就没有评论。

<a id="lifecycle"></a>

### 生命周期

1. **加载：**节点按配置顺序导入每个插件的 `node` 入口并调用工厂函数。工厂函数里只做注册，不启动进程、socket、定时器或文件监听。
2. **`start`：**所有工厂函数执行完之后，节点按加载顺序执行 `start` 处理器。长期占用的资源在这里创建；单个处理器超过 30 秒没完成就算失败。
3. **`shutdown`：**节点收到 SIGTERM 或 SIGINT 时，按加载顺序执行 `shutdown` 处理器，最多等 5 秒。处理器必须可以重复执行，并且在什么都没启动时也不能出错。

| 出错情况 | 结果 |
|---|---|
| 入口找不到、导入失败或工厂函数抛错 | 插件标记为 `failed`，它已注册的东西全部丢弃，其他插件照常加载 |
| `start` 处理器抛错或超时 | 插件标记为 `failed`，它的片源被移除，并执行它的 `shutdown` 处理器来释放已启动的资源 |
| `shutdown` 处理器抛错 | 记日志；其他处理器照常执行 |

不管哪种情况，节点都继续运行。`/internal/v1/health` 列出每个插件的状态（`started`、`failed`、`disabled`、`stopped`）和错误原因，节点启动时也会打印一遍。

### 控制面入口

```js
/** @param {import("@useyolo/plugin-api").YoloControlAPI} yolo */
export default function (yolo) {
  const { z } = yolo;
  yolo.registerTool({
    name: "queue_length",
    title: "Queue length",
    description: "How many items are waiting in the queue.",
    scope: "read",
    annotations: { readOnlyHint: true },
    input: z.object({}),
    run: async (args, { services }) => ({ queued: (await services.listQueue()).length }),
  });
}
```

`yolo` 上有 `plugin`、`options`、`log`、`z`（宿主的 zod）、`registerTool` 和 `registerDnsProvider`，后者的约定见 [DNS provider 插件](2026-10-14-dns-provider-plugins.zh.md)。工具名用 `lower_snake_case`，不能和 Yolo 自带的工具或别的插件重名。`scope` 是调用它需要的唯一一个 OAuth scope；`annotations` 默认是「非只读、非破坏性」；`input` 是一个 `z.object({...})`；`run(args, { services })` 返回给 agent（智能体）的 JSON，抛出的 `YoloError` 会变成带错误码的 `isError` 结果。`services` 就是 MCP 和 `/v1` 共用的那层服务。工厂函数在第一次 MCP 请求或媒体名称第一次维护时执行，而不是在 Worker 的全局作用域里执行。

<a id="the-official-plugins"></a>

### 官方插件

| 插件 | 片源 id | Source | 做了什么 |
|---|---|---|---|
| `@useyolo/source-plex`（`plugins/source-plex`） | `plex` | `{ plugin: "plex", id: <ratingKey> }` | 片库浏览和搜索（一集或一季用 `parents` 给出所属的剧和季）、详情（含 Plex 自己的进度 `resumeAt`）、音轨和封面；不认领网址。给车播放 720p 转码（`videoBitrateKbps` 或 `PLEX_VIDEO_BITRATE_KBPS`，4000–4800）；`limits.maxVideoKbps` 更低时用它的另一个已检查档位，1500 kbps 的 480p，不管上限再低多少（[自适应码率](../feature/2026-10-11-adaptive-quality.zh.md)）。`limits.maxVideoKbps` 能承载 720p 以上画面时（8 Mbps 起 1080p，12 Mbps 起 1440p，20 Mbps 起 2160p：在局域网上如此，默认设置下在远程直连播放上也如此），`<video>` 设备拿到按它自己画面大小的 Plex 直接串流，这个上限作为 Plex 的 `maxVideoBitrate`；低于 8 Mbps 时（比如中继）用车的档位（[能力协商](2026-10-07-capability-negotiation.zh.md)）。在局域网路径上，`playable()` 回答 `direct`、没有烧录内容、选中的音频就是文件的默认音频时，它经节点播放原始文件 part（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。它烧录图片字幕和无法转换的字幕文件，但从不烧录它能读取的文本字幕：文本字幕以 WebVTT 交付，按来源文件缓存（外挂字幕文件按路径、大小和修改时间；媒体文件里的轨道按 Plex 报告的文件路径和大小以及轨道索引），所以媒体库重新扫描给条目换了新 id 后缓存仍然有效。文件里还没提取的轨道是增长中的轨道：ffmpeg 从文件里读出屏幕窗口所在的 30 秒分段，按路径读取，节点读不到这个路径时通过 Plex 的 part URL 读取，同时整条轨道在后台提取，一次一条（[能力协商](2026-10-07-capability-negotiation.zh.md)）。`startTime` 为 `null` 时它从 Plex 的 `viewOffset` 开始，`health()` 查 Plex 的转码列表，把进度写回 Plex，`stop()` 停止转码。`reason: "frame"` 时返回原始 part，不转码，也不改音轨和字幕选择（[视频画面](../feature/2026-10-13-video-frames.zh.md)）。它还为 agent 提供：播放之外同样的 WebVTT（`subtitle`），Plex 的片头片尾标记和文件里的章节（`chapters`），以及 Plex 的简介、演职人员（剧集自己的演员很少时补上整部剧的）、日期、类型、评分和观看记录（`details`），带上 Plex guid 里的外部 id（`imdb`、`tmdb`、`tvdb`；详情用 `includeGuids=1` 取得），以及 `Role.thumb` 是 http(s) URL 时的演员 `photo`。节点所在机器能读到 part 的文件时，`file()` 给出它，比如 Plex 和节点在同一台机器上时。在 `start` 里读取 `options.url`/`token`，没有就用 `PLEX_URL`/`PLEX_TOKEN`，在 macOS 上最后从 Plex Media Server 自己的偏好设置里读 token |
| `@useyolo/source-folder`（`plugins/source-folder`） | `folder` | `{ plugin: "folder", id: "f-<根目录键>-<哈希>" }` | 列出并播放 `options.roots` 或 `FOLDER_ROOTS` 指定的、节点所在机器上的文件夹（硬盘或挂载的 NAS 共享目录）里的视频文件，按文件名和文件夹识别成一个电影片库和一个剧集片库；搜索；一部剧的剧集串（`sequence`）；音频流作为音轨；视频旁边的字幕文件和视频内部的文本字幕流以 WebVTT 提供；文件旁边的海报或一帧画面作为封面；以及给元数据插件的 `file()`。它不认领网址。`prepare` 返回 `local` Input，节点原样播放它，或复制、转码成 HLS 播放；`roots()` 给出节点允许它读取的文件夹（[文件夹片源](../feature/2026-10-26-folder-source.zh.md)） |
| `@useyolo/source-ytdlp`（`plugins/source-ytdlp`） | `ytdlp` | `{ plugin: "ytdlp", id: <规范化网址>, url: <原始网址> }` | 认领所有 http(s) 网址，用 yt-dlp 取元数据和字幕，展开播放列表。视频播放时用 `parents` 给出它所在的那一串：不止一 P 的 Bilibili 视频（不带 `?p=` 的页面），或网址的 `list=` 指定的播放列表。播放时在 `limits.maxVideoKbps` 之内选最高到设备 `maxHeight` 的格式（快速运动最高 1440p），每个高度区间先取 H.264，再取设备声明的其他编码，后者只取按字节范围读取的 SDR MP4，所以 Chrome 里的 1440p 屏幕拿到 YouTube 的 AV1（[能力协商](2026-10-07-capability-negotiation.zh.md)）；返回 HLS、单个文件或分离的音视频，带上 CDN 需要的请求头和缓存标识；链接过期时重新解析；给 YouTube 直播提供 DVR 索引；按需把字幕下载到 `cacheDir`，整个 WebVTT 文件优先于分段的字幕 rendition；网站对某条字幕回答 429 时（YouTube 对它的机器翻译字幕就是这样，而且远比对其他字幕更早限制），要等过了网站给的 Retry-After 才再请求它，没有就等一分钟，每连续被拒一次翻倍，最多 15 分钟，其间抛出 `rate_limited`，因为马上再请求只会让限制延长，直到所有字幕都被拒；yt-dlp 把网站的故事板拼图列为格式时，通过 `storyboard()` 提供它们。对 Bilibili，它通过 `comments()` 提供弹幕：取 yt-dlp 给出的评论 XML，XML 失败时改读 Bilibili protobuf 接口的一个分段，并带上 cookies 文件里的 cookie（[弹幕](../feature/2026-10-13-danmaku.zh.md)）。Bilibili 的字幕来自同一次要求字幕的 yt-dlp 运行（`--write-subs`），因为只用 `-j` 时一条也不会列出；这次运行与解析格式同时开始，所以流不用等它，`ai-<语言>` 字幕是该语言的机器生成字幕。Bilibili 只把字幕给登录了的账号：没有它的 cookie（`cookiesFile` 或 `YTDLP_COOKIES_FILE`）就没有字幕，节点日志会这样说明。直接指向媒体文件的链接（`.mp4`、`.webm`、`.m3u8`…）不经过 yt-dlp。yt-dlp 只有在登录了 Vimeo 账号时才能读取 Vimeo 页面（`vimeo.com/<id>`、未公开的 `vimeo.com/<id>/<hash>`、频道或精选集里的视频）；当它回答 web 客户端需要登录时，插件改问嵌入播放器 `player.vimeo.com/video/<id>?h=<hash>`，它能匿名播放同一个视频，并且此后一小时内对该页面直接问播放器。页面仍是条目的 `id` 和 `url`；有 Vimeo cookie 时由页面本身作答。当 yt-dlp 因 DRM 保护丢掉某些格式时，插件会读取它保留的 HLS 的主播放列表和第一个媒体播放列表，拒绝需要 DRM 密钥的流（`resolve_failed`，不可重试），因为 Yolo 的播放器都无法解密它。对 Bilibili 的 upos 链接，它在播放开始的位置让镜像赛跑，其余镜像作为 `alternates` 交出去，最快的镜像对所选格式也太慢时改从更小的格式开始（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）。它还为 agent 提供简介、频道、日期、分类、标签和各种计数（`details`），上传者标的章节（`chapters`），以及播放之外的字幕文本（`subtitle`）；这些元数据调用与 `describe`、`tracks` 对同一个视频共用一次 yt-dlp 运行，保留 10 分钟（最多 16 个视频）。播放时解析出的结果，即某台设备的格式和 YouTube 的字幕列表，在其链接距离自带的过期时间（`expire`、`expires`、`deadline`）还有至少 10 分钟时重复使用，链接没有过期时间就用 10 分钟，最多保留 8 次解析，所以从历史记录重播、重试或恢复都不再运行 yt-dlp；`refresh()` 总是重新解析，`warm()` 提前解析设备的格式，但不比较镜像速度。选项 `binary`、`cookiesFile`、`cookiesFromBrowser`，没有就用 `YTDLP_COOKIES_FILE` 和 `YTDLP_COOKIES_FROM_BROWSER`；都没设置时匿名运行。每次调用都起一个短命的 yt-dlp 进程，所以不需要 `start`；用户有出口规则时，它把节点的回环代理作为 `--proxy` 传入，自己的请求用 `yolo.fetch` 发出（[出口代理层](2026-10-13-node-egress-proxy.zh.md)）。yt-dlp 不读的腾讯体育比赛页（`sports.qq.com/kbsweb/game.htm?mid=…`）按比赛自己的回放列表、经回放的腾讯视频页面播放：页面的 `vid` 指定的那个，没有就放英文原声全场，再没有就放任一全场，最后放第一个；回放的名字和图片取自这个列表，`expand()` 把比赛页展开成所有回放；比赛进行时，比赛页改为从腾讯的直播接口直播它的英文频道。腾讯视频页面和付费直播用 Yolo 自己的腾讯登录：它来自 `npm run yolo -- accounts login`（插件的 setup entry）用二维码完成的微信登录，或 cookie 文件里已有的那个，按需续期，保存在 `stateDir` 里。B 站的剧集页（`bangumi/play/ss…`，yt-dlp 会逐集解析）播放它的第一集，剧集的每一集按 B 站季接口给出的剧名和集数命名，各集就是它所在的那一串（[接下来播放](../feature/2026-10-23-up-next.zh.md)）。对不支持 HEVC 的设备，插件带的一个 yt-dlp 扩展向腾讯视频要 H.264（[腾讯体育回放和直播](../feature/2026-10-26-tencent-sports-replays.zh.md)）。没有给出主播放列表的 HLS 格式（腾讯视频的就是这样）播放它自己的播放列表 |
| `@useyolo/model-subscriptions`（`plugins/model-subscriptions`） | 无；模型提供方 `subscriptions` | 无 | 用用户自己的订阅给其他插件一个模型：先只读地借用 Codex 的登录，然后用 `claude -p` 驱动 Claude Code，再然后是 Yolo 自己的登录（`npm run yolo -- models login`）或自定义的服务；登录由一个 `setup` 入口完成（[插件用用户自己的订阅调用模型](2026-10-25-models-for-plugins.zh.md)） |
| `@useyolo/metadata-local`（`plugins/metadata-local`） | 无；元数据 `local` | 无 | 从文件旁边和文件内部的东西描述条目：NFO 文件、海报、背景图、演员照片和内嵌标签；需要片源的 `file()`（[元数据插件](2026-10-25-metadata-plugins.zh.md#the-official-plugins)） |
| `@useyolo/metadata-wikimedia`（`plugins/metadata-wikimedia`） | 无；元数据 `wikimedia` | 无 | 不用 key，从 Wikidata 用用户的语言说出电影和剧的名字，并把其他数据库认它们用的 id 传下去；用 Wikipedia 和 Wikidata 完整地描述一部电影，对一集只描述它所属的剧（[元数据插件](2026-10-25-metadata-plugins.zh.md#the-official-plugins)） |
| `@useyolo/metadata-tvmaze`（`plugins/metadata-tvmaze`） | 无；元数据 `tvmaze` | 无 | 不用 key，对照 TVmaze 确认并描述电视剧的分集，英文：标题、简介、剧照和带照片的演员表（[元数据插件](2026-10-25-metadata-plugins.zh.md#the-official-plugins)） |
| `@useyolo/metadata-bangumi`（`plugins/metadata-bangumi`） | 无；元数据 `bangumi` | 无 | 不用 key，对照 Bangumi（bgm.tv）确认并描述动画和中日剧集：中文标题和简介，以及角色和声优的照片（[元数据插件](2026-10-25-metadata-plugins.zh.md#the-official-plugins)） |
| `@useyolo/metadata-tmdb`（`plugins/metadata-tmdb`） | 无；元数据 `tmdb` | 无 | 可选：用用户自己的 key `TMDB_API_KEY` 对照 The Movie Database 确认条目是哪部电影或哪一集，并描述它；没有 key 时什么也不做（[元数据插件](2026-10-25-metadata-plugins.zh.md#the-official-plugins)） |

这些插件都没有 `control` 入口，测试在各自的 `test/` 目录里。播放 YouTube 时，yt-dlp 必须是 2026.08.19 或更新的版本：更早的 `ANDROID_VR` 链接能播视频开头，但跳到后面时会返回 403。

<a id="writing-a-source-plugin"></a>

### 编写片源插件

[`plugins/source-example`](../../../../plugins/source-example/) 是参考插件：它从自己的 `options` 读出一个视频链接片库，实现了 `claim`、`libraries`、`items`、`search`、`describe`、`tracks` 和 `prepare`，并用每个条目的 `description`、`chapters`、`subtitles`（WebVTT 文件）和 `comments` 实现可选的 `details`、`chapters`、`subtitle` 和 `comments`；单元测试用假的 `yolo` 调用工厂函数，不需要节点。新片源从复制它开始：

1. 改掉包名和片源 id。`@useyolo/plugin-api` 仍然是唯一的 peer dependency，也是从 Yolo 唯一导入的包。
2. 只实现服务商能提供的[方法](#methods)。同一内容永远得到同一个 `id`，`claim` 保持快速、离线。
3. 播放时从 `prepare` 返回一个 Input，由节点的管线提供；长期占用的资源在 `start` 和 `shutdown` 处理函数里启动和释放（[生命周期](#lifecycle)）。
4. 像 `source-example` 那样，用 `node --test` 直接测试工厂函数和片源对象。
5. 把插件加进配置（如果它认领 URL，就放在 `source-ytdlp` 之前），重启节点，确认 `/internal/v1/health`（或 `npm run yolo -- doctor`）显示它为 `started`。

随产品发布的 [`yolo-add-source-plugin`](../../../../skills/yolo-add-source-plugin/SKILL.md) 技能带用户本人的 agent 在检出目录之外安装或编写插件；[`yolo-add-official-plugin`](../../../skills/yolo-add-official-plugin/SKILL.md) 列出本仓库里的官方插件还要多做什么。

### 现在的限制

没有 `prepare` 的片源，条目可以浏览、搜索、加进队列，但不能播放。还没有 `yolo install` 命令，所以改配置后要手动重启节点、重新部署控制面。协议和设备两类插件还没有接口。

## 曾考虑的替代方案

打包、加载和信任方面的选择及其替代方案记录在[插件架构](2026-10-11-plugin-architecture.zh.md)里；片源为什么返回 Input、而不是自己提供媒体，记录在[媒体管线](2026-10-11-node-media-pipeline.zh.md)里。

## 后果

片源插件就是一个由可选方法组成的小对象，出错的插件会降级为 `failed`，而不会让节点停下。历史和续播依赖每个插件给出稳定的 id，而核心无法检查这一点。这份约定是实验性的，1.0 之前可能不兼容地修改，所以第三方插件可能在 Yolo 升级后失效。
