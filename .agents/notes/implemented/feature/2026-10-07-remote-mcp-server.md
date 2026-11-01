# Agent Note: Agents control Yolo through a remote MCP server

Status: implemented

English | [中文](2026-10-07-remote-mcp-server.zh.md)

## Problem

Agents controlled the original Tesla-only player through a local CLI and an agent skill, which only works where an agent has a shell on the owner's machine. ChatGPT and claude.ai cannot use a local CLI or a local stdio MCP server: they need a public HTTPS address with OAuth. The aim was an experience like agentic trading apps: give the agent one remote MCP address, approve it once, and it can act.

## Decision

The control plane serves a **remote MCP server** named `yolo` over Streamable HTTP at `/mcp`, behind the [OAuth authorization server](../architecture/2026-10-07-oauth-authorization-server.md); the CLI is gone ([one repository](../process/2026-10-07-one-yolo-repository.md)). The tools are defined in [`service/control/src/mcp/tools.js`](../../../../service/control/src/mcp/tools.js) and call the same service layer as the [`/v1` API](../architecture/2026-10-07-v1-http-api.md).

| Tool | Arguments | Annotation |
|---|---|---|
| `get_status` | none | readOnly; every screen's session (its screen, profile, item, position, status, whether it is in use, what plays next, and its queue in short), and `target`, the screen a command without `device` reaches now, or why none does |
| `list_devices` | none | readOnly; each screen with its default `profile` and its `session` in short, and the list of `profiles` |
| `rename_device` | `device, name?, kind?, profile?` | Renames a device, changes its type, or sets its default profile (a profile's name or id; `Family` makes that profile if there is none); `device` is an id or the current name |
| `remove_device` | `device` | destructive; removes the device and revokes its credential |
| `search` | `query, type?` | readOnly; searches the libraries, or resolves a URL's title |
| `browse` | `library_id?, item_id?` | readOnly |
| `play` | `url? \| item_id? \| queue_item_id?, device?, start_at?, replace?` | Plays on one screen; other screens play on. A named screen where another profile's session is in use is refused with `screen_busy` unless `replace` |
| `control` | `action: pause\|resume\|stop\|next\|previous, device?` | |
| `seek` | `position_seconds, device?` | |
| `transfer` | `device, from?, replace?` | Continues `from`'s session (else the default rule's) on `device` with its whole context, and `from` pauses; `screen_busy` when the target's session is in use, unless `replace` |
| `share` | `url? \| item_id?` | A link that plays one item in a friend's browser for 7 days; the answer is the only time it is shown ([share links](2026-10-20-share-links.md)) |
| `list_tracks` | `item_id?, device?` | readOnly |
| `set_tracks` | `subtitles?: string[], audio?: string, device?` | |
| `queue_list` / `queue_add` / `queue_remove` | `device?` / `url \| item_id, position?, count?, device?` / `queue_item_id, device?` | `queue_list` readOnly; removal destructive. `device` is the screen whose queue it is |
| `queue_clear` | `device?` | destructive |
| `playlist_list` / `playlist_get` | `playlist_id?` | readOnly |
| `playlist_create` / `playlist_add` / `playlist_import` / `playlist_enqueue` | their own arguments; `playlist_import` and `playlist_enqueue` take `device`, the screen whose queue gets the items | |
| `playlist_delete` | `playlist_id` | destructive |
| `history` | `limit?, profile?` | readOnly; a profile's history (its name or id), the owner's by default, each entry with the screen that played it last |
| `get_item` | `item_id?` | readOnly; details, tracks, and the user's progress |
| `match_item` | `item_id?, candidate? \| none? \| clear?` | Says which film or episode an item is a copy of, keeps it plain, or forgets the owner's choice ([metadata plugins](../architecture/2026-10-25-metadata-plugins.md)) |
| `search_metadata` | `query, kind?, year?` | readOnly; films and shows by name in the metadata plugins' records, for `match_item` |
| `get_transcript` | `item_id?, from_seconds?, to_seconds?, language?, track?, max_chars?` | readOnly |
| `search_transcript` | `query, item_id?, language?, track?, limit?` | readOnly |
| `get_chapters` | `item_id?` | readOnly |
| `skip` | `to: intro\|next_chapter\|previous_chapter, device?` | A seek through the Hub |
| `get_playback_health` | `device?` | readOnly |
| `get_frame` | `time?, item_id?, width?` | readOnly; one JPEG of a video, by default the item playing now at its position ([video frames](2026-10-13-video-frames.md)) |
| `get_storyboard` | `item_id?, from?, to?, count?, width?` | readOnly; one JPEG grid of evenly spaced, labelled frames of an item, by default the one playing now ([storyboards](2026-10-13-video-frames.md#storyboards)) |
| `get_comments` | `item_id?, at?, window?, limit?` | readOnly; viewers' timed comments (danmaku) around a moment, by default the position ([danmaku](2026-10-13-danmaku.md)) |
| `set_danmaku` | `device?, enabled?, density?, opacity?, area?, font_size?` | Shows, hides, or restyles danmaku on one screen |
| `offer` | `options: [{ item_id \| url \| label, note? }], title?, device?, wait_seconds?` | Shows up to six choices on a screen's [agent canvas](../../proposed/architecture/2026-10-21-agent-canvas.md) and waits up to 45 seconds for the pick, which the Hub plays or queues itself: `status` chosen, dismissed, waiting, or unsupported for a screen without a canvas |
| `canvas_read` | `device?` | readOnly; each screen's canvas, what it draws, and what it plays |
| `canvas_put` / `canvas_patch` | `kind, props, id?, surface?, layout?, actions?, scope?, expires_in_seconds?, device?` / `id, props?, layout?, expires_in_seconds?` | Places or changes a note, picture, or choices |
| `canvas_remove` | `id` | destructive |
| `canvas_events` | `since?, objects?, wait_seconds?` | readOnly; what people did on the canvas after a cursor, optionally waiting for it |
| `list_plugins` | — | readOnly; the node's catalog and places, and the requests waiting for the owner ([cold start](../../proposed/feature/2026-10-31-home-cold-start.md)) |
| `change_plugin` | `plugin \| place, enabled?, options?` | Turning off applies at once with a `kind: "security"` log line; turning on or changing options makes a request that waits up to 10 minutes for the owner's passkey and answers its link and short code |

Conventions:

- Read tools are annotated `readOnlyHint`, removals `destructiveHint`; every other write tool sets `destructiveHint: false` explicitly, because MCP treats a tool without annotations as destructive.
- Each tool needs exactly one scope: read tools need `read`; `play`, `control`, `seek`, `skip`, `transfer`, `set_tracks`, `set_danmaku`, `offer`, and the canvas tools that change it need `control`; tools that change the queue, playlists, or devices need `manage`, as do `match_item`, `search_metadata`, and `change_plugin`.
- `item_id` is a library item id, `<source>:<id>` (for example `plex:<ratingKey>`); `list_tracks` and the tools that read an item (`get_item`, the transcript tools, `get_chapters`, `get_frame`, `get_storyboard`, and `get_comments`) also accept a URL.
- Tool descriptions name no specific source or website: which sites and libraries work depends on the node's source plugins. Control-plane plugins may add tools with the same scopes ([plugin architecture](../architecture/2026-10-11-plugin-architecture.md)).
- `device` names a screen by id or name. Without it, a tool goes to the screen the default rule picks: the screen that asked (an Ask from a screen), else the owner's one session in use; with none in use, `play` goes to the owner's only online screen and `control`, `seek`, `skip`, and `set_tracks` are refused with `nothing_playing`; several, or none to pick, are refused with `device_ambiguous`, whose `details.screens` the agent asks the person about. Other profiles' sessions and screens are reached only by name ([screen sessions](../architecture/2026-10-31-screen-sessions.md)).
- `play` without `start_at` resumes: the history of the session's profile first, then the source's own position ([progress and resume](2026-10-11-yolo-owns-progress-and-resume.md)).
- A tool answers with its result as JSON text, with every picture as an image link ([cover images](#cover-images)), unless it presents its own content blocks: `get_frame` and `get_storyboard` answer with an image block and a text block.
- A failing tool returns `isError: true` with the `/v1` error JSON.

The server description ([`service/control/src/mcp/server.js`](../../../../service/control/src/mcp/server.js)) states what Yolo is (a media service, not "YOLO mode"), that agents search before playing instead of guessing ids, that every screen plays on its own and a request without `device` goes to the screen that asked, else to the one screen of the owner's that is playing, and is refused with `device_ambiguous` when that is unclear, so the agent asks which screen; which tools read what plays, and how to show covers. [`skills/yolo/SKILL.md`](../../../../skills/yolo/SKILL.md) is the agent skill for using the server, and [`skills/yolo-connect-agent`](../../../../skills/yolo-connect-agent/SKILL.md) connects Claude Code, claude.ai, ChatGPT, and Codex to it.

### Understanding what plays

Nine tools let an agent understand and navigate an item, not only play it; without `item_id` they read what plays now. They answer compactly, because agents pay for every token: only fields that have a value, short track entries, and transcripts as text lines. Each source capability they use is optional, with a fallback ([source plugin API](../architecture/2026-10-11-source-plugin-api.md)).

- **Transcripts** (`get_transcript`, `search_transcript`) read the text subtitles or captions that the node already delivers as WebVTT: the playing session's `subtitle(trackId)`, else the source's `subtitle(source, trackId)`, which also gives a growing track's whole text, since the session answers only what the source has made so far. The node ([`service/node/src/transcripts.js`](../../../../service/node/src/transcripts.js)) parses the WebVTT into cues, drops the lines that rolling captions repeat, and caches the cues per item and track (24 entries, 8 million characters, one hour). It answers with `m:ss text` lines: by default a minute either side of the playing item's position, or from the start of another item, in pages of at most `max_chars` (6,000 by default, 20,000 at most), with `nextFrom` where the next page starts. Search ignores case, accents, and punctuation; it matches the whole phrase across cue boundaries, then every word within one cue, then within two or three cues at most 20 seconds apart, and gives `at` in seconds for `seek`. The track is the one asked for (`track` or `language`), else the selected text track, else the source's default, else a text track that is not automatic. Image subtitles are pictures, so asking for one, or for an item that has only those, is an error that says so; a subtitle still being extracted answers a retryable `resolve_failed`.
- **Chapters and markers** (`get_chapters`) come from the source's `chapters()`, normalized in [`service/core/src/insight.js`](../../../../service/core/src/insight.js) to `{ start, end, kind, title? }` with `kind` `chapter`, `intro`, or `credits`. `skip` seeks through the Hub's existing seek: past the intro the position is in (a marker, or a chapter titled like an opening), or to the next or previous chapter. Outside the intro it says where the intro is instead of jumping over what comes before it.
- **Details** (`get_item`) come from the source's `details()` in one shape (description, people with their roles, date, genres, tags, ratings, series, studio, and counts), trimmed and capped in the core; a source without it gives what `describe()` knows. The control plane adds the item's tracks, the user's progress from Yolo's history (or the source's own record when Yolo has none), and the cover Yolo knows from what plays or from history. The node merges the source's details with the work a metadata plugin matched the item to: an upload of an episode gets the episode's title, synopsis, cast with photos, poster, and backdrop, with its own facts under `upload`, and `metadata` says how it was matched, or lists `candidates` when the node could not decide ([metadata plugins](../architecture/2026-10-25-metadata-plugins.md)). The description tells the agent to ask the owner when there is more than one candidate and to settle it with `match_item`, which takes one of them or one of `search_metadata`'s results, `none` to keep the item plain, or `clear`; the owner's choice is kept in D1.
- **Playback health** (`get_playback_health`) is assembled by the Hub ([`service/control/src/hub/playback-health.js`](../../../../service/control/src/hub/playback-health.js)) from what it keeps per device: the last stream it loaded (delivery, the source's profile, and the cap), the device's media path report, its stream rebuilds and errors of the last 30 minutes (at most 12), and the `health` the player adds to its reports ([Hub and realtime channel](../architecture/2026-10-07-hub-and-realtime-channel.md)). It adds short hints: buffering or a low buffer, throughput below what the stream needs, stalls of a second or more in the last 5 minutes, an adaptive-quality cap, the relay with each failed probe, and rebuilds after errors.
- **Pictures** (`get_frame`, and `get_storyboard` for a labelled grid of evenly spaced frames) are read by the node from the source, not from a screen, and come back as an MCP image content block with a few lines of facts ([video frames](2026-10-13-video-frames.md)).
- **Viewer comments** (`get_comments`) are the item's timed comments from the node's comment store, which the source's `comments()` fills ([danmaku](2026-10-13-danmaku.md)): those of `window` seconds (30 by default, at most 120) around `at` (by default the position of the item playing, else 0), as `{ t, text }` in time order. The same text said several times is one entry with a count `n` at its first time, and past `limit` (60 by default, at most 200) the most repeated and those nearest `at` stay. An item without comments answers `available: false` with a note that says whether its source offers none.

These tools need the scopes that already exist: `skip` needs `control`, the others `read`.

### Cover images

Items in tool results carry their cover as `thumbnail`. On `/v1` it is a path that needs the device credential (`/v1/library/items/<id>/artwork?variant=…`) or an image on another host, which screens load through `/v1/thumbnail`. ChatGPT and Claude load images without credentials and do not know Yolo's origin, so they showed broken images or made image references up. MCP results therefore carry each `thumbnail` as an **image link**, an absolute URL on `PUBLIC_ORIGIN` that loads without a credential ([`service/control/src/image-links.js`](../../../../service/control/src/image-links.js)):

- **One field.** The MCP layer replaces every `thumbnail` in a tool's result, nested items included, and every other picture field an item's details carry (`poster`, `backdrop`, `still`, and a person's `photo`), with its link, or with null when it names no image Yolo serves; `/v1` and the player keep the credential paths. An agent sees one image field, and it always loads.
- **The link** is `https://<origin>/i/<token>`. The token (`sealImageLink` in [`service/core/src/signing.js`](../../../../service/core/src/signing.js)) seals the user id and the image, a library item's id and artwork variant or the http(s) URL of an image on another host, with deterministic authenticated encryption: a 16-byte HMAC-SHA256 tag over the key version and the payload, and the payload encrypted with AES-CTR under that tag. It names nothing in the clear, and any changed byte fails the tag. Both keys are derived from the Worker secret `NODE_SECRET` by HKDF under the label `yolo image links` and the key version, which the token carries in the clear. The same image and key version always give the same link, so clients cache it, and a link has no expiry, so it still works in a chat months later.
- **Reset.** The owner's key version is in D1 (`image_links`; no row is version 1). **Reset image links** in settings (`POST /v1/owner/image-links/reset`, which writes a `kind: "security"` log line) or `npm run yolo -- image-links reset` adds one, and every earlier link answers `410`. Each tool call that returns a cover reads the version from D1. `/i/*` keeps it per isolate for 30 seconds and reads D1 again for a link newer than the version it keeps, so a reset reaches every isolate within 30 seconds and a link issued after it works at once. A new `NODE_SECRET` also ends every link.
- **What `/i/*` serves.** A library item's artwork, through the node as `/v1/library/items/<id>/artwork` serves it, and an image on another host, through the node's thumbnail fetch with all its guards against server-side request forgery ([node's internal API](../architecture/2026-10-07-node-internal-api.md)). Only a picture of Yolo's own results is sealed, never a URL an agent passes, so `/i/*` is no open proxy. It answers `GET` and `HEAD` with a raster image (JPEG, PNG, WebP, GIF, or AVIF; anything else is a `502`), `Cache-Control: public, max-age=31536000, immutable`, `Cross-Origin-Resource-Policy: cross-origin`, `nosniff`, and a sandboxing CSP. A token that does not open, or one whose payload names no such image, is a `404`; failures are `no-store`. The `IMAGE_LIMIT` binding allows 120 requests a minute per address. The route is in `assets.run_worker_first` and sends no COOP or COEP; the player's pages keep theirs.
- **Agents are told** in the server description and in the descriptions of the tools that return items to show `thumbnail` as it is, for example as a Markdown image, to show none when it is null, and never to make up an image URL; [`skills/yolo/SKILL.md`](../../../../skills/yolo/SKILL.md) says the same.

## Alternatives considered

**Keep the CLI.** It works only where an agent has a local shell; ChatGPT and claude.ai cannot use it.

**A local stdio MCP package.** Only Claude Code and Claude Desktop can use a local MCP server; ChatGPT and claude.ai require a public HTTPS address.

**Transcribe the audio with a speech model.** It needs a model on the node or a paid API and takes minutes for a long item, while the subtitles and captions that sources already deliver are the words the owner sees on screen.

**Return the raw WebVTT, or slice it on the control plane.** A two-hour subtitle is hundreds of kilobytes; the node slices and searches next to its cache and sends only the page, so neither the tunnel nor the agent's tokens carry the rest.

**A `thumbnail_url` next to `thumbnail`.** Agents would see two image fields, one of which never loads for them, and some would show the wrong one; the credential path costs tokens and is of no use to an agent.

**Signed URLs that expire.** A chat is reread days or months later, and its covers would be broken by then. Links without expiry, all revoked at once by a reset, keep old chats whole.

**A random token stored per image in D1 or KV.** Every search would write a row for each cover, and Workers Free allows 1,000 KV writes a day; a sealed token needs no storage and is the same for the same image.

**The key version in KV.** A KV read can be up to a minute stale at the edge, so a reset would take longer to reach every isolate, and D1 already holds the owner's settings; resets are rare writes either way.

**Covers as MCP image blocks.** An image block is for the agent to look at, and it would cost the agent's tokens for every item of every result; a link costs a few dozen characters and the chat shows the picture.

**Keep playback health in Workers Logs only.** Device telemetry already goes there ([device telemetry](2026-10-11-device-telemetry.md)), but an agent cannot query logs. The Hub keeps each device's latest report instead, about one storage write every 15 seconds while it plays.

## Consequences

Any MCP client that supports remote servers and OAuth can control Yolo with one URL, and the tools stay in step with `/v1` through the shared service layer. The MCP server is core and cannot be turned off; plugins extend it but cannot remove it. An agent can say what was just said, who is in an item, and why it buffers, and seek to a moment by its words. Transcripts are only as good as the subtitles: an item without text subtitles has none, and search matches words, not meaning.

Agents show covers in ChatGPT and Claude, and a chat keeps its covers for good. Anyone who holds a link, such as someone a chat is shared with, sees that one cover and can infer that the title is in the library, until the owner resets image links; covers are low-sensitivity, and this is the price of links that keep working in old chats. A copy that a client or a proxy has already cached outlives a reset. Each cover a chat shows is a request to the Worker and the node, counted against Workers Free's daily requests.
