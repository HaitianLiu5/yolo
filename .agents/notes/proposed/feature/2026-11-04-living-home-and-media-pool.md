# Agent Note: Yolo keeps watching for the owner: interests, a living home, and a pool of what is ready

Status: proposed

English | [中文](2026-11-04-living-home-and-media-pool.zh.md)

## Problem

Yolo's home is a folder. It shows history, the queue, playlists, and Plex's libraries, and it changes only when the owner does something. Anything new reaches a screen because the owner told an agent about it. This is what was true on the owner's own instance at 20:08 Pacific on 2026-11-04:

| What was going on | What the home showed |
|---|---|
| Five NBA games were being played (Lakers 51–46 Kings, 3:23 left in the second quarter, and four others) on a site the owner plays and is signed in to, and the owner had watched another game there earlier that evening | Nothing. The owner reached that game by asking an agent |
| The owner watched 15,119 of the 15,412 seconds of Street Fighter League's Division S round 6. The same channel listed round 7 of both divisions as upcoming and Division F's round 6 as finished | Nothing, then or ever |
| The Rehearsal's third episode is known to the source | A card of the episode already watched: Continue Watching goes on to a multi-part video's next part, but not to a Bilibili series' next episode |
| An `Esports` library holds Evo France only because it was fetched and put into Plex ahead of time | That library, unchanged until someone fetches the next one |

Two ways of being a video service are both wrong for Yolo. Plex shows only what the owner curated and fetched in advance, which is a chore. YouTube recommends without being asked but keeps no copy, so every press depends on the network at that moment. Yolo has both a screen and a machine with a disk that stays on (1.1 TiB free on this one), so it can do what neither can: notice what the owner would want, and have it ready before they look.

Today it does neither, and a press pays for that:

- **Each press starts from nothing.** A yt-dlp run took 3.5 to 3.9 seconds on 2026-11-04 before any byte moved.
- **There is little headroom.** One connection to YouTube carried 6.0 to 6.5 Mbps, 1.8 times real time for a 3,440 kbps 1080p60 stream; four carried 24 Mbps.
- **Sites stumble.** The node's log from 2026-10-27 to 2026-11-05 holds 89 hedged requests, 88 of them on Bilibili's CDN and 75 for no first byte within 1.5 seconds, 34 in one session alone.

Agents are in the same dark. `search` finds only what is in a library, `history` only what already played, and nothing says what is new. An agent cannot be the only way in either: the node's log shows the owner's Claude Code sign-in had expired at 02:22 and 03:54 UTC on 2026-11-05, and on that path a home that needs an agent stays silent.

The nearest proposals leave this open. [Site accounts](2026-10-28-site-accounts.md) reads what the owner follows on a site, which needs a sign-in, says nothing of tonight's games, and misses a league the owner watches but never subscribed to. The [continuation chain](2026-10-31-continuation-chain.md) decides what plays when an item ends, not what the home shows. [Yolo 1.0](2026-10-11-yolo-1-0.md) puts caching and prefetch last. The owner's call on 2026-11-04 is that a home that changes by itself matters most, and that a pool of downloaded media is how Yolo stops being at the mercy of each press.

## Proposal

Yolo works on its own on the node, all day, in three layers. Each is useful without the next, and none waits for an agent:

```
history, the owner, agents ──▶ interests (D1, visible, editable)
                                     │  the Worker's cron sends a digest
                                     ▼
sites ──plugins' fresh()/find()──▶ feed (node) ──▶ rows on every home, get_feed
                                     │
what is unfinished, queued, next ────┴──▶ pool (node's disk) ──▶ a press plays from disk
```

- An **interest** is something the owner cares about: a channel, a competition, a team, a topic. It is a visible record with a reason, not a hidden weight.
- The **feed** is what Yolo found for those interests right now.
- The **pool** is what the node has already downloaded, within a budget the owner never has to think about.

Nothing here names a site in `service/`: plugins say what an item belongs to and what is new there.

### Interests

