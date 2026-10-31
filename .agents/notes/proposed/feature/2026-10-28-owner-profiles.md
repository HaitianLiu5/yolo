# Agent Note: Agents read what the owner follows and watches on other sites

Status: proposed

English | [中文](2026-10-28-owner-profiles.zh.md)

## Problem

The owner talks to their agent the way they think about their own media: "play a playlist from a YouTube channel I follow", "the next episode of the anime I'm following on Bilibili", "something from my watchlist", "the video I was watching on Bilibili last night". The agent knows Yolo's history, queue, and playlists, but nothing about the accounts the owner already keeps elsewhere, so it answers that it does not know what the owner follows, or guesses with a web search. The owner's taste already lives on those sites: channels and uploaders they subscribe to, favorites folders, shows they follow, films they rated, a watchlist, a manga bookshelf, and what they watched there. Yolo needs a way for the agent to read that, once, cheaply, and on every agent the owner uses (the screen's Ask, Claude, ChatGPT, Codex).

It must be a plugin: the core may not name a site ([plugin architecture](../../implemented/architecture/2026-10-11-plugin-architecture.md)), and Bilibili and YouTube are only the first sites; Douban, IMDb, and manga sites follow with the same shape.

## Proposal

A new plugin type, **profile**, reads the owner's own lists on one site. The node keeps a snapshot of every profile plugin's lists and refreshes it in the background; two read-only MCP tools let any agent see an overview and search the entries. Nothing plays from a profile: an entry carries a URL or ids, and the agent plays through the sources as it does now.

```
site account ──cookies / export file──▶ profile plugin (node) ──▶ node snapshot (.media-cache/profiles/)
                                                                         │ /internal/v1/profiles
agent ──MCP get_profile / profile_entries──▶ control plane ──nodeFetch──┘
  └──▶ search / browse { url } / play ──▶ source plugins (yt-dlp, Plex, …)
```

### The plugin

A node entry calls `yolo.registerProfile(id, impl)`, with `id` under the source id rules:

| Method | Purpose | Returns |
|---|---|---|
| `title` | The site's name for people ("Bilibili") | A string |
| `account({ signal })` | Who is signed in; throws `unauthorized` with what to set when no one is | `{ id, name, url? }` |
| `lists({ signal })` | The lists this account has | `[{ id, title, kind, private?, refreshMinutes?, keep? }]`, where `kind` is what its entries are ([lists that change often](#history-and-other-lists-that-change-often)) |
| `entries(listId, { cursor, signal })` | One page of a list, newest first where the site orders by time | `{ entries: Entry[], cursor? }`; no `cursor` ends the list |
| `health()` | Optional state for `/internal/v1/health` | Any object |

An **Entry** is `{ id, kind, title, url?, about?, by?, thumbnail?, at?, progress?, duration?, status?, rating?, tags?, ids?, links? }`:

- `kind` is `channel` (a YouTube channel, a Bilibili uploader), `title` (a film, show, anime, book, or manga), `playlist` (a favorites folder, a saved playlist), `person` (an actor or director followed), or `video` (watch later, liked, history).
- `about` is a short description the site gives (a channel's bio, a title's one line), at most 200 characters; it is what lets "the music channel I follow" match an entry whose name says nothing.
- `status` is `want`, `doing`, `done`, or `dropped`; `rating` is `{ value, scale }` as the site gives it; `at` is when the owner followed, marked, or last watched it.
- `ids` are external ids keyed as [metadata plugins](../../implemented/architecture/2026-10-25-metadata-plugins.md) key theirs, by the plugin's own name (an IMDb `tt…`, a Douban subject id); the core passes them through without reading their keys, so it names no provider. An agent can hand such an entry's ids to the metadata plugins, through `search_metadata` or an item's details, to learn what the work is.
- `links` are other pages of the entry by a generic `rel`: `videos`, `playlists`, `live`, `episodes`. A channel entry names its playlists page, so the agent need not know each site's URL layout.
- `by` is `{ title, url? }`, the channel or uploader of a `video` entry, so "the uploader I watched yesterday" finds it.
- `progress` and `duration` are seconds: how far the owner watched a history entry, and its length; `progress` equal to `duration` is watched to the end.
- `tags` carry the site's grouping, such as Bilibili's follow groups.

Plugins only read: no method follows, unfollows, rates, or marks anything on the site.

### The snapshot on the node

A new `service/node/src/profiles.js` keeps the registered profiles and does the work every plugin would otherwise repeat:

- **Refresh.** After `start`, a list older than its interval is read again, then every interval with a random tenth of jitter; the interval is the list's `refreshMinutes`, else `refreshHours` (12). Reads go one plugin and one request at a time, at least `paceMs` (1,000) between pages, so a site's rate limit or risk control sees one slow reader. `POST /internal/v1/profiles/refresh` reads one plugin, or all, now.
- **Bounds.** At most 5,000 entries per list and 2 MB per plugin, or the list's own `keep`; a longer list keeps its newest and says it was cut.
- **Failures keep the last snapshot.** A refresh that fails keeps what it had, with the error and `stale: true`; `unauthorized` says which option or cookie to set, and `yolo doctor` shows it.
- **Storage.** The snapshot is JSON under the node's ignored `.media-cache/profiles/`, rebuilt from the sites when deleted. It never goes to D1 or the Worker; agents read it through the control plane.
- **Search** runs next to the snapshot: case-, width-, and accent-insensitive matching over `title`, `about`, `by.title`, and `tags`, an exact or prefix match before a substring, then every word within one entry.

`GET /internal/v1/profiles` answers the overview and `GET /internal/v1/profiles/entries` a filtered page. Both are new and only a new control plane calls them; an older node answers 404, which the tools turn into `available: false` with "Upgrade the media node", so `NODE_PROTOCOL` stays.

### History and other lists that change often

A site's watch history is a list like the others, of `video` entries newest first with `at`, `progress`, and `duration`, but it differs from follows in four ways, and the list says so in what `lists()` returns:

- **It is private.** A list marked `private: true` is read only when the owner names it in the plugin's `lists` option (`"lists": ["following", "history"]`); without that option every list but the private ones is read. History says more about a person than follows do, and what an agent reads goes to its model's provider, so it is never on by default.
- **It changes often.** History declares `refreshMinutes: 60`; the owner's `refreshMinutes` option per list (`{ "history": 30 }`) overrides it.
- **It is read from the top.** A refresh of a list with `keep` reads pages until one holds an entry already in the snapshot with the same `at`, or the same position when the site gives no time, and merges the new entries in front; most hourly refreshes are one request.
- **It keeps only what is recent.** History declares `keep: { days: 30, entries: 500 }`; older entries are dropped at each refresh.

Site history stays apart from Yolo's own: `history` answers what played in Yolo, and `profile_entries { list: "history" }` what was watched in the site's own apps, and the tool descriptions say which is which. Neither is merged into the other, since the same video has different ids in a source and on the site. Resuming in Yolo from a position the site's history holds, for an item Yolo has no history of, is a later change that would tie a profile to a source's ids; this proposal only lets the agent read it and pass `start_at` to `play`.

### The MCP tools

Two read-only tools with the `read` scope, in [`service/control/src/mcp/tools.js`](../../../../service/control/src/mcp/tools.js), naming no site:

- **`get_profile`** answers every connected account: the site, the account's name, each list with its kind, count, and when it was read, and the titles of its 20 newest entries. It stays under about 2,000 tokens with any number of entries, so an agent can read it at the start of a request. `refresh: true` starts a refresh in the background and answers the snapshot it has, with `refreshing: true`.
- **`profile_entries`** `{ account?, list?, kind?, query?, status?, since?, offset?, limit? }` answers matching entries with their `url`, `links`, `ids`, `about`, `by`, `status`, and a history entry's `at` and `progress`; `since` (an ISO date) keeps entries from then on; `limit` is 50 by default and 200 at most, and thumbnails become image links as in every tool.

The server description and [`skills/yolo/SKILL.md`](../../../../skills/yolo/SKILL.md) say to read `get_profile` when the person says "I follow", "my subscriptions", "my list", or names a channel or title as theirs, before searching the web; the agent plugins' instructions add the same line ([screens ask the owner's own agent](../../implemented/feature/2026-10-18-agent-from-the-screen.md)). No profile data enters a prompt by itself: the agent reads it when the request needs it.

### Browsing a URL

The motivating request needs one more step: the playlists of a channel. `browse` gains `url`, which returns the source's `expand(url)` without importing it, and an expanded item may say `collection: true` when it is itself a playlist, so the agent can list `links.playlists`, choose one, and `playlist_import` or play it. The yt-dlp source marks its flat entries that point at a playlist.

So "play a playlist from a YouTube channel I follow" runs `get_profile` → `profile_entries { kind: "channel", query: "music" }` (or the whole list when nothing matches) → `browse { url: <links.playlists> }` → `playlist_import` → `playlist_enqueue` or `play`, and asks which channel when several fit, as the agent already does for search results.

### The first plugins

| Plugin | Lists | How it reads |
|---|---|---|
| `plugins/profile-bilibili` | `following` (uploaders, with follow groups as `tags`), `favorites` (folders), `bangumi` (followed series, with `status`), `watch-later`, `history` (private) | Bilibili's web JSON (`x/web-interface/nav` for the account, `x/relation/followings`, `x/v3/fav/folder/created/list-all`, `x/space/bangumi/follow/list`, `x/v2/history/toview`, and `x/web-interface/history/cursor` for history, whose entries carry the time watched, the position, the length, the uploader, and a series episode's place) with the account's cookies, through `yolo.fetch`, so the owner's egress rules apply |
| `plugins/profile-youtube` | `subscriptions` (channels), `playlists` (the owner's own and saved), `watch-later`, `liked`, `history` (private) | The pinned yt-dlp with the account's cookies: `--flat-playlist -J` on `feed/channels`, `feed/playlists`, `:ytwatchlater`, and `:ytfav`. History comes from `feed/history`'s own page data, which the plugin reads with the same cookies: yt-dlp's flat listing of it keeps only the order and lengths, while the page gives each day's heading and each video's watched share (P3); yt-dlp's tab extractor already reads `feed/channels`' channel entries with their subscriber counts. A Google Takeout `subscriptions.csv` (`subscriptionsFile`) is the fallback that needs no cookies |

Both take `cookiesFile` or `cookiesFromBrowser`, and without either fall back to `YTDLP_COOKIES_FILE`, the cookies file the yt-dlp source already reads, so an owner whose file is signed in to a site needs nothing more for it. Neither is in [`plugins/official.json`](../../../../plugins/official.json): they read a personal account, so the owner turns them on in `yolo.config.json`. Each follows [`yolo-add-official-plugin`](../../../skills/yolo-add-official-plugin/SKILL.md).

The interface fits the next sites without change: Douban's collections (`title` entries with `status` and `rating`, read from its pages with cookies or from an export), IMDb's watchlist and ratings (its CSV exports, read from a file), and a manga site's follows (`title` entries of kind manga, from its API where one exists). A site that offers only an export reads a file the owner drops in, which the same refresh rereads when it changes.

### Plan

1. Owner checks P1, P2, and P3 below.
2. The plugin API's `registerProfile` and types, `service/node/src/profiles.js` with its endpoints, per-list intervals, private lists, top-first refresh, and tests, the two tools, and `browse { url }` with `collection`.
3. `profile-bilibili`, then `profile-youtube`; the server description, the yolo skill, and the agent plugins' line.
4. The privacy policy pair at `site/public/privacy.html` and `site/public/zh/privacy.html` says the node keeps the owner's lists from the sites they connect, and the last 30 days of their watch history there when they turn it on, and that their agent reads them.

### Owner checks

| Check | Steps | Decides |
|---|---|---|
| P1, YouTube's channel list | `yt-dlp --cookies <file> --flat-playlist -J https://www.youtube.com/feed/channels`, then the same for `feed/playlists` | Whether `profile-youtube` reads cookies or starts with the Takeout file |
| P2, Bilibili's followings | With the cookies file, page `x/relation/followings?vmid=<own mid>&ps=50` to the end and count against the number the profile page shows; note any `-352` or `-412` | Whether a signed-in owner reads the whole list, and the pace it needs |
| P3, YouTube's history | `yt-dlp --cookies <file> --flat-playlist -J --playlist-end 50 :ythistory`; check that it comes newest first and whether entries carry a time watched or a position, and run it again after watching one video | Whether YouTube history has `at` and `progress`, or only its order, and whether a top-first refresh finds the new entry |

Results on 2026-10-28, with the live node's `YTDLP_COOKIES_FILE` and its pinned yt-dlp 2026.10.21:

- **The yt-dlp source's cookies file does not sign in to YouTube.** Its YouTube cookies are anonymous ones (`VISITOR_INFO1_LIVE`, `YSC`, `PREF`, no `SID`, `SAPISID`, or `LOGIN_INFO`), so `feed/channels` gives no initial data, `feed/playlists` answers 401, and `:ythistory` asks for a login. `profile-youtube` takes `cookiesFromBrowser` or a cookies file exported from a signed-in YouTube; P1 and P3 then ran with `--cookies-from-browser chrome`.
- **P1 passed.** `feed/channels` listed 370 channels in 2.4 seconds, every one with its channel id and URL, `@handle`, and subscriber count, and 337 with a description for `about`; no entry says when it was followed, so subscriptions carry no `at`. `feed/playlists` listed 18: liked (`LL`), watch later (`WL`), `FL`, and 15 playlists, each with its owner's name, which tells the account's own from saved ones, but no count or date.
- **P3: yt-dlp's listing is not enough; the page is.** `:ythistory` listed 50 videos newest first with their lengths, but no time watched, no position, and the channel on only one. The page yt-dlp read (`feed/history`'s `ytInitialData`) has both: its sections are headed by day (`Monday` back to `Thursday`, then dates such as `Oct 21`), and each video's `thumbnailOverlayProgressBarViewModel.startPercent` is the share watched (10, 16, 52, 100, …). A YouTube history entry's `at` is therefore its day, and `progress` its share times its length, to the minute at best. The second half of P3, a refresh after watching one more video, waits for the owner.
- **P2 passed.** Signed in (`nav` `isLogin`), `x/relation/stat` counts 125 followings and four pages of 50 read all 125, at 0.3 to 0.6 seconds a page with a second between them, from the home address without the egress rule's proxy and with no `-352` or `-412`. An entry carries `uname`, `sign` (the bio, for `about`), `official_verify`, `face`, `mtime`, and `tag` (its group ids, null when ungrouped); `x/relation/tags` names the account's two groups.
- **Bilibili's history has what the design needs.** `x/web-interface/history/cursor?ps=20` answered 20 rows in a second with a `cursor` of `max`, `view_at`, and `business` for the next page. Every row has `view_at`, `progress`, and `duration` in seconds, and `history.business` says `archive` (a video, with `bvid`, `page`, and `author_name`) or `pgc` (a series episode, with `epid`, `show_title`, and `long_title`); 18 of the 20 were videos.

