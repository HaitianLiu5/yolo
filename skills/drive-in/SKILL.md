---
name: drive-in
description: >
  Play and control videos on the owner's screens, such as the Tesla in-car
  browser (Drive-In), through the Yolo MCP server. Use for web video URLs and
  the home media library: search, play, pause, seek, subtitles, audio tracks,
  queues, playlists, history, and devices.
tags:
  - tesla
  - media
  - video
  - mcp
  - player
---

# Drive-In on Yolo

Drive-In is Yolo's Tesla client. Yolo is the owner's private media service, not a "YOLO mode" or auto-approve setting. Agents control it through Yolo's remote MCP server; there is no CLI any more.

## Setup

Add the remote MCP server once and sign in through its OAuth flow (the owner signs in with a passkey and approves the app):

```text
https://yolo.haitian.site/mcp
```

In Claude Code: `claude mcp add --transport http yolo https://yolo.haitian.site/mcp`. The server is named `yolo`; its tools need the `read`, `control` and `manage` scopes.

The car must be paired once: open `https://yolo.haitian.site` in the Tesla browser, scan the QR code with a phone, set its name and type (the car's browser cannot tell it is a car, so it may suggest "Browser"), and press Allow. A paired screen appears in `list_devices`.

## Operating rules

- Search or browse before playing a library item; never guess an item id. A URL the user gives can be played directly.
- Playback goes to the active device. Pass `device` only when the user names one (`list_devices` shows names and ids).
- Call `get_status` before changing tracks or seeking, and `list_tracks` before `set_tracks`.
- Without `start_at`, `play` resumes where the user left off (Yolo's history, else the library's own position). Pass `start_at: 0` to start over.
- If a tool returns `node_offline`, the home media node is down: queue, playlists and history still work; playing and browsing the library do not.
- If it returns `device_offline`, the car's browser is not open (or asleep). Ask the user to open Yolo there.
- Report tool errors as they are; do not claim playback started when `play` failed.

## Tools

| Need | Tool |
|---|---|
| What is playing, where, and what is next | `get_status` |
| Screens that can play | `list_devices`; `rename_device` sets a screen's name or type; `remove_device` revokes a paired screen |
| Find something | `search` (a title, or a URL to resolve), `browse` (libraries, a library's items, a show's episodes) |
| Play | `play` with `url`, `item_id` or `queue_item_id`, optional `device` and `start_at` |
| Pause, resume, stop, next, previous | `control` |
| Jump | `seek` with `position_seconds` |
| Move playback to another screen | `transfer` |
| Subtitles and audio | `list_tracks`, then `set_tracks` (`subtitles: []` turns them off; two subtitle ids show two languages) |
| Queue | `queue_list`, `queue_add` (`position: "next"` or `"end"`), `queue_remove`, `queue_clear` |
| Playlists | `playlist_list`, `playlist_get`, `playlist_create`, `playlist_add`, `playlist_import` (a playlist URL from a video site), `playlist_enqueue`, `playlist_delete` |
| History | `history` |

Library item ids look like `<source>:<id>` (for example `plex:12345`), exactly as `search` and `browse` return them.

## Notes

- Text subtitles are drawn by the player; image subtitles are burned into the picture by the source, so switching to one reloads the stream at the same position.
- Subtitle and audio choices are remembered for the item, and the latest choice becomes the default for new items.
- Only one screen plays at a time; playing on another device stops the previous one.
