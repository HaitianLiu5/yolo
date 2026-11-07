# Agent Note: A library of events: games as a type a plugin adds

Status: implemented

English | [中文](2026-11-06-event-libraries.zh.md)

## Problem

An NBA game reached Yolo only as a link. The owner found one on Tencent Sports, handed its address to Yolo, and from then on the game was a web video with a score in its name. Four things followed:

- **Nothing to browse.** A home screen could not say which games there are, live or finished.
- **One game looked like several.** The score was written into the title when the game started on a screen, so three screens' cards for one game read "106–102", "97–88", and the like, and a replay of the same game was another history entry for each quarter it played.
- **What it said was wrong and gave things away.** A card said "Live" an hour after the game ended, kept a score that was no longer the score, and told anyone looking at the home screen how a game ended. Tencent's picture was a channel's advertisement or a frame with the scoreboard in it.
- **A live position outlived the stream.** History kept a place in the live stream, which in the car is a clock reading of about 1.79 billion seconds, and the replay that later plays under the same item resumed there.

The owner asked for games to be a type, as films and shows are, added by a plugin.

## Decision

### What a type is

A plugin cannot bring its own screens: tvOS and iOS are native, and the car draws to a canvas. So a type has two layers. Every client knows one provider-neutral presentation, the **event**: something that happens at a time. A plugin supplies the libraries, and adding a sport or a site needs no client change. The NBA is not a type; it is a library of type `event`.

| | Film | Show | Event |
|---|---|---|---|
| Home screen | One row for all film libraries | One row for all show libraries | A row for each library, under its title |
| A tap | Plays | Opens its episodes | Plays its best version at once |
| Its children | None | Episodes, a run | Versions, alternatives to each other |
| At its end | Stops | The next episode | Stops: nothing plays the first quarter after the whole game |
| Continue Watching | One entry | One entry per show | One entry per event |

A library says `type: "event"`, and an item `kind: "event"` with an `event` field (`service/plugin-api`), which `normalizeDetails()` also keeps in an item's details:

| Field | Meaning |
|---|---|
| `status` | `upcoming`, `live`, or `ended` |
| `startsAt` | ISO date-time |
| `competition` | The league and round |
| `progress` | Where a live event is, such as "Q4 05:12" |
| `sides` | `[{ name, score? }]`, who plays, in the order it is named |

A screen draws an event's line from these (`eventLine()` in [`events.js`](../../../../clients/player/src/events.js), `EventInfo.line()` in [`Browse.swift`](../../../../clients/apple/YoloKit/Sources/YoloKit/Browse.swift)): "Live · Q4 05:12 · 112–106" while it is played, else when it is and its competition. An old client ignores a library type it does not know and reads an unknown kind as a video, so nothing here raises `CLIENT_PROTOCOL` or `NODE_PROTOCOL`, and no table changes.

### One name, no spoilers

An event's title is its name ("76人 vs 活塞") and stays the same as the score changes; that alone makes three screens' cards agree. The score lives in `event.sides` and a card shows it only while the event is live: a card must not say how a game ended that the owner may still watch. Nothing on a card reveals it later; an agent can read it and is told not to volunteer it.

An event's picture is the plugin's to make, through `artwork()`. The Tencent plugin puts the two logos side by side on a dark ground with ffmpeg, which the node has anyway, and keeps the result in `cacheDir` ([`matchup.js`](../../../../plugins/source-tencent-sports/src/matchup.js)). It is an ordinary image behind an ordinary artwork URL, so every surface that already shows a thumbnail, the now-playing bar and history included, shows it without knowing about events.

### One game, one entry

Every version names the game as its `parents`, the game itself included, so `show_key` makes it one entry in Continue Watching, as a show's episodes are one, and removing it removes them all. The version a game plays first has the game's own id, so playing the game and choosing that version share one progress.

A place in a live stream is not kept at all: `saveProgress()` and `recordPlay()` write 0 for a live item, and `transfer()` asks for no position, so a replay starts where history says. A session's "Live" shows only while the session is in use, since a live stream left a while ago may have ended.