## Alternatives considered

**Keep the snapshot in D1.** Agents could read it while the node is offline, and [Yolo 1.0](2026-10-11-yolo-1-0.md)'s 1.1 plans follows in D1. But an offline node cannot play what the agent finds, a full refresh of thousands of rows spends Workers Free's D1 writes for little, and the lists of a personal account stay on the owner's machine with the cookies that read them. When 1.1's inbox needs follows the Worker can read on a schedule, it takes the profile's channels as its follows.

**Read the site live on every tool call.** No snapshot to keep, but a Bilibili following list is ten pages and a YouTube one several continuations: seconds per question, and the request rate that triggers risk control. A snapshot answers in one hop and reads each site twice a day.

**Put everything in the agent's prompt.** Hundreds of channel names in every request cost tokens on every question, most of which are not about follows, and claude.ai or ChatGPT have no prompt Yolo writes. A compact overview tool the agent calls when it needs it costs nothing otherwise.

**An MCP resource instead of tools.** Most clients do not read resources unless the person attaches them; a tool the server description names is read when the request needs it.

**Register profiles from the source plugins.** The yt-dlp source already holds both sites' cookies and could register both profiles. But a profile needs no source, an owner may want one without the other, and a site like IMDb has no source at all; one package per site, enabled on its own, keeps the account reads apart from playback.