The next D1 migration adds `interests` (`user_id`, `profile_id`, `key`, `title`, `kind`, `follows`, `origin`, `state`, `why`, timestamps; the model's `queries` join them in phase 2), so agents and screens read them while the node is offline and D1 backups keep them. `origin` is `history`, `model`, `owner`, or `agent`; `state` is `active` or `muted`, and a muted interest is never proposed again. They arrive four ways:

1. **From history, with no model or sign-in.** A source plugin's new `follows(source)` says what an item belongs to: `[{ id, kind: "channel" | "schedule" | "team", title, within? }]`. The node counts follows across the digest of recent plays, and one becomes an interest once it appears in two plays within 30 days, or one play ran past half its length or past 30 minutes. Street Fighter League's broadcast yields the channel; a 76ers game yields the NBA schedule and the team.
2. **From titles, with a model.** Once a day one `yolo.models` call ([models for plugins](../../implemented/architecture/2026-10-25-models-for-plugins.md)) turns the last 30 days' titles into topics with search queries in the titles' own languages: "Street Fighter League" with `ストリートファイターリーグ`. Without a model there are no topic interests; everything else still works.
3. **From the owner.** Settings › Interests lists each with why it is there, and a card's secondary actions offer "Not interested" and "Stop following". A new home can ask in plain words what the owner follows ("NBA, 街霸, Lex Fridman"), beside the [home cold start](2026-10-31-home-cold-start.md)'s question of where they watch.
4. **From agents,** through [the tools below](#agents).

Interests belong to a profile, as history does ([screen sessions](../../implemented/architecture/2026-10-31-screen-sessions.md)): Family's come from Family's viewing and never show the owner's.

### The feed

`service/node/src/feed.js` keeps a snapshot under the ignored `.media-cache/feed/`, rebuilt from the sites when deleted, with the pacing, bounds, last-snapshot-on-failure, and claiming [site accounts](2026-10-28-site-accounts.md) designs for its lists. The node never calls the control plane, so the Worker's existing five-minute cron gains one step: every 30 minutes, when the node is online, it sends each profile's digest (the last 200 plays with how much of each was watched, and the interests) through `nodeFetch()`, and keeps the interests the node proposes in the answer. A home whose node has no digest for its profile sends one at once. The node then reads on its own timers. It reads a site one request at a time.

A source plugin gains three optional methods ([source plugin API](../../implemented/architecture/2026-10-11-source-plugin-api.md)):

| Method | Purpose | Returns |
|---|---|---|
| `follows(source)` | What an item belongs to, as above | `Follow[]` |
| `fresh(follow, { limit, signal })` | What is on or new for a follow | `{ entries: Entry[] }` |
| `find(query, { limit, signal })` | A site-wide search, newest first where the site allows | `{ entries: Entry[] }` |

An **Entry** is `{ source, title, by?, thumbnail?, duration?, at?, tags?, paid?, live?, matchup? }`. `live` is `{ state: "upcoming" | "live" | "ended", startsAt? }`. `matchup` is `{ left: { name, badge, score? }, right: { … }, period? }`, for anything played between two sides. `title` never carries a result ([games and spoilers](#games-and-spoilers)). `paid` entries appear only when the plugin can play them with the node's sign-in. The chain's `related()` and `sequence()` feed the same store, and an [account plugin](2026-10-28-site-accounts.md)'s lists are one more input.

What the first plugin reads, measured from the home machine without a sign-in on 2026-11-04:

| Follow | Read | Interval | Measured |
|---|---|---|---|
| A competition's schedule (Tencent Sports) | `matchUnion/list?columnId=&startTime=&endTime=` | 5 minutes with a game on or within 2 hours, else hourly | 1.1 to 2.2 s, 32 KB for three days: 26 entries with period, score, team badges, `isPay`, and the game page the source already plays |
| A channel (YouTube) | yt-dlp's flat listing of its `videos` and `streams` tabs, and one more run for each of its next two broadcasts | 30 minutes | 1 to 1.3 s a tab; titles, lengths, views, covers, `is_upcoming` or `is_live`, and with `approximate_date` the day. A broadcast's time is in no listing: its own run gives `release_timestamp` in 1.5 s |
| A topic (YouTube) | `ytsearch`, or the results page sorted by date | 6 hours | 1.4 to 1.6 s for 10 results |
| A recent item (Bilibili) | `archive/related` | When it ends | 0.44 s for 40 videos |
| A channel (Bilibili) | Its feed needs a sign-in | With an account plugin | `feed/space` answered 412, and yt-dlp's uploader listing gave ids with no titles |

Games then became a type of their own: [event libraries](../../implemented/feature/2026-11-06-event-libraries.md) gave `source-tencent-sports` the schedule above and a home row for each league, with the same rule on scores. That plugin offers no `follows` or `fresh` yet, so the feed reads channels, and games come from their league's row; phase 2 gives it both, so a followed team's game rises into `live` and its replay into `replays`.

Two tempting reads failed and are not used. YouTube's RSS feeds answered 404 for every request, and the pinned yt-dlp no longer has `ytsearchdate`.

### On the home

The node builds the rows so that every client only draws them, and the Worker lays the profile's progress over them and drops what is watched or dismissed. New rows appear above the ones the home has now:

| Row | Its cards | Limit |
|---|---|---|
| `live` | Games and broadcasts on now, then those starting within 3 hours (a followed team's within 24), followed teams first | 12 |
| Continue Watching | As now, which already goes on to the next item of a run; a Bilibili series now names its season as its run, so its next episode shows here too | 30 |
| `picks` | What an agent picked, each with its line why | 5 |
| `new` | New across all interests by score, each interest taking a turn so one channel does not fill the row, each saying why ("From Capcom Fighters JP") | 30 |
| `replays` | Whole replays of games that ended in the last 48 hours, followed teams first | 12 |
| `interest` | A shelf for each of up to three interests with at least three unwatched entries | 20 each |
| Queue, playlists, libraries | As now | |
| `popular` | A site's public chart, only while the home has under two personal rows | 20 |

An entry's score is its interest's weight (the shares watched in the last 30 days, each fading with a 14-day half-life) times how fresh it is. That is all the ranking there is; the agent's picks are where judgment goes.

Cards carry what makes a home look alive: `LIVE` with the period, a start time, `New`, and a mark for an item in the pool. On the web and a TV, the first row's first card draws large with its picture and why. A card is `New` for 48 hours after it was published. A screen fetches rows on open and on focus, every 5 minutes while the home shows, every 60 seconds while a `live` row does, and every 10 seconds while the node is still reading what it follows, replacing them in place, so a game going live appears on a home nobody touched. Rows are kept in the start record a screen already keeps ([web client](../../implemented/feature/2026-10-11-yolo-web-client.md)), so a home opens at once.

A press on a `live` card plays as any game does now; on an `upcoming` one it says when it starts.

### Games and spoilers

<a id="games-and-spoilers"></a>

The [event libraries](../../implemented/feature/2026-11-06-event-libraries.md) shipped the first two rules for games. A home full of sports must not ruin the games on it. Today a game's name carries its score (`gameReplays()` in [`tencent-sports.js`](../../../../plugins/source-ytdlp/src/tencent-sports.js)), and that name stays in history and in sessions: the same game reads `76人 106–102 活塞` on the iPhone and `76人 97–88 活塞` in the car.

- A title never holds a score: it says `76人 vs 活塞`, everywhere it is kept.
- A score shows only on the card of a game being played, from `matchup`, with a setting to hide those too. An ended game shows none.
- A plugin lists only spoiler-free videos for an ended game. Tencent's `playbackList` qualifies (`NBA常规赛：76人vs活塞英文原声全场回放`). Its `totalList` does not (`费城112-106活塞 布朗30分…`).
- A replay is the language and form the owner usually picks: `preferredReplay()` already prefers an English whole game, which is what the owner's history shows.

Replays were listed within 80 minutes of the 76ers game's end. A channel's titles cannot be cleaned this way ("SGA was NOT GUARDABLE with 42 PTS"): the [risks](#risks) say so.

### The pool

The pool is a directory of whole files, `.media-pool/` (ignored, with `POOL_DIR` in `.env.example`), on the node's disk.

**How much.** The default budget is 50 GB or a tenth of the free disk, whichever is smaller, and it always leaves 20 GB free. Settings › Pool offers off, 25, 50, 100, 200, or 500 GB, and shows what it holds. At the 1.55 to 2.58 GB an hour measured for 1080p60, 50 GB is 20 to 30 hours, or seven Street Fighter League broadcasts.

**What goes in,** highest rank first:

| Rank | What |
|---|---|
| 1 | What the owner or an agent asked to keep |
| 2 | What is unfinished from the last 14 days |
| 3 | The next five of the queue, and the agent's next |
| 4 | The next two of each run in progress |
| 5 | Whole replays of followed teams' games |
| 6 | New entries by score, at most five a day; a broadcast over two hours only from an interest the owner has watched through |

**Leaving.** Over budget, a watched item leaves after 3 days, then the lowest rank and the oldest; a candidate never pushes out a higher rank, and a file being played is never removed. Kept items leave only by the owner's or an agent's hand.

**How it downloads.** The node calls the plugin's own `prepare(source, { capabilities: POOL_TARGET, limits, reason: "pool" })` and turns the Input it gets into a file: a `file` by ranged requests, a `split` by two and an ffmpeg remux (`-c copy -movflags +faststart`), an `hls` by ffmpeg. An Input of `live` or `transcoder: true` is never pooled, and neither is a source that does not opt in with `pool: true`; Plex and folders are already at home. Requests reuse the pipeline's failover and refresh, so the plugin API barely changes and any source works. What `prepare` said (title, cover, length, tracks, chapters, and the text subtitles the owner's preference picks) goes beside the file.

**What it fetches.** `POOL_TARGET` is H.264 and AAC in MP4, at most 1080p and 6,500 kbps, which every screen plays. Settings › Pool › Quality can raise it to the best a source offers.

**How it plays.** `sources.prepare()` looks in the pool first and answers with `{ type: "local", path }` and the saved description, without calling the plugin. From there it is the [folder source](../../implemented/feature/2026-10-26-folder-source.md)'s path: `buildLocal()` plays the file as it is, copies it into HLS, or transcodes it for the screen's cap. History, resume, and tracks keep the same `sourceKey`, so nothing above the node can tell, except that it starts at once and keeps playing when the site is down. A file that fails falls through to the plugin. An item not yet in the pool plays as it does today, and a press moves it up to rank 2.

**Playback always wins.** Downloads pause while any screen reads from a site and resume 30 seconds after. At most two run at once and one per site, each on two connections (a 6.9 GB broadcast in about 77 minutes at the measured rate), with at most 20 items per site per day. A site's 403, 429, or challenge pauses the pool for that site for 6 hours and never retries harder. Three failures drop an item for a week.

**What it does not fix.** The pool removes the site from a press. It does nothing for the link from the home to the screen: the car's last session on the relay, a live game, had a 521-second stall that no file on the node could have helped. [Smooth playback first](../architecture/2026-10-21-smooth-playback-first.md) owns that link, and live games cannot be pooled at all.

### Agents

<a id="agents"></a>

| Tool | Scope | What |
|---|---|---|
| `get_feed` `{ row?, query?, since?, limit? }` | `read` | The rows, each item with why it is there, its live state, and whether it is in the pool; under about 2,000 tokens by default |
| `interest_list`, `interest_add` `{ title, queries?, url? }`, `interest_remove` `{ id, mute? }` | `read`, `control` | What Yolo follows for the owner; "I've started following SFL" becomes a record that outlives the conversation |
| `feed_pick` `{ item \| url, why, until? }` | `control` | Puts one item in the `picks` row of every screen of a profile |
| `pool_list`, `pool_add` `{ item, keep? }`, `pool_remove` | `read`, `control` | "Have this ready for the morning drive" |
| `search` `{ web: true }` | `read` | Also asks plugins' `find()`, which a screen's Search gets too |

The server's instructions and [the yolo skill](../../../../skills/yolo/SKILL.md) say to read `get_feed` first for "what's on" or "anything good", and to record what the person says they follow.

**The editor.** Once a day, and after five new plays, the node asks the screen's chosen agent plugin ([agent from the screen](../../implemented/feature/2026-10-18-agent-from-the-screen.md)) at the lowest priority, as the chain's pick does, to read history, the interests, and the feed; it may add or mute interests, make up to three picks with a line why, keep items for the pool, and search the web for what no plugin can see. It is one turn a day on the owner's subscription, on by default for the owner's profile when an agent plugin is loaded, with a switch in Settings. This is the part YouTube's algorithm cannot do: it can say why, in the owner's terms, and the owner can correct it. Nothing else waits for it, and a home with an expired sign-in only lacks a `picks` row.

### How it fits the other notes

- **[Site accounts](2026-10-28-site-accounts.md).** Its sign-ins, lists, MCP tools, and plugins stay. Its snapshot and rows become the feed's: account lists feed the same store, followed channels are follows, and `/v1/accounts/rows` is replaced by `/v1/feed/rows` before it is built.
- **[Continuation chain](2026-10-31-continuation-chain.md).** Discovery links draw on the feed, and an item in the pool skips the ready step.
- **[Home cold start](2026-10-31-home-cold-start.md).** A home with interests is not empty; its question gains one sibling, what the owner follows.
- **[Yolo 1.0](2026-10-11-yolo-1-0.md).** Promise 1 widens from the owner's sources to what those sources have new; promise 5's caching and prefetch move up.
- **[Agent canvas](../architecture/2026-10-21-agent-canvas.md).** The canvas is an agent's moment on one screen; `picks` are durable and go on every screen of a profile.

### Routes, data, and versions

| Where | Route | Scope |
|---|---|---|
| `/v1` | `GET /v1/feed/rows?limit=`, `GET /v1/feed/rows/:id?offset=&limit=` | `read` |
| `/v1` | `POST /v1/feed/feedback` `{ source?, interest?, signal: "not_interested" \| "stop_following" }` | `control` |
| `/v1` | `GET`, `POST`, `DELETE /v1/interests[/:id]` | `read`, `control` |
| `/v1` | `GET /v1/pool`, `PUT`, `DELETE /v1/pool/items/:key` | `read`, `control` |
| `/v1/owner` | `PATCH /v1/owner/pool` `{ budget, quality, paid }` | passkey session |
| Node | `POST /internal/v1/feed/digest`, `GET /internal/v1/feed/rows?profile=`, `GET`, `PATCH /internal/v1/pool` | The node's secret |

Every route is new. An older node answers 404, which the control plane reads as `available: false` and no rows, and an older client calls none of them, so `NODE_PROTOCOL` and `CLIENT_PROTOCOL` stay. D1 gains `interests` and `feed_dismissed`, which the previous release never reads. Rows and the pool's list are never kept in D1. The privacy pair at `site/public/privacy.html` and `site/public/zh/privacy.html` says in the same change that the node sends sites searches drawn from what the owner watched, keeps copies of videos on the owner's machine, and sends titles to the owner's model. When it ships, this updates the notes above and the [source plugin API](../../implemented/architecture/2026-10-11-source-plugin-api.md), [`/v1`](../../implemented/architecture/2026-10-07-v1-http-api.md), [node's internal API](../../implemented/architecture/2026-10-07-node-internal-api.md), [remote MCP server](../../implemented/feature/2026-10-07-remote-mcp-server.md), and [D1 data model](../../implemented/architecture/2026-10-07-d1-data-model.md).

### Plan

Each phase ships and rolls back alone, and the home changes first because the owner said it matters most.

1. **A home that changes, with nothing downloaded and no model. Built.** `follows`, `fresh`, the channel reads in `source-ytdlp`, `feed.js`, the cron's digest, `interests` from history, `/v1/feed/rows`, and the `live`, `new`, and `replays` rows in the web player, with "Not interested" and "Stop following" on a card. A separate `next` row was dropped while building it, since Continue Watching already shows the next item and one thing must not show twice. So was `source-ytdlp`'s own read of the schedule, once games had their own source: two would have shown each game twice, under two ids.
2. **Interests in the open, and the other clients.** `follows` and `fresh` in `source-tencent-sports`, Settings › Interests, the model's topics, `find`, shelves, `get_feed` and the `interest_*` tools, and the same rows on the Apple TV and iOS through YoloKit.
3. **The pool.** The downloader, the budget and ranks, the fall-through in `sources.prepare()`, Settings › Pool, the card's mark, and the `pool_*` tools.
4. **The editor and picks.**
5. **Accounts,** as [their note](2026-10-28-site-accounts.md) plans, into the same store.

### Decisions the owner can overrule

1. The pool is on by default at 50 GB, because the owner should not have to care. A new owner sees this in the cold start.
2. A live game's card shows its score, because it is what makes the row alive and helps pick a close game. An ended game's never does.
3. Pool files are 1080p, so the car gets them through a transcode and an Apple TV on the LAN that plays 4K live gets 1080p from the pool: smoothness over sharpness.
4. Paid replays stay out of the pool until the owner turns on the `paid` switch ([risks](#risks)).

### Owner checks

| Check | Result on 2026-11-04, or what it decides |
|---|---|
| D1, a whole file through the local path | **Ran.** A 76-second clip muxed to 1080p60 H.264 with AAC (10 s, 60 MB) passes `createLocalFiles()`: its 14 keyframes read from the index, and `playable()` says `direct` for a web screen. For the car it says `transcode`, since `CAR_CANVAS_CAPABILITIES.maxHeight` is 720 and the clip is 6,286 kbps |
| D2, that transcode's cost | **Ran,** on the M1 Max: `libx264 veryfast` at the node's settings went to 720p at 6.5 times real time on about one core. Not yet played in the car |
| D3, sizes | **Ran.** The 4h17m broadcast: 6.63 GB at 1080p60, 4.04 GB at 720p60, plus 0.25 GB of sound. A 20-minute highlight: 0.86 GB at 1080p60 |
| D4, a site's speed | **Ran.** One connection 6.0 to 6.5 Mbps, four 24 Mbps. Whether two sustain for hours is not yet known |
| D5, Tencent replays with the owner's sign-in | **Not run.** Whether `prepare` gives a stream ffmpeg can save, and how long a session lasts during it |
| D6, Bilibili with the owner's sign-in | **Not run.** Which renditions a saved file gets, and whether the hedges above disappear once it is on disk |
| D7, a week at the pool's pace | **Not run.** Whether 20 items a day from a home address brings challenges that also hurt plays; this decides the daily cap |

## Alternatives considered

**Build site accounts first.** It is designed, and follows are good data. But it needs a sign-in per site, shows no games, and would have missed this owner's league. Anonymous reads, starting from the owner's own history, gave five live games and the next round of that league in about three seconds. Accounts join the same store later.

**Let the agent write the home.** Every open or every hour, the agent would decide the rows, perhaps through the canvas. It is the most flexible and needs almost no new code. But a home would cost agent turns and seconds to load, and go silent whenever the sign-in expires, as it did twice on the day this was written. Deterministic layers make the home; the agent edits once a day.

**Run the feed in the Worker.** It would answer while the node is offline, but sites block cloud addresses, the Worker has no sign-ins or egress rules, and Workers Free counts every request. The node does the reading; D1 keeps only the interests.

**Fill the segment cache instead of keeping files.** Pre-reading what a stream would request reuses the cache, and no playback code changes. But a press would still run `prepare` against the site, ranges depend on the rendition and path, an entry cannot be evicted by item, and nothing could say an item is ready. A whole file removes the site from the press.

**Have the plugin download with yt-dlp.** Its downloader is robust and already pinned, but it works for one plugin and needs a new method; every source's Input already says how to fetch its bytes, and the pipeline already fetches them with failover.

**Put downloads in a Plex or folder library.** It reuses a library, but the item would get a new id, history and resume would split in two, and the files would show as a library of their own. That is the folder view this note is leaving.

**Keep only each item's first minutes.** A row of 40 cards could all start at once for almost no disk, but the start still hands over to the site mid-item, which is the failure the pool exists to remove, and the engine and pipeline would have to splice two streams. Worth revisiting after the [splice](../architecture/2026-10-21-smooth-playback-first.md) ships.

**Two renditions per item.** A 720p copy for the car and a better one for the TV would avoid the transcode, at nearly twice the disk. D2 says a transcode is cheap on this machine; a weaker machine may change that.

**Push rows when a game goes live.** The node cannot call the control plane, and a Durable Object polling it for every screen costs more than a screen asking once a minute while it shows the row.

**A real recommender.** One household has too little data to train on, and the site's own related lists and the owner's agent cover what a weighted count does not.

**Infer interests silently, as video sites do.** Fewer screens to build, but the owner could not see or correct why something appears, and an owner-run service has no reason to hide it. Every card says why.

**Keep interests on the node.** Simpler for the node, but agents and screens need them while it is offline, and they are the owner's data, which D1 backs up.

**Start with public charts.** One request fills a row for anyone, but a popular-videos row is the least personal thing Yolo could show, so it appears only when nothing better exists.

## Acceptance criteria

- **No sign-in, no model, no agent.** On an instance that played one NBA game, the home shows games being played at the top within 5 minutes of a game starting, without a reload, and a press plays one. Agent plugins turned off changes nothing but the `picks` row.
- **The league the owner watches.** After one Street Fighter League broadcast watched past half, the home names that channel's next round as upcoming and its unwatched rounds as new, each saying why, and the interest is listed in Settings with its reason. "Stop following" removes it and it does not come back.
- **No spoilers.** No title in history, sessions, rows, or MCP answers holds a score. An ended game's card shows none, its replay list holds no video with one, and its replay is the owner's usual language.
- **What comes next.** The next episode of a series in progress shows in Continue Watching without playing anything.
- **It changes by itself.** Two opens a day apart on a screen nobody used show different rows, with no agent involved.
- **The pool.** A pooled item starts on a LAN screen with no request to its site, and plays to the end with the site blocked. A car on the relay plays the same file through a transcode at its cap. History and resume are unchanged, and the same `sourceKey` shows the same progress.
- **Hands off.** With defaults, the pool fills and evicts by itself, never exceeds its budget, leaves 20 GB free, and pauses while a screen plays from a site. A site's 429 pauses that site and does not touch the others. Off removes the files.
- **Agents.** "Anything good on?" asked of an agent with no prior context names a live game and the next round, from `get_feed`. "Have this ready for tomorrow" fills the pool, and `get_feed` says it is ready.
- **Profiles and old sides.** A Family screen shows Family's rows only. An older node gives no rows and no error, and an older client works as before.
- **Checks.** `npm run check` passes; no tracked file under `service/` names a site; plugin tests pin parsing on recorded answers; the privacy pair says what is above.

## Risks

<a id="risks"></a>

- **The home address's reputation is the biggest one.** Background downloads from a residential address can bring a site's bot checks, and those would also hit the owner's own presses. Hence the daily cap, the 6-hour backoff, playback's priority, and D7 before the numbers are trusted.
- **Terms of service.** Keeping copies goes further than streaming on some sites, and an account that signs for downloads can be flagged. The pool takes only what `prepare` already gives, never gets around DRM, and is one household's. Paid items stay out until the owner turns that on, per site, knowing this.
- **A wrong guess costs disk and data, and a metered home link pays for it.** The budget, the five-a-day limit on guesses, and the off switch bound it, and Settings › Pool shows what it used.
- **A laptop as the home machine.** This instance's node runs on a MacBook, and one that sleeps neither reads nor downloads. The home then shows the last rows, and the pool waits.
- **The pool leaves the last mile as it is.** An owner who expects it to cure stalls in the car on LTE will be disappointed where the home's uplink or the relay is the limit. The car's transcode also costs a core on the node, more on a weaker machine.
- **Sites change.** Both reads that failed on 2026-11-04 were once the obvious ones. A failed read keeps the last snapshot and says so, and no row depends on one site.
- **A narrow view.** Interests from history show more of the same. Related lists and the editor's picks widen it, and it remains less than a site's whole catalog.
- **Spoilers outside the schedule.** Channel titles and covers can give results away, and only a model could guess which. An owner avoiding results can stop following that channel. A follow-up may let the model hide such titles.
- **What screens show and what sites hear.** A home now displays interests to whoever sits there, passengers included, and searches drawn from viewing go to the sites. Interests are per profile, muting is one tap, and the privacy pages say so.
- **More running on the node, and more for the Worker.** A feed and a downloader add work to a machine that also serves video, and every card's cover is a `/v1/thumbnail` request counted against Workers Free. Screens cache covers, and the cron's step adds 48 requests a day.
- **Given up:** rows fresher than a poll, offline copies on the screens themselves, pooling live games, per-item renditions, and any recommendation trained on more than one household.
