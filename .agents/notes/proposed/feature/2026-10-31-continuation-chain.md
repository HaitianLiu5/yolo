# Agent Note: Something always plays next: the continuation chain on every screen

Status: proposed

English | [中文](2026-10-31-continuation-chain.zh.md)

## Problem

When an item ends, the Hub goes forward through the walk, then the queue's head, then the next item of the run the source gives with `sequence()` ([what plays next](../../implemented/feature/2026-10-23-up-next.md), [`hub-core.js`](../../../../service/control/src/hub/hub-core.js)). Past that, nothing plays. Most of what a person watches has no run:

- **A single web video** (a YouTube upload, a Bilibili video in one part, a news clip) has no run and stops on "Finished".
- **What an agent played** stops the same way. The agent has no say in what follows: it can put items in the queue, which stay there after the person has moved on, but it cannot say "after this, keep going from this channel" or "play just this one".
- **A series ends at its season.** A Bilibili series' run is its season ([`bilibili-bangumi.js`](../../../../plugins/source-ytdlp/src/bilibili-bangumi.js)), so the last episode of season 1 stops, with season 2 one search away.
- **The Apple TV and iOS** go on through a run, since the Hub plays it, but show no card before the end and no end screen.

[Yolo 1.0](2026-10-11-yolo-1-0.md) promises something next when an item ends, on every 1.0 client, and leaves the order and the candidates to this note. The [account plugins](2026-10-28-site-accounts.md) give candidates from the owner's follows, and [screen sessions](../../implemented/architecture/2026-10-31-screen-sessions.md) give every screen its own queue and run; neither says how they combine into what plays next.

## Proposal

What plays after an item is one ordered **continuation chain**, computed by the Hub per screen session from the same links on every screen. An agent can set its head and its end; the owner's agent at home picks when nothing else does; and the screen shows what comes next before the item ends, with an end screen after it.

### The chain

After an item ends, or on Next, the first link that has an item plays:

