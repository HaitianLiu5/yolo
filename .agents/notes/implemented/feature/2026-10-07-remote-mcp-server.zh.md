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

约定：

- 读取类工具标 `readOnlyHint`，删除类标 `destructiveHint`；其余写操作都显式标 `destructiveHint: false`，因为 MCP 把没有注解的工具当成 destructive。
- 每个工具只要求一个 scope：读取类工具要 `read`；`play`、`control`、`seek`、`transfer`、`set_tracks` 要 `control`；修改队列、播放列表或设备的工具要 `manage`。
- `item_id` 是片库条目 id，格式为 `<片源>:<id>`（例如 `plex:<ratingKey>`）；`list_tracks` 也接受 URL。
- 工具描述不提具体的片源或网站：能播哪些网站、有哪些片库，取决于节点上的片源插件。控制面插件可以用同一套 scope 添加工具（[插件架构](../architecture/2026-10-11-plugin-architecture.zh.md)）。
- `play` 不带 `start_at` 时续播：先用 Yolo 的历史，没有时用片源自己的进度（[进度和续播](2026-10-11-yolo-owns-progress-and-resume.zh.md)）。
- 工具出错时返回 `isError: true`，内容是 `/v1` 的错误 JSON。

服务描述（[`service/control/src/mcp/server.js`](../../../../service/control/src/mcp/server.js)）写清楚三点：Yolo 是什么（媒体服务，不是「YOLO mode」）；agent 先搜索再播放，不要猜 id；默认在当前设备上播放。[`skills/yolo/SKILL.md`](../../../../skills/yolo/SKILL.md) 是使用这个服务的 agent 技能，[`skills/yolo-connect-agent`](../../../../skills/yolo-connect-agent/SKILL.md) 把 Claude Code、claude.ai、ChatGPT 和 Codex 连到它上面。

## 曾考虑的替代方案

**保留 CLI。** 它只在 agent 有本地 shell 的地方可用；ChatGPT 和 claude.ai 用不了。

**本地 stdio MCP 包。** 只有 Claude Code 和 Claude Desktop 能用本地 MCP 服务；ChatGPT 和 claude.ai 要求公网 HTTPS 地址。

## 后果

任何支持远程服务和 OAuth 的 MCP 客户端，用一个 URL 就能控制 Yolo，而工具通过共用的服务层与 `/v1` 保持一致。MCP 服务属于核心，不能关掉；插件可以扩展它，但不能移除它。