### Playing through another source

The plugin says which games there are; another source knows how to play the page. The new `delegate(source)` method hands an item over: it answers `{ url, title?, thumbnail?, artwork?, parents? }`, and the first other source that claims `url` prepares it ([`sources.js`](../../../../service/node/src/sources.js)). The item keeps its own Source, so history, resume, and track choices follow it. Whatever the delegating source does not implement of `tracks`, `subtitle`, `chapters`, `storyboard`, `comments`, and `warm` is answered by the source it hands to, so a replay still warms ahead and an agent can still read its subtitles. One hop only: the other source plays the item itself.

A game with nothing to play says so from `delegate()` with `resolve_failed`, not `not_found`, which would send the Hub looking for the item elsewhere in the library and then call it gone.

### `source-tencent-sports`

[`plugins/source-tencent-sports`](../../../../plugins/source-tencent-sports/) lists a league's games from Tencent's schedule (`matchUnion/list`), a week back and two days ahead on Beijing's calendar, asked again after a minute and left as it was when Tencent does not answer. It keeps only `matchType` 2, which leaves out studio shows and old games shown again. Live games come first, then the newest ended, then the soonest to come. An item's id is the game (`100000-10022600173`), with a replay (`~<vid>`) or a live channel (`~live-<id>`) for a version; `:` in Tencent's id becomes `-`, since an item id that reaches `play` may not contain one.

Its `columns` option names the leagues, by default the NBA. Playing, the live API, and the sign-in stay in `source-ytdlp` for now, which plays a game page's `vid` and `channel`; moving them is the rest of the [home cold start](../../proposed/feature/2026-10-31-home-cold-start.md)'s split.

### On each screen

- **The player** builds a row for each event library before Playlists, keeps it in the home cache, and pages it like any library row. A card's versions action, like its queue action, shows in edit mode or under keyboard focus, and opens the episodes page without its season headers.
- **Apple TV** plays on a press and offers All Versions on a long press. **iPhone and iPad** keep their two targets: the play button plays, and the cover opens the versions.
- **Agents** find games with `search` (`type: "event"`), see each one's versions with `browse`, and read its state in `get_item`.

## Alternatives considered

**Reusing `show`, with a league as a show and a game as an episode.** No client change at all, but Next would play the next game, a season's watched count would mean nothing, and a game's versions would need a third level. It also has no status, so nothing could say a game is live.

**A kind named for the sport, known to clients.** It would have to be built again for the next sport, and it would put a provider's vocabulary into the core.

**A plugin describing its own screens.** Plugin-defined layouts could serve types nobody has thought of, but a vocabulary general enough for that is a UI toolkit across three clients, built for one use. `event` is small, and a second presentation can join it when something needs one.

**Adding the library to `source-ytdlp`.** It is less code, but built-in link playback is always on, so every owner would get an NBA row.

**`prepare()` returning `{ delegate: url }`,** as the home cold start first proposed. It is smaller, but only `prepare` could follow it: a game would lose warming, and with it about 16 seconds at every start of a replay through the proxy, and agents would lose its subtitles and chapters.

**Drawing logos on the client.** A client-drawn card needs a layout in three clients and still leaves history, the now-playing bar, and agents with no picture. A plugin's image reaches them all.

## Consequences

Games have a row on the home screen, live and finished, with one name and one entry each, and nothing on a card spoils them. A new league is one line of options; a new site is a plugin with no client change.

The costs:

- Games watched before keep their `ytdlp:` entries, which do not merge into the new ones and do not show as watched in the row.
- A link to a game page now claims under `tencent-sports:` once the plugin is on, and under `ytdlp:` while it is off.
- A row of a league's games is long, since a day can have fifteen; search finds a team's, and following a team is left for later.
- A tap on a game that has not started shows the error panel saying so, rather than anything more helpful.
- On a touch screen in the player, a game's other versions are behind a long press.
- The plugin reads an unofficial schedule API whose fields can change without notice, as `source-ytdlp` already does for the replay list.
