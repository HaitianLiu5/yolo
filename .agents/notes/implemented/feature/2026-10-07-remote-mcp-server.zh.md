# Agent Note: agent 通过远程 MCP 服务控制 Yolo

Status: implemented

[English](2026-10-07-remote-mcp-server.md) | 中文

## 问题

agent（智能体）以前通过本地 CLI 加一个 agent 技能来控制最初只面向特斯拉的播放器，只有在 agent 能使用用户本人机器上的 shell 时才行得通。ChatGPT 和 claude.ai 用不了本地 CLI，也用不了本地 stdio MCP 服务：它们需要带 OAuth 的公网 HTTPS 地址。目标是类似 agentic trading 应用的体验：给 agent 一个远程 MCP 地址，批准一次，它就能操作。

## 决策

控制面在 `/mcp` 用 Streamable HTTP 提供名为 `yolo` 的**远程 MCP 服务**，前面是 [OAuth 授权服务器](../architecture/2026-10-07-oauth-authorization-server.zh.md)；CLI 已经去掉（[一个仓库](../process/2026-10-07-one-yolo-repository.zh.md)）。工具定义在 [`service/control/src/mcp/tools.js`](../../../../service/control/src/mcp/tools.js)，和 [`/v1` API](../architecture/2026-10-07-v1-http-api.zh.md) 调用同一层服务。

