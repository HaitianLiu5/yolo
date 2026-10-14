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

约定：

- 读取类工具标 `readOnlyHint`，删除类标 `destructiveHint`；其余写操作都显式标 `destructiveHint: false`，因为 MCP 把没有注解的工具当成 destructive。
- 每个工具只要求一个 scope：读取类工具要 `read`；`play`、`control`、`seek`、`skip`、`transfer`、`set_tracks` 要 `control`；修改队列、播放列表或设备的工具要 `manage`。
- `item_id` 是片库条目 id，格式为 `<片源>:<id>`（例如 `plex:<ratingKey>`）；`list_tracks` 和读取条目的工具（`get_item`、文字稿工具、`get_chapters`、`get_frame` 和 `get_storyboard`）也接受 URL。
- 工具描述不提具体的片源或网站：能播哪些网站、有哪些片库，取决于节点上的片源插件。控制面插件可以用同一套 scope 添加工具（[插件架构](../architecture/2026-10-11-plugin-architecture.zh.md)）。
- `play` 不带 `start_at` 时续播：先用 Yolo 的历史，没有时用片源自己的进度（[进度和续播](2026-10-11-yolo-owns-progress-and-resume.zh.md)）。
- 工具把结果作为 JSON 文本返回，除非它自己给出内容块：`get_frame` 和 `get_storyboard` 返回一个图片块和一个文本块。
- 工具出错时返回 `isError: true`，内容是 `/v1` 的错误 JSON。

服务描述（[`service/control/src/mcp/server.js`](../../../../service/control/src/mcp/server.js)）写清楚：Yolo 是什么（媒体服务，不是「YOLO mode」）；agent 先搜索再播放，不要猜 id；默认在当前设备上播放；以及哪些工具用来了解正在播放的内容。[`skills/yolo/SKILL.md`](../../../../skills/yolo/SKILL.md) 是使用这个服务的 agent 技能，[`skills/yolo-connect-agent`](../../../../skills/yolo-connect-agent/SKILL.md) 把 Claude Code、claude.ai、ChatGPT 和 Codex 连到它上面。

<a id="understanding-what-plays"></a>

### 了解正在播放的内容

有八个工具让 agent 不只是播放，还能理解一个条目、在里面跳转；不带 `item_id` 时，它们读的是正在播放的条目。它们的回答都很紧凑，因为 agent 要为每个 token 付费：只列有值的字段，音轨条目只给要点，文字稿是一行行文本。它们用到的片源能力都是可选的，缺了都有退路（[片源插件 API](../architecture/2026-10-11-source-plugin-api.zh.md)）。

- **文字稿**（`get_transcript`、`search_transcript`）读取节点本来就以 WebVTT 交付的文字字幕或自动字幕：先用正在播放的会话的 `subtitle(trackId)`，否则用片源的 `subtitle(source, trackId)`。节点（[`service/node/src/transcripts.js`](../../../../service/node/src/transcripts.js)）把 WebVTT 解析成字幕条，去掉滚动字幕重复的行，并按条目和字幕轨缓存字幕条（24 项、800 万字符、一小时）。它返回 `m:ss 文本` 形式的行：默认是正在播放的条目当前位置前后各一分钟，其他条目则从头开始；每页最多 `max_chars` 个字符（默认 6,000，最多 20,000），`nextFrom` 给出下一页的起点。搜索不区分大小写、重音和标点：先跨字幕条匹配整个短语，再找一条字幕里包含全部词的位置，再找相隔不超过 20 秒的两三条字幕里包含全部词的位置，并给出以秒计的 `at` 供 `seek` 使用。字幕轨按以下顺序选：指定的那条（`track` 或 `language`），否则已选中的文字字幕，否则片源的默认字幕，否则一条不是自动生成的文字字幕。图形字幕是图片，所以指定图形字幕，或条目只有图形字幕时，会返回说明原因的错误；仍在提取中的字幕返回可重试的 `resolve_failed`。
- **章节和标记**（`get_chapters`）来自片源的 `chapters()`，在 [`service/core/src/insight.js`](../../../../service/core/src/insight.js) 里统一成 `{ start, end, kind, title? }`，`kind` 是 `chapter`、`intro` 或 `credits`。`skip` 通过 Hub 现有的跳转来跳：跳过当前所在的片头（片头标记，或标题像片头的章节），或跳到下一章、上一章。不在片头里时，它会说明片头在哪里，而不是把片头之前的内容一起跳过。
- **详情**（`get_item`）来自片源的 `details()`，形状统一（简介、带角色的人员、日期、类型、标签、评分、剧集信息、制片公司和各种计数），由核心裁剪并限制长度；没有 `details()` 的片源给出 `describe()` 知道的内容。控制面再加上条目的音轨字幕，以及用户在 Yolo 历史里的进度；Yolo 没有记录时，用片源自己的记录。
- **播放健康**（`get_playback_health`）由 Hub（[`service/control/src/hub/playback-health.js`](../../../../service/control/src/hub/playback-health.js)）根据它为每台设备保存的信息组装：最近一次加载的流（交付方式、片源给出的规格和码率上限）、设备报告的媒体路径、最近 30 分钟内的重建和出错（最多 12 条），以及播放器附在汇报里的 `health`（[Hub 和实时通道](../architecture/2026-10-07-hub-and-realtime-channel.zh.md)）。它还给出简短提示：正在缓冲或缓冲很少、测得的吞吐量低于这路流的需要、最近 5 分钟内一秒以上的卡顿、自适应画质的上限、走中继以及每个失败的探测、出错后的重建。
- **画面**（`get_frame`，以及把均匀分布、标好时间的画面排成网格的 `get_storyboard`）由节点从片源读取，不经过屏幕，以 MCP 图片内容块加几行说明返回（[视频画面](2026-10-13-video-frames.zh.md)）。

这些工具只需要现有的 scope：`skip` 要 `control`，其余要 `read`。

## 曾考虑的替代方案

**保留 CLI。** 它只在 agent 有本地 shell 的地方可用；ChatGPT 和 claude.ai 用不了。

**本地 stdio MCP 包。** 只有 Claude Code 和 Claude Desktop 能用本地 MCP 服务；ChatGPT 和 claude.ai 要求公网 HTTPS 地址。

**用语音模型转写音频。** 这需要在节点上跑模型或调用付费 API，长片要几分钟；而片源已经交付的字幕和自动字幕，正是用户在屏幕上看到的文字。

**返回原始 WebVTT，或在控制面切分。** 两小时的字幕有几百 KB；节点在缓存旁边切分和搜索，只发出需要的那一页，隧道和 agent 的 token 都不必承载其余部分。

**播放健康只放在 Workers Logs 里。** 设备遥测已经写在那里（[设备遥测](2026-10-11-device-telemetry.zh.md)），但 agent 查不了日志。所以 Hub 为每台设备保存最新一次汇报，播放时大约每 15 秒写一次存储。

## 后果

任何支持远程服务和 OAuth 的 MCP 客户端，用一个 URL 就能控制 Yolo，而工具通过共用的服务层与 `/v1` 保持一致。MCP 服务属于核心，不能关掉；插件可以扩展它，但不能移除它。agent 能说出刚才说了什么、谁出演、为什么在缓冲，也能按台词跳到某个时刻。文字稿的质量取决于字幕：没有文字字幕的条目就没有文字稿，搜索匹配的是词语而不是意思。
