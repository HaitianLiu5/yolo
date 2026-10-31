# Agent Note: 显示 Spotify 正在播放的内容，并配上歌词和书的文字

Status: proposed

[English](2026-10-14-spotify-now-playing.md) | 中文

## 问题

Spotify 在用户本人的手机、电脑或车上自带的 Spotify 应用里播放音乐和有声书，而 Yolo 的屏幕对此一无所知。期望的体验是：

1. 用户本人把 Spotify 关联到 Yolo，只需一次。
2. Yolo 的屏幕显示 Spotify 正在播放什么（一首歌或有声书的一章），以及在哪台设备上播放。
3. Yolo 从不自行接管播放。
4. 由用户本人决定是否转移播放，之后 Yolo 在旁边显示歌曲的歌词或书的文字。

这件事优先级低。音乐、播客和有声书不在 [Yolo 1.0](2026-10-11-yolo-1-0.zh.md) 的范围内，也没有其他工作在等这份记录。

Spotify 的音频受 DRM 保护，不得经过媒体节点，所以 Spotify 不能成为 Yolo 的片源。[能力协商](../../implemented/architecture/2026-10-07-capability-negotiation.zh.md)记录已经为这种情况预留了 `external` 渲染器：Yolo 通过 Spotify Connect 控制 Spotify，由 Spotify 自己的设备播放。

## 提案

### 边界

