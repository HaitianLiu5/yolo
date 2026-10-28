# Agent Note: A canvas agents place things on, on every screen

Status: proposed

English | [中文](2026-10-21-agent-canvas.zh.md)

## Problem

An agent that finds something to watch can only act or talk: `play` replaces what is playing, and when several matches are plausible the [agent plugin](../../implemented/feature/2026-10-18-agent-from-the-screen.md) plays nothing and names up to three in a sentence, and the person's next request answers. The person cannot see the three, their pictures, or how long they are, and has to speak or type again to choose, which in a car is the hardest thing to ask. Nothing an agent does can be shown on a screen except playback and the Ask panel's one sentence, and nothing a person does on a screen reaches the agent except a new question.

Choosing between results is the first case of a wider one. An agent should be able to put things on the owner's screens and hear back when someone uses them: a set of choices, a note, a picture, a video, and on a computer or TV a wallpaper behind everything or an overlay above it, as Wallpaper Engine and Lively Wallpaper do. The screens are a Tesla's browser, other browsers, the [Apple TV app](../feature/2026-10-19-apple-tv-client.md), the iPhone and iPad app, and later desktop and Android hosts, and Apple TV has no web engine. The channel underneath has to be the same on all of them, so that a new platform needs only a renderer.

## Proposal

The Hub keeps a **canvas** for each screen: layers called **surfaces**, and on them **objects** agents place, change, and remove. The Hub is the one authority. Screens receive the canvas over the realtime channel and draw it with their own components; what a person does to an object goes back to the Hub as an **event**, which the Hub acts on, records, and hands to agents. The channel knows nothing about how an object is drawn: platforms differ only in which object kinds they draw.

![Agents place objects through MCP and read or await events; the Hub keeps a canvas per screen and an event log; screens get the canvas over the realtime channel and send events over /v1](2026-10-21-agent-canvas.svg)

### Layers

- **Transport** is what Yolo already has: the [realtime channel](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md) down, `/v1` HTTP up, and [MCP](../../implemented/feature/2026-10-07-remote-mcp-server.md) for agents. WebSocket, JSON, and HTTP exist on every platform; the JavaScript side of the protocol lives in `@useyolo/core` and the Swift side in YoloKit.
- **The canvas protocol** (surfaces, objects, operations, events) is the part that stays the same everywhere.
- **Kinds** say what an object is. Each host declares the kinds it draws and their versions; an object it cannot draw shows its fallback.
- **Hosts** draw the canvas on one platform and send events back.

### Surfaces and objects

A **surface** is one layer of one screen:

| Surface | Where it is |
|---|---|
| `panel` | inside a panel the client already has, such as Ask |
| `player` | over the picture while something plays |
| `overlay` | above everything else; input passes through where no object is |
| `wallpaper` | behind every window, as a desktop or TV background |

A host declares the surfaces it has in its `hello` capabilities, beside the kinds it draws: `canvas: { surfaces: ["panel", "player"], kinds: { note: 1, image: 1, choices: 1 } }`.

An **object** is the same envelope for every kind:

```json
{
  "id": "obj_7Qf2",
  "surface": "overlay",
  "kind": "note",
  "rev": 12,
  "layout": { "anchor": "top-right", "w": 0.25, "h": "auto", "z": 3 },
  "props": { "text": "Tyres at 9 tomorrow" },
  "actions": { "press": { "do": "notify" } },
  "fallback": { "title": "Note", "text": "Tyres at 9 tomorrow" },
  "owner": "agent:claude-code",
  "scope": "device",
  "transient": false,
  "expiresAt": null
}
```

- **Layout is anchors and fractions, never pixels.** `anchor` is one of nine points of the surface, `w` and `h` are fractions of its width and height or `auto`, and `z` orders objects on one surface. The car's window is 601 CSS pixels tall and a TV is 1080 or 2160; an agent cannot know either and does not need to. A host keeps objects inside its safe area and the [in-car design principles](../../implemented/architecture/2026-07-13-in-car-design-principles.md)' touch sizes.
- **`fallback`** is a title, a line of text, and an optional image every host can draw. It is how kinds and hosts evolve apart: a host that does not know a kind, or a newer version of it, draws the fallback.
- **`scope`** is `device`, the screen it was placed on (the default, which is the screen the agent was asked from), or `all`, every screen the owner has, each drawing it on its own canvas if it has that surface.
- **`transient`** objects (choices waiting for an answer, a confirmation) belong to the moment: they expire, and they are never saved into a layout or copied.
- **`owner`** is who placed it: `agent:<id>` for an agent plugin on the node, the OAuth client's name for an MCP client, or `owner` for the person. An agent changes or removes objects it placed; removing another's needs the `manage` scope.

