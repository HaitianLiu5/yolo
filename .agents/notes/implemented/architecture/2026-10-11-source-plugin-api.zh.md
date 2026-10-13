# Agent Note: 片源插件 API

Status: implemented

[English](2026-10-11-source-plugin-api.md) | 中文

## 问题

[插件架构](2026-10-11-plugin-architecture.zh.md)把所有具体服务商移出了核心，所以核心需要一份片源插件要实现的约定：插件怎么打包和加载，怎么给内容命名才能让历史和续播生效，可以提供哪些能力，怎么启动和停止，以及控制面入口怎么添加工具。这份约定还必须容得下出错的插件，不能让一个坏插件拖垮节点。

## 决策

API 就是 `@useyolo/plugin-api`（[`service/plugin-api/src/index.js`](../../../../service/plugin-api/src/index.js)）；1.0 之前为实验性。两个官方插件 `plugins/source-plex` 和 `plugins/source-ytdlp` 就是按它写的，可以当示例看。

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
| `node` | 媒体节点（Node.js） | 节点启动时 | 片源：`yolo.registerSource` |
| `control` | 控制面（Worker） | 部署时打包进 Worker | MCP 工具：`yolo.registerTool` |

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

`yolo` 上有 `plugin`（`{ name, version }`）、`options`（配置里这个插件的选项，只读，默认 `{}`）、`env`（节点的环境变量，已包含 `.env`）、`log`（`debug`/`info`/`warn`/`error`，每行自动带插件名）、`cacheDir`（插件自己的缓存目录，在节点的 `.media-cache/plugins/` 下，被 Git 忽略，用到时创建，Yolo 随时可以删除，某些测试里为 `null`）、`registerSource(id, impl)`（id 只能用小写字母、数字和 `-`，以字母开头，在节点内唯一），以及返回取消订阅函数的 `on("start" | "shutdown", fn)`。

### Source 和 sourceKey

一个条目就是一个 **Source**：`{ plugin: "example", id: "/v/123", url: "https://video.example/v/123?ref=share" }`。Yolo 把 `plugin` 填成片源的 id；`id` 是条目在这个片源里的身份（数字会转成字符串）；其他字段都归插件所有，Yolo 原样存进队列、播放列表和历史，从不读取。一个 Source 的 JSON 最多 4KB。`<plugin>:<id>` 是条目的 **sourceKey**：历史、续播进度和音轨偏好都按它保存，片库条目的 id 也是它。所以对同一个内容，插件每次都必须给出同一个 `id`；官方 yt-dlp 插件用规范化后的网址，同一个视频的不同写法因此共用一条历史。插件认领之前，网址是一个未认领的 `{ url }`，节点离线时加进队列的网址就这样保存。

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
| `search(query, { type, limit })` | 搜索 | `LibraryItem[]` |
| `artwork(itemId, variant)` | 封面图 | 一个图片 `Response` |
| `prepare(source, context)` | 播放：把条目解析成节点媒体管线能提供的 Input（[媒体管线](2026-10-11-node-media-pipeline.zh.md)） | 流描述 |
| `health()` | 状态，显示在 `/internal/v1/health` 里 | 任意对象 |

规则：

- **认领按顺序进行。** 节点按配置的加载顺序、同一插件内按注册顺序调用 `claim`；第一个返回 Source 的胜出。`expand` 也一样。官方 yt-dlp 插件认领所有 http(s) 网址，所以需要先处理网址的插件必须排在它前面。
- **`claim` 要快，而且不联网。** 控制面每次播放网址前都会先调用它；需要联网的事放到 `describe` 里做。`claim` 抛错时，错误直接返回给调用方，而不是交给下一个片源。
- **片库 id 是本地的。** `libraries`、`items`、`children` 和 `search` 返回和接收的 id 都是插件自己的；Yolo 对外加上前缀 `<片源 id>:`。播放某个条目，就是播放 Source `{ plugin: <片源 id>, id }`。
- **封面**可以是 http(s) 的 `thumbnail`，也可以是 `artwork` 里的变体名（例如 `"poster"`）；Yolo 把变体名换成 `/v1/library/items/<id>/artwork?variant=…`，由片源的 `artwork(itemId, variant)` 提供。
- **报错**用 `YoloError(code, message)`，错误码同 `/v1`，例如 `not_found` 或 `resolve_failed`；其他异常都会变成 `internal`。
- **搜索跨片源。** `libraries` 和 `search` 会问所有实现了它们的片源；只要有一个成功就返回结果，失败的片源列在 `unavailable` 里。

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

