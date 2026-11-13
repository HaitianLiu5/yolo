# Agent Note: 给用户其他媒体应用的媒体库协议

Status: proposed

[English](2026-11-11-library-protocol.md) | 中文

## 问题

用户自己还运行着别的应用，里面有 Yolo 应该能播的视频。第一个是一条流水线：下载视频、加中文字幕，把每个视频放在自己 Worker 后面的私有 Cloudflare R2 桶里，包括原片（常是 AV1 加 Opus）、原片不是 H.264 和 AAC 时的一份 H.264 加 AAC 副本、一条 zh-CN WebVTT 字幕、封面和简介，保留约 30 天。这些现在都到不了 Yolo。那个应用自己的记录写明：Yolo 只能用来看，并且要读一个稳定的只读导出，而不是它的 job 文件夹。

每个应用写一个来源插件，会把每个应用的内部结构写进 Yolo。缺的是一份任何这类应用都能提供的只读约定，加一个读它的插件，这样接入新应用只需要在应用那一边做事。从它播出来的东西也就能缓存到设备上离线看，因为下载存的是 Yolo 发出的那条流，与背后是哪个来源无关。

## 提案

一个协议 `yolo-library/1`：只读的 HTTPS 加 JSON，用 bearer token，媒体按字节范围读取。一个通用的官方插件 `source-library`，读取任意多个提供这套协议的库。两者都不认识具体的应用：插件的配置里只写每个库的地址。

### 协议

| 请求 | 返回 |
| --- | --- |
| `GET {base}/`（不要 token） | `{ protocol: "yolo-library/1", title, authorize, token }`，带 token 时还有 `libraries: [{ id, title, kind }]` |
| `GET {base}/libraries/{id}/items?cursor=&limit=` | `{ items: [Entry], next }`，新的在前 |
| `GET {base}/search?q=&limit=` | `{ items: [Entry] }` |
| `GET {base}/items/{id}` | `Item` |
| 媒体或字幕的 URL | 文件内容，支持 `Range` 和 206；MP4 的索引在前 |

- **Entry**：`id`、`title`、`kind`（`video`、`movie` 或 `episode`）、`thumbnail`、以秒计的 `duration`、`date`、`updatedAt`。同一内容的 `id` 保持不变：观看历史、续播和保存的音轨字幕选择都以它为键。
- **Item**：Entry 加上 `description`、`url`（作品的公开页面）、`people`、`tags`、`chapters: [{ start, end?, title }]`、`expiresAt`（库删除它的时间，或 null）、`media` 和 `subtitles`。
- **media**：同一作品的若干版本，每个是 `{ id, url, alternates?, container, video: { codec, width, height, fps }, audio: [{ codec, channels, language? }], bytes, kbps, sha256? }`。编码用[能力协商](../../implemented/architecture/2026-10-07-capability-negotiation.zh.md)所用的 RFC 6381 前缀（`av01`、`avc1`、`opus`、`mp4a`）。至少有一个版本是 MP4 封装的 H.264 加 AAC，因为 Yolo 对远程文件原样转发，不转码。`alternates` 是同一份字节的其他地址，比如局域网地址。
- **subtitles**：`[{ id, language, name, url, default? }]`，都是 WebVTT，id 保持不变。
- JSON 响应带 `ETag`。错误是 HTTP 状态码加 `{ error: { code, message } }`：401 表示没有 token 或 token 已吊销，404 表示条目已不存在，503 表示库暂时无法回答。加字段仍是 `/1`；只有不兼容的改动才变成 `/2`。

第 1 版不包括写操作（留在应用自己的界面里）、HLS 和直播、弹幕，以及应用自己的观看进度，进度由 Yolo 自己记录。

### 授权

每个库都通过同一种设备码授权发出 token，形式与 Yolo 自己的[屏幕配对](../../implemented/feature/2026-10-07-device-code-pairing.zh.md)相同，没有人需要手动复制 token：

1. 插件发送 `POST {authorize}`，带 `{ client: "Yolo", name }`，得到 `{ deviceCode, userCode, verificationUri, interval, expiresIn }`。
2. Yolo 通过插件的设置入口在 `npm run yolo -- accounts` 里显示链接和码，也画成二维码；腾讯的微信登录用的就是这个入口（[腾讯体育回放](../../implemented/feature/2026-10-26-tencent-sports-replays.zh.md)）。
3. 用户在库自己的页面上、库自己的登录之后同意这个码。
4. 插件用设备码轮询 `POST {token}`，得到 `{ accessToken }`，存在插件的状态目录里，权限 600，不进 Git，也不进 `yolo.config.json`。
5. 库列出它授权过的客户端，可以吊销任何一个；之后插件拿到 401，请求重新授权。