**The sites' official APIs.** YouTube's Data API reads `subscriptions?mine=true`, but needs a Google Cloud project and OAuth consent, and a consent screen left in testing mode expires its refresh token after seven days, while `youtube.readonly` needs Google's verification to publish. Bilibili and Douban offer no public API for a user's lists. Cookies, which the yt-dlp source already uses, and export files work for every site the owner can sign in to.

**Merge the site's history into Yolo's.** One history would answer "what did I watch" in one call and resume across apps, but a video's id in a source (a normalized URL) and on the site differ, a wrong match would move someone's progress, and Yolo's history keys resume and watched state. Kept apart, the agent reads both and decides; a later change can map them where the ids are certain.

**Make profiles a kind of metadata plugin.** Both read other sites, and a Douban plugin could do both. But a metadata plugin describes any work for anyone, from public records or the owner's key, and is asked per item while it plays; a profile reads one person's signed-in account, is read on a schedule, and answers about the person. Kept apart, one package may still register both, as a source and a metadata entry already can.

**Yolo's own follows only.** The owner would follow everything again inside Yolo; the point is to use what the owner already keeps, and Yolo's own follows can come later on top.

## Acceptance criteria

- With `profile-bilibili` and `profile-youtube` loaded and signed in, `get_profile` lists both accounts with their lists and counts, under about 2,000 tokens, and `yolo doctor` shows both `started` with when each was read.
- Asked on a screen "play a playlist from a YouTube channel I follow" (and the same in Chinese), the screen's agent reads the profile, names or picks a followed channel, and a playlist of that channel plays or is queued, without a web search for the owner's subscriptions.
- "The anime I'm following on Bilibili" finds the followed series by `status` and plays its next episode through the existing up-next run.
- With `history` in the plugin's `lists`, "the video I was watching on Bilibili last night" finds it in the site's history and plays it from where the owner stopped; without it, no history is read, and `get_profile` shows no history list.
- An hourly refresh of a history that did not change is one request per plugin, and history keeps no entry older than 30 days.
- A plugin without cookies reports `unauthorized` with the option to set, and the other plugins' lists still answer; a failed refresh keeps the last snapshot marked `stale`.
- No file under `service/` names a site: `scripts/provider-names.test.js` passes with the two new plugin directories, which make `bilibili` a provider name, so every line under `service/` that names Bilibili today (comments in the core, the plugin API, and the MCP tools, and the metadata tests' sample uploads) is reworded.
- No method writes to a site; tests cover the snapshot bounds, pacing, search, and the 404 of an older node.

## Risks

- **Accounts and terms.** Reading a signed-in account with cookies is what yt-dlp already does, but a site may flag an account that reads too fast; the pace, the twice-a-day refresh, and read-only calls keep the reads near a person's. Owners turn the plugins on themselves.
- **Cookies expire or rotate.** YouTube rotates cookies exported from a browser tab that stays open; `cookiesFromBrowser` on the owner's Mac avoids that, and `unauthorized` in `yolo doctor` says when to export again.
- **Personal data reaches the agent's provider.** What an agent reads goes to its model's provider, as Yolo's history and transcripts already do; the privacy pages say so, and the tools answer only when an agent asks. A site's watch history is the most personal of these, so it is read only when the owner turns it on and keeps 30 days.
- **History reads more often.** An hourly read is 24 requests a day per site where the rest is two; one page each, at the same pace.
- **Site changes.** Bilibili's endpoints and YouTube's pages change; the yt-dlp path moves with the pinned yt-dlp, and the Bilibili plugin's tests pin its parsing on recorded answers.
- **Matching by words, not meaning.** "The music channel" matches only where a title, bio, or group says so; otherwise the agent reads the whole list, a few thousand tokens once.
- **Given up:** reading while the node is offline, and lists fresher than the last refresh unless the agent asks for one.