`yolo` 上有 `plugin`、`options`、`log`、`z`（宿主的 zod）和 `registerTool`。工具名用 `lower_snake_case`，不能和 Yolo 自带的工具或别的插件重名。`scope` 是调用它需要的唯一一个 OAuth scope；`annotations` 默认是「非只读、非破坏性」；`input` 是一个 `z.object({...})`；`run(args, { services })` 返回给 agent（智能体）的 JSON，抛出的 `YoloError` 会变成带错误码的 `isError` 结果。`services` 就是 MCP 和 `/v1` 共用的那层服务。工厂函数在第一次 MCP 请求时执行，而不是在 Worker 的全局作用域里执行。

### 官方插件

| 插件 | 片源 id | Source | 做了什么 |
|---|---|---|---|
| `@useyolo/source-plex`（`plugins/source-plex`） | `plex` | `{ plugin: "plex", id: <ratingKey> }` | 片库浏览、搜索、详情（含 Plex 自己的进度 `resumeAt`）、音轨和封面；不认领网址。经 tunnel 时播放固定的 720p 转码（`videoBitrateKbps` 或 `PLEX_VIDEO_BITRATE_KBPS`，4000–4800；`limits.maxVideoKbps` 更低时随之降低，画面降到 480p、360p 或 240p）。在局域网路径上，`playable()` 回答 `direct`、没有烧录内容、选中的音频就是文件的默认音频时，它经节点播放原始文件 part，否则给 `<video>` 设备按设备画面大小的 Plex 直接串流（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)）。它烧录图片字幕，把文本字幕转成 WebVTT（内嵌的先烧录、后台抽取），`startTime` 为 `null` 时从 Plex 的 `viewOffset` 开始，`health()` 查 Plex 的转码列表，把进度写回 Plex，`stop()` 停止转码。在 `start` 里读取 `options.url`/`token`，没有就用 `PLEX_URL`/`PLEX_TOKEN`，在 macOS 上最后从 Plex Media Server 自己的偏好设置里读 token |
| `@useyolo/source-ytdlp`（`plugins/source-ytdlp`） | `ytdlp` | `{ plugin: "ytdlp", id: <规范化网址>, url: <原始网址> }` | 认领所有 http(s) 网址，用 yt-dlp 取元数据和字幕，展开播放列表。播放时按设备的 `maxHeight`、偏好编码和 `limits.maxVideoKbps` 选格式；返回 HLS、单个文件或分离的音视频，带上 CDN 需要的请求头和缓存标识；链接过期时重新解析；给 YouTube 直播提供 DVR 索引；按需把字幕下载到 `cacheDir`。直接指向媒体文件的链接（`.mp4`、`.webm`、`.m3u8`…）不经过 yt-dlp。对 Bilibili 的 upos 主机，它让镜像赛跑，其余镜像作为 `alternates` 交出去（[媒体管线](2026-10-11-node-media-pipeline.zh.md)）。选项 `binary`、`cookiesFile`、`cookiesFromBrowser`，没有就用 `YTDLP_COOKIES_FILE` 和 `YTDLP_COOKIES_FROM_BROWSER`；都没设置时匿名运行。每次调用都起一个短命的 yt-dlp 进程，所以不需要 `start` |

两个插件都没有 `control` 入口，测试在各自的 `test/` 目录里。播放 YouTube 时，yt-dlp 必须是 2026.08.19 或更新的版本：更早的 `ANDROID_VR` 链接能播视频开头，但跳到后面时会返回 403。

### 现在的限制

没有 `prepare` 的片源，条目可以浏览、搜索、加进队列，但不能播放。还没有 `yolo install` 命令，所以改配置后要手动重启节点、重新部署控制面。元数据、协议和设备三类插件还没有接口。

## 曾考虑的替代方案

打包、加载和信任方面的选择及其替代方案记录在[插件架构](2026-10-11-plugin-architecture.zh.md)里；片源为什么返回 Input、而不是自己提供媒体，记录在[媒体管线](2026-10-11-node-media-pipeline.zh.md)里。

## 后果

片源插件就是一个由可选方法组成的小对象，出错的插件会降级为 `failed`，而不会让节点停下。历史和续播依赖每个插件给出稳定的 id，而核心无法检查这一点。这份约定是实验性的，1.0 之前可能不兼容地修改，所以第三方插件可能在 Yolo 升级后失效。
