# Yolo 插件开发指南

状态：**实验性**，随 Yolo 0.2 实现，0.3 加了播放（`prepare`），2026-10-11。1.0 之前插件接口可以不兼容地修改。设计和理由见 [yolo-roadmap.md 第 3 节](yolo-roadmap.md#3-插件模型) 和[决策 19–24](yolo-decisions.md)，节点接口见 [yolo-v1.md 第 8 节](yolo-v1.md#8-控制面到节点的内部接口)。

做法参考 pi 的扩展机制（`badlogic/pi-mono` 的 `extensions.md` 和 `packages.md`）：插件是导出工厂函数的普通 npm 包，在工厂函数里注册能力，按加载顺序执行。

## 1. 插件是什么

一个插件就是一个 npm 包，`package.json` 的 `yolo` 字段写明两个入口：

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
| `node` | 家里的媒体节点（Node.js） | 节点启动时 | 片源：`yolo.registerSource` |
| `control` | 控制面（Cloudflare Worker） | 部署时打包进 Worker | MCP 工具：`yolo.registerTool` |

两个入口都可以没有，但至少要有一个。每个入口都是 ES 模块，默认导出一个工厂函数 `(yolo) => void | Promise<void>`。Yolo 调用它一次，传入对应一侧的 API。

宿主提供的包（目前只有 `@useyolo/plugin-api`）要写在 `peerDependencies` 里，不要写进 `dependencies`。节点加载插件时，会把插件里的 `import "@useyolo/plugin-api"` 指向节点自己的那一份，所以插件装在哪个目录都能加载，而且和节点共用同一个 `YoloError` 类。插件自己用到的其他包照常写进 `dependencies`。

现在只有片源插件和 MCP 工具。元数据、协议、设备这三类插件在路线图里，接口还没有；Yolo 自己的实时通道在核心里（决策 25）。

## 2. 节点入口和片源

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

`yolo` 上有：

| 成员 | 说明 |
|---|---|
| `plugin` | `{ name, version }`，取自插件的 `package.json` |
| `options` | 配置文件里这个插件的 `options`，只读，没有时是 `{}` |
| `env` | 节点的环境变量，已经读过仓库根目录的 `.env` |
| `log` | `debug`、`info`、`warn`、`error`，每行自动带插件名 |
| `cacheDir` | 这个插件自己的缓存目录（在节点的运行时目录 `.media-cache/plugins/` 下，被 git 忽略），用到时自己创建，Yolo 随时可以删。测试里可能是 `null` |
| `registerSource(id, impl)` | 注册一个片源。`id` 只能用小写字母、数字和 `-`，以字母开头，整个节点内唯一 |
| `on("start" \| "shutdown", fn)` | 生命周期事件，见第 3 节。返回一个取消订阅的函数 |

### Source 和 sourceKey

片源里的每个条目用一个 Source 表示：

```js
{ plugin: "example", id: "/v/123", url: "https://video.example/v/123?ref=share" }
```

- `plugin` 由 Yolo 填成片源的 `id`，插件返回 Source 时不用写。
- `id` 由插件决定，表示条目在这个片源里是谁。数字会被转成字符串。
- 其他字段都归插件所有。Yolo 原样保存在队列、播放列表和历史里，不会去读。整个 Source 的 JSON 不能超过 4KB。
- `<plugin>:<id>` 是这个条目的 **sourceKey**。历史、续播进度和字幕偏好都按它保存，片库条目的 id 也是它。所以同一个内容，插件每次都必须给出同一个 `id`。官方 yt-dlp 插件用规范化后的网址作为 `id`，同一个视频的不同写法因此共用一条历史。

网址在被认领之前是一个未认领的引用 `{ url }`。节点离线时，加进队列的网址就保持这个样子，等到播放时再交给节点认领。

### 片源可以实现的方法

所有方法都是可选的，没实现的能力 Yolo 不会调用。方法只会在插件的 `start` 处理器执行完之后才被调用。

| 方法 | 用途 | 返回 |
|---|---|---|
| `claim(url)` | 认领一个 http(s) 网址 | Source（不含 `plugin`），或 `undefined` 交给下一个片源 |
| `expand(url)` | 展开播放列表或合集网址（`playlist_import`） | `{ title, items: [{ source, title, thumbnail, duration }] }`，或 `undefined` 交给下一个 |
| `describe(source)` | 标题、封面、时长 | `{ title, thumbnail?, artwork?, duration?, isLive? }` |
| `tracks(source)` | 字幕和音轨 | `{ subtitles: Track[], audio: Track[] }`。不实现就当作没有 |
| `libraries()` | 片库列表 | `[{ id, title, type }]` |
| `items(libraryId, { offset, limit })` | 浏览片库，分页 | `{ total, offset, items: LibraryItem[] }` |
| `children(itemId)` | 剧集、季等子项 | `{ parent?, items: LibraryItem[] }` |
| `search(query, { type, limit })` | 搜索 | `LibraryItem[]` |
| `artwork(itemId, variant)` | 封面图 | 一个图片 `Response` |
| `prepare(source, context)` | 播放：把条目解析成节点媒体管线能提供的流，见下文「播放」 | 流描述 |
| `health()` | 状态，出现在 `/internal/v1/health` 里 | 任意对象 |

规则：

- **认领按顺序进行**。节点收到网址时，按配置里的加载顺序、同一插件内按注册顺序依次调用 `claim`，第一个返回 Source 的片源胜出。`expand` 也一样。官方 yt-dlp 插件会认领所有 http(s) 网址，所以要优先处理网址的插件应该排在它前面。
- **`claim` 要快，而且不能联网**：控制面每次播放网址前都会先调用它。需要网络请求的事放到 `describe` 里做。`claim` 抛错时，错误会直接返回给调用方，不会交给下一个片源。
- **片库 id 是本地的**。`libraries`、`items`、`children`、`search` 返回的 `id` 和传进来的 `libraryId`、`itemId` 都是插件自己的 id，Yolo 对外加上前缀 `<片源 id>:`。播放某个条目，就是播放 Source `{ plugin: <片源 id>, id }`。
- **封面**可以用 `thumbnail` 给一个 http(s) 地址，也可以用 `artwork: "poster"` 这样的变体名。用变体名时，Yolo 把它换成控制面的 `/v1/library/items/<id>/artwork?variant=…`，请求最终落到这个片源的 `artwork(itemId, variant)` 上。
- **报错**用 `YoloError(code, message)`，code 见 [yolo-v1.md 第 5 节](yolo-v1.md#5-http-api控制面v1)，例如 `not_found`、`resolve_failed`。其他异常会变成 `internal`。
- **多个片源一起搜索**：`libraries` 和 `search` 会问所有实现了它们的片源。只要有一个成功，就返回结果，失败的片源列在 `unavailable` 里。

### 播放：`prepare`

Yolo 0.3 把媒体管线搬进了节点核心（`service/node/src/media/`）：字节范围代理和磁盘缓存、HLS 清单改写、分离音视频拼成 fMP4 HLS、ffmpeg 转码、WebVTT 字幕，都在 `/m/{token}/…` 下提供给设备。片源插件只负责**提供输入**：`prepare` 说从哪里读、怎么读，不碰 HTTP 服务、缓存和设备。

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
      startTime: startTime ?? 0,              // null：Yolo 没有进度，片源自己决定
      input: { type: "hls", url: media.playlistUrl, headers: { Referer: "https://video.example/" } },
      tracks: { subtitles, audio: [], selected },
      subtitle: async (id) => fetchVtt(media, id),     // WebVTT 文本
      refresh: async () => ({ type: "hls", url: (await lookUp(source.url)).playlistUrl }),
    };
  },
});
```

`context`（第二个参数）：

| 字段 | 说明 |
|---|---|
| `capabilities` | 要播放的设备的能力（[yolo-v1.md](yolo-v1.md) 第 6 节）：`maxHeight`、偏好的 `video`/`audio` 编码、`delivery`、`subtitles` 等。特斯拉是 720p、`avc1`/`mp4a` 优先 |
| `viewport` | 设备最近上报的视口，可能是 `null` |
| `startTime` | 从第几秒开始；**`null` 表示 Yolo 没有这个条目的进度**，片源有自己的进度（比如 Plex 的 viewOffset）就用自己的，否则从 0 开始 |
| `reason` | `play`、`recovery`、`seek`、`quality`、`transfer`、`tracks` |
| `limits` | `{ maxVideoKbps }`，节点的码率上限（`STREAM_MAX_VIDEO_BITRATE_KBPS`） |
| `chooseTracks({ subtitles, audio })` | 按用户明确的选择，否则按保存的偏好（这个条目的，或最近一次的），返回要用的 `{ subtitles: [id…], audio: id \| null }`。`audio: null` 表示片源默认音轨 |

返回的**流描述**，只有 `input` 必填：

| 字段 | 说明 |
|---|---|
| `input` | 从哪里读，见下表 |
| `title`、`duration`（秒）、`isLive`、`thumbnail` 或 `artwork` | 同 `describe` |
| `startTime` | 设备实际从第几秒开始，默认 0 |
| `profile` | `{ width, height, fps, videoKbps, audioKbps, split }`，设备用来判断带宽够不够 |
| `tracks` | `{ subtitles, audio, selected }`。每条字幕的 `delivery`：`vtt` 由 Yolo 交给设备渲染（可以同时显示几条），`burn` 由片源画进画面（选它会重建会话） |
| `subtitle(trackId)` | 返回一条 `vtt` 字幕的 WebVTT 文本；还在准备（比如从大文件里抽取）时返回 `{ pending: true, retryAfter }` |
| `refresh()` | 上游链接过期（快到 `expire` 参数的时间，或者被拒 403）时，返回一个新的 `input`。Yolo 按角色替换链接，30 秒内最多一次 |
| `health()` | 上游会话是否还在：`alive`、`expired`、`unknown`。`input.transcoder` 为真时，分片 404 会问它；`expired` 时 Yolo 回 410 `SESSION_EXPIRED`，设备重建会话 |
| `progress({ position, duration, status })` | 播放进度，大约每 30 秒和每次状态变化时一次，可以写回片源自己的进度 |
| `stop()` | 会话结束时释放上游资源（比如停转码），可能被调用多次 |

`input` 的三种形状：

| `type` | 字段 | Yolo 怎么提供 |
|---|---|---|
| `file` | `url`，`headers?`，`cacheKey?`，`cache?` | 一个渐进式文件（MP4、WebM），按字节范围代理，写磁盘缓存 |
| `hls` | `url`，`headers?`，`cacheKey?`，`cache?`，`manifest?`，`maxBandwidth?`，`trimToStart?`，`transcoder?`，`live?` | 改写清单里的每个 URI，分片经节点代理。`manifest` 是片源已经取到的主清单（再取一次可能又起一个转码）；`maxBandwidth`（bit/s）去掉更大的变体；`trimToStart` 裁掉 `EXT-X-START` 之前的占位分片；`transcoder` 表示上游还没写出的分片会 404，Yolo 短暂重试并问 `health()`；`cache: false` 不进磁盘缓存；`live.parse(body)` 把直播 DVR 清单解析成按序号寻址的索引，Yolo 提供一个有界的直播窗口 |
| `split` | `video` 和 `audio`：各有 `url`、`headers?`、`cacheKey?`、`codec?`、`width?`、`height?`、`fps?`、`kbps?`；`transcode?` | 分离的音视频 MP4：按 sidx 拼成 fMP4 HLS，分片是原文件的字节范围；没有 sidx 时把两个文件交给设备；`transcode: true`（或节点设了 `DASH_TRANSCODE=1`）时用 ffmpeg |

`headers` 跟着这个 input 的每个上游请求（HLS 的子清单和分片也带）。`cacheKey(url)` 说明一个上游 URL 背后是什么内容，比如签名不同的 CDN 链接指向同一个文件，返回同一个标识，就能共用节点的磁盘缓存；拿不准就返回 `null`，Yolo 用 URL 本身。Yolo 会在标识后面加上字节范围。

规则：

- `prepare` 可以慢（yt-dlp 加上探测要几十秒），但要可以重复调用：恢复、跳转到流开始之前、换音轨都会再调一次。
- 不要自己起 HTTP 服务、不要自己缓存分片，这些是核心的事。
- 插件不知道设备是谁，也拿不到媒体 token。

## 3. 生命周期

1. **加载**：节点按配置顺序导入每个插件的 `node` 入口并调用工厂函数。工厂函数里只做注册，**不要启动进程、socket、定时器或文件监听**。同步注册即可，也可以是 async 函数。
2. **`start`**：所有工厂函数执行完后，节点按加载顺序执行各插件的 `start` 处理器。长期占用的资源在这里创建。单个处理器超过 30 秒没完成就算失败。
3. **`shutdown`**：节点收到 SIGTERM 或 SIGINT 时，按加载顺序执行 `shutdown` 处理器，最多等 5 秒。处理器必须**可以重复执行**，而且在什么都没启动时也不能报错。

出错时：

| 情况 | 结果 |
|---|---|
| 入口找不到、导入失败、工厂函数抛错 | 这个插件标记为 `failed`，它已经注册的东西全部丢弃，其他插件照常加载 |
| `start` 处理器抛错或超时 | 插件标记为 `failed`，它的片源被移除，并执行它的 `shutdown` 处理器来释放已经启动的资源 |
| `shutdown` 处理器抛错 | 记日志，其他处理器照常执行 |

不管哪种情况，节点都继续运行。`/internal/v1/health` 的 `plugins` 列出每个插件的状态（`started`、`failed`、`disabled`、`stopped`）和错误原因，节点启动时也会打印一遍。

## 4. 控制面入口和 MCP 工具

Worker 不能在运行时加载代码，所以 `control` 入口在部署时打包：`wrangler.jsonc` 的构建命令会先运行 `service/control/scripts/generate-plugins.js`，它读取和节点同一份配置，生成 `service/control/src/plugins.generated.js`，用静态 `import` 引入每个启用插件的 `control` 入口。`wrangler dev`、`wrangler deploy` 和 `npm run check` 里的 dry-run 构建都会自动重新生成。配置里有插件找不到时，构建直接失败，不会悄悄漏掉它。

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

- `yolo` 上有 `plugin`、`options`、`log`、`z`（宿主的 zod）和 `registerTool`。
- 工具名用 `lower_snake_case`，不能和 Yolo 自带的 23 个工具或别的插件重名。
- `scope` 是调用它需要的唯一一个 OAuth scope：`read`、`control` 或 `manage`。
- `annotations` 默认是「非只读、非破坏性」。
- `input` 是一个对象 schema，用 `yolo.z.object({...})` 写。
- `run(args, { services })` 的返回值以 JSON 返回给 agent。抛出 `YoloError` 时，工具返回 `isError` 和对应的错误码。`services` 就是 MCP 工具和 `/v1` 共用的那层服务。
- 工厂函数在第一次 MCP 请求时执行，不在 Worker 的全局作用域里执行。
- **插件的 `options` 会原样打包进 Worker 代码**，不要在 `control` 插件的选项里放密钥，密钥用 Worker secret。

## 5. 配置

| 情况 | 加载什么 |
|---|---|
| 设置了 `YOLO_CONFIG` | 这个文件（绝对路径，或者相对仓库根目录的路径；也可以写在 `.env` 里） |
| 仓库根目录有 `yolo.config.json` | 这个文件。它被 git 忽略，可以从 `yolo.config.example.json` 复制 |
| 都没有 | `plugins/official.json`：两个官方片源插件，选项全部取自环境变量（零配置默认） |

格式：

```json
{
  "plugins": [
    { "source": "./plugins/source-plex", "options": { "url": "http://localhost:32400" } },
    { "source": "@someone/yolo-source-example" },
    { "source": "./plugins/source-ytdlp", "enabled": false }
  ]
}
```

- `source` 是相对配置文件的路径（以 `.` 或 `/` 开头），或者一个 npm 包名。包名从配置文件所在目录往上找 `node_modules`，所以先在仓库根目录 `npm install` 它。只写字符串，等于只给 `source`。
- **列表就是完整的加载清单，顺序就是加载顺序**。没列出的插件，包括官方插件，都不会加载；`"enabled": false` 也可以关掉一个插件。
- `options` 原样交给插件的 `yolo.options`。
- 改了配置之后：重启节点；如果涉及 `control` 入口，还要重新部署控制面。

## 6. 信任模型

和 pi 一样，**插件没有权限系统**。节点插件跑在节点进程里，拥有节点的全部权限：能读 `.env`、`NODE_SECRET`、文件系统，也能访问局域网。控制面插件跑在 Worker 里，能用 Worker 的所有 binding，包括 D1 和 OAuth 数据。安装插件之前先审查代码，并固定版本。

## 7. 官方插件

两个官方插件就是按这份指南写的，可以当示例看：

| 插件 | 目录 | 片源 id | Source | 做了什么 |
|---|---|---|---|---|
| `@useyolo/source-plex` | `plugins/source-plex` | `plex` | `{ plugin: "plex", id: <ratingKey> }` | 片库的浏览、搜索、详情（含 Plex 自己的进度 `resumeAt`）、音轨和封面。不认领网址。播放：固定 720p 转码（`videoBitrateKbps` 或 `PLEX_VIDEO_BITRATE_KBPS`，4000–4800），图片字幕烧录，文本字幕转成 WebVTT（嵌在文件里的先烧录、后台抽取），`startTime` 为 `null` 时从 Plex 的 viewOffset 开始，`health()` 查 Plex 的转码列表，`progress()` 写回 Plex，`stop()` 停转码。在 `start` 里读取 `options.url`/`token`，没有就用 `PLEX_URL`、`PLEX_TOKEN`，在 macOS 上最后再从 Plex Media Server 自己的偏好设置里读 token |
| `@useyolo/source-ytdlp` | `plugins/source-ytdlp` | `ytdlp` | `{ plugin: "ytdlp", id: <规范化网址>, url: <原始网址> }` | 认领所有 http(s) 网址，用 yt-dlp 取元数据和字幕，展开播放列表。播放：按设备的 `maxHeight` 和偏好编码选格式，返回 HLS、单文件或分离的音视频，带上 CDN 要的请求头和缓存标识，链接过期时重新解析，YouTube 直播给出 DVR 索引，字幕按需下载到 `cacheDir`。直接指向媒体文件的链接（`.mp4`、`.webm`、`.m3u8`…）不经过 yt-dlp。选项 `binary`、`cookiesFile`、`cookiesFromBrowser`，没有就用 `YTDLP_COOKIES_FILE`、`YTDLP_COOKIES_FROM_BROWSER`。每次调用都起一个短命的 yt-dlp 进程，所以不需要 `start` |

两者都没有 `control` 入口，测试在各自目录的 `test/` 里。

## 8. 现在的限制

- 没有 `prepare` 的片源，条目可以浏览、搜索、加进队列，但不能播放。
- 还没有 `yolo install` 命令，改配置要手动重启节点、重新部署控制面。
- 元数据、协议、设备三类插件还没有接口。