Operations are `put`, `patch`, and `remove`. Each one raises the canvas's `rev` and is merged last-writer-wins per object: the Hub orders every change, so no CRDT is needed. A person dragging a note on a screen sends a `patch` like an agent does. A welcome carries each screen's whole canvas and its `rev`; later changes arrive as `canvas_ops` with the `rev` they produce, and a host that sees a gap asks for the canvas again.

### One canvas per screen, and layouts to copy

Each screen has its own canvas, because screens differ in size, surfaces, and kinds: a car has no wallpaper, and a TV has no touch. An object with `scope: all` covers what every screen should show.

A **layout** is a saved copy of a canvas: its persistent objects, without transient ones, `scope: all` ones (they are on every screen already), or the event log. Layouts live in D1 (`canvas_layouts`, with `user_id`, per the [D1 data model](../../implemented/architecture/2026-10-07-d1-data-model.md)), so the owner's pages can list them and D1 backups keep them; live canvases stay in the Hub's storage.

- **Save** a screen's canvas as a named layout, from the screen or an agent.
- **Apply** a layout to a screen, replacing its canvas or merging into it. Applying copies: every object gets a new id and the screen's canvas is independent afterwards, so changing one screen never changes another.
- **Copy** one screen's canvas to another, which is saving a snapshot and applying it in one step.
- **Start a new screen** from a layout. Pairing offers the owner's layouts, and a layout can be marked the default for a device type (`car`, `tv`, `computer`, …), so a second TV starts the way the first one looks.

An object on a surface the target lacks is kept in the canvas and not drawn, and a host reports it as hidden, so copying a desktop's canvas to the car loses nothing and copying it back restores the wallpaper.

### Kinds

Kinds come in two weights.

**Light kinds** are built into each host, with props in a small JSON schema of Yolo's own, validated by zod on the server. The Hub writes them and they show at once, which suits a car or a TV, where a pick has to answer in a moment.

