# Agent Note: Metadata plugins describe what an item is

Status: implemented

English | [中文](2026-10-25-metadata-plugins.zh.md)

## Problem

An item's posters, synopsis, and credits came only from its source. The Plex plugin supplies them for its library; every other item had what its source happened to know. An owner without Plex had no metadata at all, even when the files carry their own (file names, embedded tags, Kodi-style NFO files), and the [plugin architecture](2026-10-11-plugin-architecture.md) listed Metadata as a plugin type with no interface.

Web videos fared worse. A Bilibili upload titled `救援高手/Nathan For You-第一季 [译制 by 电波字幕组][美剧] p08 救援高手.Nathan.For.You.S01E08.WEB-720p…` is episode 8 of season 1 of *Nathan For You*: the title says so three ways (`第一季`, `p08`, `S01E08`), and the show's details are public. `source-ytdlp` gives it only that title, a duration, and the uploader's description, so Yolo showed a plain video with a release name for a title.

Two smaller gaps sat on the same path. `normalizeDetails()` in [`service/core/src/insight.js`](../../../../service/core/src/insight.js) kept a person's name, role, and character, so the cast photos Plex supplies (`Role.thumb`) never reached anyone. And `/v1` had no item details route: screens showed titles and covers but no synopsis or cast, which only MCP `get_item` returned.

## Decision

