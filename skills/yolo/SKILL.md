---
name: yolo
description: >
  Play and control videos on the owner's screens, such as a Tesla's in-car
  browser or any other browser, through the owner's Yolo MCP server. Use for
  web video URLs and the home media library: search, play, pause, seek,
  subtitles, audio tracks, queues, playlists, history, and devices.
tags:
  - media
  - video
  - mcp
  - player
---

# Yolo

Yolo is the owner's private media service, not a "YOLO mode" or auto-approve setting. Each owner runs their own instance on their own domain; agents control it through that instance's remote MCP server.

## Setup

The server is `https://<the owner's Yolo address>/mcp`. In a clone of the Yolo repository the address is `https://` plus `domain` in `yolo.instance.json`; otherwise ask the owner. Connecting is described for Claude Code, claude.ai, ChatGPT, and Codex in [`skills/yolo-connect-agent`](../yolo-connect-agent/SKILL.md): the owner approves the agent once with their passkey. The server is named `yolo`; its tools need the `read`, `control`, and `manage` scopes.

A screen must be paired once: the owner opens the Yolo address in its browser (the Tesla browser, for the car), scans the QR code with a phone, checks the name and type Yolo suggests, and presses Allow. A paired screen appears in `list_devices`.

## Operating rules

- Search or browse before playing a library item; never guess an item id. A URL the user gives can be played directly.
- Playback goes to the active device. Pass `device` only when the user names one (`list_devices` shows names and ids).
- Call `get_status` before changing tracks or seeking, and `list_tracks` before `set_tracks`.
- Without `start_at`, `play` resumes where the user left off (Yolo's history, else the library's own position). Pass `start_at: 0` to start over.
- If a tool returns `node_offline`, the home media node is down or runs another release: queue, playlists and history still work; playing and browsing the library do not. The error message says which.
- If it returns `device_offline`, the screen's browser is not open (or asleep). Ask the user to open Yolo there.
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