token 只能读，直到被吊销都有效。

### 插件

```json
{ "source": "./plugins/source-library",
  "options": { "libraries": [{ "id": "studio", "url": "https://studio.example/api/v1/library", "title": "Studio" }] } }
```

它把协议映射到[来源插件接口](../../implemented/architecture/2026-10-11-source-plugin-api.zh.md)：`libraries()`、`items()` 和 `search()` 对应列表；`describe()`、`details()` 和 `chapters()` 对应 `GET items/{id}`，在内存里短暂保留；`tracks()` 和 `subtitle()` 对应 `subtitles`；`health()` 对应 `GET {base}/`。`prepare()` 对每个版本询问上下文里的 `playable()`，返回第一个设备能直接播放且在 `limits.maxVideoKbps` 之内的版本，否则返回最小的 H.264 版本，形式是 `{ type: "file", url, headers, alternates, cacheKey }`，用该版本的 `sha256` 作缓存键。能解 AV1 的 Mac 播原片；手机和车播副本。来源是 `{ plugin: "library", id: "<库 id>/<条目 id>" }`。

插件按 [`yolo-add-official-plugin`](../../../skills/yolo-add-official-plugin/SKILL.md) 流程加入，默认不加载。它不改 `/v1`，也不改 `/internal/v1`，所以 `CLIENT_PROTOCOL` 和 `NODE_PROTOCOL` 都不变，客户端也不用改。

### 离线副本

下载对库的要求不超出播放的要求，只是库里的视频让两点变得明显：下载要把条目的文本字幕轨和视频一起存下，因为字幕是单独的 WebVTT 文件；下载要带设备真实的能力去请求流，这样 `prepare()` 会选设备能解码的版本。设备上的副本在库的 `expiresAt` 之后仍然可看。

### 计划

1. 本笔记。
2. `plugins/source-library`，用一个脚本化的库做单元测试，再加一个播放并跳转一个条目的 e2e 测试；`npm run check`。
3. 第一个库在它自己的仓库里实现协议并部署。
4. 随包含插件的版本发布、经用户同意升级之后：完成授权，在车上和手机上各播一个条目，再下载一个。

## 考虑过的替代方案

**为一个应用写插件，直接读它的 job 文件夹。** 在两者共用的那台机器上起步最快，能看到它硬盘上的所有视频。但这把 Yolo 绑在另一个应用的内部结构上，而那个应用自己已经排除了这种做法，而且只在那台机器上可用。

**用 S3 密钥直接读应用的 R2 桶。** 应用不用加路由，但 Yolo 会拿着整个桶的密钥、知道它的键结构，而且仍然需要 Worker 存在 D1 里的目录。

**把 token 粘贴进环境变量。** 实现更简单，但每个库都要有自己的说明，而泄露或过期的 token 没有一个地方能让用户看到并吊销。

**只用 HLS 交付。** 在 Apple 设备上通用，但要求每个库都把文件切片。目前考虑到的应用都已经存 MP4，Yolo 按范围读取，能发给任何屏幕。

## 验收标准

- 在 `yolo.config.json` 里加一个库并用 `npm run yolo -- accounts` 授权后，它的条目出现在首页和搜索里，智能体用 `search` 能找到。
- 一个条目在车上和没有 AV1 解码器的 iPhone 上用 H.264 版本播放和跳转，带 WebVTT 字幕；能解原片的设备播原片。
- 节点和库重启后，观看历史和续播仍然在。
- token 被吊销后，库的条目会说明这一点；重新授权后不用重启就恢复。
- 在 iPhone 上下载的条目，在库删除它之后，飞行模式下仍能带字幕播放。

## 风险

- 保留时间短的库会在观看历史和"继续观看"里留下空缺；`expiresAt` 让屏幕能说明，但留不住视频。
- 媒体从库到节点再到设备：经过 Worker 时，受库自己的出网和请求限制。
- 分享链接能让朋友看单个条目。属于其他创作者的视频可能需要插件对某个库拒绝分享链接，由用户按库决定。
