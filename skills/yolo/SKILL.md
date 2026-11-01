---
name: yolo
description: >
  Play, control, and understand videos on the owner's screens, such as a
  Tesla's in-car browser or any other browser, through the owner's Yolo MCP
  server. Use for web video URLs and the home media library: search, play,
  pause, seek, subtitles, audio tracks, queues, playlists, history, and
  devices, and for questions about what is playing: what was said, who is in
  it, its chapters, skipping the intro, why it buffers, and what is on screen
  ("show me what's on screen", "what happens at 12:34"), and storyboards to
  skim a video.
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
- Every screen plays on its own, with its own queue. Without `device`, a request goes to the one screen of the owner's that is playing. When it answers `device_ambiguous`, ask the user which screen (its `details` list them), then pass `device`; `nothing_playing` means nothing of the owner's plays. Pass `device` whenever the user names a screen (`list_devices` shows names, ids, and who watches where).
- A screen someone else is watching on (a family TV) answers `screen_busy` with what plays there: tell the user and ask, and pass `replace: true` only after they confirm.
- Each profile (the owner, Family, …) has its own history; `history` is the owner's unless you pass `profile`.
- Call `get_status` before changing tracks or seeking, and `list_tracks` before `set_tracks`.
- Without `start_at`, `play` resumes where the user left off (Yolo's history, else the library's own position). Pass `start_at: 0` to start over.
- If a tool returns `node_offline`, the home media node is down or runs another release: queue, playlists and history still work; playing and browsing the library do not. The error message says which.
- If it returns `device_offline`, the screen's browser is not open (or asleep). Ask the user to open Yolo there.
- To see what is on the screen, call `get_frame` without arguments: the item playing now, at its current position. For "what happens at 12:34", pass `time`; for an item that is not playing, also pass `item_id` (an item id or URL). The picture comes from the source, not from the screen, so it has no player controls or subtitles, and live streams have none. To skim a video, or to find the moment to look at, call `get_storyboard` first: one image of evenly spaced, labelled frames (12 by default, `from`/`to` for a part), then `get_frame` at the time that matters. Both need only the `read` scope; agents connected before they existed can call them without reconnecting.
- Show covers from `thumbnail` exactly as tools return them: an absolute image URL on the owner's Yolo that loads without signing in, also later in the chat. Put it in the reply as a Markdown image, such as `![Alien](https://<the owner's Yolo address>/i/…)`. When `thumbnail` is null or missing, show no image. Never make up, guess, shorten, or rewrite an image URL, and never build one from an item id.
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
| Continue one screen's item on another ("put it on the TV") | `transfer` with `device`, and `from` when it is unclear |
| Subtitles and audio | `list_tracks`, then `set_tracks` (`subtitles: []` turns them off; two subtitle ids show two languages) |
| Queue | `queue_list`, `queue_add` (`position: "next"` or `"end"`), `queue_remove`, `queue_clear` |
| Playlists | `playlist_list`, `playlist_get`, `playlist_create`, `playlist_add`, `playlist_import` (a playlist URL from a video site), `playlist_enqueue`, `playlist_delete` |
| History | `history` |
| What the item is: description, people, date, genres, ratings, episode, tracks, progress | `get_item` |
| What is said | `get_transcript` (a page of `m:ss text` lines), `search_transcript` (moments with `at` in seconds) |
| Chapters, intro and credits markers | `get_chapters`; `skip` with `to: "intro"`, `"next_chapter"`, or `"previous_chapter"` |
| Why playback stutters | `get_playback_health` |
| See the picture | `get_frame` with optional `time` (seconds or `"hh:mm:ss"`), `item_id` (an item id or URL), and `width` (default 1280): a JPEG, the title, the exact time used, and the source |
| Skim a video | `get_storyboard` with optional `item_id` (an item id or URL), `from`, `to`, `count` (2–30, default 12), and `width` per tile (default 320): one labelled grid and the tiles' times |
| What viewers write at a moment (danmaku) | `get_comments` with optional `item_id`, `at` (seconds; default the position), `window` (default 30, at most 120), and `limit` (default 60) |
| Show, hide, or restyle danmaku on a screen | `set_danmaku` with `enabled`, `density` (`low`, `normal`, `high`), `opacity` (0.2–1), `area` (`full`, `half`, `quarter`), `font_size` (`small`, `normal`, `large`), and optional `device` |

Library item ids look like `<source>:<id>` (for example `plex:12345`), exactly as `search` and `browse` return them.

## Understanding what plays

These tools read the playing item unless you pass `item_id` (a library item id or a URL). They answer compactly; ask for more only when you need it.

| The user says | Do |
|---|---|
| "What did they just say?" | `get_transcript` without a range: about a minute either side of the position. Quote the lines just before `position`. |
| "Go to where they talk about X" | `search_transcript` with words someone would say, then `seek` to the best match's `at`. If nothing matches, the topic was said in other words: read `get_transcript` pages (`from_seconds: 0`, then `nextFrom`) and pick the moment. |
| "Skip the intro" | `skip` with `to: "intro"`. If it answers that playback is not in the intro, it says where the intro is; `seek` past it only if the user meant that one. For end credits, use `control` with `next`. |
| "Next chapter", "what's in this video" | `skip` with `to: "next_chapter"`; `get_chapters` lists chapters with their start times. |
| "Who is in this?", "what is this about?" | `get_item`: `people` with roles (cast with characters, director, channel), `description`, and `series` for an episode. |
| "What are people saying here?" | `get_comments`: the comments around the position, the same text said many times as one entry with its count `n`. Sum up the mood and quote a few; say if the item has no comments (`available: false`). |
| "Turn off the danmaku", "make them smaller" | `set_danmaku` with `enabled: false`, or `font_size`, `opacity`, `area`, or `density`, on the screen that is playing unless the user names one. The screen keeps the setting for every video. |
| "Why is it buffering?" | `get_playback_health`: read `hints` first, then the buffer, measured throughput against the stream's bitrate, the media path (`lan`, `wan`, or `relay`) with each probe's outcome, and the quality cap. |

- Transcripts come from the item's text subtitles or captions. An item without them, or with only image subtitles (pictures), has no transcript; the error says which. A subtitle still being extracted answers a retryable `resolve_failed`: try again after the seconds it names.
- Transcript times are `m:ss` (`h:mm:ss` past an hour); `seek` takes seconds, and `search_transcript` gives `at` in seconds.
- Search matches words, ignoring case and accents: the whole phrase first, then all its words close together. Pass `language` (for example `"en"`) or a `track` id from `list_tracks` to read another subtitle track.
- Danmaku are timed viewer comments that a source offers, such as a Bilibili video's; most items have none. `get_comments` reads them without a screen; `set_danmaku` changes only what one screen shows, and needs that screen online.
- Playback health explains; it does not fix. Adaptive quality is the screen's own choice. Suggest what the hints point to: a screen at home that falls back to the relay may not be on the home network, and a weak connection in the car recovers when the signal does.

## Notes

- Text subtitles are drawn by the player; image subtitles are burned into the picture by the source, so switching to one reloads the stream at the same position.
- Subtitle and audio choices are remembered for the item, and the latest choice becomes the default for new items.
- Only one screen plays at a time; playing on another device stops the previous one.
