# Agent Note: Account plugins bring what the owner follows and watches on other sites to every home and agent

Status: proposed

English | [中文](2026-10-28-site-accounts.zh.md)

## Problem

The owner talks to their agent the way they think about their own media: "play a playlist from a YouTube channel I follow", "the next episode of the anime I'm following on Bilibili", "something from my watchlist", "the video I was watching on Bilibili last night". The agent knows Yolo's history, queue, and playlists, but nothing about the accounts the owner already keeps elsewhere, so it answers that it does not know what the owner follows, or guesses with a web search. The owner's taste already lives on those sites: channels and uploaders they subscribe to, favorites folders, shows they follow, films they rated, a watchlist, a manga bookshelf, and what they watched there.

The screens have the same gap. Without Plex or a folder of files, the home screen is empty: there is nothing to open Yolo for. With them, it still shows nothing of what the owner follows, so to find something new the owner opens the site's own app, and Yolo is left playing the links they hand an agent. Yolo's main path is open it and find something, watch, and go on to the next thing; the owner's follows are what fills the first and last steps for most owners. Even an owner who never signs in to a site has picked it for a reason, and its public lists can fill a row.

Yolo needs one way to read those lists that serves both: every agent the owner uses (the screen's Ask, Claude, ChatGPT, Codex) and every screen's home (the web and the car, the Apple TV, iOS). It must be a plugin: the core may not name a site ([plugin architecture](../../implemented/architecture/2026-10-11-plugin-architecture.md)), and Bilibili and YouTube are only the first sites; Douban, IMDb, and manga sites follow with the same shape.

## Proposal

A new plugin type, **account**, reads one site's lists: the owner's own, through their account there, and the site's public ones without it. The node keeps a snapshot of every account plugin's lists and refreshes it in the background. Screens get rows built from it on their home screen, and what a cold start needs to fill an empty one; agents get two read-only MCP tools; what plays after an item can draw on it. An account plugin never plays anything itself: an entry that can play carries a URL, which a source plugin claims, so a tap or an agent plays it as any web video plays now.

```
site sign-in (QR, cookies) ──▶ node's sign-ins (.yolo/sign-ins/) ──▶ link playback, signed in
                                       │
                                       ▼
site ──public lists, or the account's──▶ account plugin (node) ──▶ node snapshot (.media-cache/accounts/)
                                                                         │ /internal/v1/accounts/*
screens ──/v1/accounts/rows──▶ control plane ──nodeFetch─────────────────┤
agents ──MCP get_accounts / account_entries──▶ control plane ──nodeFetch─┘
  tap or play { source } ──▶ source plugins (link playback, Plex, …) ──▶ Yolo's history and up next
```

### Accounts and profiles

<a id="accounts-and-profiles"></a>

Two words keep two things apart:

- An **account** is a sign-in to a site or library (Bilibili, YouTube, Plex), which the node keeps. It is not a person. One sign-in serves both playback and the lists this note reads, so the owner signs in to a site once.
- A **profile** is a person watching: whose history, Continue Watching, watched marks, and track preferences a screen's session uses (the owner, or Family, as [screen sessions](../../implemented/architecture/2026-10-31-screen-sessions.md) defines them).

**An account belongs to the owner's profile.** Rows from lists read through a sign-in show on screens whose session is the owner's, and only the owner's agents read them. A screen whose profile is Family gets only the public rows (lists marked `account: false`), with Family's own progress laid over them, and no candidate from the owner's lists plays after an item there. Until screens have profiles, every screen is the owner's. A Family profile may later connect its own accounts: a sign-in would then name the profile it belongs to, and the rows, already chosen per profile, need no other change.

### The plugin

A node entry calls `yolo.registerAccount(id, impl)`, with `id` under the source id rules, and declares the site's `hosts` in its manifest, as every plugin does under the home cold-start proposal ([signing in](#signing-in)):

| Method | Purpose | Returns |
|---|---|---|
| `title` | The site's name for people ("Bilibili") | A string |
| `identity({ signal })` | Who the node's sign-in for the site is; null when it has none; throws `unauthorized` with what to do when the sign-in no longer works | `{ id, name, url? }` or null |
| `lists({ signal })` | The lists the plugin reads now: the public ones always, the account's when signed in | `[{ id, title, kind, home?, account?, private?, refreshMinutes?, keep? }]`, where `kind` is what its entries are, `home` the row it makes ([on the home screen](#on-the-home-screen)), `account: false` a public list read without a sign-in, and the rest how it is read ([lists that change often](#history-and-other-lists-that-change-often)) |
| `entries(listId, { cursor, signal })` | One page of a list, newest first where the site orders by time | `{ entries: Entry[], cursor? }`; no `cursor` ends the list |
| `connect` | Optional: how a screen signs in to the site, the generic `connect` of the cold start proposal ([signing in](#signing-in)) | `{ start(), poll(attempt), forget() }` |
| `health()` | Optional state for `/internal/v1/health` | Any object |

An **Entry** is `{ id, kind, title, url?, about?, by?, thumbnail?, at?, progress?, duration?, status?, next?, rating?, tags?, ids?, links? }`:

- `kind` is `channel` (a YouTube channel, a Bilibili uploader), `title` (a film, show, anime, book, or manga), `playlist` (a favorites folder, a saved playlist), `person` (an actor or director followed), or `video` (a new upload, watch later, a favorite, history, a popular video).
- `about` is a short description the site gives (a channel's bio, a title's one line), at most 200 characters; it is what lets "the music channel I follow" match an entry whose name says nothing.
- `by` is `{ title, url? }`, the channel or uploader of a `video` entry, so "the uploader I watched yesterday" finds it.
- `at` is when the owner followed, marked, or last watched it, or when a new upload was published. `progress` and `duration` are seconds: how far the owner watched a history entry, and its length.
- `status` is `want`, `doing`, `done`, or `dropped`; `rating` is `{ value, scale }` as the site gives it. `next` is `{ title, url, label? }` on a `title` entry the owner is watching: the episode the site says comes next for them.
- `ids` are external ids keyed as [metadata plugins](../../implemented/architecture/2026-10-25-metadata-plugins.md) key theirs, by the plugin's own name (an IMDb `tt…`, a Douban subject id); the core passes them through without reading their keys, so it names no provider. An agent can hand such an entry's ids to the metadata plugins, through `search_metadata` or an item's details, to learn what the work is.
- `links` are other pages of the entry by a generic `rel`: `videos`, `playlists`, `live`, `episodes`. A channel entry names its playlists page, so the agent need not know each site's URL layout.
- `tags` carry the site's grouping, such as Bilibili's follow groups.

Plugins only read: no method follows, unfollows, rates, or marks anything on the site.

### Signing in

<a id="signing-in"></a>

The sign-in is the node's, not the plugin's: the [home cold start](2026-10-31-home-cold-start.md) proposal gives every plugin a generic `connect` and the node a store of site sign-ins (`yolo.signIns`, in its ignored `.yolo/sign-ins/`, mode 600), each limited to the hosts the plugin that made it declares. Link playback reads the same store, so one Bilibili scan both fills the rows and plays Bilibili links signed in. An account plugin gets its account in one of three ways:

- **From a screen**, where the site allows it. `connect.start()` returns `{ attempt, qr, expiresAt }`, a sign-in the owner approves in the site's own phone app by scanning the code; `connect.poll(attempt)` answers `waiting`, `scanned`, `done`, or `expired`, and on `done` the plugin saves the session's cookies with `yolo.signIns.save()`. Bilibili's web sign-in works this way (P5). A screen shows the code only after the owner's passkey, since it signs an account in.
- **With the owner's own cookies:** a cookies file the node already has for the site's hosts (`YTDLP_COOKIES_FILE`, or the plugin's `cookiesFile`) or the plugin's `cookiesFromBrowser` option. As in the cold start proposal, the owner's own cookies win over a sign-in the node saved, for playback and lists alike. A plugin without a screen sign-in answers `connect` with these steps as `instructions`.
- **From an export file** (`subscriptionsFile`, an IMDb CSV), for sites that offer only an export. It gives lists, not a sign-in.

The plugin reads through the sign-in with `yolo.fetch(url, { signIn: true })`, which sends the cookies the node holds for that URL's host when the host is among the plugin's `hosts`, or with `yolo.signIns.cookieFile(url)` for a tool such as yt-dlp. A plugin turned on with no sign-in reads only its public lists; with no public list, it makes no request at all. Disconnect deletes the sign-in and the account's lists from the snapshot, keeping the public ones; it does not sign the session out on the site, which the owner does in the site's own security settings. How a plugin is turned on, and where a screen shows its code, belong to the cold start proposal; account plugins are not loaded by default, like every plugin there.

### The snapshot on the node

A new `service/node/src/accounts.js` keeps the registered account plugins and does the work every plugin would otherwise repeat:

- **Refresh.** After `start`, a list older than its interval is read again, then every interval with a random tenth of jitter; the interval is the list's `refreshMinutes`, else `refreshHours` (12). Reads go one plugin and one request at a time, at least `paceMs` (1,000) between pages, so a site's rate limit or risk control sees one slow reader. `POST /internal/v1/accounts/refresh` reads one plugin, or all, now. When a sign-in is saved, the node reads that plugin at once, the lists with a `home` row first.
- **Bounds.** At most 5,000 entries per list and 2 MB per plugin, or the list's own `keep`; a longer list keeps its newest and says it was cut.
- **Failures keep the last snapshot.** A refresh that fails keeps what it had, with the error and `stale: true`; `unauthorized` says what to do, and `yolo doctor` shows it.
- **Playable entries are claimed.** When it stores an entry with a `url` (or a `title` entry's `next.url`), the node asks the source registry's `claim`, which is fast and offline, and keeps the `source` it gets; the entry's item id is that source's `sourceKey`, as any web video's is. An entry no source claims stays readable by agents and never becomes a card.
- **Storage.** The snapshot is JSON under the node's ignored `.media-cache/accounts/`, rebuilt from the sites when deleted; the sign-ins stay in the node's store. Neither goes to D1 or the Worker; screens and agents read through the control plane.
- **Search** runs next to the snapshot: case-, width-, and accent-insensitive matching over `title`, `about`, `by.title`, and `tags`, an exact or prefix match before a substring, then every word within one entry.

`GET /internal/v1/accounts` answers the overview, `GET /internal/v1/accounts/entries` a filtered page, `GET /internal/v1/accounts/rows?profile=` the home rows for a profile, and `GET /internal/v1/accounts/candidates` what may play next. All are new and only a new control plane calls them; an older node answers 404, which the control plane turns into no rows and `available: false` with "Upgrade the media node", so `NODE_PROTOCOL` stays.

### On the home screen

<a id="on-the-home-screen"></a>

Each list says in `home` which row it makes, if any; `channel`, `person`, and `playlist` lists make none, since a card of one would not play. The node builds the rows from the snapshot, so every client (the web player, the Apple TV, iOS) gets the same rows and only draws them:

| `home` | Row | Its cards | Order and limit |
|---|---|---|---|
| `continue` | Go on with what the owner watches on the site | A followed series' `next` episode; with history on, a video the owner left unfinished there | The series and videos last watched first; a video only when its `progress` is under 90% of `duration` and within 7 days; 20 at most |
| `updates` | New from the channels and uploaders the owner follows | The site's own feed of their uploads | Newest first, from the last 14 days, 40 at most |
| `saved` | Watch later | The list as the site has it | The site's order |
| `collection` | One favorites folder or saved playlist | Its videos | The site's order (newest added first), 40 at most; a plugin makes at most 5 such lists, the default folder first |
| `popular` | Popular on the site, a public list | The site's own chart | The site's order, 20 at most |

- **Order on the page.** Rows follow Yolo's own Continue Watching, by role in the order above, and within a role by the plugins' load order; the public `popular` rows come last, after everything the owner chose. Clients title a row by its role, translated in the client ("New from people you follow"), with the plugin's `title` as its site, or with the list's own title for a `collection`; no client or service code names a site.
- **Whose rows.** `/v1/accounts/rows` answers for the requesting screen's profile ([accounts and profiles](#accounts-and-profiles)): every row on the owner's, the public rows on Family's.
- **What the profile has seen goes.** Every card carries that profile's Yolo progress, laid over it as library listings are ([`/v1`](../../implemented/architecture/2026-10-07-v1-http-api.md)). `updates` and `popular` leave out what Yolo marks `watched` and, with history on, what the site's history shows watched past 90%; `continue` leaves out an item already in Yolo's Continue Watching, so one thing never shows twice.
- **A tap plays the source.** A card is a library item with its `source`; a tap plays it with `POST /v1/playback/play { source }`, as a history card does, and link playback plays it with the same sign-in. The play is in Yolo's history from then on, the source's run goes on after it ([up next](../../implemented/feature/2026-10-23-up-next.md)), and a series' `next` lands in its season's run. A card from the site's history starts at its `progress` when Yolo has no position of its own for it: the screen passes it as `startTime`, so nothing maps the site's ids to Yolo's.
- **Covers** are the entries' own images, sent to screens as a web video's thumbnail is and loaded through `/v1/thumbnail`, which the node fetches with its guards ([node's internal API](../../implemented/architecture/2026-10-07-node-internal-api.md)); MCP answers carry the same images as image links ([cover images](../../implemented/feature/2026-10-07-remote-mcp-server.md#cover-images)).
- **Freshness.** A screen asks for the rows when it loads its home, as it asks for history; a refresh pushes nothing. `updates` lists declare `refreshMinutes: 30`, so a new upload reaches the home within about half an hour.
- **When the node is offline,** `/v1/accounts/rows` answers `node_offline` as the library routes do. A screen keeps the rows it last showed in the record it keeps for a start, as it keeps the other rows ([web client](../../implemented/feature/2026-10-11-yolo-web-client.md)), shows them, and a tap says the home media node is offline, as a library card's does. The rows are never kept in D1.

The `/v1` routes, each forwarding to the node, need the `read` scope, so a paired screen's own credential is enough:

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/accounts` | `{ available, accounts }`: each account plugin's `id`, `title`, the account's `name` or null, its state (`signed_out`, `reading`, `connected`, `unauthorized`, `failed`, `stale`) and `reason`, how it connects (`qr`, `instructions`, or none), and its lists with `kind`, `home`, `account`, `private`, whether they are read, their count, and when they were read |
| GET | `/v1/accounts/rows?limit=` | `{ rows }` for the screen's profile: each `{ id, account, list, role, title, total, items }`, `items` being library items (`id`, `source`, `title`, `by`, `thumbnail`, `duration`, `at`, `label`, `startAt`) with the profile's progress; `limit` (20 by default, 40 at most) caps each row |
| GET | `/v1/accounts/rows/:id?offset=&limit=` | One row, paged, for a screen's See all |
| GET | `/v1/accounts/entries` | The same query and answer as MCP `account_entries` |

Behind the owner's passkey session, connecting and disconnecting are the cold start proposal's routes under `/v1/owner/plugins/:name/`, and the lists the plugin reads are its `lists` option, changed with that proposal's `PATCH /v1/owner/plugins/:name`. This note adds one [owner route](../../implemented/architecture/2026-10-07-v1-http-api.md#owner-routes), `POST /v1/owner/accounts/:id/refresh`. Every route is new, so `CLIENT_PROTOCOL` stays. Settings › Plugins shows an account plugin's state, Connect or Disconnect, a switch for each list (private ones off until turned on), and Refresh now.

### What accounts give a cold start

<a id="what-accounts-give-a-cold-start"></a>

How an empty home leads the owner to choose where they watch belongs to the [home cold start](2026-10-31-home-cold-start.md) proposal, which also turns plugins on from any screen. An account plugin gives it four things:

- **A row without a sign-in**, where the site has a public list: choosing Bilibili and skipping its sign-in still gives the home its popular videos.
- **A sign-in on the screen**, where the site allows it: `connect.start()` and `connect.poll()` ([signing in](#signing-in)), so the owner connects a site by scanning a code with its phone app, without the home machine.
- **Rows at once.** When a sign-in is saved, the node reads that plugin at once, the lists with a `home` row first, and `GET /v1/accounts` says `reading` until the first rows are in; a cold start can show their skeletons and then the rows, within seconds of the scan rather than at the next refresh.
- **The rows themselves**, from then on ([on the home screen](#on-the-home-screen)).

### What plays after an item

The design of what plays after an item ends, past what [up next](../../implemented/feature/2026-10-23-up-next.md) does now, belongs to its own note; this one says what an account can give it. The order there is meant to be the series' next episode, then the queue, then the next from the same channel, then new uploads from follows, then the agent's pick; accounts give the two middle steps' candidates. `GET /internal/v1/accounts/candidates?after=<sourceKey>&by=<channel url>&profile=&limit=` answers, each as a library item with `from: "account"` and its list:

- **`sameBy`:** entries of every read list whose `by.url` is the ended item's channel, not watched: those published after the ended item first, oldest first, so the channel's next upload follows; then the others, newest first. This covers only channels the owner follows and uploads in the snapshot; a channel's whole listing is its source's to give.
- **`updates`:** what the `updates` rows hold, newest first, not watched.
- **`continuing`:** the `next` of each followed series, last watched first.

"Not watched" is the rows' rule, for the session's profile. The candidates obey the same lists and profiles as the rows: a list turned off gives none, and a Family session gets none from the owner's account.

### History and other lists that change often

<a id="history-and-other-lists-that-change-often"></a>

A site's watch history is a list like the others, of `video` entries newest first with `at`, `progress`, and `duration`, but it differs from follows in four ways, and the list says so in what `lists()` returns:

- **It is private.** A list marked `private: true` is read only when the owner turns it on, in the plugin's settings or by naming it in the plugin's `lists` option (`"lists": ["following", "history"]`); a list the owner did not name is read unless it is private. History says more about a person than follows do, and what an agent reads goes to its model's provider, so it is never on by default.
- **It changes often.** History declares `refreshMinutes: 60`; the owner's `refreshMinutes` option per list (`{ "history": 30 }`) overrides it.
- **It is read from the top.** A refresh of a list with `keep` reads pages until one holds an entry already in the snapshot with the same `at`, or the same position when the site gives no time, and merges the new entries in front; most hourly refreshes are one request.
- **It keeps only what is recent.** History declares `keep: { days: 30, entries: 500 }`; older entries are dropped at each refresh.

One rule decides who sees a list: a list is read or it is not. A list that is read is open to the owner's agents and to the screens on the owner's profile alike, through the `read` scope, and a public list to every paired screen; one that is not is read by none of them, never fetched from the site, and gives no row and no candidate. Share links and unpaired pages never see an account. A screen keeps the rows it showed in its own storage, as it keeps Continue Watching, so with history on, a browser on the owner's profile holds the titles of videos the owner left unfinished on the site.

Site history stays apart from Yolo's own: `history` answers what played in Yolo, and `account_entries { list: "history" }` what was watched in the site's own apps, and the tool descriptions say which is which. Neither is merged into the other, since the same video has different ids in a source and on the site; a card or an agent starts it at the site's position with `startTime` or `start_at`.

### The MCP tools

Two read-only tools with the `read` scope, in [`service/control/src/mcp/tools.js`](../../../../service/control/src/mcp/tools.js), naming no site; agents act for the owner, so they read the owner's accounts:

- **`get_accounts`** answers every account plugin turned on: the site, the account's name or that none is signed in, each list with its kind, whether it is public, its count, and when it was read, and the titles of its 20 newest entries. It stays under about 2,000 tokens with any number of entries, so an agent can read it at the start of a request. `refresh: true` starts a refresh in the background and answers the snapshot it has, with `refreshing: true`.
- **`account_entries`** `{ account?, list?, kind?, query?, status?, since?, offset?, limit? }` answers matching entries with their `url`, `links`, `ids`, `about`, `by`, `status`, `next`, item id where a source claimed it, and a history entry's `at` and `progress`; `since` (an ISO date) keeps entries from then on; `limit` is 50 by default and 200 at most, and thumbnails become image links as in every tool.

The server description and [`skills/yolo/SKILL.md`](../../../../skills/yolo/SKILL.md) say to read `get_accounts` when the person says "I follow", "my subscriptions", "my list", or names a channel or title as theirs, before searching the web; the agent plugins' instructions add the same line ([screens ask the owner's own agent](../../implemented/feature/2026-10-18-agent-from-the-screen.md)). No account data enters a prompt by itself: the agent reads it when the request needs it.

### Browsing a URL

The motivating request needs one more step: the playlists of a channel. `browse` gains `url`, which returns the source's `expand(url)` without importing it, and an expanded item may say `collection: true` when it is itself a playlist, so the agent can list `links.playlists`, choose one, and `playlist_import` or play it. The yt-dlp source marks its flat entries that point at a playlist.

So "play a playlist from a YouTube channel I follow" runs `get_accounts` → `account_entries { kind: "channel", query: "music" }` (or the whole list when nothing matches) → `browse { url: <links.playlists> }` → `playlist_import` → `playlist_enqueue` or `play`, and asks which channel when several fit, as the agent already does for search results.

### The first plugins

| Plugin | Lists | How it reads |
|---|---|---|
| `plugins/account-bilibili` | Public: `popular` (`home: popular`). The account's: `following` (uploaders, with follow groups as `tags`), `updates` (`home: updates`), `bangumi` (followed series with `status` and `next`, `home: continue`), `watch-later` (`home: saved`), one list per favorites folder (`home: collection`), `history` (private, `home: continue`) | Bilibili's web JSON through `yolo.fetch`, so the owner's egress rules apply: `x/web-interface/popular` without a sign-in (P7); with one, `x/web-interface/nav` for the account, `x/relation/followings`, the video feed of the account's follows `x/polymer/web-dynamic/v1/feed/all?type=video`, `x/space/bangumi/follow/list`, `x/v2/history/toview`, `x/v3/fav/folder/created/list-all` and each folder's `x/v3/fav/resource/list`, and `x/web-interface/history/cursor` for history, whose entries carry the time watched, the position, the length, the uploader, and a series episode's place. Connects by `qr` with Bilibili's web sign-in, which also makes link playback play Bilibili signed in |
| `plugins/account-youtube` | The account's: `subscriptions` (channels), `updates` (`home: updates`), `playlists` (the owner's own and saved), `watch-later` (`home: saved`), `liked`, `history` (private, `home: continue`); no public list yet | The pinned yt-dlp with the sign-in's cookie file: `--flat-playlist -J` on `feed/channels`, `feed/subscriptions` for `updates` (P4), `feed/playlists`, `:ytwatchlater`, and `:ytfav`. History comes from `feed/history`'s own page data, which the plugin reads with the same cookies: yt-dlp's flat listing of it keeps only the order and lengths, while the page gives each day's heading and each video's watched share (P3); yt-dlp's tab extractor already reads `feed/channels`' channel entries with their subscriber counts. Connects with `instructions` for `cookiesFromBrowser` on the home machine; a Google Takeout `subscriptions.csv` (`subscriptionsFile`) gives `subscriptions` without cookies |

Neither is in [`plugins/official.json`](../../../../plugins/official.json)'s load list; the owner turns on the ones they want ([what accounts give a cold start](#what-accounts-give-a-cold-start)). Each follows [`yolo-add-official-plugin`](../../../skills/yolo-add-official-plugin/SKILL.md).

The interface fits the next sites without change: Douban's collections (`title` entries with `status` and `rating`, read from its pages with cookies or from an export), IMDb's watchlist and ratings (its CSV exports, read from a file), and a manga site's follows (`title` entries of kind manga, from its API where one exists). A site that offers only an export reads a file the owner drops in, which the same refresh rereads when it changes. Their entries rarely play, so they mostly serve agents, and a `title` entry with `next` makes a `continue` card where a source can play it.

### Plan

1. Owner checks P4 to P7 below; P1 to P3 ran.
2. On the cold start proposal's `yolo.signIns`, `yolo.fetch`'s `signIn`, and generic `connect`: the plugin API's `registerAccount` and types; `service/node/src/accounts.js` with public and private lists, per-list intervals, top-first refresh, the read after a sign-in, claiming, rows per profile, candidates, and its endpoints and tests; the two MCP tools and `browse { url }` with `collection`.
3. The `/v1/accounts` routes and the refresh route; in the web player, the account rows, kept in the start record like the other rows. Turning plugins on, the cold start's guide, and where the QR code shows come with the cold start proposal; rows per profile follow the screen sessions proposal. The Apple TV and iOS draw the same rows from the same routes in their own changes.
4. `account-bilibili`, then `account-youtube`, neither in `plugins/official.json`'s load list; the server description, the yolo skill, and the agent plugins' line.
5. The privacy policy pair at `site/public/privacy.html` and `site/public/zh/privacy.html` says the node keeps the owner's lists from the sites they connect, and the last 30 days of their watch history there when they turn it on; that their screens show and keep those rows; and that their agent reads them. The sign-ins themselves are the cold start proposal's to add.

### Owner checks

| Check | Steps | Decides |
|---|---|---|
| P1, YouTube's channel list | `yt-dlp --cookies <file> --flat-playlist -J https://www.youtube.com/feed/channels`, then the same for `feed/playlists` | Whether `account-youtube` reads cookies or starts with the Takeout file |
| P2, Bilibili's followings | With the cookies file, page `x/relation/followings?vmid=<own mid>&ps=50` to the end and count against the number the account's own page on the site shows; note any `-352` or `-412` | Whether a signed-in owner reads the whole list, and the pace it needs |
| P3, YouTube's history | `yt-dlp --cookies <file> --flat-playlist -J --playlist-end 50 :ythistory`; check that it comes newest first and whether entries carry a time watched or a position, and run it again after watching one video | Whether YouTube history has `at` and `progress`, or only its order, and whether a top-first refresh finds the new entry |
| P4, the follows' feeds | Bilibili's `x/polymer/web-dynamic/v1/feed/all?type=video` with the cookies, two pages; `yt-dlp --cookies-from-browser chrome --flat-playlist -J --playlist-end 60 :ytsubs`, and its page's own data as in P3 | Whether both feeds give each upload's channel, publish time, length, and cover in one or two requests, and what `updates` must read from the page instead |
| P5, a sign-in from a screen | Bilibili's web QR sign-in (`passport.bilibili.com/x/passport-login/web/qrcode/generate`, then `…/poll`), scanned with the Bilibili app; then P2 with the session it gives, and a Bilibili link played with it | Whether `account-bilibili` connects by `qr`, how long its session lasts, and whether link playback plays signed in with it |
| P6, a followed series' next episode | For two series followed on Bilibili, compare `x/space/bangumi/follow/list`'s progress fields with the season's episode list and the owner's history | Whether `next` comes from the follow list alone or needs the season and history |
| P7, a public list | From the node with no Bilibili cookies, read `x/web-interface/popular?ps=20&pn=1` twice an hour apart; note any `-352` or `-412` | Whether the `popular` row needs no sign-in, and its pace |

Results on 2026-10-28, with the live node's `YTDLP_COOKIES_FILE` and its pinned yt-dlp 2026.10.21:

- **The yt-dlp source's cookies file does not sign in to YouTube.** Its YouTube cookies are anonymous ones (`VISITOR_INFO1_LIVE`, `YSC`, `PREF`, no `SID`, `SAPISID`, or `LOGIN_INFO`), so `feed/channels` gives no initial data, `feed/playlists` answers 401, and `:ythistory` asks for a login. `account-youtube` takes `cookiesFromBrowser` or a cookies file exported from a signed-in YouTube; P1 and P3 then ran with `--cookies-from-browser chrome`.
- **P1 passed.** `feed/channels` listed 370 channels in 2.4 seconds, every one with its channel id and URL, `@handle`, and subscriber count, and 337 with a description for `about`; no entry says when it was followed, so subscriptions carry no `at`. `feed/playlists` listed 18: liked (`LL`), watch later (`WL`), `FL`, and 15 playlists, each with its owner's name, which tells the account's own from saved ones, but no count or date.
- **P3: yt-dlp's listing is not enough; the page is.** `:ythistory` listed 50 videos newest first with their lengths, but no time watched, no position, and the channel on only one. The page yt-dlp read (`feed/history`'s `ytInitialData`) has both: its sections are headed by day (`Monday` back to `Thursday`, then dates such as `Oct 21`), and each video's `thumbnailOverlayProgressBarViewModel.startPercent` is the share watched (10, 16, 52, 100, …). A YouTube history entry's `at` is therefore its day, and `progress` its share times its length, to the minute at best. The second half of P3, a refresh after watching one more video, waits for the owner.
- **P2 passed.** Signed in (`nav` `isLogin`), `x/relation/stat` counts 125 followings and four pages of 50 read all 125, at 0.3 to 0.6 seconds a page with a second between them, from the home address without the egress rule's proxy and with no `-352` or `-412`. An entry carries `uname`, `sign` (the bio, for `about`), `official_verify`, `face`, `mtime`, and `tag` (its group ids, null when ungrouped); `x/relation/tags` names the account's two groups.
- **Bilibili's history has what the design needs.** `x/web-interface/history/cursor?ps=20` answered 20 rows in a second with a `cursor` of `max`, `view_at`, and `business` for the next page. Every row has `view_at`, `progress`, and `duration` in seconds, and `history.business` says `archive` (a video, with `bvid`, `page`, and `author_name`) or `pgc` (a series episode, with `epid`, `show_title`, and `long_title`); 18 of the 20 were videos.

## Alternatives considered

**Only agents read the accounts.** The first form of this proposal: two MCP tools and nothing on the screens. The home would stay empty without local media, and with it would still show nothing new, so the owner would keep opening the site's app to find something and use Yolo only for the links they hand an agent. Rows are what makes Yolo the place to start.

**Call the plugin type "profile".** Its first name, for the owner's profile on each site. But a profile is a person watching, whose history a screen writes, and an account is a sign-in, which several people's screens may draw on; one word for both would leave "whose profile" unanswerable.

**Fold the lists into the source plugins.** Link playback already reads sites, and one plugin per site could both play and list. But link playback is one built-in plugin for every site while lists are chosen per site, a site such as IMDb has no source at all, and the node's sign-in store already lets link playback and an account plugin share one sign-in without sharing code. One package may still register both, as a source and a metadata entry already can.

**Keep each account plugin's sign-in in its own state directory.** The plugin would need nothing from the node, but a Bilibili scan would then read follows while playback stayed anonymous, or the owner would sign in twice. The node's store, limited to declared hosts, serves both.

**Each client builds its rows from `/v1/accounts/entries`.** The web player, the Apple TV, and iOS would each filter, sort, and leave out the watched in their own code, and drift. The node builds them once next to the snapshot, where watched state and the claims are at hand, and clients only draw.

**Poll each followed channel for new uploads.** 370 YouTube channels or 125 Bilibili uploaders would be hundreds of requests per refresh. Both sites have a feed of the account's follows in one or two requests, which is what the site's own app shows.

**Keep the snapshot or the rows in D1.** Agents and screens could read them while the node is offline, and [Yolo 1.0](2026-10-11-yolo-1-0.md)'s 1.1 plans follows in D1. But an offline node cannot play what they show, a refresh of thousands of rows spends Workers Free's D1 writes for little, screens already keep the rows they showed for a start, and the lists of a personal account stay on the owner's machine with the sign-in that reads them. When 1.1's inbox needs follows the Worker can read on a schedule, it takes the accounts' channels as its follows.

**Read the site live on every request.** No snapshot to keep, but a Bilibili following list is ten pages and a YouTube one several continuations: seconds per question or home load, and the request rate that triggers risk control. A snapshot answers in one hop and reads each list on its own interval.

**Show the owner's account rows on every profile.** One set of rows is simpler, but the owner's follows, and their history when on, would show on the family TV to whoever sits there, and Family's viewing would mark them watched. Public lists carry nothing personal, so they show on every profile.

**Load both plugins by default.** A cold start could then offer the sites with nothing to turn on. But which plugins run is the owner's choice for every plugin, and a plugin loaded on every node is code running there for owners who never use it.

**Put everything in the agent's prompt.** Hundreds of channel names in every request cost tokens on every question, most of which are not about follows, and claude.ai or ChatGPT have no prompt Yolo writes. A compact overview tool the agent calls when it needs it costs nothing otherwise.

**An MCP resource instead of tools.** Most clients do not read resources unless the person attaches them; a tool the server description names is read when the request needs it.

**The sites' official APIs.** YouTube's Data API reads `subscriptions?mine=true`, but needs a Google Cloud project and OAuth consent, and a consent screen left in testing mode expires its refresh token after seven days, while `youtube.readonly` needs Google's verification to publish. Bilibili and Douban offer no public API for a user's lists. A site's own sign-in, cookies, and export files work for every site the owner can sign in to.

**Merge the site's history into Yolo's.** One history would answer "what did I watch" in one call and resume across apps, but a video's id in a source (a normalized URL) and on the site differ, a wrong match would move someone's progress, and Yolo's history keys resume and watched state. Kept apart, a card or an agent starts at the site's position and Yolo's history takes over from that play.

**Make accounts a kind of metadata plugin.** Both read other sites, and a Douban plugin could do both. But a metadata plugin describes any work for anyone, from public records or the owner's key, and is asked per item while it plays; an account plugin reads one person's lists, is read on a schedule, and answers about the person. Kept apart, one package may still register both.

**Yolo's own follows only.** The owner would follow everything again inside Yolo; the point is to use what the owner already keeps, and Yolo's own follows can come later on top.

## Acceptance criteria

- With `account-bilibili` turned on and no sign-in, the home shows a row of Bilibili's popular videos and no request reads anything of an account. Scanning its code reads the account's home lists at once: `GET /v1/accounts` says `reading`, then the home shows rows of new uploads from follows, followed series' next episodes, watch later, and favorites, without waiting for a refresh, and a Bilibili link then plays signed in without any cookies file on the node.
- A tap on any card plays it on that screen through its source; it then shows in Yolo's Continue Watching, leaves the `updates` row once watched, and the source's run goes on after it. A followed series' card plays its next episode and goes on through the season.
- The rows are the same on the web player and in the car, carry the profile's Yolo progress, never show an item twice, and load their covers through `/v1/thumbnail`. With the node offline, a reload shows the last rows and a tap says the node is offline; no row is written to D1.
- A screen on the Family profile shows the public rows only, with Family's progress, and gets no candidate from the owner's account.
- With `account-bilibili` and `account-youtube` signed in, `get_accounts` lists both accounts with their lists and counts, under about 2,000 tokens, and `yolo doctor` shows both with when each was read. Asked on a screen "play a playlist from a YouTube channel I follow" (and the same in Chinese), the screen's agent reads the accounts, names or picks a followed channel, and a playlist of that channel plays or is queued, without a web search for the owner's subscriptions.
- History is read only once turned on; then its unfinished videos make a `continue` row that starts each at the site's position, and agents can read it; turned off, neither screens nor agents see it, and no history request goes to the site. An hourly refresh of a history that did not change is one request per plugin, and history keeps no entry older than 30 days.
- For an ended video whose channel the owner follows, `/internal/v1/accounts/candidates` gives that channel's next upload in the snapshot first under `sameBy`, and nothing from a list turned off.
- Neither plugin is in `plugins/official.json`'s load list. One whose sign-in expired reports `unauthorized` with what to do and keeps its public rows, the other plugins' rows and lists still answer, and a failed refresh keeps the last snapshot marked `stale`. Disconnecting removes the account's lists and keeps the public ones.
- No file under `service/` or `clients/` names a site: row titles come from roles and the plugins' titles. `scripts/provider-names.test.js` passes with the two new plugin directories, which make `bilibili` a provider name, so every line under `service/` that names Bilibili today (comments in the core, the plugin API, and the MCP tools, and the metadata tests' sample uploads) is reworded.
- No method writes to a site's lists; tests cover the snapshot bounds, pacing, claiming, public and private lists, the rows' order and filters per profile, the candidates, the private-list rule for rows and tools alike, and the 404 of an older node.

## Risks

- **Accounts and terms.** Reading a signed-in account is what the site's own apps do, but a site may flag an account that reads too fast; the pace, per-list intervals, and read-only calls keep the reads near a person's. Owners connect each account themselves.
- **A sign-in kept on the node.** A screen's QR sign-in is a whole session of the owner's account, kept on the home machine in the node's sign-in store and used by link playback too; anyone who can read that machine can use it. Disconnect deletes it, and the owner ends it on the site.
- **Sessions expire or rotate.** YouTube rotates cookies exported from a browser tab that stays open; `cookiesFromBrowser` on the owner's Mac avoids that, and Settings and `yolo doctor` say when to connect again. Reading Chrome's cookies from the node's service may need one approval in macOS's Keychain.
- **Personal data reaches the agent's provider, and the screen.** What an agent reads goes to its model's provider, as Yolo's history and transcripts already do. A screen on the owner's profile shows its rows to whoever sits in front of it, in the car the passengers too, and keeps them in its storage. History, the most personal list, is off until turned on and keeps 30 days; the privacy pages say all of this.
- **More requests.** An `updates` list read every 30 minutes and history every hour are about 70 requests a day per site, one page each at the same pace, and a public list read every 12 hours adds two. Each card's cover is a `/v1/thumbnail` request through the Worker, counted against Workers Free's daily requests, though screens cache them.
- **Site changes.** Bilibili's endpoints and YouTube's pages change; the yt-dlp path moves with the pinned yt-dlp, and the plugins' tests pin their parsing on recorded answers.
- **Matching by words, not meaning.** "The music channel" matches only where a title, bio, or group says so; otherwise the agent reads the whole list, a few thousand tokens once.
- **Given up:** rows and lists while the node is offline beyond what a screen kept, rows fresher than the list's interval, a channel's uploads beyond those in the follows' feed, and accounts of a profile other than the owner's.
