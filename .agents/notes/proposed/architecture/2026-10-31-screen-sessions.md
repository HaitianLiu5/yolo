# Agent Note: Every screen plays on its own, and any screen continues another's in one tap

Status: proposed

English | [中文](2026-10-31-screen-sessions.zh.md)

## Problem

The Hub keeps one `PlaybackState`, one queue, and one active device per owner ([Hub and realtime channel](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md)). A play on another screen sends `deactivate` to the screen that played, which stops (`play()` in [`hub-core.js`](../../../../service/control/src/hub/hub-core.js)). The rationale was that one person never watches on two screens at once. In a household that does not hold: family members watch the living room TV while the owner watches on a phone, and either one's play stops the other's.

The single state leaks into every surface:

- **A tap in the web profile plays where playback is now**, Spotify Connect style ([`play-target.js`](../../../../clients/player/src/play-target.js), [Yolo Web](../../implemented/feature/2026-10-11-yolo-web-client.md#where-a-tap-plays)). While the family watches the TV, the owner's tap on a phone plays on the TV.
- **An agent's `play` without `device` goes to the active device** ([`mcp/tools.js`](../../../../service/control/src/mcp/tools.js)), so it lands on whichever screen played last.
- **History is written from the active device's reports only** ([progress and resume](../../implemented/feature/2026-10-11-yolo-owns-progress-and-resume.md)), and everything anyone watches on any screen goes into the owner's history and "Continue watching".
- **Previous, next, the walk, the run, and the queue are one per owner** ([what plays next](../../implemented/feature/2026-10-23-up-next.md)), so the TV's episode ending would take the item the owner queued on the phone.

The other half of the need is what the single state does well: moving to another screen keeps the item and position. Yolo has to keep that, and make it faster: on any screen, newly paired or not, one tap continues what another screen was playing, with the same item, position, subtitles, audio, and what plays next.

## Proposal

### Terms

- **Profile**: a person watching, such as the owner or Family. A profile owns history, continue watching, watched marks, and track preferences, and each screen picks one.
- **Account**: a sign-in to a site or library, such as a video site or a Plex server, kept by the node and used by plugins ([account plugins, PR #110](https://github.com/HaitianLiu5/yolo/pull/110)). An account is not a person: any profile plays through any account.

### The model

1. **Each screen has its own session**: its `PlaybackState`, its walk through history, its run, its queue, its stream, and its pending commands. Any number of screens play at once.
2. **What a person keeps is shared across screens**: progress, watched marks, and track preferences, per profile (below), and playlists (Watch Later among them) for everyone.
3. **A tap plays on the screen it was made on.** Controlling another screen is an explicit act in the now-playing bar. The car already works this way.
4. **"Continue here" takes over another screen's whole context in one tap**: item, position, subtitles and audio, the walk, the run, and the queue. The other screen pauses. The home screen warms the first candidate, so the tap starts as fast as a warmed history item.
5. **"Move to TV" is the same act from the other side**, and asks first when someone else is watching there.
6. **Sessions belong to a profile.** Profiles are a list: the owner's first, then any others, Family the usual one. A screen has a default profile; a family screen is one whose default is Family. Family viewing writes Family's history, never the owner's.
7. **Agents have a rule for the screen they target** when none is named (below).
8. **The now-playing bar lists every session**, and the owner picks the one to control.

### Profiles

A **profile** is who is watching: whose history a session writes, whose "Continue watching" and watched marks it feeds, whose track choices it remembers, and whose takeover card it shows on. Yolo has one owner, one passkey, one Hub, and one set of sources and accounts; a profile changes none of that. It is a label on screens and sessions, not a sign-in.

- **Profiles are a list**, each `{ id, name }`. The owner's is always there, first, with the id `owner`, and cannot be removed. Every other profile is an equal entry: Family is created the first time a screen is set to it, and the owner adds, renames, or removes others in the owner pages' Settings › Profiles. Removing a profile deletes its history and preferences and sets its screens back to the owner's. A third person is a new entry, with no change to the protocol, the Hub, or D1.
- **A screen's default profile** is the owner's unless set to another. When the owner approves a screen whose type is TV, the approval page asks "Who watches on this screen?", listing Me, then Family, then any other profile, with Me selected ([`auth/pages.js`](../../../../service/control/src/auth/pages.js)). The owner changes it later in Settings › Screens, or an agent with `rename_device`.
- **A session's profile is set when it starts**: a takeover keeps the profile of the session it took over, and any other play takes the screen's default. So the owner who continues their own episode on the family TV writes their own history, and the next item the family taps there is Family's.
- **A screen's home shows its default profile's** "Continue watching", watched marks, and resume positions: a family screen shows Family's, never the owner's. Its takeover card still lists the owner's sessions, so the owner can continue on it.
- **An account's rows** (its follows, subscriptions, or watch-later list) show on the homes of the profiles the account lists, the owner's alone by default; the owner adds Family to an account in Settings › Accounts. The list is a setting of the account, kept where accounts are kept (PR #110). Which homes show the rows is all it decides: a session of any profile plays through the account.
- **The player shows whose session it is** with a small tag naming the profile when it differs from the screen's default, so the owner sees that the family TV is writing their history.

The owner's history stays in `history` and its track choices in `track_preferences`, the tables the previous release reads and writes; every other profile's go to `profile_history` and `profile_track_preferences` (D1, below). A profile picker when a screen starts, as streaming services have, can come later on the same list. Separate Yolo users, each with their own sign-in, sources, and permissions, are a different change and out of 1.0 (alternatives).

### Sessions in the Hub

The Hub stays one Durable Object per owner. Its storage keys that are one per owner today become one per screen: `state:<deviceId>`, `walk:<deviceId>`, and `run:<deviceId>`; `commands:`, `danmaku:`, `stream:`, `health:`, `rates:`, `network:`, and the canvas are per device already. The Hub's `generation` counter, which makes a newer play supersede an older one still preparing, becomes one per screen, so a play on the TV never supersedes one on the phone. `lastProgressWrite` becomes one per screen.

`PlaybackState` gains:

| Field | Meaning |
|---|---|
| `profile` | `{ id, name }` of the session's profile; the owner's id is `owner` |
| `handedTo` | `{ deviceId, at }` once another screen continued this session; the session is paused and this screen does not resume it on its own |
| `handedFrom` | `{ deviceId }` on a session that took over another |
| `updatedAt` | When the session last changed, for the takeover card's order and "in use" |

`deviceId` already names the screen; every state carries it.

**Reports.** Every screen reports its own session, and the Hub writes each session's history under its profile. The rule "only from the active device" becomes "only for this device's own session"; the `sessionId` check stays.

**A session in use** has an item, a screen online, and a status of `playing`, `loading`, or `buffering`, or `paused` within the last 30 minutes. "In use" decides the agents' default and whether "Move to" asks.

**Ending a session.** `stop` on a screen ends its session (status `idle`, no item). The session of a screen the owner removes goes with it.

### The queue is per screen

The queue becomes part of a session, beside the walk and the run: `queue_items` gains `device_id`, and `next` on a screen takes that screen's queue. A takeover moves the queue with the rest of the context, ahead of anything queued on the screen that took over.

A per-screen queue wins over one shared queue with a "plays where" on each item, because the queue answers "what does this screen play next", as the walk and the run do. With a shared queue, the TV's episode ending would take what the owner queued on the phone, or every screen would have to decide which items are its own, which is a per-screen queue with extra steps. What the owner wants to watch later on whichever screen is Watch Later, a playlist shared by every screen; `playlist_enqueue` puts a playlist's items in one screen's queue.

### Continue here

The takeover card sits at the top of every home screen: "Continue from another screen", up to three sessions, each with the screen's name, the item's picture and title, the position, and how long ago. It lists the owner's sessions and those of the screen's own default profile, on other screens, that have an item that is not finished, newest first, including sessions of screens now offline: a parked car's session is there with the position of its last report. Another profile's session never shows on a screen whose default is the owner's; the owner reaches it from the now-playing bar.

When the card shows, the screen asks `POST /v1/playback/warm` for the first card's item ahead of its history items. `warm` takes `{ source, startTime }` entries as well as sources, and passes `startTime` to the node, an additive field that raises no `NODE_PROTOCOL`.

One tap is `PUT /v1/playback/device` `{ deviceId: <this screen>, from: <that screen> }`. The Hub, in one step:

1. Reads the session on `from`: its item, its position extrapolated to now, its subtitles and audio, its walk, its run, its profile.
2. Plays the item on the target at that position (`reason: "transfer"`), with the chosen subtitles and audio as preferences, since track ids belong to a stream, and with `autoplay` true.
3. Copies the walk and the run, moves `from`'s queue rows ahead of the target's, and gives the target's session the profile of `from`'s, with `handedFrom`.
4. Sends `pause` to `from` when it plays, marks its session `paused` with `handedTo`, and stops its node session, as a released kept player's is stopped; the screen keeps its paused picture and, if the owner resumes it there, recovers with a new stream as a kept player shown after its stream went does.
5. Writes history for the target's session under its profile.

A screen whose session is `handedTo` another does not resume it on a welcome, a reload, or a car's wake ([`resume-decision.js`](../../../../clients/player/src/resume-decision.js)): its home shows "Continued on Living room TV", with Continue here to take it back.

### Move to

The now-playing bar's picker moves a session to another screen with the same call, `{ deviceId: <target>, from: <the session's screen> }`. When the target has a session in use and the request is not made from the target itself, the Hub refuses with `screen_busy` and names what plays there and whose it is; the screen asks "Family is watching *Title* on Living room TV. Play here instead?", and the confirm sends `replace: true`. The replaced session's position goes to its profile's history, and its screen plays the new item. A takeover from the target itself never asks: the person is at that screen.

### Which screen an agent targets

One function decides the screen of every request that names none, for `/v1` and MCP alike:

1. **A request from a screen targets that screen**: a paired screen's own credential, and an Ask from it, whose `device` the control plane passes already ([agent from the screen](../../implemented/feature/2026-10-18-agent-from-the-screen.md)). A remote-only browser goes on to rule 2.
2. **Otherwise, the owner's sessions in use**: exactly one, and the request goes there.
3. **None in use**: a play goes to the only online screen whose default is the owner's that can play; a control command (`pause`, `seek`, `skip`, …) is refused with `nothing_playing`.
4. **Several, or none to pick**: refused with `device_ambiguous`, listing each screen with what it plays, so the agent asks the person which one in its reply.

Sessions of other profiles, and screens whose default is another profile, are never a default: an agent reaches them only by name. A pause from the owner's agent therefore never stops the family's film.

### Protocol: `CLIENT_PROTOCOL` 2

Several screens' states in one channel change what `state` means: a client of protocol 1 reads a `state` naming another device as playback having moved away (the Apple TV app's `AppModel` compares `state.deviceId` with its own). So this raises `CLIENT_PROTOCOL` to 2, and the Hub serves 1 and 2 for one release ([client protocol](../../implemented/architecture/2026-10-19-client-protocol.md#versions)).

**What protocol 2 changes on the realtime channel:**

| Message | Protocol 2 |
|---|---|
| `welcome` | `state` is this screen's own session (an empty state when it has none). New: `sessions`, every other screen's session that has an item; `profile`, this screen's default `{ id, name }`; `profiles`, the list. `queue` is this screen's queue |
| `state` | Every screen's session changes go to every protocol-2 connection; the state's `deviceId` says whose |
| `queue` | `{ deviceId, items }`, every screen's, to every protocol-2 connection |
| `pause` | Also sent to a screen whose session another screen took over; the `state` that follows carries `handedTo` |
| `deactivate` | Only `reason: "replaced"`, the same screen connected from another window. Another screen playing no longer deactivates anyone |
| `report`, `ended`, `error` | From every screen, for its own session |

**`/v1`:**

- `GET /v1/playback` takes `?deviceId=`; a screen's own credential without it reads its own session, anything else the default rule's. New `GET /v1/playback/sessions` lists every session. `GET /v1/playback/up-next` takes `?deviceId=`.
- `POST /v1/playback/pause`, `/resume`, `/stop`, `/seek`, `/next`, `/previous`, and `PUT /v1/playback/tracks` take `deviceId`; without it the default rule applies.
- `PUT /v1/playback/device` takes `{ deviceId, from?, replace? }` as above.
- `POST /v1/playback/play` without `deviceId` plays on the requesting screen when it can play, else by the default rule.
- `GET /v1/queue`, `POST /v1/queue`, `/reorder`, and `DELETE` take `deviceId`, default the requesting screen's.
- `GET /v1/history` takes `?profile=`, default the requesting screen's default profile; entries carry `deviceId`, the screen that played them last. Library listings lay that profile's history over what the source lists, and a play resumes from it.
- `GET /v1/profiles` lists the profiles; the owner pages add, rename, and remove them under `/v1/owner/profiles`, behind the passkey session.
- `PATCH /v1/devices/:id` and `/v1/owner/devices` take `profile`, a profile's id.
- `POST /v1/agent` passes `playing` as the asking screen's own session, and `others`, the other sessions in use, so "this" stays the screen's own and "what's on the TV" can be answered.

**A protocol-1 client** gets the shapes it has today, scoped to itself: `welcome.state` and every `state` it receives are its own session only, `queue` its own queue, and a takeover from it is the `pause` it already handles. It plays on its own beside other screens; it cannot see other sessions or continue them until it is updated. Protocol-1 `/v1` requests (the `Yolo-Protocol` header) get the same scoping.

### D1

Migration `0015_screen_sessions.sql`, written so the previous release's code runs on it:

```sql
-- Profiles other than the owner's: who is watching. The owner's profile
-- has the reserved id 'owner' and no row; NULL profile_id means it.
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_profiles_user ON profiles(user_id);

ALTER TABLE devices ADD COLUMN profile_id TEXT;    -- a screen's default profile
ALTER TABLE queue_items ADD COLUMN device_id TEXT; -- the screen whose queue it is
CREATE INDEX idx_queue_items_user_device ON queue_items(user_id, device_id, position);
ALTER TABLE history ADD COLUMN device_id TEXT;     -- the screen that played it last

-- A profile's history, as `history` is the owner's, newest 500 per profile.
CREATE TABLE profile_history (
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail TEXT,
  position REAL NOT NULL DEFAULT 0,
  duration REAL,
  play_count INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  watched_at INTEGER,
  show_key TEXT,
  season_key TEXT,
  device_id TEXT,
  PRIMARY KEY (user_id, profile_id, source_key)
);
CREATE INDEX idx_profile_history_updated ON profile_history(user_id, profile_id, updated_at DESC);

-- A profile's track choices, as `track_preferences` holds the owner's.
CREATE TABLE profile_track_preferences (
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  selection TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile_id, source_key)
);
```

The owner's history stays in `history` with its primary key, so the previous release reads and writes it unchanged, and MCP's `history` keeps its meaning. A separate table, rather than a `profile_id` in `history`'s primary key, avoids rebuilding `history`, which the previous release's `ON CONFLICT (user_id, source_key)` writes depend on. The same holds for `track_preferences`. Every new table has `user_id` ([D1 data model](../../implemented/architecture/2026-10-07-d1-data-model.md)). The two tables per kind are a storage detail: the Hub and `/v1` read every profile through one function, so the owner's rows can move into the profile tables in a later release without changing the model.

### MCP

| Tool | Change |
|---|---|
| `get_status` | Lists every session: screen, profile, item, position, status, in use, what plays next. Says which screen a command without `device` reaches now, or that it is ambiguous |
| `play` | Without `device`, the default rule. Refuses `screen_busy` on a named screen that someone else is using, unless `replace: true` |
| `control`, `seek`, `skip`, `set_tracks`, `list_tracks`, `get_playback_health`, `set_danmaku` | `device` optional with the default rule; `device_ambiguous` lists the screens |
| `transfer` | `{ device, from?, replace? }`: continues `from`'s session (default rule) on `device` with its whole context, and `from` pauses; `screen_busy` as for `play` |
| `queue_list`, `queue_add`, `queue_remove`, `queue_clear`, `playlist_enqueue` | `device?`: the screen whose queue it is, by the default rule |
| `history` | `profile?`, a profile's name or id, the owner's by default; entries carry the screen that played them last |
| `list_devices` | Each screen's default profile and its session in short, and the list of profiles |
| `rename_device` | `profile?`: a profile's name or id, the screen's new default |

The server's instructions change from "Playback goes to the active device by default" to the default rule in one sentence: the asking screen, else the one screen the owner is using, else ask. The agent plugins' system prompt already plays on the screen that asked.

### Clients

**Web and car** ([`clients/player/`](../../../../clients/player/)):

- `play-target.js`: a tap plays here whenever this browser can play, in both profiles; a remote-only browser keeps the picker.
- `store.js`: keeps every session by `deviceId` and this screen's own; previous, next, and up-next read the own session.
- `remote.js`: the now-playing bar lists every session, this screen's kept one first, each with its screen and profile; the owner picks one to control, and its picker moves that session with `from`, asking on `screen_busy`.
- `browse.js`: the takeover card at the top of home, and its warm.
- `resume-decision.js` and `kept-player.js`: a session `handedTo` another is not resumed; its player stays paused with "Continued on …" and Continue here.
- `main.js`: `hello` with protocol 2; `state` and `queue` by `deviceId`; `deactivate` only for `replaced`.
- `settings.js` and the owner pages: Settings › Screens shows each screen's "Who watches here".
- The car keeps its layout; the card and the bar's session list sit on the driver's side as its other sheets do ([design principles](../../implemented/architecture/2026-07-13-in-car-design-principles.md)).

**Apple TV** ([`clients/apple/`](../../../../clients/apple/)):

- YoloKit: protocol 2 in `hello`; `RealtimeMessages` and `Playback.swift` read `sessions` and `state` by `deviceId`; `MissedCommands.swift` reads only the own session; `APIClient.swift` gains `deviceId` and `from` on the routes above.
- `AppModel.swift` keeps every session and stops treating another screen's `state` as deactivation.
- `HomeScreens.swift`: the takeover card as Home's first row, warmed, one press of select to continue.
- `TVPlayer.swift`: a session `handedTo` another shows paused with "Continued on …".
- Settings shows the screen's profile; the owner sets it at approval or in the owner pages, so the TV needs no picker.
- The now-playing session list and Move to are W8's remote work for the TV, built on these routes.

**iPhone and iPad** (PR #72, not merged): the app shares YoloKit and the TV's app layer, so it speaks protocol 2 from its first release and never ships protocol 1. On top of the TV's changes it adds what a phone is for: the takeover card at the top of Home, a now-playing bar that lists every session and controls the chosen one, and Move to with the `screen_busy` question. AirPlay stays the system's own and is not a Yolo takeover.

**Conformance kit**: scenarios for a protocol-2 welcome with `sessions`; another screen's `state` that must not change what the client plays; a takeover's `pause` with `handedTo`, after which a reconnect does not resume; a `load` with `reason: "transfer"` and its tracks; and a protocol-1 client that sees only its own session.

### Upgrade and compatibility

1. **The release that ships this** migrates D1 with `0015`, and the Hub moves its old storage on first load: `state` to `state:<its deviceId>`, `walk` and `run` to that screen's keys, and queue rows without `device_id` to the screen that played last. It serves protocols 1 and 2. The browser player ships with the Worker and speaks 2 at once; a tab loaded before reloads as it does for any release.
2. **Native clients** of protocol 1 keep playing on their own screens, as above, until updated. The Apple TV build with protocol 2 and the first iPhone build ship before the next release.
3. **The next release** drops protocol 1.

A rollback to the previous release finds no `state` key, so it shows nothing playing; screens play again with a tap. It reads every screen's queue rows as one queue, and it does not see Family's history, which waits in `profile_history`. The `yolo-upgrade` block in `CHANGELOG.md` says so. The privacy pages (`site/public/privacy.html` and its Chinese page) say that the server keeps each profile's name, history, and track choices and which screen played an item, in the same change.

### Notes this changes

When it ships, this proposal supersedes "One queue, one active device" and the "A queue per device" alternative in [Hub and realtime channel](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md), and updates, in the same change: that note's message tables; [Yolo Web](../../implemented/feature/2026-10-11-yolo-web-client.md)'s "Where a tap plays" and "The remote"; [progress and resume](../../implemented/feature/2026-10-11-yolo-owns-progress-and-resume.md)'s recording, continue watching, and resuming; [what plays next](../../implemented/feature/2026-10-23-up-next.md); [`/v1`](../../implemented/architecture/2026-10-07-v1-http-api.md); [remote MCP server](../../implemented/feature/2026-10-07-remote-mcp-server.md); [D1 data model](../../implemented/architecture/2026-10-07-d1-data-model.md); [client protocol](../../implemented/architecture/2026-10-19-client-protocol.md); and [agent from the screen](../../implemented/feature/2026-10-18-agent-from-the-screen.md). The Hub note stays active: the realtime channel, its limits, and what a dead connection takes are unchanged, per session.

### Plan

1. **Hub and protocol**: sessions per screen, the per-screen queue, the default rule, the takeover, `/v1`, MCP, migration `0015`, and the browser player (tap here, the bar's sessions, the card). One release with the browser player, since both ship with the Worker.
2. **Profiles**: the profile list in use with its tables, the approval page's question, Settings › Profiles and › Screens, which profiles an account's rows show for, and the player's tag. It can ship in the same release.
3. **Apple clients**: the Apple TV app on protocol 2, and PR #72 built on it (W8).
4. **The next release** drops protocol 1.

## Alternatives considered

**Keep one active device and add "Continue here".** Spotify Connect's model, and today's with a faster transfer. It gives the quick resume but not the independent use: the family's TV and the owner's phone still cannot play at once.

**A shared queue with a target screen on each item.** Every screen's end would have to pick its own items from a list the others also edit, and an item without a target would go to whichever screen ended first. The per-screen queue with a shared Watch Later playlist says the same with less (above).

**Separate Yolo users for family members**, each with a sign-in, sources, and permissions. It opens the one-owner model the whole system rests on: the passkey, the Hub per user, `user_id` on every D1 row, the node's sources. Profiles give households separate histories at a fraction of that, and stay compatible with separate users if they ever come.

**A fixed pair of profiles, the owner and Family.** It costs about the same as a list: the tables, the protocol's `{ id, name }`, and the approval page's question are the same shape. A fixed pair would need a protocol change and a migration for the third person, such as a child with their own history; a list needs a new entry.

**A family flag on the screen instead of a profile on the session.** Viewing on a family screen would never count for the owner, so the owner who continues their episode on the TV after a drive loses that progress; and a second family member's history later would need a migration. A profile on the session follows the person through a takeover.

**One Hub per screen.** The takeover card, the bar's session list, and the takeover itself read and change two screens at once; across Durable Objects that is a call per screen and a fan-out per broadcast. One Hub per owner already holds every connection, and per-screen keys cost nothing more.

**Continuing automatically on a new screen**, as Spotify does when an app opens while playback is paused elsewhere. On a family TV that would play the owner's episode to the family. Takeover stays one explicit tap, and the card makes it one.

**The most recently used screen as the agents' default.** It silently picks the wrong screen when two are in use, such as pausing the family's film when the owner meant the phone. Asking costs one turn and only when two of the owner's screens are in use.

**Asking on the target screen before Move to** ("Phone wants to play here"). It needs someone at the TV to answer and leaves the sender waiting; the sender's own confirm, with what plays there, is enough for a household.

## Acceptance criteria

1. **Family on the TV, owner on the phone.** The TV (default Family) plays a film; the owner taps an episode on the phone. Both play; neither pauses. The owner's history gains the episode only; Family's gains the film. The owner's agent says "pause" with no device: the phone pauses and the film plays on.
2. **A newly paired screen takes over in one tap.** The owner pairs a browser while the phone plays episode 3 with Chinese subtitles and two episodes queued. Its home shows the phone's session first in "Continue from another screen". One tap plays episode 3 at the phone's position, with Chinese subtitles, as fast as a warmed history item; the phone pauses with "Continued on …"; Next plays the first queued episode, then the run.
3. **Parked car, then the TV at home.** The car plays episode 5 and sleeps when parked, so its session keeps the position of its last report. At home, the family TV's card shows "Model Y · Episode 5 · 23:10". One press continues it on the TV as the owner's session, writing the owner's history. When the car wakes, it does not resume episode 5; it shows "Continued on Living room TV".
4. **Move to TV while the family watches.** From the phone's bar, Move to Living room TV asks first, naming the film the family watches. Cancel changes nothing. Confirm plays the phone's episode on the TV at its position, and the film's position is in Family's history.
5. **Agents.** An Ask from the car plays in the car while the TV plays on. With the phone and the car both in use, an external agent's "play X" is refused with `device_ambiguous` listing both, and the agent asks which. With only the family TV in use, "play X" from the owner's agent plays on the owner's only online screen, never on the TV.
6. **The bar.** The phone's now-playing bar lists the TV's and the car's sessions; pausing the TV's from the phone pauses only the TV.
7. **Protocol 1.** An Apple TV build of protocol 1 plays its own item while the phone plays another, and pauses when the phone continues its session.
8. **A third profile.** The owner adds "Kids" in Settings › Profiles and sets the bedroom tablet to it. With no update to any client, the tablet's home shows Kids' history, and its viewing writes Kids' history, apart from Family's and the owner's.
9. **Account rows.** The owner's signed-in video account shows its follows on the owner's phone and not on the family TV. After the owner adds Family to that account, the TV shows them too, and a play from them on the TV writes Family's history.
10. **Checks.** `npm run check` passes with the Hub's tests for per-screen sessions, the default rule, `screen_busy`, the takeover, the migration of old storage, and protocol-1 scoping; the conformance kit's new scenarios pass against the Apple TV and iPhone apps.

## Risks

- **The node carries several streams at once.** Two transcodes, or a transcode and a relay, can exceed a home machine's CPU or Plex's transcode limit. The node already serves warm sessions beside a playing one; a refusal surfaces on the screen that asked, with its error panel.
- **Per-screen state multiplies the Hub's hardest code.** Supersession, the welcome's recovery of a lost `load`, and missed commands were per owner and become per screen; the `generation` counter is the subtle one. The Hub's tests have to cover two screens playing at once for each.
- **The same item on two screens of one profile** writes one history row from both; the last report wins, and both show in the card.
- **A family screen's card shows the owner's sessions**, so the family sees what the owner watched in the car. It is what makes the car-to-TV takeover one press; a setting can hide it later if it matters.
- **Protocol-1 Apple TV builds** cannot take over until updated, and a takeover from them only pauses them.
- **A rollback** shows nothing playing and merges the queues, as above.
- **Agents ask more.** With two of the owner's screens in use, a command without a device costs a question.