| Kind | What it is | Where |
|---|---|---|
| `note` | short text with simple emphasis | every host |
| `image` | a picture, only through Yolo's own image links (`/i/*`) | every host |
| `choices` | items to pick from: library ids or URLs, each with a short note; titles, covers, and durations come from Yolo's own lookup, never from the agent | every host |
| `card` | a small fixed set of parts (title, text, image, up to three buttons) for what a note or choices cannot say | every host |
| `cues` | text timed to what plays: lyrics, a transcript, a book's text ([timed text](#timed-text-cues)) | every host |
| `answer` | what an agent found, in text and pictures ([answers](#answers-answer)) | every host; a few lines in the car |
| `media` | an item or URL played as ambient media (see below) | hosts with a `<video>` or AVPlayer |

`choices` resolves its items on the server: an agent names `item_id` or `url` and at most one line of its own per item. A picture or title an agent made up never reaches a screen. A new light kind is a schema in `@useyolo/core` and a renderer in each host; a host that has not learned it draws the fallback.

**The heavy kind, `module`,** is a [Native Shell](https://nsh.dev) package (`.nshpkg`, Apache-2.0, from Longbridge): a TSX file the agent writes, for anything the light kinds cannot draw. The agent writes it from Native Shell's documentation for models ([`llms.txt`](https://nsh.dev/llms.txt)) and places it with `canvas_put`; Yolo runs it headless (`nsh test`, `compile_module`) and refuses it with the errors so the agent can fix it, signs it with the instance's own Ed25519 key, and only then sends it. A host verifies the signature against the key it learned when it paired and draws the module with native views (UIKit, Android's views, AppKit, Win32 with Direct2D, GTK 4, or HTML in a web page), one QuickJS VM per module with memory, call-time, and node limits. The host grants a module only Yolo's capabilities: sending an event (which becomes a canvas event like any other) and asking for one of the built-in actions (`play`, `queue`, `dismiss`); no network, no storage beyond the object's own props. Where the check and signing run, the Worker or the media node, is open until Native Shell's compiler is measured against Workers' size and CPU limits. `module` is off until the owner turns it on, and never draws in the car or on Apple TV, which show its `degrade` object or its fallback.

A module object only refers to its package, and carries a fallback like every object. It may also carry `degrade`, a light object to draw where the module cannot run, so a screen without Native Shell can still act on it rather than show a still picture:

```json
{
  "kind": "module",
  "props": { "pkg": "<package id>", "sig": "ed25519:<signature>" },
  "degrade": { "kind": "choices", "props": { "title": "Tonight?", "options": [{ "item_id": "<item id>" }, { "label": "Something else", "action": { "do": "ask", "text": "Suggest something else" } }] } },
  "fallback": { "title": "Tonight?", "text": "Keep watching, or something else" }
}
```

### Light kinds or a module

The same "what tonight?" note with two choices can be either: a `choices` object an agent fills in, or a TSX module that draws it and calls back through the capabilities the host granted.

| | Light kind | Module |
|---|---|---|
| What the agent writes | props, tens of tokens | a program, hundreds of tokens |
| How it fails | the schema check says at once | only running it (`nsh test`) shows |
| Time to the screen | the Hub writes it: milliseconds | write, check, sign, send, verify: seconds |
| What it can draw | only kinds the host implements | any layout, with local state, animation, and several steps |
| State | none; every press goes to the Hub | its own, in signals |
| Apple TV | SwiftUI, with SwiftUI's focus | not drawn: `degrade` or the fallback |
| Web, Android, desktop | a renderer in each host | one package everywhere |
| Moving or editing it | a `patch` to the Hub | the module handles it and reports back |
| Safety | data | code, held by the signature, the sandbox, and granted capabilities |
| Cost of something new | every host implements the kind | no host changes |

Light kinds carry the common, fixed interfaces: notes, pictures, choices, a "continue watching" card, notices. They draw on every platform, Apple TV included, and answer at once, so a car or a TV relies on them. Modules carry the one-off, made-to-measure ones: a scoreboard an agent builds for tonight's match, a form of several steps, a small tool. They ship without changing any host, behind the owner's setting.

Modules are where light kinds come from. A kind of module agents keep writing is a sign it should become a built-in light kind, which then draws everywhere, Apple TV included, and costs no code at run time.

### Where widgets live

A widget is either built in or written by an agent:

- **Built-in light kinds** ship with each host and change only with a release.
- **A module an agent writes** is kept in D1 (`canvas_modules`, with `user_id`): its name, the agent that wrote it, its TSX source, the compiled package, its signature, and the Native Shell version it was built for. The object on the canvas refers to it by id. A module placed once is dropped 30 days after it was last placed. The owner, or an agent asked to, can **save** one as a named widget, kept until it is deleted; agents list the saved widgets and place one again by name without writing it anew, and a change to one is a new version, so objects already placed keep theirs.
- **A plugin can ship widgets**, as a pet pack or a community widget does: Yolo checks and signs them with the instance's key when the plugin loads, as it does an agent's.

So a widget goes from one-off to saved to shared, and the widgets many owners keep become built-in kinds.

### Screen context and bindings

A widget about what is playing needs to know what is playing. Every screen already reports its playback to the Hub (`PlaybackState`: the item, `position` with the time `positionAt` it was read, the status, the rate, and the chosen tracks); the canvas reads the same state, so the canvas and the player are one model, not two.

- **Agents read it.** This part is already done: every question asked from a screen carries `playing`, what plays now as the Hub has it (`{ itemId, title, position, duration, status, device }`), and the agent plugins read "this", "here", and "now" as that moment, with `get_transcript` for what is said and `get_frame` for what is shown ([agent from the screen](../../implemented/feature/2026-10-18-agent-from-the-screen.md)). So "where are they now?" during a travel video needs no explanation. The canvas adds only that `canvas_read` returns each screen's context beside its canvas, for agents asked from elsewhere.
- **Objects bind to it.** A prop may be a reference instead of a value: `{ "bind": "playback.position" }`, `"playback.status"`, `"playback.item"`, or `"playback.rate"`. The host resolves it from its own state each time it draws: the playing screen from its own clock, frame-accurate, and another screen from the Hub's `position` and `positionAt`, counted forward while it plays. Nothing is sent per frame, and an agent never streams a position.
- **Objects act on it.** `do: "seek"` with a time moves the playing screen there, by the same path as the `seek` tool.

### Timed text: `cues`

Lyrics are a transcript of a song, and a podcast's transcript or an audiobook's text works the same way: lines with times, the current line following the playback clock, and a tap on a line seeking to it. One kind, `cues`, draws them all, with a `style` for how it looks:

| `style` | For | What it draws | The label a person sees |
|---|---|---|---|
| `lyrics` | music | a few lines, the current one filled as it is sung | Lyrics |
| `transcript` | podcasts, talks, interviews | a page of the text with speakers, search, and Back to now when the person scrolls away | Transcript |
| `readalong` | audiobooks | the book's text by chapter, the current sentence marked | Read along |
| `subtitle` | video | the lines as a page beside the picture, in one or two languages | Subtitles |

The name a person sees follows the item, never the kind: the host shows one button whose label comes from the item's type as its source reports it, or from the style the agent chose. The player's own subtitles stay where they are, under the picture and in the subtitle menu; `cues` is the text as a page.

```json
{ "kind": "cues", "surface": "player", "props": { "style": "lyrics", "source": { "from": "track:auto" }, "at": { "bind": "playback.position" } } }
```

`track:auto` takes the first that exists: the item's own text track; AI subtitles from the node's transcriber, read in windows as they grow, as [`growing-subtitles.js`](../../../../clients/player/src/growing-subtitles.js) does (weaker for singing than for speech); or text the agent found and handed in as WebVTT or LRC, which Yolo converts to WebVTT and keeps with the item as one more text track, so the next play has it without asking. A line's `press` is `do: "seek"` to its start.

### Answers: `answer`

What an agent finds about what is playing (where the vlogger is and what the hotels there cost, or how one phone compares with another) is text and pictures, laid out. An `answer` is Markdown with fenced blocks of JSON for the parts a host draws as more than text:

| Block | What it draws |
|---|---|
| `compare` | items side by side, a picture each, rows of values, the better one marked |
| `cards` | places or products: picture, title, a line, a price, a link |
| `gallery` | pictures in a row |
| `quote` | a moment in the item, with its words; a press seeks there |
| `sources` | where it came from, as links, and as QR codes on a TV or in the car |
| `followups` | next questions; a press asks the agent (`do: "ask"`) |

A host draws a block it does not know as its text. The agent streams an answer as it works: a `canvas_put` with the first lines, then `canvas_patch`es that add to it, so the screen shows the answer forming as this conversation's own answers do.

**Pictures are fetched by Yolo, never by the screen.** An agent names a picture's URL; Yolo fetches it, checks it is an image, scales it down, and serves it from its own image links (`/i/*`). The page's COEP header would block a picture from elsewhere anyway, and a screen never reaches a site an agent read. The host keeps the picture's place with a placeholder until it arrives, and a picture that fails leaves its text.

Where an answer shows depends on the screen, not the agent: over a playing video it is a card at the side while the video plays on, and Expand shrinks the video to a corner; on the home screen or a phone it is a page; on a TV it is larger and paged with the remote; in the car it is two or three lines and **Read on phone**. Read on phone copies the object to the owner's phone's canvas, with a new id, as a layout copies.

A conversation keeps an answer's text, at most 4,000 characters today; an answer object is kept whole beside it, within the 16 KB of props, so reopening the conversation draws it again.

### How hosts present objects

An agent says what to show; each host decides how, from where it is and what it is doing:

- **Choices on the home screen** are a spotlight: the first choice large, with its picture and the agent's line, the rest in a row to move between.
- **Choices while something plays** are a shelf over the bottom of the picture, which keeps playing behind it. Each choice can play now or **After this**, which is `do: "queue"`, so it joins what the Hub plays next: the queue first, then the run of what plays ([up next](../../implemented/feature/2026-10-23-up-next.md)). The shelf is drawn with the same cards as the player's own up-next card and end screen (`cardElement` in [`dom.js`](../../../../clients/player/src/dom.js)), and the bottom of the picture holds one row at a time: in an item's last seconds the up-next card waits while choices are open, and choices placed over the end screen replace its row until they are picked or dismissed.
- **Choices in the car** are a few large numbered tiles; on a phone, cards to swipe; on a TV, a row the remote's focus moves along.
- **The agent's presence** (listening, thinking, answering) is a small status beside Ask and a line of what it says. A **pet** can draw it instead: a pack from a plugin with pictures (sprites, Lottie, or Rive) and a small state machine keyed by signals (`idle`, `agent.thinking`, `agent.speaking`, `playing`, `pressed`). A pet is optional and never the only place something shows, so a screen without one loses nothing.
- **In the car there is no text field.** The person asks with the existing [voice input](../../implemented/feature/2026-10-18-agent-from-the-screen.md#voice-input) or with a few suggested questions the host offers for what is playing (Lyrics for a song, Where is this for a travel video).

### Interaction and events

An object's `actions` map a gesture (`press`, `submit`, `dismiss`, `move`) to what happens:

- **`do: "play" | "queue" | "seek" | "dismiss" | "remove"`**, with the item or time to act on: the Hub does it at once, by the same path as the MCP tool of that name, so history, progress, and resume behave as they always do. No agent has to answer first, which matters in a car.
- **`do: "copy"`**, with a device: the Hub copies the object to that screen's canvas with a new id.
- **`do: "notify"`**: the event goes to the log for agents to read.
- **`do: "ask"`**: the event starts an agent turn in the object's conversation, through the [agent plugin](../../implemented/feature/2026-10-18-agent-from-the-screen.md), with a line saying what was pressed. An agent that has finished can still be told.

Every event is also logged, whatever its action: `{ cursor, deviceId, objectId, gesture, payload, at }`, with a payload of at most 1 KB, in a ring of the owner's newest 500 events kept for 24 hours; AG-UI's event stream between agents and front ends is the reference for its shape. A screen sends events with `POST /v1/canvas/events` and its device credential (the `control` scope), not over the realtime channel, which never answers broadcasts. For `choices`, the first pick wins: the Hub closes the object on every other screen.

An agent hears back three ways:

- **It waits.** `canvas_events({ since, objects?, wait_seconds })` returns as soon as a matching event arrives, or at the wait's end (at most 45 seconds, under common MCP clients' tool timeouts). `offer` places a `choices` object and waits in one call, returning `{ status: "chosen" | "dismissed" | "waiting" | "expired", option?, played? }`. Both official agent plugins keep their CLI running while it waits (`claude -p` for Claude Code, `codex exec` for Codex), so the pick returns to the agent as the tool's result in the same turn, whichever agent the screen asks, and it says what it played.
- **It reads later.** `canvas_events({ since })` with a cursor from an earlier answer. A follow-up question in an Ask conversation begins with a line naming what was picked since the last answer, as a resumed request already names its screen.
- **It is told.** `do: "ask"` starts a turn. MCP clients that subscribe to resources get `notifications/resources/updated` for `yolo://canvas`.

### MCP tools and routes

| Tool | Scope | What it does |
|---|---|---|
| `canvas_read` | `read` | a screen's canvas, or every screen's |
| `canvas_put` / `canvas_patch` / `canvas_remove` | `control` | place, change, or remove objects; removing another's object needs `manage` |
| `canvas_events` | `read` | events since a cursor, optionally waiting |
| `offer` | `control` | place choices and wait for the pick |
| `canvas_layouts` | `control` | list, save, and apply layouts; deleting one needs `manage` |
| `canvas_widgets` | `control` | list and save the owner's widgets, and place a saved one; deleting one needs `manage` |

The `/v1` routes are `GET /v1/canvas` (this screen's canvas), `POST /v1/canvas/events`, `PATCH /v1/canvas/objects/{id}` (the person moves or edits an object), and `GET`, `POST`, `DELETE /v1/canvas/layouts` with `POST /v1/canvas/layouts/{id}/apply`. The tools and routes call one service layer, as every other tool does.

Today both agent plugins' instructions say: play when one match clearly fits; when several are plausible, play nothing, name up to three, and let the next request answer. With the canvas they call `offer` instead, and fall back to those words only when `offer` answers `unsupported` because the screen declares no canvas. What they do now is therefore the fallback, and nothing about it changes for a screen without a canvas.

### Hosts

| Host | Surfaces | How it draws |
|---|---|---|
| The player, web profile | `panel`, `player`, `overlay` | the web renderer, plain JavaScript modules in [`clients/player/`](../../../../clients/player/); the canvas is kept in [`store.js`](../../../../clients/player/src/store.js) beside the Hub's state, queue, and playlists, and `canvas_ops` redraw through it like their changes; `module` through Native Shell's web player (`createPlayer`) |
| The player, car profile | `panel`, `player` | the same renderer, limited to `note`, `image`, `choices`, `card`, `cues`, and `answer` (a few lines), at most four objects |
| Apple TV | `panel`, `player`, `overlay` | SwiftUI for the light kinds, with `.focusSection()` for the remote; a module's `degrade` object or fallback, since Native Shell has no tvOS target and tvOS has no web view |
| iPhone, iPad | `panel`, `player`, `overlay` | the same SwiftUI renderers as Apple TV, with touch; `module` through Native Shell's UIKit view, since iOS is one of its targets |
| Desktop (macOS, Windows, Linux) | `overlay`, `wallpaper` | a thin native shell around the system web view, running the player's web renderer, with Native Shell's desktop view for `module`; native code places the window: below the desktop's icons (macOS's desktop window level, Windows' WorkerW, Wayland's layer-shell background or X11's desktop window type) or above every window with input passing through, which Native Shell does not do |
| Android, Android TV, Fire TV | `overlay`, `wallpaper` | a `WallpaperService` and an app around Android's web view, running the same renderer, with Native Shell's Android view for `module` |
| Samsung Tizen, LG webOS | `panel`, `player`, `overlay` | their web runtimes run the same renderer; the Samsung TV app opens the instance's player paired as a TV, which draws the canvas and works it with the remote ([TV web client](../feature/2026-10-26-tv-web-client.md)) |

Every platform with a web engine reuses one renderer for the light kinds, and Native Shell draws `module` on every platform it targets. The Apple apps have one native renderer: the canvas protocol lives once in YoloKit and the light kinds' SwiftUI views in the app layer Apple TV and the iPhone and iPad app share, so each light kind is written once for all three. Apple TV, and Roku if it is ever a target, shows a module's `degrade` object or fallback. Native Shell keeps nothing in sync across devices; the Hub does that. The shell for desktops, Tauri or Electron, is decided when that host is built.

### Ambient media

The Hub keeps one `PlaybackState` per owner and at most one active device ([one queue, one active device](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md)). A video on a wallpaper must not take that place, or a background loop would stop the film someone is watching. A `media` object is **ambient**: muted unless the person unmutes it, never in history or progress, never resumed, never the active device's playback, at the lowest quality that fills its frame, and paused while the screen plays something. Its stream comes from the same media pipeline with its own media token, through the same direct paths and relay rules.

### Limits and safety

- A canvas holds at most 50 objects; an object's `props` at most 16 KB; an agent at most 10 operations a second per owner. Transient objects expire within 10 minutes, and any object may carry `expiresAt`.
- A car shows only `panel` and `player` surfaces, only the light kinds it draws, at most four objects, and no `media`, whatever an agent asks; the host enforces this, not the agent.
- Pictures come only from Yolo's image links, including those an answer names. `module` is off until the owner turns it on in the owner's settings, runs only after Yolo checked and signed it, and gets only the capabilities above.
- An agent that read a hostile page can place and change only objects within these limits, and cannot remove the person's own objects without `manage`.
- The canvas keeps what Yolo kept before it did not: canvases and the event log in the Hub, layouts and `canvas_modules` in D1, found text with the owner's items, answers beside conversations, and pictures Yolo fetched for answers. Each step that starts keeping or sending one of these updates the privacy policy (`site/public/privacy.html` and `site/public/zh/privacy.html`) in the same change ([useyolo.app](../../implemented/process/2026-10-23-useyolo-app-website.md)).

### Protocol and versions

`canvas` (in the welcome and on request) and `canvas_ops` are new realtime messages, and the canvas capability is new in `hello`. A client that declares no canvas gets none of them, and `offer` to that screen answers `unsupported` so the agent asks in words instead. Nothing an older client relies on changes, so `CLIENT_PROTOCOL` and `NODE_PROTOCOL` stay; the [client protocol](../../implemented/architecture/2026-10-19-client-protocol.md) lists the canvas among what a client may leave out. The conformance kit gains a script that places choices, picks one, and checks the play and the event; it runs against the web player and each Apple app.

### Plan

Each step is one PR, merged and deployed, with the privacy policy's pages updated for what it starts keeping:

1. The canvas in the Hub (surfaces, objects, operations, `rev`, the event log), the MCP tools, `/v1/canvas`, and the player's host with `note`, `image`, and `choices`. `offer` and both agent plugins' instructions to use it ship here. This step is built: [`service/core/src/canvas.js`](../../../../service/core/src/canvas.js) checks objects, [`service/control/src/hub/canvas.js`](../../../../service/control/src/hub/canvas.js) keeps the canvases and the event log, and [`clients/player/src/canvas.js`](../../../../clients/player/src/canvas.js) draws them; a choice is picked with the gesture `pick` and `{ option, after? }`, and `submit` and `move` wait for the kinds that need them. A screen paired as a TV, the Samsung TV app among them, draws them too and works them with the remote alone ([`tv-remote.js`](../../../../clients/player/src/tv-remote.js)): focus lands on choices when they appear, the arrows reach every card and its After this, OK picks, Back dismisses them, and a note's close button lies past the end of a row of controls.
2. Screen context and bindings, `do: "seek"`, `cues`, and `answer` with Yolo fetching its pictures, in the player's host.
3. Layouts: the migration, save, apply, copy, and starting a new screen from one.
4. `module` in the player's web profile, behind the owner's setting: checking and signing, the host's verification, the capabilities, and `canvas_modules` with saved widgets. The Native Shell compiler is measured in a Worker first.
5. `do: "ask"`, `card`, and the Apple host: the protocol in YoloKit and the light kinds in the shared app layer, for Apple TV, iPhone, and iPad at once, with `module` on iPhone and iPad.
6. The desktop host, macOS first, then Windows and Linux.
7. Ambient media, then the Android hosts.

## Alternatives considered

**Agent-written HTML, as Claude's artifacts are.** Apple TV and Roku have no web engine, so it cannot be the common format; in the car's page it would run beside the device credential and the canvas engine, written by an agent that may have read a hostile page; and its look and touch sizes would be the agent's, not Yolo's. `module` covers what an agent needs to write, checked, signed, and sandboxed.

**A generative UI format for the light kinds, such as json-render or A2UI.** They describe arbitrary trees of components from a catalog, more than a note, a set of choices, or a small card needs. json-render has renderers for React, Vue, Svelte, Solid, and React Native but none for plain JavaScript or Swift, so the player would take on a framework and Apple TV would need its own renderer of an outside format anyway; and its actions run in the client, while Yolo's must run in the Hub, where they reach playback and agents. Light kinds of Yolo's own stay small enough for every host to draw natively, and what is bigger goes to `module`.

**Native Shell for every kind.** It would give one format everywhere, but it has no tvOS target, every object would become code to compile, check, and sign before it shows, which is too slow for a pick in the car, and its runtime would share the car's page with the canvas engine. It is the runtime of `module` only.

**A sandboxed web view for agent-written pages (a `web` kind).** It would draw only where a web view exists and duplicate what `module` does with native views and granted capabilities.

**One canvas shared by every screen.** Screens differ too much in size, surfaces, and kinds for one arrangement to fit them all; `scope: all` gives the shared case, and layouts give the copied one.

**Layouts that stay linked to their screens.** A change on one screen would silently change others. Copying keeps each screen what the person last saw there.

**A CRDT for the canvas.** Every change already passes through one Durable Object, which orders them; per-object last-writer-wins is enough and keeps the protocol small for Swift and other hosts.

**A second connection for the canvas.** It would double sockets, heartbeats, and reconnection for every screen; the realtime channel already carries the device's state and its rules.

**MCP Apps alone.** They show UI inside a chat client, not on the screens Yolo plays on; they may later mirror a canvas object into a chat.

**A kind each for lyrics, transcripts, and read-along.** They are one thing, text timed to what plays, with different looks; one kind keeps one source order and one binding to the clock, and the name a person sees follows the item.

**Screens sending their position to the canvas.** A widget that follows the playback would need many messages a second for every screen watching; bindings resolve the position where it is drawn, from the state the Hub already has.

**Pictures an agent links to directly.** The page's COEP header blocks them, they would tell other sites what plays on the owner's screens, and an agent that read a hostile page could choose them; Yolo fetches and checks every picture instead.

**Making the agent wait for every press.** A pick that plays has to play at once; the Hub acts on built-in actions itself, and agents hear about them afterwards.

## Acceptance criteria

- An agent asked for an ambiguous title places choices on the asking screen; a tap plays the item at once, and the agent's `offer` returns the pick in the same turn.
- A pick made after the agent stopped waiting appears in `canvas_events` and opens the next Ask question.
- A note placed on a screen survives a reload and a reconnect, and a note with `scope: all` shows on every screen with an overlay.
- A screen's canvas saved as a layout and applied to a new screen shows the same objects there, with new ids; changing one screen afterwards leaves the other as it was.
- A host that does not know a kind draws its fallback; a screen that declares no canvas makes `offer` answer `unsupported`, and the agent names up to three in words as it does today.
- Choices placed in an item's last seconds never show beside the up-next card; the card waits until they close.
- In the car, objects beyond the car's surfaces, kinds, and count are not drawn, whatever was placed.
- Ambient media never changes the active device, history, or progress.
- Asked for lyrics while a song plays, an agent places `cues` that follow the song; a tap on a line seeks there, and another screen showing the same object follows within a second. A podcast shows the same kind labelled Transcript.
- Asked "where are they?" during a travel video, an agent answers from the moment playing without being told what it is, and its answer's pictures arrive through `/i/*`; in the car the same answer is a few lines and Read on phone puts it whole on the phone.
- A widget an agent saved is placed again by name in a later conversation without being written again.
- A module that fails Yolo's check never reaches a screen and returns its errors to the agent; one that passes draws in the web profile, sends an event, and asks for a play, and nothing else it tries works. A module whose signature does not verify is not drawn. On Apple TV and in the car, a module with a `degrade` object draws that object, and a press on it acts as it would anywhere.

## Risks

- **Waiting in the Hub.** A waiting `canvas_events` holds a Durable Object call open for up to 45 seconds, which costs duration on Workers' plans; waits are capped, and a screen's event ends them early.
- **Platform tricks.** Placing a window behind desktop icons relies on behavior each system does not promise, most of all Windows' WorkerW and the differences among Wayland compositors; each desktop host is tried on real machines before it ships.
- **Weak TV hardware.** Android TV devices and old web views may not keep up with a busy canvas or ambient video; hosts cap what they draw and fall back.
- **Native Shell is young.** Its format and APIs may change between versions; Yolo pins one version, and hosts report a module built for another as unsupported and draw its fallback. Its documentation says nothing about a TV remote's focus, so modules on Android TV are tried before they are allowed there.
- **Module latency.** Writing, checking, and signing a module takes far longer than placing a light object; agents use light kinds for anything a person waits on.
- **Found text.** AI subtitles of singing are often wrong, and lyrics found on the web belong to their publishers; Yolo keeps found text only with the owner's item and never puts it in a share link.
- **Stale answers.** Prices and opening hours an agent found change; an answer shows its sources and when it was found.
- **Clutter.** Agents may fill screens; the per-canvas cap, expiry, and the person's own remove keep them in check.
- **What it gives up.** A host draws only kinds it knows, so a new kind looks plain on older hosts until they learn it, and Apple TV's renderer is a second implementation of every common kind.