The media node has a **metadata** plugin type ([`service/node/src/metadata.js`](../../../../service/node/src/metadata.js)). A metadata plugin does not bring content in or play it; it says what an item is (a film, a show, an episode of a show) and describes that work: titles, synopsis, people with photos, pictures, dates, genres, ratings, and external ids. The node identifies each item it describes, a model first: when the node has a model, by default the one the owner's Codex or Claude Code already signed in to for Ask ([plugins call models on the owner's own subscription](2026-10-25-models-for-plugins.md)), the model reads the item the way a person would and says which work it is, and the metadata plugins confirm that against their records and describe the work. Without a model, a title parser in the core takes its place. The node merges the plugins' answers with the source's details under one rule and caches the result; the control plane keeps only the owner's own corrections. Five official plugins ship with the interface and load by default: `metadata-local`, from the files themselves; `metadata-wikimedia`, `metadata-tvmaze`, and `metadata-bangumi`, from public databases that need no key; and `metadata-tmdb`, from The Movie Database with the owner's own key, an optional extra ([the official plugins](#the-official-plugins)).

The [own library and NAS sources](../../proposed/feature/2026-10-11-own-library-and-nas.md) proposal keeps the folder and WebDAV sources, the remux, the catalog in D1, and the Docker image, and links here for metadata.

### The metadata entry

A metadata plugin is an ordinary plugin package whose `node` entry calls `yolo.registerMetadata(id, impl)`, alongside or instead of `registerSource`. It runs only on the node: it needs the files, the home network, and the plugin's `cacheDir`, and its key stays in the node's `.env` rather than bundled into the Worker. Every method is optional, as for sources ([`service/plugin-api/src/index.js`](../../../../service/plugin-api/src/index.js), `MetadataImpl`).

| Method | Purpose | Returns |
|---|---|---|
| `identify(subject, { language })` | Say which works an item may be | `Candidate[]`, best first; `[]` when nothing fits |
| `lookup(candidate, { language })` | Describe one work | `WorkMetadata` |
| `search(query, { kind, year, language, limit })` | Find works by name, for an agent correcting a match | `Candidate[]` |
| `image(ref, { file })` | A picture the plugin has only locally, such as a poster file beside the video; `file` is the item's file | An image `Response` |
| `health()` | State for `/internal/v1/health` and `yolo doctor`; `{ configured: false, reason }` makes `doctor` show the reason | Any object |

A **Subject** is what the node knows about an item before any metadata plugin speaks: `{ sourceKey, kind, title, duration, date, year, description, channel, series, url, ids, file, hints, identity }`. `kind`, `title`, `duration`, `date`, `year`, `description`, `channel` (the uploader), `series`, and `url` come from the source's `details()` (or `describe()`); `ids` are external ids the source or an earlier metadata plugin already knows, such as Plex's `tmdb://` and `imdb://` guids or an NFO's `<uniqueid>`; `file` is `{ path, size }` when the source names a file the node can read, through the optional source method `file(source)` ([source plugin API](2026-10-11-source-plugin-api.md#methods)); `hints` is the title parser's reading ([title hints](#title-hints)); `identity` is the model's answer ([matching an item](#matching-an-item)), or `null` without one. `file` never leaves the node.

A **Candidate** is `{ id, kind, title, year?, season?, episode?, episodeTitle?, confidence, ids? }`: `id` is the plugin's own id of the work, such as `tv/1234` or `movie/5678`; for an episode, `id` names the show and `season` and `episode` the episode in it; `confidence` is 0 to 1, and 1 means found by an external id. **WorkMetadata** is the plugin API's `Details` with pictures, the show around an episode, and the notice its data needs:

```js
{
  kind: "episode", title: "…", description: "…", date: "2013-…", year: 2013,
  series: { title: "Nathan For You", season: 1, episode: 8, episodeTitle: "…" },
  show: { title: "Nathan For You", description: "…", year: 2013, poster: "https://…/w342/….jpg" },
  people: [{ name: "Nathan Fielder", role: "cast", character: "Himself", photo: "https://…/w185/….jpg" }],
  genres: ["Comedy", "Reality"], ratings: [{ value: 8.3, max: 10, source: "audience" }],
  poster: "https://…/w342/….jpg", backdrop: "https://…/w780/….jpg", still: "https://…/w300/….jpg",
  ids: { tmdb: "tv/…", imdb: "tt…" },
  attribution: { text: "This product uses the TMDB API but is not endorsed or certified by TMDB.", url: "https://www.themoviedb.org/" },
}
```

`attribution` is the one notice the plugin's data needs, `{ text, url? }`; the node gathers the notice of every plugin whose record applied into the match's `attributions` ([reaching /v1 and get_item](#reaching-v1-and-get_item)). The keys of `ids` are the plugins' own names; the core reads them only as opaque strings. `language` is the node's `YOLO_METADATA_LANGUAGE`, else `en`; a plugin's own `language` option wins, and a plugin falls back to the work's original language for a field it has no translation of.

### Matching an item

Identifying an item is two questions: which work it is, and which record of that work a plugin holds. A model answers the first, since it reads a messy title, a description, and an uploader the way a person does; the plugins answer the second, since their records are facts a model can only remember.

The node identifies an item the first time its details are asked for, and in the background when `/internal/v1/metadata` describes it or `/internal/v1/prepare` plays it, and never on the way to a play's first frame: both merge only what the caches already hold and otherwise queue the identification, one item at a time, at most 200 waiting. `/internal/v1/details` waits for it up to 17 seconds, inside the control plane's 20-second timeout, then answers with the source's details while identification goes on ([node's internal API](2026-10-07-node-internal-api.md)). One item is identified once at a time, however many requests ask for it.

1. **An owner's match wins.** When the owner pinned a match for the item, or refused every match, the control plane passes it with the request, and the node looks the record up without identifying.
2. **An external id needs no guessing.** When the Subject already carries ids, such as Plex's guids or an NFO's `<uniqueid type="tmdb">12345</uniqueid>`, the model is not asked, and the plugins look the work up by id.
3. **The model says which work it is.** With `yolo.models` available, the node asks it (`purpose: "identify"`), sending the item's title, the first 500 characters of its description, its uploader, site, duration, date, file name, the parser's reading as a hint, and the titles of the run's parts when the source's `sequence()` lists them. The answer fits a flat, strict schema (`kind`, `showTitle`, `originalTitle`, `year`, `title`, `season`, `episode`, `episodeTitle`, `confidence`, `reason`, and `parts`, every property required), which the node turns into the Subject's `identity`: `{ kind: "episode" | "movie" | "show" | "other", show: { title, originalTitle, year }, title, season, episode, episodeTitle, confidence, reason }`. `other` is for what is not a copy of a work: a clip, a trailer, a compilation, a reaction, a vlog.
4. **The plugins confirm it.** The node calls `identify(subject)` on each metadata plugin in load order. A plugin with records searches them by the identity's original title, then its other titles and year, and checks the details a model may misremember: whether the season has that episode, and the item's duration against the runtime. A plugin's applied match adds its `ids` to the Subject the next plugin sees, so the TVmaze, Bangumi, and TMDB ids Wikidata holds let the plugins after Wikimedia find the work by id.
5. **A match applies only when both agree.** The node applies a plugin's best candidate when the model's confidence is at least 0.8 and the candidate's at least 0.85, with the plugin's next candidate at least 0.15 lower; a candidate found by an external id (confidence 1) applies on its own. The keyless plugins score a record found by name alike: the same name gives 0.85 plus a tenth of its name score, about 0.95 and at most 0.97; a name that only contains the other (a sequel, an OAD, a spin-off), or the same name with a year that disagrees, gives 0.7, so it stays a candidate and never applies by itself. That is why 进击的巨人 applies over 进击的巨人 OAD: 0.95 against 0.7 clears the margin. A record that contradicts the model (no such episode, a runtime far off) leaves the item with up to 8 candidates, shown in `get_item`'s `metadata.candidates`, so the owner's agent can ask which one it is.
6. **The model's answer alone gives the identity, not the details.** When the model is sure (at least 0.8) of an episode or a film but no plugin applied a record, because none is configured or the database lacks the work, the item takes the identity only: its kind, its show, season, episode, and the episode title the model gave, marked `from: "model"`. Synopsis, cast, and pictures come only from records, never from the model's memory.
7. **Nothing found is an answer too.** An item the model is sure is `other`, or that nothing matches, is cached as unmatched and keeps exactly the details its source gives.

Without a model, step 3 is skipped and the plugins search by the parser's hints instead, with the same checks and thresholds; the result is the same for regular titles and misses more of the irregular ones.

A file whose name reads clearly, a name with a season and an episode or a film's name with a year (`readsClearly()`), takes that path first even with a model: when a record confirms the hints, the item is matched with no model call, and only a file the records do not confirm goes on to step 3. A library's files mostly carry such names, so a folder of a thousand files costs model calls only for the few named unclearly, within the daily number of calls. Web uploads, whose titles are irregular, still ask the model first.

Bilibili's parts are separate items (`?p=8` is part of the item's id), so a ten-part upload is ten items. The source registry's `sequence()` lists an item and the run after it, so one model call covers the item and the parts after it, 30 items at most, and the node caches each part's identity; a part asked before them gets its own call. The database plugins cache their API answers, so the later parts cost no search over the network either, only the lookup of their episode.

The example was tried on 2026-10-25 through a local gateway with two small models of the owner's subscriptions: both answered episode 8 of season 1 of *Nathan For You*, in 5.5 and 11.6 seconds, and one also gave the episode's title, *Private Investigator / Taxi Company*, which the public episode lists confirm, but in the field the prompt meant for the show's title. That is why the answer has separate fields for the show and the episode, is checked against a schema, and is confirmed against records.

The whole path ran on 2026-10-26: this release's node on the owner's home machine, against the owner's real play history, a Bilibili upload of season 1 of *Nathan For You* in parts p01 to p08, with `zh-CN` and no TMDB key. One Codex call identified the run (921 + 428 tokens, about 15 seconds). p02 and p08 then came back in 2 to 4 seconds each as `救援高手 S1E2 — Santa / Petting Zoo` and `救援高手 S1E8 — Private Investigator / Taxi Company`, with the episode's synopsis and still, the show's poster and description, the cast with photos, and three notices (Wikipedia, TVmaze, Bangumi). p01's first request took 19.6 seconds, past the 17-second wait, so it answered with the source's details while identification finished; its next request gave `救援高手 S1E1 — Yogurt Shop / Pizzeria` in 2 seconds.

### Title hints

`parseReleaseTitle()` in [`service/core/src/release-title.js`](../../../../service/core/src/release-title.js) reads every title into `subject.hints`. It is not the matcher: the model gets its reading as a hint, and without a model the plugins search by it. It knows release-name and upload conventions, not providers:

| Pattern | Reads | Strength |
|---|---|---|
| `S01E08`, `s1e8`, `S01 E08`, `1x08`, `S01E08-E09` (the first) | Season and episode | Strong |
| `Season 1`, `S01` alone, `第一季`, `第1季`, `第十二季` (Chinese numerals) | Season | Strong |
| `第8集`, `第八话`, `第8話`, `EP08`, `E08`, `Episode 8` | Episode | Strong |
| `p08`, `P8` standing alone (a Bilibili part) | Episode | Weak: used only when no strong episode is present or when it agrees with one |
| `[08]`, ` - 08 ` after a title (fansub style) | Episode | Weak |
| `(2013)`, `.2013.`, `[2013]` | Year | Medium; ignored when it is the title itself |
| `720p`, `1080p`, `WEB`, `WEB-DL`, `HDTV`, `BluRay`, `x264`, `HEVC`, … | Release tags; the title ends before the first one | — |
| `【…】`, `[…]` | Tags, kept apart; `美剧`, `日剧`, `电影`, `TV`, `Movie` hint the kind | — |

Title candidates come from the text that remains: a dotted release name (`Nathan.For.You.S01E08`) gives the words before its season and episode, the text before `第…季` or a strong marker gives another, and `/`, `|`, and a spaced or full-width dash split one name from its translation. The example reads as `{ titles: ["Nathan For You", "救援高手"], season: 1, episode: 8, part: 8, year: null, kind: "episode", agree: ["S01E08", "第一季", "p08"], tags: ["译制 by 电波字幕组", "美剧", "WEB", "720p"] }`.

A source that already knows the work skips the guessing: `source-ytdlp` passes yt-dlp's `series`, `season_number`, and `episode_number` where a site gives them, and the Plex plugin passes its guids as `ids`.

### Merging with the source

The node merges the source's details with the applied metadata field by field, with `mergeDetails(source, metadata)` beside `normalizeDetails()` in the core. Which side wins depends on whether the source describes the work or only a copy of it:

- **A source that knows the work wins, and metadata fills the gaps.** A source item whose `kind` is a work (`movie`, `show`, `season`, or `episode`), such as a Plex item, keeps every field it has; metadata adds the fields it lacks, pictures it has none of, and people's photos matched by name. An owner with Plex keeps Plex's curated details and gains what Plex did not have.
- **For an upload, the match describes the work.** A source item of any other kind (`video`, `live`) that a record applies to takes the work's description, people, genres, date, year, ratings, series, show, ids, and pictures, and becomes `kind: "episode"` or `"movie"`. The upload's own facts move under `upload`: `{ title, description, channel, date, url, stats }`. The item's `title` becomes the work's display title, `Nathan For You S1E8 — <episode title>`, unpadded, as the Plex plugin titles episodes (`workTitle()` in the core).
- **An identity without a record changes only the names.** An upload the model identified but no plugin confirmed ([step 6](#matching-an-item)) takes the display title, `kind`, and `series`, keeps its own description, people, and pictures, and keeps its own title under `upload.title`.
- **Some fields are always the source's.** `duration`, `url`, `stats`, `progress`, tracks, chapters, and comments describe the copy the owner plays, so metadata never replaces them.
- **Among metadata plugins, load order decides.** For each field, the earliest plugin that has it wins, so a hand-written NFO beats a database and Wikipedia's synopsis of a show in the owner's language beats TVmaze's English one. `series`, `show`, and `ids` merge the same way field by field, and a later plugin fills in the photo of a person an earlier one named without one, matched by name.

`normalizeDetails()` keeps a person's `photo` and the fields `poster`, `backdrop`, `still`, `show`, `upload`, `ids`, and `metadata`, within the limits it already applies; a picture is an http(s) URL or an item's artwork path. [`service/core/test/metadata.test.js`](../../../../service/core/test/metadata.test.js) owns the merge's and the parser's rules.

### Caches and the owner's matches

| What | Where | Lifetime |
|---|---|---|
| An item's identification: the model's identity, and the applied candidates or the unresolved ones, by source key, checked against a hash of the Subject | The node, `.media-cache/metadata/` | 30 days when matched; 3 days when unmatched, so an upload that a database adds later still matches |
| The model's identity of an item, a run's other parts included | The node, `.media-cache/metadata/` | 30 days |
| A plugin's `lookup` of one work in one language | The node, `.media-cache/metadata/` | 7 days |
| The API answers of Wikidata and Wikipedia, TVmaze, Bangumi, and TMDB | Each plugin's `cacheDir` | 30 days |
| Remote pictures | Not stored: the node's thumbnail fetch keeps them in memory ([node's internal API](2026-10-07-node-internal-api.md)) | Its memory budget |
| The owner's pinned or refused match for an item | D1, `item_matches` (migration `0013`): `user_id`, `source_key`, `plugin`, `candidate` (JSON), `created_at`; `plugin` and `candidate` null for a refusal | Until the owner changes it |

The node's caches can be deleted at any time and are rebuilt on the next request; every lifetime stays well under TMDB's six-month limit on cached data. The owner's matches are the only state that cannot be rebuilt, so they live in D1 with the rest of the owner's data ([D1 data model](2026-10-07-d1-data-model.md)). The previous release's code never reads the table, so the migration works with that release. A moved library item's match moves with its history, unless the new id has one ([moved library items](../feature/2026-10-21-moved-library-items.md)).

Two MCP tools let the owner's agent correct matches ([remote MCP server](../feature/2026-10-07-remote-mcp-server.md)). `match_item` takes `item_id` and exactly one of a `candidate` from `get_item` or `search_metadata` (with its `plugin`), `none` to refuse every match, or `clear` to forget the owner's choice so the node identifies the item again; it returns the item's details as they now are. `search_metadata` (`query`, `kind` `movie` or `show`, `year`) asks the plugins' `search`. Both need the `manage` scope, as playlists do.

### Pictures

A picture field (`thumbnail`, `poster`, `backdrop`, `still`, and a person's `photo`) takes the same two forms as a `thumbnail` ([v1 HTTP API](2026-10-07-v1-http-api.md)):

- **An http(s) URL of a public image**, as the databases' are. Screens load it through `/v1/thumbnail`, which the node fetches with its guards against server-side request forgery; agents get it as an `/i/*` link. A plugin returns the size a screen needs (a 342-pixel poster, a 780-pixel backdrop, a 185-pixel portrait), not the original.
- **A picture only the node can read**, such as `poster.jpg` beside a file. The plugin names it `"local:<ref>"` in its answer, and the node turns it into an artwork variant of the item, `/v1/library/items/<id>/artwork?variant=m-<plugin id>-<ref>` (dropped when the variant is longer than 32 characters), which the node answers from that plugin's `image(ref, { file })` instead of the source's `artwork`. The variant is derived from the item and the ref, so an `/i/*` link to it keeps working after the node's caches are deleted.

`createImageLinks().present()` in [`service/control/src/image-links.js`](../../../../service/control/src/image-links.js) seals every picture field (`thumbnail`, `poster`, `backdrop`, `still`, and `photo`), so MCP results carry each one as a link that loads without signing in. No new image route is needed.

### Reaching /v1 and get_item

- **MCP `get_item`** returns the merged details: the fields above, people with `photo`, and `metadata: { plugin, id, confidence, origin: "auto" | "owner", from: "records" | "model", candidates?, attributions? }`, where `candidates` lists unresolved matches and `attributions` the notice of every plugin whose record applied, `{ text, url? }`, at most 5, without repeats. Its description tells the agent to ask the owner when `metadata.candidates` holds more than one and to settle it with `match_item`.
- **`GET /v1/library/items/:id`** returns the same object as `get_item`, with the `read` scope, so screens can show a synopsis, the cast, and a backdrop. `:id` is any source key, a web video's included. The player's details sheet ([`clients/player/src/details.js`](../../../../clients/player/src/details.js)), opened from the player's info button, shows the picture, title, a meta line, the synopsis and the show's, the cast with photos, the upload it plays as "This copy" with its uploader, and each notice in `attributions`.
- **Library listings** (`/internal/v1/library/:id/items`, `/library/items/:id/children`, and `/library/search`) show a matched item as its work: an item whose kind is not a work (`video`, such as a file in a folder) takes the work's display title, `kind`, `series`, and `poster` when the node's caches hold a match, and the work's picture as its `thumbnail` (the episode's still, else the backdrop or poster), in place of the source's own, such as a frame of the file, which an unmatched item keeps. An item not identified yet is listed as its source gives it and queued, never waited for, so a library's grid fills in as the queue works through it. Items whose source knows the work, such as Plex's, are listed as they are and never identified for a listing.
- **`/internal/v1/metadata`** adds the work's display title, `series` (`{ title, season, episode }`), and `poster` when the node's caches hold a match. The control plane titles queue and playlist items with it. A stream `/internal/v1/prepare` opens takes the same display title when the caches hold a match, so the playback state and history show the work's name; `series` and `poster` do not reach the control plane yet, and the stream's other fields keep their shape.

Every change is additive: a new route, new optional fields, and a better string in `title`. A client that ignores unknown fields, as the player's JavaScript and YoloKit's `Decodable` types do, keeps working, so neither `CLIENT_PROTOCOL` nor `NODE_PROTOCOL` rises ([client protocol](2026-10-19-client-protocol.md)). A control plane of this release talking to an older node gets details without metadata; an older control plane ignores the node's new fields.

### The TMDB key

No key is needed for the full details of most TV: Wikimedia names the show and describes it, TVmaze describes the episode, and Bangumi covers anime and Chinese and Japanese shows, all without one. A TMDB key is an extra: wider coverage of films, backdrops, and posters at the sizes screens use.

TMDB's API terms grant each developer a non-transferable, non-sublicensable licence for non-commercial use, so Yolo cannot ship a key that every instance shares. An owner who wants TMDB registers a free key on themoviedb.org and sets it as `TMDB_API_KEY` (a v3 key, sent as `api_key`, or a v4 read access token, sent as a bearer token), or as the plugin's `apiKey` option.

- Without a key, `metadata-tmdb` starts and does nothing; its `health()` says so with the link to register, and `yolo doctor` shows it as an optional `info` line, `node.metadata.tmdb`, not as a failure. The other official metadata plugins need no key.
- The `yolo-deploy` skill offers the key as an optional step, as it offers Plex.
- The plugin returns TMDB's notice as its `attribution`, and the player's details sheet shows it among the item's notices whenever an item's details came from TMDB.
- The plugin keeps TMDB's responses for 30 days and asks TMDB only on a cache miss, a handful of requests per new item, each with an 8-second timeout.

### The official plugins

| Plugin | Reads | Notes |
|---|---|---|
| `@useyolo/metadata-local` (`plugins/metadata-local`, id `local`) | `<base>.nfo` or `movie.nfo` beside a file, and `tvshow.nfo` in its folder or the one above; pictures beside it (`<base>-poster`, `poster`, `folder`, `cover`; `<base>-fanart`, `fanart`, `backdrop`; `<base>-thumb`), the show folder's poster and fan art, and cast pictures in `.actors/First_Last.jpg`; the `show`, `season_number`, and `episode_sort` tags embedded in the file, through ffprobe (`FFPROBE_PATH`, or the `ffprobe` option) | Needs `subject.file`, so it serves the Plex plugin on the same machine and future folder and WebDAV sources, not web videos. An NFO matches with confidence 1 and passes its `<uniqueid>`s to the plugins after it; embedded tags give a candidate of 0.9; pictures alone give one of 0.9 whose record is only pictures, which fill what a source lacks. Embedded cover art is not read. Candidate ids are `f-<hash>`, mapped to paths in its `cacheDir`, so paths never leave the node. Nothing goes over the network |
| `@useyolo/metadata-wikimedia` (`plugins/metadata-wikimedia`, id `wikimedia`) | Wikidata's entity search, statement search, and entities; Wikipedia's page summaries; Wikimedia Commons' pictures | Finds films and shows by name in any language (救援高手 is *Nathan for You*, `Q10935299`), keeping only items whose instance-of classes are films or TV series, and by an `imdb`, `tvmaze`, or `tmdb` id through Wikidata's statement search. Passes on the ids `wikidata`, `imdb`, `tmdb` (`movie/<id>` or `tv/<id>`), `tvmaze`, `bangumi`, and `douban`. Describes a whole film: its title in the owner's language (`zh-CN` tries the `zh-cn`, then `zh-hans` labels), the Wikipedia summary in that language (the `zh-cn` variant for `zh-CN`), else English, a picture (the article's thumbnail, else Wikidata's image through Commons), up to 12 cast and 3 directors with photos from Commons, genres, and a runtime check within 25 percent. For an episode it describes only the show around it (`series`, the show's title, description, year, and poster, genres) and leaves the episode to an episode database. Notice: "Descriptions from Wikipedia under CC BY-SA 4.0; data from Wikidata.", linking the article. Option `language` (else `YOLO_METADATA_LANGUAGE`, else `en`) |
| `@useyolo/metadata-tvmaze` (`plugins/metadata-tvmaze`, id `tvmaze`) | TVmaze's show search, lookup by IMDb or TheTVDB id, show with cast, and episode by number | TV only, in English. By a `tvmaze`, `imdb`, or `tvdb` id from an earlier plugin the show is certain (confidence 1), and the episode is still checked: a season without it gives 0.3, a runtime more than 15 percent off 0.6; by name it searches shows, up to three records. Describes the episode: title, synopsis, air date, still, the show's poster and synopsis, up to 12 cast with photos, genres, rating, and ids. Notice: "TV data from TVmaze under CC BY-SA 4.0.", linking the show's TVmaze page. No options |
| `@useyolo/metadata-bangumi` (`plugins/metadata-bangumi`, id `bangumi`) | Bangumi's (bgm.tv) subject search, subject, episodes, and characters | Anime and live-action subjects (types 2 and 6), with Chinese titles and synopses. Bangumi keeps each season as its own subject, so season 2 or later is searched as `<name> 第二季` and `<name> Season 2`, and a subject's season is read from its name. Checks the episode in the subject's episode list and its runtime within 20 percent (25 for a film); a `bangumi` id from Wikidata makes the subject certain. It answers only an owner whose language is Chinese or Japanese (option `always` for everyone). Describes with the episode's Chinese title, the subject's synopsis on the show, leaving the episode's synopsis to TVmaze since an episode's own text on Bangumi is mostly its staff list, up to 12 main and supporting characters with their voice actors' pictures, tags as genres, and a rating. Notice: "Anime and show data from Bangumi (bgm.tv).", linking the subject. Options `language` and `always` |
| `@useyolo/metadata-tmdb` (`plugins/metadata-tmdb`, id `tmdb`) | TMDB's find-by-external-id, search, movie, TV, season, and episode endpoints | Finds a work by its `tmdb`, `imdb`, or `tvdb` id first, else searches the identity's or the hints' names (three records at most), scores names and years, checks the season has the episode and the runtime within 15 percent (25 for a film), and gives ids `movie/<id>` and `tv/<id>`. Describes a work with up to 12 cast, its directors, creators, and writers, an episode's guest stars, genres, a rating, and pictures. Options `apiKey` (else `TMDB_API_KEY`) and `language` (else `YOLO_METADATA_LANGUAGE`, else `en`) |

The four plugins that go over the network make their requests with `yolo.fetch`, so the owner's egress rules apply to them ([egress proxy layer](2026-10-13-node-egress-proxy.md)).

The three keyless plugins send a User-Agent that names Yolo, as Wikimedia and Bangumi ask, give each request 8 seconds, and keep every API answer, a 404 included, for 30 days in their `cacheDir`.

The catalog of `plugins/official.json` lists the metadata plugins after the source, agent, and model provider plugins, in the order the merge relies on, since the earliest plugin wins each field; a plugin turned on from a screen goes into the config in that order, whenever it is turned on ([plugins chosen from any screen](../../proposed/feature/2026-10-31-home-cold-start.md)):

1. `metadata-local`: the owner's own files say best what they are.
2. `metadata-wikimedia`: it names the work in the owner's language and passes the ids that let the plugins after it find the work by id rather than by name.
3. `metadata-bangumi`, for an owner who reads Chinese or Japanese: the episode's title in that language, and anime and Chinese and Japanese shows, which the others cover thinly.
4. `metadata-tvmaze`: the episode itself, with its synopsis and still, which Wikimedia leaves out.
5. `metadata-tmdb`, last and optional: what the others lack, when the owner set a key.

`scripts/provider-names.js` lists `metadata-local` among the directories that name no provider, since it reads the owner's own files, and gives `tmdb` the alias `themoviedb` and `wikimedia` the aliases `wikipedia` and `wikidata`, so no service code may name them.

The Plex plugin passes its guids (`imdb`, `tmdb`, `tvdb`, from details fetched with `includeGuids=1`) as `ids`, a cast member's `photo` from `Role.thumb` when that is an http(s) URL, and its part's file through `file()` when the node's machine can read it ([source plugin API](2026-10-11-source-plugin-api.md#the-official-plugins)). The folder source gives every file it lists through `file()`, and an episode's show, season, and number in `details()` ([folder source](../feature/2026-10-26-folder-source.md)).

## Alternatives considered

**Metadata inside each source plugin.** Each source would repeat title parsing, a database client, and its key, and an upload could never borrow a database's knowledge of the show. Sources describe copies; metadata plugins describe works; the node joins them.

**Metadata plugins in the control plane.** A control entry could call TMDB from the Worker and keep working while the node is offline. It could not read NFO files, embedded tags, or pictures beside files, so the local plugin would still run on the node, and two places would merge metadata. A key in a control plugin's options would also be bundled into the Worker's code. Details already come from the node, so metadata joins them there.

**Caching every result in D1.** It would let item details show while the node is offline, but the node cannot be reached then to play anything either, and D1 would hold TMDB content that the terms require purging when the licence ends. The node's caches are rebuildable and hold only what was asked for; D1 keeps only the owner's decisions. The [own library](../../proposed/feature/2026-10-11-own-library-and-nas.md)'s catalog in D1 may later carry the merged title and poster of each catalog item.

**A node cache of the show a title resolved to.** It would spare later parts of a run a show search, but the database plugins already keep their API answers for 30 days, so a second part's search costs no request; a node-side map would duplicate a plugin's records under a key the node cannot check.

**Requiring a TMDB key for details.** TMDB alone covers films and TV in many languages, but a key is a registration most owners never make, so most instances would show no details at all. Wikidata, Wikipedia, TVmaze, and Bangumi answer without a key and between them name and describe most TV, an upload's show in the owner's language included; TMDB stays as an optional plugin for what they lack.

**A shared project key or a project proxy.** Infuse gets its details through a service its developer runs between its apps and the databases. Yolo has no such service: the developer runs nothing an instance talks to, and the privacy policy says so. A shared TMDB key breaks the terms, which make the licence non-transferable and non-sublicensable, and every instance would share one rate limit and one revocation; a proxy would put the developer between every owner and their lookups, and be a service to run, pay for, and keep up. Keyless databases called from the owner's own node need neither.

**Rules first, a model only for what they miss, for every item.** A parser is free and gives the same answer every time, but every site, fansub group, and naming habit needs another rule, and no rule knows that 救援高手 is *Nathan For You*, or that a twenty-minute upload with the show's name is a clip rather than the episode. A model reads the whole item at once, in any language, and costs one short call per item on the owner's own subscription. The parser stays as the model's hint, as the path without a model, and as the first try for a file whose name reads clearly, where it is right far more often than for an upload's title.

**Taking the model's word without records.** The model identified the example, and one even named the episode correctly, but a model's memory of synopses, casts, and air dates is where it is most often wrong, and nothing on the screen would say so; in a later trial Claude Code's Haiku named the right episode with a made-up title. The model says which work it is; records describe the work; an identity without a record changes only the item's names.

**The model's memory for the synopsis and photos when no database answers.** The model already named the work and could write a synopsis and name the cast too. But a synopsis is where its memory fails most, as the alternative above says, and a model cannot give a photo at all, only a URL it recalls or invents, which may not exist or may show someone else. With the keyless databases a record is there for most TV, so little gap is left to fill, and an item no database knows keeps its source's details.

**Running the owner's agent for each item.** The agent plugins already reach the owner's subscription and can search the web, but a run is a full agent session of tens of seconds or more, one at a time with the screens' Ask requests. One structured model call per item, through [`yolo.models`](2026-10-25-models-for-plugins.md), is enough; the agent settles only the ambiguous items, through `match_item`.

**Applying the best candidate whatever its confidence.** A wrong episode is worse than a plain video: it replaces a correct title with a false one. A threshold with a margin keeps doubtful matches as candidates for the owner to confirm.

**Metadata winning over every source.** It would replace curated Plex details, including an owner's own edits in Plex, with a database's. Sources that describe the work keep their fields; only uploads, whose fields describe a copy, give way.

**A new `/v1/items/:id/details` route instead of `/v1/library/items/:id`.** Library item ids are already source keys, and the artwork route lives under `/v1/library/items/:id`; one more route under the same prefix keeps the item's details and pictures together.

## Consequences

An upload of a known episode shows as that episode, with its show's synopsis, poster, and cast, and a Plex item gains cast photos and the pictures Plex lacked, without the owner registering anything: the official databases need no key for most TV, and a TMDB key only adds to them; an owner's files describe themselves through NFO files and pictures. Tests pin the node's identification, thresholds, and caches ([`service/node/test/metadata.test.js`](../../../../service/node/test/metadata.test.js)), the owner's matches through `/v1` and MCP ([`service/control/test/integration/metadata.test.js`](../../../../service/control/test/integration/metadata.test.js)), and each plugin's reading of its records.

- **A model can be confidently wrong**, and different models answer differently. Records confirm every match, the duration check catches a confident wrong episode, and a wrong match is one `match_item` away from fixed. Compilations (`S01E01-E03`), specials (`S00`), and absolute anime numbering stay hard for the model and the parser alike.
- **Identification costs model calls** on the owner's subscription: about one per new item or run of parts, a few hundred tokens each, within the node's daily number of calls for `metadata`; the 30-day caches keep a replay free. An item's title, description, uploader, and file name go to the model's vendor, as the privacy policy says.
- **A false match misleads more than no match.** It renames an item in the queue, playlists, and agent answers. The thresholds are the safeguard and may need tuning on real uploads.
- **TMDB's terms can change**, and their commercial-use examples include an AI system that drives traffic or revenue. An owner's private agent reading their own items has neither, and the per-owner key keeps each instance within the terms on its own. The terms also ask for TMDB's logo where its data is shown; the player shows the text notice only, and its settings show none.
- **Notices are shown.** Wikipedia's text and TVmaze's data are under CC BY-SA 4.0, which asks for credit and a link, so the details sheet shows every applied plugin's notice, and MCP results carry them in `metadata.attributions` for an agent that quotes them.
- **TVmaze is English only.** For an owner who reads Chinese or Japanese, Bangumi comes before it, so an episode Bangumi knows takes its title in that language, while the synopsis and still are TVmaze's in English; an episode only TVmaze knows keeps its English title, as in `救援高手 S1E8 — Private Investigator / Taxi Company`.
- **A new item asks several services.** Wikidata, Wikipedia, TVmaze, and Bangumi each see a few requests with the work's name and a season and episode number, never the media or the owner's history, as the privacy policy says; their 30-day caches keep the run's later parts and a replay off the network.
- **Coverage of Chinese titles is uneven.** Wikidata knows many works by their Chinese names and Bangumi covers anime, but TMDB's and TVmaze's Chinese titles are incomplete or absent, so most matches there go by the original title: the release name's, the one the model gives for a Chinese title, or Wikidata's ids. Without a model, an upload without an original title depends on the Chinese title being listed. A community Douban plugin can fill this later through the same interface, starting from the `douban` id Wikimedia passes on.
- **The first details request of a new item waits for the model and the plugins**, about 5 to 15 seconds, at most 17, since identification runs then unless describing the item already started it; past that, the item shows its source's details until identification ends. The first item of a new run can miss its first request when the model is slow, as p01 did at 19.6 seconds in the 2026-10-26 run; the run's other parts come from the cache in seconds.
- **Item details need the node**, as before; the catalog in D1 is the [own library](../../proposed/feature/2026-10-11-own-library-and-nas.md)'s to design.
- **Only the browser player's details sheet shows details.** The home screen and the Apple TV app show none; both can build on `GET /v1/library/items/:id`.
- **The interface is shaped by five plugins**, the owner's files, three keyless databases, and one with a key, and stays experimental before 1.0.