- Yolo 从不提取、解密、录制、转写或重新提供 Spotify 的音频，因为它受 DRM 保护。Spotify 的音频不经过节点，也不经过 Worker。
- Yolo 只使用 Spotify 有公开文档的 Web API 和 Web Playback SDK。它从不调用 Spotify 的私有接口，例如 Spotify 自家网页播放器背后的 `color-lyrics` 接口（[歌词](#lyrics)）。
- 没有明确的点按或 agent（智能体）请求，Yolo 从不开始、暂停或转移 Spotify 的播放。方案 A 根本不调用任何 Spotify 写接口。

### 计划

1. **先做两项用户本人检查。** [用户本人检查](#owner-checks)里的 P1 和 P2 大约需要 15 分钟，不需要写代码。它们决定有声书的章节到底能不能看到，以及车能不能作为可用的 Spotify Connect 目标。
2. **然后在手机和电脑上做方案 A：** 一张只读的“Now on Spotify”卡片，配上歌词（[方案](#options)）。
3. **方案 B 的屏幕控制按钮是可选的：** 暂停、跳转，以及在 Spotify 设备之间转移播放，只在用户本人想要时才加。
4. **只有在用户本人接受政策风险之后才提供 agent 工具。** Spotify 关于 AI 和语音的条款直接适用于 MCP 工具（[条款和政策](#terms-and-policy)）。
5. **方案 C 推迟。** 让 Yolo 本身成为 Spotify 设备只在手机和电脑上可行，而在那里 Spotify 应用本来就能播放。

如果需要，有声书文字是以后另做的独立功能：Spotify 不提供任何文字，唯一正当的来源是用户本人自己的无 DRM EPUB（[有声书文字](#audiobook-text)）。

<a id="owner-checks"></a>

### 用户本人检查

每项检查都用用户本人自己的账号运行，不需要 Yolo 的代码。

| 检查 | 步骤 | 决定什么 |
|---|---|---|
| P1，有声书是否可见 | 在手机上播放一章，调用 `GET /me/player?additional_types=episode`。记下 `currently_playing_type`、`item.type`、所属的节目或有声书、`progress_ms`，以及在手机上暂停后多快能反映出来。然后调用 `GET /chapters/{id}`，检查 `resume_point`。 | 方案 A 能否显示有声书，以及歌词必须容忍的延迟 |
| P2，车作为 Connect 目标 | 打开车上的 Spotify 应用，调用 `GET /me/player/devices`，检查车是否列出且 `is_restricted: false`。然后带 `play: false` 调用一次 `PUT /me/player`，把播放转到车上，再试一次暂停。 | 方案 B 能否把播放转到车上 |
| P3，从指定章节开始 | 带 `uris: ["spotify:episode:<chapter id>"]` 和 `position_ms` 调用 `PUT /me/player/play`。 | 方案 B 能否从指定章节开始播放 |
| P4，车上的 Widevine | 在特斯拉浏览器里调用 `navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{ audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }])`。这一项不需要 Spotify 账号。 | 方案 C 将来能否在车上运行 |

### 给用户本人的待定问题

- 账号是完整的 Spotify Premium（不是仅限移动端的套餐）吗？账号所在国家是否属于有声书的市场？开发模式、每次控制调用和 SDK 都需要 Premium。
- 每 6 个月重新关联一次 Spotify，能接受吗？
- 用户本人是否接受 LRCLIB 的条款（歌词版权责任由使用者承担），以及在 Spotify 播放旁边显示第三方歌词可能触犯 Spotify“content from another service”条款的风险？
- 车不是 Approved Device（Spotify 认可的设备），卡片还应该在车机模式里出现吗？本提案默认在车上关闭它。
- 需要方案 B 的屏幕控制按钮吗？
- 用户本人是否接受 AI 和语音条款给 MCP 工具带来的风险？不接受的话，方案 B 不带 agent 工具。
- 以后需要一个阅读用户本人自己无 DRM EPUB 的阅读器吗？

## Spotify 提供什么

资料读取于 2026-10-14。**未经证实**表示没有官方来源确认的说法；社区帖子和对 Spotify 代码的检查只算佐证。大多数未经证实的事项都可以由一项用户本人检查确定。

### 查看播放状态和有声书章节

- `GET /me/player` 返回设备、`progress_ms`、`is_playing`、`timestamp`、`currently_playing_type`、`actions` 和 `item`，`GET /me/player/currently-playing` 是更轻量的版本。两者都可能返回 200、204、401、403 或 429（[Get Playback State](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback)、[Get Currently Playing Track](https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track)）。
- `additional_types` 只接受 `track` 和 `episode`，并且文档说它“将来可能弃用”（[Get Playback State](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback)）。不带 `episode` 时，单集会以 `"item": null` 返回（[社区帖子 5625103](https://community.spotify.com/forum/en/discussion/5625103/api-v1-me-player-currently-playing-item-is-null-when-currently-playing-is-an-episode)）。
- **`/me/player` 里能否看到有声书章节，未经证实。** 播放器接口只记录了歌曲和单集。有三点事实表明，发送 `additional_types=episode` 时章节会以单集的形式返回：Chapter 对象的 `type` 是 `"episode"`，URI 是 `spotify:episode:` 形式（[Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter)）；已保存的有声书会同时出现在 `/me/audiobooks` 和 `/me/shows` 里（[社区帖子 7319327](https://community.spotify.com/forum/en/discussion/7319327/web-api-audiobooks-getting-returned-alongside-shows)）；Web Playback SDK 的代码把章节格式化为 `type: "episode", content_type: "chapter"`（[embedded/index.js](https://sdk.scdn.co/embedded/index.js)）。用户本人检查 P1 可以确定这一点。
- `GET /chapters/{id}` 返回章节序号、名称、简介、时长、图片、有声书的作者和朗读者，以及 `resume_point`；只有带 `user-read-playback-position` scope 时才会填入 `resume_point`（[Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter)）。自 2026 年 2 月起，批量的 `GET /chapters` 和 `GET /audiobooks` 接口已被移除（[2026 年 2 月变更日志](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)）。
- 有声书只在美国、英国、加拿大、爱尔兰、新西兰和澳大利亚市场提供，使用用户 token 时，账号所在国家优先于 `market`（[Get an Audiobook](https://developer.spotify.com/documentation/web-api/reference/get-an-audiobook)）。
- Spotify 没有推送。Web API 没有记录任何 webhook 或事件流，SDK 的 `player_state_changed` 只覆盖它自己的本地播放器（[SDK 参考](https://developer.spotify.com/documentation/web-playback-sdk/reference)），所以 Yolo 只能轮询。
- `timestamp` 是播放状态最后一次变化的时间。另一台设备上的变化多快能反映出来，**未经证实**，由 P1 测量。开发者报告过音乐播放时收到 204 响应（[社区帖子 7039998](https://community.spotify.com/forum/en/discussion/7039998/currently-playing-api-return-an-empty-response-204)），所以 204 表示“未知”，而不是“已停止”。
- `GET /me/player/devices` 列出 Connect 设备及其 `is_restricted`。受限的设备不接受任何 Web API 命令，有些设备型号从不出现在列表里（[Get Available Devices](https://developer.spotify.com/documentation/web-api/reference/get-a-users-available-devices)）。休眠或新加入的设备可能缺失（[spotify/web-api#1337](https://github.com/spotify/web-api/issues/1337)）。Spotify 关于车载的页面让用户向汽车厂商确认是否支持 Connect（[Spotify in the car](https://support.spotify.com/us/article/spotify-in-the-car/)），所以车上的 Spotify 应用是否以不受限的状态列出，**未经证实**；P2 可以确定这一点。

### 控制播放

- 每个控制接口只对 Premium 用户可用，需要 `user-modify-playback-state`，并且不保证各个 Player 调用之间的执行顺序（[Start/Resume](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback)）。
- 暂停、继续、跳转、下一首、上一首、加入队列和转移都有接口。转移是 `PUT /me/player`，带一个 `device_ids` 条目和 `play`（[Transfer Playback](https://developer.spotify.com/documentation/web-api/reference/transfer-a-users-playback)）。没有调整播放速度的接口（[2026 年 2 月变更日志](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)）。
- 用章节的 `spotify:episode:` URI 从指定章节开始播放，以及在有声书里切换下一章、上一章，**未经证实**：`play` 只记录了歌曲 URI，而单集的 `context_uri` 会失败（[社区帖子 5040833](https://community.spotify.com/forum/en/discussion/5040833/episode-uri-not-supported-player-play)）。P3 可以确定能否从指定章节开始。
- 自 2026 年 2 月起，`GET /me` 不再返回 `product`，所以 Yolo 无法查询账号是否有 Premium，只能把控制调用返回的 403 显示出来（[2026 年 2 月变更日志](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)）。

### Scope

按照 Spotify 的要求，Yolo 只申请所构建方案需要的 scope（[Scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes)、[Building with AI](https://developer.spotify.com/documentation/web-api/tutorials/building-with-ai)）。

| Scope | 用途 | 方案 |
|---|---|---|
| `user-read-playback-state` | `GET /me/player`、设备列表和当前播放的内容 | A、B、C |
| `user-read-playback-position` | 章节的 `resume_point` | A、B、C |
| `user-modify-playback-state` | 暂停、跳转、下一首、上一首、转移、播放和加入队列 | B、C |
| `user-library-read` | 已保存的有声书，供 agent 执行“播放我的书”（[Get Saved Audiobooks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-audiobooks)） | B，可选 |
| `streaming`、`user-read-email`、`user-read-private` | Web Playback SDK（[SDK how-to](https://developer.spotify.com/documentation/web-playback-sdk/howtos/web-app-player)） | C |

### 2026 年的开发模式

个人的非商业应用仍然可以使用播放器接口，但要遵守以下规则：

- 应用所有者需要 Premium；Premium 失效，应用就停止工作（[Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)、[迁移指南](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)）。
- 一个应用最多允许 5 个白名单用户（[2026 年 2 月博客](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)）。应用所有者是否自动在白名单里，**未经证实**。
- 配额按开发者账号计算，而不是按 Client ID 计算，429 响应带有 `"reason": "QUOTA_EXCEEDED"`（[2026 年 7 月变更日志](https://developer.spotify.com/documentation/web-api/references/changes/july-2026)）。速率限制的具体数字没有公布（[Rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)）。
- refresh token 在授权 6 个月后过期，刷新不会延长期限；access token 的有效期是 1 小时（[Refreshing tokens](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens)）。
- 扩展配额只对月活跃用户至少 25 万的组织开放，不对个人开放（[Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)）。
- 播放器接口在 2026 年 2 月的缩减中保留了下来（[2026 年 2 月变更日志](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)）。
- 重定向 URI 必须是 HTTPS 并且完全匹配（[Redirect URIs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)），`GET /me` 返回用于关联账号的 `account_id`（[2026 年 5 月变更日志](https://developer.spotify.com/documentation/web-api/references/changes/may-2026)）。

### Web Playback SDK 和 COEP

- SDK 让一个浏览器页面成为 Spotify Connect 设备。它需要完整的 Premium（不含仅限移动端的套餐），支持 Chrome、Firefox、Safari 和 Edge，用于商业项目需要 Spotify 的书面批准（[Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk)）。它通过 EME 播放，代码里引用了 Widevine 和 PlayReady 密钥系统（[SDK 参考](https://developer.spotify.com/documentation/web-playback-sdk/reference)、[embedded/index.js](https://sdk.scdn.co/embedded/index.js)）。它的文档只写了歌曲、单集和广告；代码里处理了章节（[embedded/index.js](https://sdk.scdn.co/embedded/index.js)），但能否播放章节**未经证实**。在 iOS 上，转移播放后要点按一次才会开始播放（[SDK 参考](https://developer.spotify.com/documentation/web-playback-sdk/reference)）。开发者报告过 Safari 上播放失效，多发生在 2023 年（[社区帖子 5591446](https://community.spotify.com/t5/Spotify-for-Developers/Spotify-WebSDK-Playback-stopped-working-on-Safari-for-Desktop/td-p/5591446)），2026 年的情况**未经证实**。
- SDK 无法在 Yolo 的播放器页面上运行。播放器在每个路径上都发送 COOP `same-origin` 和 COEP `credentialless`（`clients/player/public/_headers`）。SDK 脚本会创建一个指向 `https://sdk.scdn.co/embedded/index.html` 的隐藏 iframe（[spotify-player.js](https://sdk.scdn.co/spotify-player.js)），而这个页面在 2026-10-14 既不带 COEP 也不带 CORP；HTML 标准会阻止 COEP 页面嵌入这样的 iframe（[HTML 嵌入者策略检查](https://html.spec.whatwg.org/multipage/browsers.html#check-a-navigation-response's-adherence-to-its-embedder-policy)）。`<iframe credentialless>` 只有 Chrome 支持（[Chrome 博客](https://developer.chrome.com/blog/iframe-credentialless)），而 SDK 创建 iframe 时也不带这个属性。这个结论来自标准本身，还没有浏览器测试确认过。
- 播放器的构建产物不得引用其他主机，以免第三方得知每块屏幕的地址（`service/control/test/integration/third-party-origins.test.js`）。
- **`/listen` 页面。** 同源的 `/listen` 路径可以在 `_headers` 里用 `! Cross-Origin-Embedder-Policy` 规则去掉 COEP，而 `/*` 仍然保留它（[Cloudflare headers](https://developers.cloudflare.com/workers/static-assets/headers/)）。这个页面共享该源的存储，也就共享了设备凭据；播放器在同一个标签页里跳转过去，再跳转回来。它需要在 third-party-origins 测试里加一个按路径限定的例外，并在 [Yolo 1.0](2026-10-11-yolo-1-0.zh.md) 计划的内容安全策略里给 `sdk.scdn.co` 留出位置。弹出窗口更差：COOP 会切断它和打开者之间的联系，[canvas 引擎](../../implemented/architecture/2026-04-04-canvas-playback-engine.zh.md)记录里写明了这一点。

### 车和 Approved Devices

Spotify 的开发者条款只许可应用运行在“Approved Devices”上，即“台式电脑、笔记本电脑、上网本、平板电脑、手机，以及我们书面批准的其他设备”（[Developer Terms](https://developer.spotify.com/terms)）。车不在这个列表里，所以按字面理解，特斯拉屏幕上的任何 Spotify 功能都在许可之外。特斯拉浏览器是否支持 Widevine，以及车辆行驶时 SDK 的音频能否持续播放，都**未经证实**；而且车辆行驶时特斯拉可能冻结媒体元素（[canvas 引擎](../../implemented/architecture/2026-04-04-canvas-playback-engine.zh.md)）。在车上，音频留在车自带的 Spotify 应用里；自软件版本 2024.38 起，这个应用用用户本人自己的 Spotify 账号登录（[Model Y Owner's Manual, Media](https://www.tesla.com/ownersmanual/modely/en_us/GUID-7A85FB6B-9DF6-4C55-A2F9-793207E48E9D.html)）。

<a id="lyrics"></a>

### 歌词

- **Spotify 不提供歌词。** Web API 没有歌词接口（[2026 年 2 月变更日志](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)），应用内的歌词来自与 Musixmatch 的合作（[Spotify newsroom 2021-11-18](https://newsroom.spotify.com/2021-11-18/you-can-now-find-the-lyrics-to-your-favorite-songs-in-spotify-heres-how/)）。未公开的 `spclient.wg.spotify.com/color-lyrics/v2/…` 接口需要网页播放器的 token（[社区帖子 5429280](https://community.spotify.com/forum/en/discussion/5429280/get-lyrics)），条款中的“不当访问”条款排除了它（[Developer Terms](https://developer.spotify.com/terms)）。
- **LRCLIB** 免费，不需要 key，它的条款允许在应用里使用，同时把歌词版权责任留给使用者（[LRCLIB 文档](https://lrclib.net/docs)、[LRCLIB 条款](https://lrclib.net/assets/TermsView-e07a6269.js)）。用歌名、歌手、专辑和时长（±2 秒内匹配）调用 `GET /api/get`，返回 LRC 格式的 `syncedLyrics` 和 `plainLyrics`。客户端要用 `User-Agent` 标明身份，一次只发一个请求，并在收到 429 时遵守 `Retry-After`；也可能出现 503。2026-10-14 对 14 首流行中英文歌曲的抽查发现 14 首都有同步歌词；冷门歌曲的覆盖率**未经证实**。
- **Musixmatch** 是有授权的途径，但同步歌词（`matcher.subtitle.get`）需要付费的 Grow 套餐（[matcher.subtitle.get](https://docs.musixmatch.com/api-reference/lyrics-catalog/matcher-subtitle-get)），价格**未经证实**（[价格](https://www.musixmatch.com/pro/api/pricing)）。

<a id="audiobook-text"></a>

### 有声书文字

Spotify 没有通过任何 API 提供有声书的文字或文稿。章节和有声书对象只带简介（[Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter)）；Page Match 可以在纸质书或电子书的页面和有声书之间切换，但它是应用内功能，没有面向开发者的接口（[Spotify newsroom 2026-02-05](https://newsroom.spotify.com/2026-02-05/bookshop-partnership-page-match-announcement/)）。

唯一正当的文字来源，是用户本人已有的无 DRM EPUB。Yolo 会把 Spotify 的章节序号和名称对应到 EPUB 的目录，并在章节内按 `progress_ms / duration_ms` 的比例滚动。这只是近似，准确度**未经证实**：朗读速度有快有慢，前言等前置内容也会让对应关系偏移。逐词同步需要音频，而边界禁止这样做。有 DRM 的电子书也不行，因为去除它的 DRM 同样属于规避。

<a id="terms-and-policy"></a>

### 条款和政策

| 条款 | 条文（节选） | 对 Yolo 的影响 |
|---|---|---|
| AI | 不得用 Spotify Content“训练机器学习或 AI 模型，或以其他方式把 Spotify Content 摄入机器学习或 AI 模型”；Spotify Content 包括元数据和用户数据（[Developer Terms](https://developer.spotify.com/terms)） | 按字面理解，把歌名和播放位置返回给 ChatGPT 或 Claude 的 MCP 工具就是在摄入 Spotify Content。这是 agent 一侧最大的风险。 |
| 语音 | “不得开发让用户用语音控制 Spotify 的语音 SDA”（[Developer Policy](https://developer.spotify.com/policy)） | agent 的语音模式通过 Yolo 控制 Spotify 就会符合这一条，而 Yolo 无法知道 agent 是否在用语音。 |
| Streaming | 控制后台的 Spotify 应用也算 Streaming（[Developer Terms](https://developer.spotify.com/terms)），而 Streaming 不得用于商业用途（[Developer Policy](https://developer.spotify.com/policy)） | 方案 B 的控制和方案 C 的播放都属于 Streaming。 |
| 其他服务 | “不得开发任何与其他服务的流或内容整合的产品或服务。”（[Developer Policy](https://developer.spotify.com/policy)） | 把 Spotify 的条目放进 Yolo 的队列会符合这一条。在 Spotify 播放旁边显示第三方歌词，存在被这样解读的风险。 |
| 音频重叠 | 不得让设备把 Spotify Content 和其他音频叠在一起播放（[Developer Policy](https://developer.spotify.com/policy)） | Yolo 用“Pause Spotify?”提示来询问，从不自动暂停。 |
| 存储 | 不得无限期存储 Spotify Content，也不得在严格必要之外建立它的数据库（[Developer Terms](https://developer.spotify.com/terms)） | Yolo 实时读取 Spotify 的播放位置，从不把它写进历史记录。 |
| 署名 | 显示 Spotify 的标志和回链（[Developer Policy](https://developer.spotify.com/policy)），不得裁剪或遮盖封面图（[Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter)） | 卡片带有标志、“Open in Spotify”链接和未裁剪的封面。 |
| 用户数据 | 提供方便的断开方式，并在断开时删除数据（[Developer Policy](https://developer.spotify.com/policy)） | 用户本人页面上的“Disconnect Spotify”会删除 token。 |
| 命名 | 应用名称不应以“Spot”开头（[Developer Policy](https://developer.spotify.com/policy)） | 用户本人把开发者后台里的应用命名为类似“Yolo”的名字。 |

违约时，Spotify 的处置是撤销访问权限或许可（[Developer Policy](https://developer.spotify.com/policy)、[Developer Terms](https://developer.spotify.com/terms)）。对一个私人用户来说，这是需要权衡的风险，既不是一定会发生，也不是一定不会发生。

## 与 Yolo 架构的契合

### 外部会话插件

Spotify 既不是片源插件，也不是 Hub 的状态。

- **不是片源。** 片源通过从 `prepare()` 返回一个由节点提供的 Input 来播放（[媒体管线](../../implemented/architecture/2026-10-11-node-media-pipeline.zh.md)），而 Spotify 的音频从不经过节点。
- **不是 Hub 的状态。** Hub 拥有一个队列、一个当前设备和 Yolo 的进度（[Hub 和实时通道](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md)）。Spotify 会话是由 Spotify 拥有、与之并行的第二个会话；把它并入 Hub 的播放状态，等于声称 Yolo 拥有它并不具备的控制权。
- **外部会话插件。** 它的 `control` 入口用不绑定具体服务商的形式报告 Spotify 的会话。播放器把它显示在 Yolo 自己的状态旁边，从不放进队列，Yolo 的点按规则（`play-target.js`）也从不以它为目标。歌词来自另一个元数据插件。

### 宿主功能

插件只从 Yolo 导入 `@useyolo/plugin-api`，`service/` 不出现任何服务商的名字（[插件架构](../../implemented/architecture/2026-10-11-plugin-architecture.zh.md)）。如今 `control` 入口只能拿到 `plugin`、`options`、`log`、`z`、`registerTool` 和 `registerDnsProvider`（`service/control/src/plugins.js`）。这个插件需要四项不绑定具体服务商的宿主功能：

1. **账号关联。** 要么在 `/v1/plugins/<plugin>/…` 下提供 `registerRoute`，要么提供更窄的 `registerAccountLink({ authorize, exchange, refresh })`，由核心从受 passkey 保护的 `/account` 页面驱动。更窄的形式把路由和用户本人会话的检查留在核心里。[协议插件](../../implemented/architecture/2026-10-11-plugin-architecture.zh.md)也会需要控制面路由。
2. **按用户加密封存的存储。** 一张不绑定具体服务商的 D1 表，例如 `plugin_secrets(user_id, plugin, name, value, updated_at)`；表中的值用从 `NODE_SECRET` 派生的密钥封存（图片链接已经这样做），放在下一个编号的迁移里（[D1 数据模型](../../implemented/architecture/2026-10-07-d1-data-model.zh.md)）。
3. **外部会话。** `registerExternalSession({ get(ctx) })` 返回 `{ provider: { name, logo }, kind, title, subtitle, artwork, durationMs, positionMs, playing, at, device: { name, type }, link, actions? }`。核心在 `read` scope 下通过 `GET /v1/external` 提供它，`remote.js` 把它渲染成正在播放栏下方的外部卡片。方案 B 在 `control` scope 下加上 `act(action, args)`。
4. **歌词查询。** `node` 入口调用 `registerLyrics(id, { lookup({ title, artist, album, duration }) })`，返回 `{ synced: [{ t, text }] | null, plain: string | null, attribution: { name, url } }`。节点在 `/internal/v1/lyrics` 提供它，`/v1/lyrics` 经 `nodeFetch()` 代理它。这是元数据插件类型的第一个接口，插件架构里这个类型目前还没有接口。查询在节点上运行，所以结果缓存在磁盘上，不消耗 Worker 的子请求，也不让第三方主机进入播放器。同一个查询以后还能给 Yolo 自己的音乐视频提供歌词字幕。

只有方案 C 还需要第五项功能：一个由插件提供、带有自己响应头的页面，位于播放器构建产物之外。

### 实时读取进度，不存储

Spotify 在自己的服务器上保存每一章的 `resume_point`，并在听者换设备时跟着走（[Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter)）。Yolo 的历史记录无限期保存 500 个条目（[进度和续播](../../implemented/feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)），而条款禁止无限期存储 Spotify Content。所以 Yolo 实时读取 Spotify 的播放位置，在两次轮询之间用本地时钟推算，从不把 Spotify 的条目写进 `history`。用插件 API 的说法，这是 `Details.progress`（片源自己的观看记录）的角色，而不是 Yolo 的进度。

### 关联和 token

- 关联使用带 PKCE 的 Authorization Code 流程（[PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)），所以插件不存储 client secret，公开的 Client ID 可以放在插件的 `options` 里。
- `/account` 上的“Connect Spotify”把 `state` 和 PKCE verifier 短暂存进 KV，再重定向到 Spotify。回调地址（例如 `https://<host>/v1/plugins/<plugin>/callback`）检查用户本人会话和 `state`，用授权码换取 token，把 refresh token 加密封存，并用 Spotify 的 `account_id` 标识关联的账号。
- access token 在过期或遇到 401 时才按需刷新，刷新时返回的新 refresh token 会替换存储的那个，遇到 `invalid_grant` 时显示“Reconnect Spotify”。Spotify 在轮换时是否作废旧的 refresh token，**未经证实**，所以每个用户的刷新保持单飞（single-flight），并在重新读取存储的 token 后重试一次。
- `npm run yolo -- doctor` 在 6 个月期满前 14 天发出警告。“Disconnect Spotify”删除存储的记录。

### 轮询成本

- 只有当 Yolo 屏幕显示这张卡片且页面可见时才轮询，经一个普通的 Worker 路由，而不是 Hub Durable Object。节点无法向控制面推送，因为控制面只通过 `nodeFetch()` 访问节点（[节点访问](../../implemented/architecture/2026-10-08-workers-vpc-node-access.zh.md)）；cron 触发器则会在没人看的时候也轮询。
- 歌词面板打开时间隔 5 秒，只显示卡片时间隔 15–30 秒。推算的位置超过当前条目的结尾时立即轮询一次，暂停 5 分钟后间隔增加到 60 秒，页面隐藏时停止轮询。
- 一次轮询是一个 Worker 请求，至多带 3 个子请求：Spotify 调用、至多每小时一次的 token 刷新，以及换章时的一次章节查询。按 5 秒计，每小时 720 个请求；每天开着歌词面板两小时就是 1,440 个请求，约为 Workers Free 每天 100,000 个请求的 1.4%（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)）。token 写入每天至多 24 次。每次轮询的 CPU 时间预计远低于 10 ms；这一点**未经证实**。
- 每小时 720 次调用就是每个 30 秒窗口 6 次。这是否在 Spotify 未公布的开发模式限额之内，**未经证实**，所以 Yolo 遇到 `Retry-After` 和 `QUOTA_EXCEEDED` 时退避。
- LRCLIB 每首新歌查询一次，结果缓存在节点上。

### 服务商名称

服务商名称门禁从 `plugins/<kind>-<provider>` 目录名取出每个服务商的名字（`scripts/provider-names.js`）。像 `plugins/remote-spotify` 这样的插件目录会让“spotify”成为 `service/` 下禁止出现的名字，门禁随即会标记 `service/control/src/store/queue.js:4` 处的“Spotify-style queue”注释。这条注释要在加入插件之前或同时改写。`plugins/lyrics-lrclib` 会禁止“lrclib”，而 `service/` 里没有提到它。因为每个用户本人都要创建自己的 Spotify 应用并接受政策风险，Spotify 插件默认不启用，也不列入 `plugins/official.json`。

<a id="options"></a>

## 方案

### 方案 A：只读的“Now on Spotify”卡片，配上歌词

- **提供什么。** 用户本人关联一次 Spotify。手机和电脑上的 Yolo 屏幕显示 Spotify 在哪里播放什么：歌曲，或者书以及它的章节、位置和续播点。歌词面板显示 LRCLIB 的同步歌词，跟随播放位置；对于有声书，它显示章节标题、简介和朗读者。Yolo 从不向 Spotify 写入。
- **Scope。** `user-read-playback-state` 和 `user-read-playback-position`。
- **工作量。** 小：宿主功能 1 到 4、约 150 行的控制面插件、约 100 行的节点歌词插件、`remote.js` 里的外部卡片和歌词面板、一个 D1 迁移，以及 `queue.js` 的注释。不需要 MCP 工具，也不需要 SDK。
- **风险。** 有声书取决于 P1。LRCLIB 的覆盖率和可用性不确定，歌词版权责任由用户本人承担。Spotify 播放旁边的歌词可能符合“其他服务”条款，在车上启用卡片则会碰上 Approved Devices 条款。用户本人每 6 个月要重新关联一次 Spotify。

### 方案 B：方案 A 加上明确的控制

- **提供什么。** 卡片上的暂停、继续、±30 秒以及下一章或上一章按钮；一个设备菜单，提供一键“Play in car”或“Play on phone”（`PUT /me/player` 带 `play: true`，只在点按时调用）；以及一个可选的“Pause Spotify?”提示，在同一设备上开始播放 Yolo 视频时出现。只有在用户本人接受政策风险之后，才提供 MCP 工具，让 agent 回答“我听到第几章了？”和“把我的书转到车上播”。
- **Agent 工具。** 只在收到明确请求时才行动的 `control` 入口工具：`spotify_now_playing`、`spotify_devices`、`spotify_control`（暂停、继续、下一首、上一首和跳转）、`spotify_transfer`，以及针对已保存有声书的 `spotify_play_audiobook`。它们的名字可以带“spotify”，因为它们位于 `plugins/` 里。
- **Scope。** 方案 A 的 scope，加上 `user-modify-playback-state`，可选再加 `user-library-read`。
- **工作量。** 在方案 A 之上为小到中：外部会话上的 `act()`、按钮、五个工具，以及用户本人检查 P2 和 P3。
- **风险。** AI 和语音条款直接适用于 MCP 工具，这是最大的政策风险。车上的控制取决于 P2，从指定章节开始播放未经证实。没有速度控制，Player 调用之间也没有顺序保证。

### 方案 C：方案 B 加上“Play here”

- **提供什么。** 在手机或电脑上，一次点按就把 Spotify 的播放转到 Yolo 里，旁边显示歌词或文字。播放器跳转到同源、不带 COEP 的 `/listen` 页面，由它创建 SDK 播放器，并用 `play: true` 转移播放。
- **Scope。** 方案 B 的 scope，加上 `streaming`、`user-read-email` 和 `user-read-private`。
- **工作量。** 中到大：一个由插件提供、带有自己响应头的页面，third-party-origins 测试里的一个例外，内容安全策略里给 `sdk.scdn.co` 留的位置，iOS 上播放前的那次点按，以及把 access token 交给这个页面。
- **风险。** SDK 没有记录章节，而且 SDK 在 iOS 上有限制，过去也多次失效。它不适用于车：车不是 Approved Device，Widevine 和行驶中的音频都未经证实（P4）。它为一个路径放弃了“Yolo 的每个页面都是跨源隔离的”，并且以最少的收益带来最多的新增面，因为在手机上 Spotify 应用本来就能播放。

## 曾考虑的替代方案

**把 Spotify 做成片源插件。** 片源返回一个由节点提供的 Input，所以 Spotify 的音频必须经过节点。它受 DRM 保护，提取或转发它都越过了边界。

**把 Spotify 会话放进 Hub。** 把 Spotify 的条目放进 Hub 的队列和播放状态，会让 Yolo 声称拥有它并不具备的控制权，而 Spotify 的政策禁止把它的内容与其他服务的流整合在一起。所以外部卡片放在 Hub 状态的旁边。

**Spotify 的私有接口，例如 `color-lyrics`。** 它们提供 Spotify 自己的同步歌词，但没有公开文档，需要网页播放器的 token，随时可能变化，还违反条款中的“不当访问”条款。

**用 Musixmatch 提供歌词。** 它是 Spotify 自家歌词背后的授权来源，但同步歌词需要付费的 Grow 套餐，价格未经证实。歌词查询不绑定具体服务商，所以以后可以用一个 Musixmatch 插件替换 LRCLIB。

**播放器直接调用 LRCLIB。** 这样更简单，但播放器不得引用其他主机，这样第三方才无法得知每块屏幕的地址；而且节点会把结果缓存在磁盘上。

**把 Spotify 的进度镜像到 Yolo 的历史记录里。** 这样历史记录就能显示有声书，但 Spotify 已经跨设备保存续播点，而且条款禁止无限期存储 Spotify Content。

**在 Hub Durable Object 里或用 cron 轮询。** Hub 会为不属于它的状态消耗 Durable Object 的请求数和运行时长，cron 触发器则会在没人看的时候也轮询。由可见页面轮询的普通 Worker 路由只消耗 Worker 请求。

**在播放器页面上运行 Web Playback SDK。** COEP 会阻止 SDK 的 iframe，`<iframe credentialless>` 只有 Chrome 支持，而且 SDK 创建 iframe 时本来就不带这个属性。从播放器上去掉 COEP 会破坏 canvas 引擎的音频时钟。

**用弹出窗口运行 SDK。** 播放器的 COOP 会切断弹出窗口和打开者之间的联系，两个页面只能经 Hub 通信，而且特斯拉浏览器里的弹出窗口未经证实。

**像 DNS provider 插件那样使用 Worker secret。** [DNS provider 插件](../../implemented/architecture/2026-10-14-dns-provider-plugins.zh.md)读取的是用户本人在设置时用 `wrangler secret put` 存好的固定 token。Spotify 的 refresh token 则是在运行时经用户本人的回调拿到的，每次刷新都可能变化，并且属于某一个用户，所以它需要 Worker 能够写入的按用户存储。

**带 client secret 的 Authorization Code 流程。** 有安全后端时 Spotify 接受这种流程，但 PKCE 不需要存储任何 secret，只需把 Client ID 放进插件的 options。

**现在就做方案 C，或让 Yolo 在车上成为 Spotify 设备。** 这是把音频转进 Yolo 的唯一办法，但在手机和电脑上 Spotify 应用本来就能播放；在车上，它不在许可范围内，Widevine 和行驶中的音频也都未经证实。

**从音频获取书的文字。** 转写 Spotify 的音频或对它做强制对齐可以得到逐词的文字，但这要处理受 DRM 保护的音频，而边界禁止这样做。

## 验收标准

以方案 A 作为第一次构建：

- `service/` 不出现任何服务商的名字，并且在 `plugins/` 里有 Spotify 插件时 `npm run check` 通过。
- 不启用插件时，Yolo 的行为和以前一样。
- 用户本人从 `/account` 关联一次 Spotify。refresh token 加密封存在按用户划分的表里，“Disconnect Spotify”会删除它。
- 网页模式的屏幕显示一张卡片，上面有正在播放的歌曲或章节、Spotify 设备、播放位置、Spotify 的标志、“Open in Spotify”链接和未裁剪的封面。204 显示为未知，而不是已停止。除非用户本人打开，车机模式不显示卡片。
- 歌词面板显示跟随播放位置的 LRCLIB 同步歌词，并注明来自 LRCLIB。
- Yolo 不调用任何 Spotify 写接口或未公开的 Spotify 接口，也不把任何 Spotify 条目写进队列或历史记录。Spotify 的音频不经过节点，也不经过 Worker。
- 页面隐藏时轮询停止，轮询也从不经过 Hub Durable Object。
- `npm run yolo -- doctor` 在 refresh token 过期前 14 天发出警告。

## 风险

- **政策。** AI、语音和其他服务条款可能被解读为涵盖 Yolo 的 agent 工具和它显示的歌词，而 Spotify 的处置是撤销访问权限。车不是 Approved Device。
- **平台变化。** Spotify 在 2024、2025 和 2026 年都收紧了开发者访问，`additional_types`“将来可能弃用”，速率限制也没有公布，所以这个功能可能毫无预兆地失效。Premium 失效会让应用停止工作。
- **未经证实的前提。** `/me/player` 里的有声书章节、Spotify 状态的延迟、车作为 Connect 目标、从指定章节开始播放，以及 SDK 里的章节，都有待用户本人检查。
- **维护负担。** 用户本人要创建自己的 Spotify 应用，一直作为它的白名单用户，并每 6 个月重新关联一次 Spotify。
- **LRCLIB。** 它是免费的社区服务，冷门歌曲的覆盖率和服务可用性都不确定，歌词版权责任由用户本人承担。
- **放弃了什么。** Yolo 不能控制播放速度，拿不到 Spotify 的有声书文字，车上默认也没有 Spotify 卡片；方案 C 还会留下一个不是跨源隔离的路径。