| 工具 | 参数 | 注解 |
|---|---|---|
| `get_status` | 无 | readOnly |
| `list_devices` | 无 | readOnly |
| `rename_device` | `device, name?, kind?` | 改设备名称或类型；`device` 是设备 id 或现在的名称 |
| `remove_device` | `device` | destructive；删除设备并撤销它的凭据 |
| `search` | `query, type?` | readOnly；在片库里搜索，或解析出网址的标题 |
| `browse` | `library_id?, item_id?` | readOnly |
| `play` | `url? \| item_id? \| queue_item_id?, device?, start_at?` | |
| `control` | `action: pause\|resume\|stop\|next\|previous` | |
| `seek` | `position_seconds` | |
| `transfer` | `device` | |
| `list_tracks` | `item_id?` | readOnly |
| `set_tracks` | `subtitles?: string[], audio?: string` | |
| `queue_list` / `queue_add` / `queue_remove` | `url \| item_id, position?` / `queue_item_id` | `queue_list` 为 readOnly；删除为 destructive |
| `queue_clear` | 无 | destructive |
| `playlist_list` / `playlist_get` | `playlist_id?` | readOnly |
| `playlist_create` / `playlist_add` / `playlist_import` / `playlist_enqueue` | 各自的参数 | |
| `playlist_delete` | `playlist_id` | destructive |
| `history` | `limit?` | readOnly |
| `get_item` | `item_id?` | readOnly；详情、音轨字幕和用户的进度 |
| `get_transcript` | `item_id?, from_seconds?, to_seconds?, language?, track?, max_chars?` | readOnly |
| `search_transcript` | `query, item_id?, language?, track?, limit?` | readOnly |
| `get_chapters` | `item_id?` | readOnly |
| `skip` | `to: intro\|next_chapter\|previous_chapter` | 通过 Hub 跳转 |
| `get_playback_health` | `device?` | readOnly |
| `get_frame` | `time?, item_id?, width?` | readOnly；视频的一张 JPEG，默认取正在播放的条目当前位置的画面（[视频画面](2026-10-13-video-frames.zh.md)） |
| `get_storyboard` | `item_id?, from?, to?, count?, width?` | readOnly；把条目中均匀分布、标好时间的画面排成网格的一张 JPEG，默认取正在播放的条目（[故事板](2026-10-13-video-frames.zh.md#storyboards)） |
| `get_comments` | `item_id?, at?, window?, limit?` | readOnly；某个时刻前后观众的时间轴评论（弹幕），默认取当前位置（[弹幕](2026-10-13-danmaku.zh.md)） |
| `set_danmaku` | `device?, enabled?, density?, opacity?, area?, font_size?` | 在一块屏幕上显示、隐藏弹幕或改变弹幕样式 |

约定：

- 读取类工具标 `readOnlyHint`，删除类标 `destructiveHint`；其余写操作都显式标 `destructiveHint: false`，因为 MCP 把没有注解的工具当成 destructive。
- 每个工具只要求一个 scope：读取类工具要 `read`；`play`、`control`、`seek`、`skip`、`transfer`、`set_tracks`、`set_danmaku` 要 `control`；修改队列、播放列表或设备的工具要 `manage`。
- `item_id` 是片库条目 id，格式为 `<片源>:<id>`（例如 `plex:<ratingKey>`）；`list_tracks` 和读取条目的工具（`get_item`、文字稿工具、`get_chapters`、`get_frame`、`get_storyboard` 和 `get_comments`）也接受 URL。
- 工具描述不提具体的片源或网站：能播哪些网站、有哪些片库，取决于节点上的片源插件。控制面插件可以用同一套 scope 添加工具（[插件架构](../architecture/2026-10-11-plugin-architecture.zh.md)）。
- `play` 不带 `start_at` 时续播：先用 Yolo 的历史，没有时用片源自己的进度（[进度和续播](2026-10-11-yolo-owns-progress-and-resume.zh.md)）。
- 工具把结果作为 JSON 文本返回，其中每个 `thumbnail` 都是图片链接（[封面图片](#cover-images)），除非它自己给出内容块：`get_frame` 和 `get_storyboard` 返回一个图片块和一个文本块。
- 工具出错时返回 `isError: true`，内容是 `/v1` 的错误 JSON。

服务描述（[`service/control/src/mcp/server.js`](../../../../service/control/src/mcp/server.js)）写清楚：Yolo 是什么（媒体服务，不是「YOLO mode」）；agent 先搜索再播放，不要猜 id；默认在当前设备上播放；哪些工具用来了解正在播放的内容；以及怎样显示封面。[`skills/yolo/SKILL.md`](../../../../skills/yolo/SKILL.md) 是使用这个服务的 agent 技能，[`skills/yolo-connect-agent`](../../../../skills/yolo-connect-agent/SKILL.md) 把 Claude Code、claude.ai、ChatGPT 和 Codex 连到它上面。

<a id="understanding-what-plays"></a>

### 了解正在播放的内容

有九个工具让 agent 不只是播放，还能理解一个条目、在里面跳转；不带 `item_id` 时，它们读的是正在播放的条目。它们的回答都很紧凑，因为 agent 要为每个 token 付费：只列有值的字段，音轨条目只给要点，文字稿是一行行文本。它们用到的片源能力都是可选的，缺了都有退路（[片源插件 API](../architecture/2026-10-11-source-plugin-api.zh.md)）。

- **文字稿**（`get_transcript`、`search_transcript`）读取节点本来就以 WebVTT 交付的文字字幕或自动字幕：先用正在播放的会话的 `subtitle(trackId)`，否则用片源的 `subtitle(source, trackId)`。节点（[`service/node/src/transcripts.js`](../../../../service/node/src/transcripts.js)）把 WebVTT 解析成字幕条，去掉滚动字幕重复的行，并按条目和字幕轨缓存字幕条（24 项、800 万字符、一小时）。它返回 `m:ss 文本` 形式的行：默认是正在播放的条目当前位置前后各一分钟，其他条目则从头开始；每页最多 `max_chars` 个字符（默认 6,000，最多 20,000），`nextFrom` 给出下一页的起点。搜索不区分大小写、重音和标点：先跨字幕条匹配整个短语，再找一条字幕里包含全部词的位置，再找相隔不超过 20 秒的两三条字幕里包含全部词的位置，并给出以秒计的 `at` 供 `seek` 使用。字幕轨按以下顺序选：指定的那条（`track` 或 `language`），否则已选中的文字字幕，否则片源的默认字幕，否则一条不是自动生成的文字字幕。图形字幕是图片，所以指定图形字幕，或条目只有图形字幕时，会返回说明原因的错误；仍在提取中的字幕返回可重试的 `resolve_failed`。
- **章节和标记**（`get_chapters`）来自片源的 `chapters()`，在 [`service/core/src/insight.js`](../../../../service/core/src/insight.js) 里统一成 `{ start, end, kind, title? }`，`kind` 是 `chapter`、`intro` 或 `credits`。`skip` 通过 Hub 现有的跳转来跳：跳过当前所在的片头（片头标记，或标题像片头的章节），或跳到下一章、上一章。不在片头里时，它会说明片头在哪里，而不是把片头之前的内容一起跳过。
- **详情**（`get_item`）来自片源的 `details()`，形状统一（简介、带角色的人员、日期、类型、标签、评分、剧集信息、制片公司和各种计数），由核心裁剪并限制长度；没有 `details()` 的片源给出 `describe()` 知道的内容。控制面再加上条目的音轨字幕、用户在 Yolo 历史里的进度（Yolo 没有记录时，用片源自己的记录），以及 Yolo 从正在播放的内容或历史里知道的封面。
- **播放健康**（`get_playback_health`）由 Hub（[`service/control/src/hub/playback-health.js`](../../../../service/control/src/hub/playback-health.js)）根据它为每台设备保存的信息组装：最近一次加载的流（交付方式、片源给出的规格和码率上限）、设备报告的媒体路径、最近 30 分钟内的重建和出错（最多 12 条），以及播放器附在汇报里的 `health`（[Hub 和实时通道](../architecture/2026-10-07-hub-and-realtime-channel.zh.md)）。它还给出简短提示：正在缓冲或缓冲很少、测得的吞吐量低于这路流的需要、最近 5 分钟内一秒以上的卡顿、自适应画质的上限、走中继以及每个失败的探测、出错后的重建。
- **画面**（`get_frame`，以及把均匀分布、标好时间的画面排成网格的 `get_storyboard`）由节点从片源读取，不经过屏幕，以 MCP 图片内容块加几行说明返回（[视频画面](2026-10-13-video-frames.zh.md)）。
- **观众评论**（`get_comments`）是条目的时间轴评论，来自节点的评论缓存，由片源的 `comments()` 填充（[弹幕](2026-10-13-danmaku.zh.md)）：取 `at`（默认是正在播放条目的位置，否则为 0）前后 `window` 秒（默认 30，最多 120）内的评论，按时间顺序给出 `{ t, text }`。同一句话说了多次合并成一条，带次数 `n`，时间取第一次；超过 `limit`（默认 60，最多 200）时，保留重复最多和离 `at` 最近的。条目没有评论时回答 `available: false`，并附一句说明，指出是不是片源根本不提供评论。

这些工具只需要现有的 scope：`skip` 要 `control`，其余要 `read`。

<a id="cover-images"></a>

### 封面图片

工具结果里的条目用 `thumbnail` 带出封面。在 `/v1` 上，它是需要设备凭据的路径（`/v1/library/items/<id>/artwork?variant=…`），或者是另一台主机上的图片，屏幕通过 `/v1/thumbnail` 加载。ChatGPT 和 Claude 加载图片时不带凭据，也不知道 Yolo 的源（origin），所以以前显示破图，或者自己编造图片地址。因此 MCP 结果把每个 `thumbnail` 换成**图片链接**：`PUBLIC_ORIGIN` 上的绝对 URL，不带凭据就能加载（[`service/control/src/image-links.js`](../../../../service/control/src/image-links.js)）：

- **只有一个字段。** MCP 层把工具结果里（包括嵌套条目里）的每个 `thumbnail` 换成它的链接；它指的不是 Yolo 能提供的图片时，换成 null。`/v1` 和播放器继续用需要凭据的路径。agent 只看到一个图片字段，而且它总能加载。
- **链接**是 `https://<origin>/i/<token>`。token（[`service/core/src/signing.js`](../../../../service/core/src/signing.js) 里的 `sealImageLink`）用确定性认证加密封装用户 id 和图片（片库条目的 id 和封面规格，或另一台主机上图片的 http(s) URL）：对密钥版本和内容计算 HMAC-SHA256，取前 16 字节作为标签，再以这个标签为计数器，用 AES-CTR 加密内容。token 里没有任何明文，改动任何一个字节都会让标签校验失败。两把密钥都由 Worker 密钥 `NODE_SECRET` 通过 HKDF 派生，用的标签是 `yolo image links` 加上密钥版本；密钥版本以明文放在 token 里。同一张图片在同一个密钥版本下总是得到同一个链接，所以客户端可以缓存；链接没有有效期，所以几个月后的聊天里也还能显示。
- **重置。** 用户的密钥版本存在 D1 里（`image_links` 表；没有这一行就是版本 1）。在设置里**重置图片链接**（`POST /v1/owner/image-links/reset`，会写一行 `kind: "security"` 日志），或者运行 `npm run yolo -- image-links reset`，版本就加一，之前的每个链接都返回 `410`。每次返回封面的工具调用都从 D1 读取版本。`/i/*` 在每个 isolate 里把版本保留 30 秒；遇到比所保留版本更新的链接时，它会重新读 D1。所以重置在 30 秒内到达所有 isolate，重置之后发出的链接立即可用。换一个 `NODE_SECRET` 也会让所有链接失效。
- **`/i/*` 提供什么。** 两种图片：片库条目的封面，经节点取得，和 `/v1/library/items/<id>/artwork` 提供的相同；另一台主机上的图片，经节点的缩略图抓取取得，带着它全部的服务端请求伪造（SSRF）防护（[节点内部 API](../architecture/2026-10-07-node-internal-api.zh.md)）。只有 Yolo 自己结果里的 `thumbnail` 会被封装，agent 传入的 URL 永远不会，所以 `/i/*` 不是开放代理。它只响应 `GET` 和 `HEAD`，返回位图（JPEG、PNG、WebP、GIF 或 AVIF；其他类型返回 `502`），带 `Cache-Control: public, max-age=31536000, immutable`、`Cross-Origin-Resource-Policy: cross-origin`、`nosniff` 和一条沙箱 CSP。打不开的 token，或内容不是这样一张图片的 token，返回 `404`；失败的响应都是 `no-store`。`IMAGE_LIMIT` 绑定允许每个地址每分钟 120 个请求。这个路由列在 `assets.run_worker_first` 里，不发送 COOP 或 COEP；播放器页面保留自己的这两个头。
- **告诉 agent 怎么做。** 服务描述和返回条目的工具的描述都告诉 agent：原样显示 `thumbnail`，例如作为 Markdown 图片；为 null 时不显示图片；永远不要编造图片 URL。[`skills/yolo/SKILL.md`](../../../../skills/yolo/SKILL.md) 也这样写。

## 曾考虑的替代方案

**保留 CLI。** 它只在 agent 有本地 shell 的地方可用；ChatGPT 和 claude.ai 用不了。

**本地 stdio MCP 包。** 只有 Claude Code 和 Claude Desktop 能用本地 MCP 服务；ChatGPT 和 claude.ai 要求公网 HTTPS 地址。

**用语音模型转写音频。** 这需要在节点上跑模型或调用付费 API，长片要几分钟；而片源已经交付的字幕和自动字幕，正是用户在屏幕上看到的文字。

**返回原始 WebVTT，或在控制面切分。** 两小时的字幕有几百 KB；节点在缓存旁边切分和搜索，只发出需要的那一页，隧道和 agent 的 token 都不必承载其余部分。

**在 `thumbnail` 旁边加一个 `thumbnail_url`。** agent 会看到两个图片字段，其中一个对它永远加载不了，有的 agent 会显示错的那个；需要凭据的路径还要花 token，对 agent 毫无用处。

**会过期的签名 URL。** 聊天会在几天或几个月后被重新打开，那时封面早已失效。没有有效期、靠一次重置全部撤销的链接，能让旧聊天保持完整。

**为每张图片在 D1 或 KV 里存一个随机 token。** 每次搜索都要为每个封面写一行，而 Workers 免费版每天只允许 1,000 次 KV 写入；封装出来的 token 不需要存储，同一张图片总是同一个 token。

**把密钥版本放在 KV 里。** KV 的读取在边缘节点上可能滞后最多一分钟，重置到达所有 isolate 要更久；D1 本来就存着用户的设置，而且无论放哪里，重置都是很少的写入。

**把封面作为 MCP 图片块返回。** 图片块是给 agent 自己看的，而且每个结果的每个条目都要花 agent 的 token；一个链接只有几十个字符，图片由聊天界面显示。

**播放健康只放在 Workers Logs 里。** 设备遥测已经写在那里（[设备遥测](2026-10-11-device-telemetry.zh.md)），但 agent 查不了日志。所以 Hub 为每台设备保存最新一次汇报，播放时大约每 15 秒写一次存储。

## 后果

任何支持远程服务和 OAuth 的 MCP 客户端，用一个 URL 就能控制 Yolo，而工具通过共用的服务层与 `/v1` 保持一致。MCP 服务属于核心，不能关掉；插件可以扩展它，但不能移除它。agent 能说出刚才说了什么、谁出演、为什么在缓冲，也能按台词跳到某个时刻。文字稿的质量取决于字幕：没有文字字幕的条目就没有文字稿，搜索匹配的是词语而不是意思。

agent 能在 ChatGPT 和 Claude 里显示封面，聊天里的封面一直有效。任何拿到链接的人，例如被分享了这段聊天的人，都能看到那一张封面，并推断出这部作品在片库里，直到用户重置图片链接；封面的敏感度很低，这是让链接在旧聊天里一直有效的代价。客户端或代理已经缓存的副本在重置后仍然存在。聊天里显示的每张封面都是一次对 Worker 和节点的请求，计入 Workers 免费版的每日请求数。
