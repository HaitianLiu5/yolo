# Agent Note: Agents control Yolo through a remote MCP server

Status: implemented

English | [中文](2026-10-07-remote-mcp-server.zh.md)

## Problem

Agents controlled Drive-In through a local CLI (`@drive-in/cli`) and an agent skill, which only works where an agent has a shell on the owner's machine. ChatGPT and claude.ai cannot use a local CLI or a local stdio MCP server: they need a public HTTPS address with OAuth. The aim was an experience like agentic trading apps: give the agent one remote MCP address, approve it once, and it can act.

## Decision

The control plane serves a **remote MCP server** named `yolo` over Streamable HTTP at `/mcp`, behind the [OAuth authorization server](../architecture/2026-10-07-oauth-authorization-server.md); the CLI is gone ([one repository](../process/2026-10-07-one-yolo-repository.md)). The tools are defined in [`service/control/src/mcp/tools.js`](../../../../service/control/src/mcp/tools.js) and call the same service layer as the [`/v1` API](../architecture/2026-10-07-v1-http-api.md).

| Tool | Arguments | Annotation |
|---|---|---|
| `get_status` | none | readOnly |
| `list_devices` | none | readOnly |
| `rename_device` | `device, name?, kind?` | Renames a device or changes its type; `device` is an id or the current name |
| `remove_device` | `device` | destructive; removes the device and revokes its credential |
| `search` | `query, type?` | readOnly; searches the libraries, or resolves a URL's title |
| `browse` | `library_id?, item_id?` | readOnly |
| `play` | `url? \| item_id? \| queue_item_id?, device?, start_at?` | |
| `control` | `action: pause\|resume\|stop\|next\|previous` | |
| `seek` | `position_seconds` | |
| `transfer` | `device` | |
| `list_tracks` | `item_id?` | readOnly |
| `set_tracks` | `subtitles?: string[], audio?: string` | |
| `queue_list` / `queue_add` / `queue_remove` | `url \| item_id, position?` / `queue_item_id` | `queue_list` readOnly; removal destructive |
| `queue_clear` | none | destructive |
| `playlist_list` / `playlist_get` | `playlist_id?` | readOnly |
| `playlist_create` / `playlist_add` / `playlist_import` / `playlist_enqueue` | their own arguments | |
| `playlist_delete` | `playlist_id` | destructive |
| `history` | `limit?` | readOnly |

Conventions:

- Read tools are annotated `readOnlyHint`, removals `destructiveHint`; every other write tool sets `destructiveHint: false` explicitly, because MCP treats a tool without annotations as destructive.
- Each tool needs exactly one scope: read tools need `read`; `play`, `control`, `seek`, `transfer`, and `set_tracks` need `control`; tools that change the queue, playlists, or devices need `manage`.
- `item_id` is a library item id, `<source>:<id>` (for example `plex:<ratingKey>`); `list_tracks` also accepts a URL.
- Tool descriptions name no specific source or website: which sites and libraries work depends on the node's source plugins. Control-plane plugins may add tools with the same scopes ([plugin architecture](../architecture/2026-10-11-plugin-architecture.md)).
- `play` without `start_at` resumes: Yolo's history first, then the source's own position ([progress and resume](2026-10-11-yolo-owns-progress-and-resume.md)).
- A failing tool returns `isError: true` with the `/v1` error JSON.

The server description ([`service/control/src/mcp/server.js`](../../../../service/control/src/mcp/server.js)) states three things: what Yolo is (a media service, not "YOLO mode"), that agents search before playing instead of guessing ids, and that playback goes to the active device by default. [`skills/yolo/SKILL.md`](../../../../skills/yolo/SKILL.md) is the agent skill for using the server, and [`skills/yolo-connect-agent`](../../../../skills/yolo-connect-agent/SKILL.md) connects Claude Code, claude.ai, ChatGPT, and Codex to it.

## Alternatives considered

**Keep the CLI.** It works only where an agent has a local shell; ChatGPT and claude.ai cannot use it.

**A local stdio MCP package.** Only Claude Code and Claude Desktop can use a local MCP server; ChatGPT and claude.ai require a public HTTPS address.

## Consequences

Any MCP client that supports remote servers and OAuth can control Yolo with one URL, and the tools stay in step with `/v1` through the shared service layer. The MCP server is core and cannot be turned off; plugins extend it but cannot remove it. `@drive-in/cli` remains on npm until the owner deprecates it.