| # | Link | `from` | Where it comes from | Kind |
|---|---|---|---|---|
| 1 | Forward through the walk | `history` | The items Previous came back from, as now | Asked for |
| 2 | The agent's next | `agent` | Items an agent set to follow this one ([below](#what-an-agent-sets-as-next)) | Asked for |
| 3 | The queue | `queue` | This screen's queue, head first | Asked for |
| 4 | The run | `sequence` | The run of what plays: the agent's `from` when it set one, else the item's own `sequence()` | The same work |
| 5 | What follows the run | `sequence` | The next season or volume the source names after the run's last item ([below](#the-run-past-its-end)) | The same work |
| 6 | The same channel | `by` | The channel's or uploader's next upload after this one: from a followed channel in the owner's accounts (`sameBy`), else from the source's `related()` | Discovery |
| 7 | Followed series | `continuing` | The next episode of each series the owner follows on a site, last watched first (accounts) | Discovery |
| 8 | New from follows | `updates` | New uploads from the channels and uploaders the owner follows, newest first (accounts) | Discovery |
| 9 | Related | `related` | The source's own related list for the item | Discovery |
| 10 | The owner's agent | `agent_pick` | One item the owner's agent at home picks ([below](#the-owners-agent-picks-the-last-link)) | Discovery |
| 11 | Nothing | | The end screen, with Play again and what the screen can offer | |

The queue goes before the run, as now: it is what the owner or an agent asked for, and the run goes on once it is empty, as a music player goes back to an album after the songs queued into it. The agent's next goes before the queue because it is a request about this item, made after the queue was filled, and lasts only as long as this viewing does. Links 1 to 5 are what the person asked for or the work they are in; links 6 to 10 are discovery, which plays on by itself only within the [guard](#autoplay-and-still-watching).

Every link skips an item that would not be welcome:

- **Watched.** Links 6 to 10 skip what the session's profile has marked watched in Yolo, and links 6 to 9 what the accounts' rows leave out as watched ([site accounts](2026-10-28-site-accounts.md#on-the-home-screen)).
- **Already in this viewing.** No link plays an item the session played in the last 4 hours, so related lists that point at each other never loop.
- **Failing.** A candidate whose `prepare` fails (`resolve_failed`, `unavailable`, `not_found`) is skipped and the next one plays; the screen shows the failure only when three in a row fail, with what failed and Try again ([no dead ends](2026-10-11-yolo-1-0.md#five-promises)).
- **Not this profile's.** Links 6 to 8 obey the accounts' profile rule: a session of a profile other than the owner's gets no candidate from the owner's account lists, only from public ones ([accounts and profiles](2026-10-28-site-accounts.md#accounts-and-profiles)).

The Hub asks for links 1 to 5 as now: the walk and queue are its own, and the run is asked of the node in the background when an item plays directly. Links 6 to 9 are asked of the node in one request (`GET /internal/v1/next`, [below](#routes-state-and-versions)) only when links 2 to 5 are empty, in the background once the item starts, and kept for the item for 30 minutes. Link 10 is asked only when links 2 to 9 are empty. So a series or a queue costs no more requests than it does now.

### The run, past its end

A source's `sequence()` answer gains `next: { source, title? }`: the first item of what follows the run, such as the next season of a series or the next volume of a collection. When the run is within 10 items of its end, the Hub asks `sequence()` for that item and appends its run, each item keeping its own `label` ("S2 · E1") and the card naming the new run's title. A run with no `next` ends there, and the chain goes on to link 6.

- **Plex** already lists a show's episodes across seasons in one `allLeaves` run and needs no `next`.
- **Bilibili series:** the season API that names the season's episodes also lists the series' other seasons (`result.seasons`), in Bilibili's order. That list mixes in dubbed versions and spin-offs (for one long series, "TV版", then "中配版", then two spin-off series), so `next` is the following entry whose title does not mark a dub of the current one; check C1 decides the rule.
- **A Bilibili upload in a collection (合集):** a single-part video that belongs to its uploader's collection (`ugc_season` in Bilibili's video view) has that collection's episodes as its run, labelled with their place, the way a multi-part video has its parts. Check C2 confirms the field from the node.
- **A playlist** (`list=`) ends with its last video, and the chain goes on.

### A single web video

A video with no run, no queue, and no agent's next goes on by discovery: the same channel's next upload, then followed series and new uploads when an account plugin is on, then the source's related list, then the owner's agent. The yt-dlp source implements `related()` for the sites whose pages give it, with no sign-in where the site allows:

- **The same channel** (`why: "by"`): the channel's or uploader's uploads published after this one, oldest first, from a flat listing of the channel's videos page (yt-dlp's channel tab for YouTube; Bilibili's uploader space), at most 30, shared for 30 minutes by every video of that channel.
- **Related** (`why: "similar"`): the site's own related list, in its order: Bilibili's `x/web-interface/archive/related?bvid=` (40 videos without a sign-in on 2026-10-31), and YouTube's watch page's related videos (check C3).

A site yt-dlp plays but `related()` does not cover has links 6 and 9 empty, and with no account the chain reaches the owner's agent, then the end screen. A direct `.mp4` link has nothing but the agent.

### What an agent sets as next

<a id="what-an-agent-sets-as-next"></a>

An agent sets the head and the end of a session's chain with `set_next` (MCP) or `PUT /v1/playback/next`, or with the same `next` object on `play`, so "play this, then keep going from the channel" is one call:

| Field | Meaning |
|---|---|
| `items` | Up to 30 items, item ids or URLs, that play after the item now playing, in order: link 2 |
| `from` | A URL whose items continue once `items` are done and the queue is empty: a playlist, a channel's videos, a series page. It replaces the item's own run as link 4, through the source's `expand()` (a collection) or `sequence()` (an item in a run) |
| `then` | `continue` (the default): the chain goes on past what the agent named. `stop`: nothing plays by itself after the agent's items and `from`; the end screen offers the queue's head and the chain's first candidates, and nothing autoplays from them |
| `clear` | Removes what an agent set |

**It holds for the viewing.** What an agent set stays on the session while the chain plays: an item it named, a queue item, and a run item all keep it, each of the agent's items leaving it as it plays. It ends when someone plays something directly on that screen (a tap, the end screen's card, Previous, an agent's `play` without `next`), when the session stops, with `clear`, or 4 hours after the session last played. A takeover carries it to the screen that continues the session, with the run and the queue ([screen sessions](../../implemented/architecture/2026-10-31-screen-sessions.md#continue-here)). A new `set_next` replaces the old one, and the answer says what it replaced.

It is apart from the queue on purpose: a queue item stays until it plays or is removed, whatever the person watches meanwhile, while the agent's next belongs to what the agent was asked to play and goes when the person turns to something else.

The state names it (`next: { setBy, items, from?, then, at }`), so every screen and agent can see who set what plays next. `setBy` is the MCP client's name, or the agent plugin's for a request from a screen.

### The owner's agent picks the last link

<a id="the-owners-agent-picks-the-last-link"></a>

When links 2 to 9 are empty for the item playing, the Hub asks the owner's agent at home to pick one item, through the node's agent plugins ([agent from the screen](../../implemented/feature/2026-10-18-agent-from-the-screen.md)):

- **When.** Once per item, at the later of its halfway point and 2 minutes before its end, so the pick has time to be resolved ahead; at once for an item shorter than 4 minutes.
- **Which agent.** The one the screen chose ([`agent-choice.js`](../../../../clients/player/src/agent-choice.js)), else the first agent plugin the node loads. Without an agent plugin the link is empty: an owner who uses only claude.ai or ChatGPT gets the end screen, and their agent can set `next` when it plays.
- **The request.** `POST /internal/v1/agents/next`: the node's [`agents.js`](../../../../service/node/src/agents.js) composes the request itself from the screen, the profile, the item ending with its URL and details, and the session's last five items, and runs the agent with Yolo's MCP tools and one instruction: pick one thing to play next, set it with `set_next`, play nothing, and answer in one line why. The pick comes back as the agent's next with `setBy: "agent_pick"` and `from: "agent_pick"` in `upNext`, and the line shows on the card.
- **Its place.** It runs at the lowest priority: it waits for a screen's Ask that is running and never delays one, takes at most 60 seconds, and is dropped if the item ended over 30 seconds before it answers.
- **The setting.** Settings › Playback › "When nothing follows, ask my agent", per profile: on for the owner's profile, off for every other, since the agent reads with the owner's rights. The node's agent plugin decides the model and the cost, as for an Ask.

When the item ends before the pick, the end screen says "Asking *agent* what's next…" with Cancel for up to 30 seconds and plays the pick when it comes; after that the pick shows as the end screen's first card and does not play by itself.

### Autoplay and "Still watching?"

<a id="autoplay-and-still-watching"></a>

Every link plays by itself, so a screen in the car or across the room keeps going with nobody touching it. One guard stops discovery from running for hours unattended: the Hub counts, per session, the items that links 6 to 10 played by themselves since the screen last had input. At 3, the next item that would come from links 6 to 10 does not play by itself: the card before the end asks "Still watching?" with Keep watching instead of Play now, and the item stops at its end on the end screen with the same question. Links 1 to 5 are never held: a series plays through.

Input is any tap, key, or remote press on the screen, which its reports carry as `inputAge` (seconds since the last one), and any command for the session: pause, seek, tracks, Next, a card, an Ask from it, or an agent's `play` or `set_next` on it. A takeover starts the count again.

Settings › Playback › "Keep going after what I chose", per profile and on by default, turns links 6 to 10 off for autoplay: the item stops at its end and the end screen offers them.

### Warming the next item

What plays next starts as fast as a warmed history item, without the screen loading two streams:

1. **Resolve ahead,** as now: each time `upNext` names another item, the Hub has the node `warm` it for the screen that plays, with its capabilities and media path ([node's internal API](../../implemented/architecture/2026-10-07-node-internal-api.md)).
2. **Ready in the last 60 seconds:** the Hub asks the node to prepare the first candidate as a pending media session for that screen (`POST /internal/v1/warm` with `ready: true`): the source's `prepare` runs, and the first segments go into the node's segment cache. The `load` at the end carries that session's stream, so the screen starts from the cache. One pending session per screen; it is dropped when `upNext` changes, the session moves, or 2 minutes pass unused. A dismissed card drops it.
3. **The screen loads nothing early.** The canvas engine keeps its bounded queues and single-flight HLS prefetch ([canvas engine](../../implemented/architecture/2026-04-04-canvas-playback-engine.md)), `<video>` keeps one element, and a car on LTE spends no data on an item it may not play. A press shows the next item's picture and title at once, as now.

Candidates for links 6 to 9 are fetched when the item starts and the agent's pick 2 minutes before the end, so both are known before the ready step.

### On the screen

The card shows in an item's last 20 seconds, on items of at least 90 seconds, as now. It says where the next item comes from, translated on the client from `from`: "Next episode", "Season 2", "Your agent's pick", "In your queue", "From *channel*", "Following", "New from people you follow", "Related", "Picked by *agent*" with its line why. An unknown `from` shows no reason line. While the agent is being asked, the card says "Asking *agent*…"; when the guard holds, it asks "Still watching?".

The end screen shows when an item stops at its end on the screen: the last picture dimmed, "Finished" (or "Still watching?" when the guard held, or "Your agent said to stop here" for `then: stop`), Play again, and a row of what the chain would have played, in its order, each card tagged with its link, at most 30 (`GET /v1/playback/up-next`). Nothing on it plays by itself, except an agent's pick that arrives within its 30 seconds.

| Screen | The card | The end screen |
|---|---|---|
| Web mode | Bottom right over the picture, as now, with the reason line | Over the dimmed last picture, as now, with tags |
| Car mode | On the driver's side, as now, with targets sized for the car ([design principles](../../implemented/architecture/2026-07-13-in-car-design-principles.md)) | The same, on the driver's side |
| Apple TV | A Play next button in the player's contextual actions (`AVPlayerViewController.contextualActions`), the place tvOS shows a next episode, with the title and reason beside it; Stop after this in the transport bar's menu sends `advance: false` | A full screen after the player: the dimmed picture, Play again, and the row, focus on the first card; select plays it, Back goes home |
| iOS | An overlay above the playback controls, bottom trailing; the lock screen's and Control Center's next-track command plays next while `upNext` is there | The app's own screen after the player, as on the Apple TV; in Picture in Picture or with the screen locked, the chain goes on without a card and stops for "Still watching?" without a prompt |

The Apple TV and iOS read `upNext` from the state and the row from `GET /v1/playback/up-next`, both of which exist; YoloKit gains their types, and the conformance kit a scenario for each.

### Profiles and screen sessions

The chain is part of a screen's session: its walk, queue, and run already are ([screen sessions](../../implemented/architecture/2026-10-31-screen-sessions.md#sessions-in-the-hub)), and the agent's next, the guard's count, and the candidates for links 6 to 10 join them under `chain:<deviceId>`. Two screens never share a chain, even on one profile. A takeover copies the agent's next and the run with the rest of the context, moves the queue, and starts the guard's count again.

The profile decides what the chain may draw on: its own watched marks for skipping, the accounts' rows for links 6 to 8 (the owner's lists for the owner's sessions, public lists for the rest), and its own settings for the agent's pick and discovery autoplay. A Family session on the living room TV therefore plays Family's next episode and the source's related videos, but never the owner's follows, and asks no agent unless the owner turned that on for Family.

### What plugins provide

Source plugins ([source plugin API](../../implemented/architecture/2026-10-11-source-plugin-api.md#methods)), each optional:

| Addition | Purpose | Returns |
|---|---|---|
| `sequence()`'s `next` | What follows the run | `{ source, title? }` in the answer, or nothing |
| `related(source, { limit, signal })` | The item's same-channel uploads after it and the site's related items, for links 6 and 9; called only when links 2 to 5 are empty, and kept by the node for 30 minutes | `{ items: [{ source, title?, thumbnail?, duration?, by?, why }] }`, `why` being `by` (the same channel's uploads after this one, oldest first) or `similar` (the site's related list, in its order), at most `limit` (30) |
| `describe()`'s `by` | The channel or uploader of an item, `{ title, url? }`, for the accounts' `sameBy` and the card | In `Metadata` |

Plex can answer `related()` with a library item's similar items (`/library/metadata/{id}/similar`); the folder source needs nothing past its runs.

Account plugins add nothing: the node's `GET /internal/v1/accounts/candidates` ([site accounts](2026-10-28-site-accounts.md#what-plays-after-an-item)) gives links 6 to 8 its `sameBy`, `continuing`, and `updates`.

Agent plugins add nothing either: the node composes the pick request and runs it through the agent plugin as it runs a screen's request.

The chain asks plugins when it needs an answer and does not rely on events plugins push: one ordered pull gives one answer to "what plays next", where several plugins pushing their own next would compete.

### Routes, state, and versions

<a id="routes-state-and-versions"></a>

**`PlaybackState`:** `upNext` gains the new `from` values (`agent`, `by`, `continuing`, `updates`, `related`, `agent_pick`), `reason` (the agent's line for a pick), `hold: "still_watching"` when the guard holds, and `pending: "agent_pick"` while the agent is asked. The state gains `next`, what an agent set. All are additive: a client that does not know a `from` shows no reason, and one that ignores `hold` shows the card it shows now, while the Hub still stops the item.

**Reports** carry `inputAge`, seconds since the screen's last input; a screen that sends none counts as having had input at each command it sends.

**`/v1`:**

- `GET /v1/playback/up-next` lists the whole chain as it would play, each item with its `from`, and says what an agent set and the guard's count.
- `PUT /v1/playback/next` `{ items?, from?, then?, clear? }`, `control` scope, sets the agent's next; `POST /v1/playback/play` takes the same `next` object.
- `GET` and `PATCH /v1/owner/playback` read and change the settings per profile: `keepGoing` and `askAgent`.

**The node** ([node's internal API](../../implemented/architecture/2026-10-07-node-internal-api.md)): `GET /internal/v1/next?source=&profile=&exclude=` answers links 6 to 9 in one request, from `related()` and the accounts' candidates; `POST /internal/v1/agents/next` runs the pick; `POST /internal/v1/warm` takes `ready: true`. Each is additive: an older node answers 404 or ignores the field, which reads as empty links and resolve-only warming, so `NODE_PROTOCOL` stays.

**D1:** the next migration adds `playback_settings` (`user_id`, `profile_id` with NULL for the owner's profile, `keep_going`, `ask_agent`, `updated_at`), which the previous release never reads. The agent's next and the guard's count live in the Hub's storage with the session, not in D1.

**`CLIENT_PROTOCOL` stays:** every field is additive, and the web player's card already shows no reason for a `from` it does not know.

### The MCP tools

| Tool | Change |
|---|---|
| `set_next` (new, `control`) | `{ items?, from?, then?, clear?, device? }` as [above](#what-an-agent-sets-as-next); answers the chain's first items as they now stand and what it replaced |
| `up_next` (new, `read`) | `{ device?, limit? }`: the chain as it would play, each item with its link, and what an agent set; for "what's next?" |
| `play` | `next?`, the `set_next` object, applied after the play |
| `get_status` | `upNext` with its link, and what an agent set, by whom |
| `control` | The description of `next` names the chain instead of "the next queue item" |

The server's instructions add one line: to say what happens after what you play, pass `next` to `play` or call `set_next`; use `then: "stop"` when the person asked for just this one. `device` follows the default rule of [screen sessions](../../implemented/architecture/2026-10-31-screen-sessions.md#which-screen-a-request-reaches).

### Notes this changes

When it ships, this proposal updates [what plays next](../../implemented/feature/2026-10-23-up-next.md) (the order, the run's `next`, the end screen, the Apple TV's card), the [source plugin API](../../implemented/architecture/2026-10-11-source-plugin-api.md) (`related`, `sequence`'s `next`, `describe`'s `by`), [`/v1`](../../implemented/architecture/2026-10-07-v1-http-api.md), the [node's internal API](../../implemented/architecture/2026-10-07-node-internal-api.md), the [remote MCP server](../../implemented/feature/2026-10-07-remote-mcp-server.md), [agent from the screen](../../implemented/feature/2026-10-18-agent-from-the-screen.md), and the [D1 data model](../../implemented/architecture/2026-10-07-d1-data-model.md). The privacy pages (`site/public/privacy.html` and its Chinese page) say that the node asks a site for an item's related videos and its channel's uploads, and that the owner's agent is sent what is ending on a screen when nothing follows, in the same change.

### Plan

1. **The chain in the Hub:** the order, the agent's next with its hold, the guard, `inputAge`, the failure skip, `set_next`, `up_next`, `play`'s `next`, the `/v1` routes, and the settings, kept per screen under `chain:<deviceId>`; links 6 to 10 empty until steps 2 and 3.
2. **Sources:** `sequence()`'s `next` for Bilibili series and collections, `related()` and `describe()`'s `by` in the yt-dlp source, `related()` in Plex, `GET /internal/v1/next`, and the ready step of `warm`.
3. **The agent's pick:** `POST /internal/v1/agents/next` and the setting; links 6 to 8 come with the account plugins.
4. **Screens:** the web player's reasons, "Still watching?", and asking the agent; the Apple TV's and iOS's card and end screen, with the conformance kit's scenarios.

### Owner checks

| Check | Steps | Decides |
|---|---|---|
| C1, Bilibili's next season | For three series with several seasons, one with a dub and one with a spin-off, read `pgc/view/web/season?ep_id=` for the last episode of season 1 and compare `result.seasons`' order, `season_title`, and `season_type` with what Bilibili's own app plays next | The rule for `next` among dubs and spin-offs |
| C2, Bilibili collections | From the node, read `x/web-interface/view?bvid=` for a video in an uploader's collection (it answered with a non-JSON page without a sign-in on 2026-10-31) and check `ugc_season`'s sections and episodes | Whether collections are a run without a sign-in, or need the node's sign-in or yt-dlp |
| C3, YouTube's related | Fetch a watch page with the node's cookies and read the related videos from its page data, and the channel's `/videos` tab with `yt-dlp --flat-playlist -J --playlist-end 50` | Whether `related()` reads YouTube with one page request, and the order a channel's uploads come in |
| C4, the ready step | Prepare a web video's stream 60 seconds ahead and play it 60 seconds later on the car on LTE | That the cached first segments and the stream's URLs are still valid, and how much sooner it starts |

Results on 2026-10-31, from this machine without a sign-in: Bilibili's `archive/related` answered 40 related videos with their uploaders; the season API for a long series listed six seasons, "TV版", "中配版", and two spin-offs each with a dubbed copy, with `season_type` 1 for every one, so the title alone tells the dubs apart in that case.

## Alternatives considered

**The run before the queue.** A streaming service plays the next episode whatever else is pending, but it has no queue. Yolo's queue is what the owner or an agent asked for, and the run picks up after it, as [what plays next](../../implemented/feature/2026-10-23-up-next.md) decided; the agent's next, a request about this very item, goes before both.

**The agent's next as queue items at the head.** It needs no new state, but queue items outlive the request: after the person taps something else, the agent's three follow-ups would still play after it. Holding the agent's next for the viewing ties it to what the agent was asked.

**The agent's next only for the item playing.** "Keep going from this channel" would last one item, and the agent would have to be asked again at each end. **Kept until the agent or the person clears it:** a rule set for one evening's request would still steer the next day's viewing on that screen.

**Stop at the end of the work** and offer discovery only on the end screen. A screen in the car or across the room would stop after every single video with nobody to tap it. Autoplay with a guard keeps it going and still stops a screen nobody is watching.

**Autoplay without a guard,** as video sites do. A screen left on plays related videos for hours, through the node's and the site's bandwidth, and with the agent's pick, on the owner's subscription.

**Only an external agent's next, no agent at home.** The [floor](2026-10-11-yolo-1-0.md#experience-layers) is an owner with no source who asks an agent; when what it played ends, nothing would follow unless that agent thought to set `next`. The agent plugin at home can be asked at the end; claude.ai and ChatGPT cannot be called back, so they set `next` when they play.

**Ask the agent before discovery.** The agent knows the person, but every single video would cost an agent turn while the source's related list and the follows cost nothing; it is the last link, used when the free ones are empty.

**Event hooks that let plugins push a next.** Several plugins would each push a candidate on every ending, and the Hub would have to arbitrate between them anyway. One ordered pull, asked only when the links before are empty, costs nothing for a series and gives one answer.

**Clients build the chain.** The web player, the Apple TV, and iOS would each merge the links and filter the watched, and drift; the end of an item would differ by screen. The Hub has the walk, the queue, the run, and the session, and every client only draws `upNext` and the row.

**The screen preloads the next item's media.** It would start the next item from memory, but the canvas engine's queues are bounded on purpose, a car on LTE would download an item it may not play, and two `<video>` elements on a TV cost decoders. The node's pending session gives most of the gain with nothing on the screen.

**A countdown on the end screen.** The card before the end already counts down; the end screen is where the person chose not to go on, or where the guard stopped, so nothing there plays by itself.

## Acceptance criteria

1. **Bilibili episode 1 → episode 2.** On the web player and in the car, episode 1 of a Bilibili series played from its episode page shows the card in its last 20 seconds, "Next episode · E2 *title*"; at its end, episode 2 plays within 2 seconds on the home network, from the ready step's cache, and the guard's count stays 0. A Bilibili video in a collection goes on to the collection's next video the same way.
2. **The next season.** The last episode of season 1 shows "Season 2 · E1" on the card and plays season 2's first episode, never a dubbed copy of season 1 or a spin-off; with no next season, the chain goes on to link 6.
3. **A one-off video an agent played.** Claude plays a YouTube video on the car with no queue. (a) With no `next`, the card names the channel's next upload, "From *channel*", and it plays; after three discovery items with no input on the screen, the card asks "Still watching?" and the fourth stops on the end screen with the question and the row. (b) With `play { next: { from: <the channel's videos URL> } }`, the channel's videos play in order, and the guard never holds them. (c) With `then: "stop"`, the video ends on "Your agent said to stop here", and nothing plays.
4. **The floor.** An owner with only built-in link playback and the Claude Code agent plugin asks from the screen to play a direct `.mp4` link. Two minutes before its end, the card says "Asking Claude Code…", then "Picked by Claude Code" with its line; the pick plays at the end. With the setting off, or on a Family session, the end screen shows instead.
5. **The hold.** An agent sets `next` with two items and a playlist `from`; the first item plays, then a queue item the owner added; the agent's second item still plays after it. The owner then taps a history card: `upNext` no longer names the agent's items, and `up_next` shows no `next`.
6. **Queue first.** With two items queued and a series playing, the queue plays first, then the series goes on from the next episode.
7. **Apple TV and iOS.** On the Apple TV, Play next shows in the contextual actions in the last 20 seconds with the reason, and the end screen follows a dismissed card with Play again and the row. On an iPhone, the overlay card shows, the lock screen's next-track command plays next, and with the phone locked a series plays through.
8. **Two screens and profiles.** The family TV (Family) and the owner's phone play at once; each goes on through its own chain; the TV never gets a candidate from the owner's follows. Continue here on the TV takes the phone's agent's next with it, and the TV's guard count starts at 0.
9. **Failures and old nodes.** A next item that fails to resolve is skipped and the one after plays; three in a row show the error panel with Try again. Against a node without the new routes, links 6 to 10 are empty and the chain ends on the end screen.
10. **Checks.** `npm run check` passes with the Hub's tests for the order, the hold and its ends, the guard and `inputAge`, the failure skip, the run's `next`, and the profile rules; the yt-dlp source's `related()` and `next` tests on recorded answers; and the conformance kit's card, end-screen, and unknown-`from` scenarios against the Apple TV and iPhone apps.

## Risks

- **Discovery plays what the person did not want.** A related list can wander, and an uploader's next upload may be unrelated. The guard caps it at three unattended items, the card names where each comes from, and the owner can turn discovery autoplay off per profile.
- **Sites change their pages.** Related lists and channel pages are read from site pages that change; `related()` failing leaves links 6 and 9 empty, and its tests pin parsing on recorded answers. Reading them adds requests to the site: one related list and one channel listing per single video played, shared for 30 minutes.
- **The agent's pick costs.** Each pick is one agent turn on the owner's subscription, at most three in a row unattended because of the guard, and only when everything free is empty. The pick runs with the owner's rights, which is why it is off for other profiles.
- **The agent may play instead of setting.** An agent that calls `play` during a pick would cut the item short; the instruction says not to, and the Hub refuses `play` from a pick request with `invalid_request`, naming `set_next`.
- **The ready step spends the node's work on an item that may not play.** A skipped card or a change of mind wastes one `prepare` and a few segments; one pending session per screen and a 2-minute expiry bound it. Some sites' stream URLs expire within minutes; C4 checks it, and an expired URL falls back to a normal prepare.
- **Season rules are heuristics.** Choosing the next season among dubs and spin-offs can be wrong for a series C1 did not cover; a wrong next season shows its title on the card 20 seconds ahead, and the owner can dismiss it.
- **Given up:** a chain while the node is offline (the queue and history still answer, but nothing plays), discovery for a profile beyond public lists and related items, a countdown on the end screen, and an agent at home called back by an external agent's session.
