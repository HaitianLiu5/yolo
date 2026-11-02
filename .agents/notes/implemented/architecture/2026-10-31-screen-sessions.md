# Agent Note: Every screen plays on its own, and any screen continues another's in one tap

Status: implemented

English | [中文](2026-10-31-screen-sessions.zh.md)

## Problem

A Hub with one `PlaybackState`, one queue, and one active device per owner ([Hub and realtime channel](2026-10-07-hub-and-realtime-channel.md)) stops a screen whenever another plays: the play sends `deactivate` to the screen that played. That holds while one person watches on one screen at a time. In a household it does not: family members watch the living room TV while the owner watches on a phone, and either one's play stops the other's.

The single state leaks into every surface:

- **A tap in web mode plays where playback is**, Spotify Connect style, so while the family watches the TV, the owner's tap on a phone plays on the TV.
- **An agent's `play` without `device` goes to the active device**, whichever screen played last.
- **History comes from the active device's reports only**, and everything anyone watches on any screen goes into the owner's history and "Continue watching".
- **Previous, next, the walk, the run, and the queue are one per owner** ([what plays next](../feature/2026-10-23-up-next.md)), so the TV's episode ending takes the item the owner queued on the phone.

The other half of the need is what the single state does well: moving to another screen keeps the item and position. Yolo has to keep that, and make it faster: on any screen, newly paired or not, one tap continues what another screen was playing, with the same item, position, subtitles, audio, and what plays next.

## Decision

### Terms

- **Profile**: a person watching, such as the owner or Family. A profile owns history, continue watching, watched marks, and track preferences, and each screen has a default one.
- **Account**: a sign-in to a site or library, kept by the node and used by plugins ([site accounts](../../proposed/feature/2026-10-28-site-accounts.md)). An account is not a person: any profile plays through any account.

### The model

1. **Each screen has its own session**: its `PlaybackState`, its walk through history, its run, its queue, its stream, and its pending commands. Any number of screens play at once, and a play on one never stops another.
2. **What a person keeps is shared across screens**: progress, watched marks, and track preferences per profile, and playlists (Watch Later among them) for everyone.
3. **A tap plays on the screen it was made on.** Controlling another screen is an explicit act in the now-playing bar.
4. **"Continue here" takes over another screen's whole context in one tap**: item, position, subtitles and audio, the walk, the run, and the queue. The other screen pauses. The home screen warms the first candidate, so the tap starts as fast as a warmed history item.
5. **"Move to" is the same act from the other side**, and asks first when someone is watching there.
6. **Sessions belong to a profile.** Profiles are a list, the owner's first. A family screen is one whose default profile is Family, and Family's viewing writes Family's history, never the owner's.
7. **One rule picks the screen of a request that names none**, for `/v1` and MCP alike.
8. **The now-playing bar lists every session in use**, and the owner picks the one to control.

### Profiles

A profile is who is watching: whose history a session writes, whose "Continue watching" and watched marks it feeds, and whose track choices it remembers. Yolo keeps one owner, one passkey, one Hub, and one set of sources and accounts; a profile is a label on screens and sessions, not a sign-in ([`store/profiles.js`](../../../../service/control/src/store/profiles.js)).

- **Profiles are a list** of `{ id, name }`. The owner's is always first, with the reserved id `owner` (`OWNER_PROFILE` in [`@useyolo/core`](../../../../service/core/src/playback.js)), has no row, and cannot be removed or renamed. Family is made the first time a screen is set to it ("family" names it in any request that takes a profile). The owner adds, renames, and removes the others in the player's settings under "Who watches"; removing one deletes its history and track choices and sets its screens back to the owner's. A third person is a new entry, with no change to the protocol, the Hub, or D1.
- **A screen's default profile** is the owner's unless set to another (`devices.profile_id`). The approval page asks "Who watches on this screen?" for a screen of type TV, listing Me, then Family, then the others, with Me selected ([`auth/pages.js`](../../../../service/control/src/auth/pages.js)). The owner changes it in a screen's editor in settings ("Who watches here"), and an agent with `rename_device`.
- **A session's profile is set when it starts**: a takeover keeps the profile of the session it took over, next and previous and a stream's rebuild keep the session's own, and any other play takes the screen's default. The owner who continues their own episode on the family TV writes their own history, and the next item the family taps there is Family's.
- **A screen reads its default profile's history**: `GET /v1/history`, library listings' resume positions and watched marks, and the home's "Continue watching" on a family screen are Family's. Its takeover card still lists the owner's sessions, so the owner can continue there.
- **The now-playing bar tags a session with its profile** when it is not the screen's default one, so the owner sees the family TV writing their history.

The owner's history and track choices stay in `history` and `track_preferences`, the tables the previous release reads and writes; every other profile's are in `profile_history` and `profile_track_preferences`. The stores read every profile through one function, `profileScope()` in [`store/rows.js`](../../../../service/control/src/store/rows.js), so the owner's rows can move into the profile tables in a later release without changing the model.

### Sessions in the Hub

The Hub stays one Durable Object per owner ([`hub-core.js`](../../../../service/control/src/hub/hub-core.js)). A session is kept per screen under `state:<deviceId>`, `walk:<deviceId>`, and `run:<deviceId>`, beside the per-device `commands:`, `danmaku:`, `stream:`, `health:`, `rates:`, `network:`, and the canvas. Plays are numbered in the order they were asked, and the newest one for a screen claims it, so an older play still preparing for that screen is superseded and a play on another screen never is. The time of the last progress write and the `ended` being handled are per screen too.

`PlaybackState` carries:

| Field | Meaning |
|---|---|
| `deviceId` | The screen whose session it is |
| `profile` | `{ id, name }` of the session's profile |
| `handedTo` | `{ deviceId, at }` once another screen continued this session; it is paused, not in use, and its screen does not resume it on its own |
| `handedFrom` | `{ deviceId }` on a session that took over another |
| `updatedAt` | When the session last changed, for the takeover card's order and "in use" |

**Reports.** Every screen reports its own session, and the Hub writes each session's progress under its profile; the `sessionId` check stays.

**A session in use** has an item, a screen online, no `handedTo`, and a status of `playing`, `loading`, or `buffering`, or `paused` within the last 30 minutes (`sessionInUse()` in `@useyolo/core`). "In use" decides the default rule and whether a play or a move asks first.

**Ending a session.** `stop` on a screen ends its session (status `idle`, no item). The session of a screen the owner removes goes with its walk, run, and queue.

**Old storage.** `HubCore.migrateStorage()` runs whenever the Hub starts ([`hub.js`](../../../../service/control/src/hub/hub.js)): the single `state`, `walk`, and `run` of the releases before become the session of the screen that played them, as the owner's, and queue rows without a screen become that screen's (or the one seen last). A flag makes it a no-op afterwards, unless a rollback wrote `state` again.

### The queue is per screen

The queue is part of a session, beside the walk and the run: `queue_items.device_id` names the screen, `next` on a screen takes that screen's queue, and a takeover moves the queue ahead of anything queued on the screen that took over ([`store/queue.js`](../../../../service/control/src/store/queue.js)).

A per-screen queue wins over one shared queue with a "plays where" on each item, because the queue answers "what does this screen play next", as the walk and the run do. What the owner wants to watch later on whichever screen goes in Watch Later, a playlist shared by every screen; `playlist_enqueue` puts a playlist's items in one screen's queue.

### Continue here

"Continue from another screen" is the first row of every home screen that can play ([`browse.js`](../../../../clients/player/src/browse.js)): up to three sessions of other screens, each with the screen's name, the item's picture and title, the position, and how long ago (`continueCandidates()` in [`store.js`](../../../../clients/player/src/store.js)). It lists the sessions of the owner's profile and of the screen's own default profile that have an item not finished, newest first, offline screens' included: a parked car's session is there with the position of its last report. When the screen's own session was continued elsewhere, that screen's session comes first under "Continued on …".

The row warms its first session's item where it would start: `POST /v1/playback/warm` takes `{ source, startTime }` entries as well as sources, and the node passes the start to its plugins' `warm()` as `startTime` (an additive field, `startTimes` by source key, which raises no `NODE_PROTOCOL`).

One tap is `PUT /v1/playback/device` `{ deviceId: <this screen>, from: <that screen> }` (`continueHere()` in [`playback.js`](../../../../clients/player/src/playback.js)). `HubCore.transfer()`, in one step:

1. Reads the session on `from`: its item, its position extrapolated to now, its walk, its run, and its profile.
2. Plays the item on the target at that position (`reason: "transfer"`, `autoplay` true) under that profile, so the profile's saved subtitle and audio choices pick the tracks; track ids belong to a stream.
3. Copies the walk and the run, moves `from`'s queue rows ahead of the target's, and marks the new session `handedFrom`.
4. Sends `pause` to `from` when it plays, marks its session `paused` with `handedTo`, and stops its node session. Its screen keeps the paused picture; if the owner resumes it there, the stream recovers with a new one, as a kept player's does after its stream went.
5. Writes history for the new session under its profile.

A screen whose session is `handedTo` another does not resume it on a welcome, a reload, or a car's wake ([`resume-decision.js`](../../../../clients/player/src/resume-decision.js)). A player on screen when it is continued elsewhere goes behind home as Back leaves it, and the now-playing bar says "Continued on Living room TV"; its play button takes the session back from there in one tap ([`remote.js`](../../../../clients/player/src/remote.js)).

### Move to

The now-playing bar's sheet moves the session it controls to another screen with the same call, `{ deviceId: <target>, from: <the session's screen> }`. When the target has a session in use and the request is not made from the target itself, the Hub refuses with `screen_busy`, whose `details` name the screen, the item, and whose session it is; the sheet asks "Family is watching *Title* on Living room TV.", and its confirm sends `replace: true`. The replaced session's position goes to its profile's history, and its screen plays the moved item. A takeover from the target itself never asks: the person is at that screen.

A play on a named screen (`POST /v1/playback/play` with `deviceId`, MCP `play` with `device`) asks first the same way when the session in use there is another profile's, unless the request comes from that screen or carries `replace: true`. Replacing the owner's own session there needs no question: the owner asked for it.

### Which screen a request reaches

`HubCore.resolveScreen()` decides the screen of every request that names none, for `/v1` and MCP alike:

1. **A request from a screen targets that screen**: a paired screen's own credential (`requester`). A remote that cannot play goes on to rule 2. An Ask from a screen names the screen to its agent already ([agent from the screen](../feature/2026-10-18-agent-from-the-screen.md)).
2. **Otherwise, the owner's sessions in use**: exactly one, and the request goes there.
3. **None in use**: a play goes to the only online screen whose default profile is the owner's and that can play; a command for what plays (`pause`, `seek`, `skip`, `next`, …) is refused with `nothing_playing`; a queue edit goes to the owner's screen that played last, online or not; a read of what plays answers that nothing does.
4. **Several, or none to pick**: refused with `device_ambiguous`, whose `details.screens` list each screen with its profile and what it plays, so the agent asks the person which one.

Sessions of other profiles, and screens whose default is another profile, are never a default: an agent reaches them only by name. A pause from the owner's agent therefore never stops the family's film. The error codes `screen_busy`, `device_ambiguous`, and `nothing_playing` are in [`errors.js`](../../../../service/core/src/errors.js).

### Protocol: `CLIENT_PROTOCOL` 2

Several screens' states in one channel change what `state` means: a client of protocol 1 reads a `state` naming another device as playback having moved away (the Apple TV app's `AppModel` of 0.12 compares `state.deviceId` with its own). So `CLIENT_PROTOCOL` is 2, and the Hub serves 1 and 2 for one release ([client protocol](2026-10-19-client-protocol.md#versions)).

**The realtime channel in protocol 2:**

| Message | Protocol 2 |
|---|---|
| `welcome` | `state` is this screen's own session (an empty state when it has none). Also `sessions`, every other screen's session that has an item; `profile`, this screen's default `{ id, name }`; `profiles`, the list. `queue` is this screen's queue |
| `state` | Every screen's session changes go to every protocol-2 connection; the state's `deviceId` says whose |
| `queue` | `{ deviceId, items }`, every screen's, to every protocol-2 connection |
| `devices` | Each device carries its default `profile` id and its `session` in short; protocol 2 also gets `profiles` |
| `pause` | Also sent to a screen whose session another screen took over; the `state` that follows carries `handedTo` |
| `deactivate` | Only `reason: "replaced"`, the same screen connected from another window |
| `report`, `ended`, `error` | From every screen, for its own session |

**`/v1`** ([`api/v1.js`](../../../../service/control/src/api/v1.js)):

- `GET /v1/playback` takes `?deviceId=`; a screen's own credential without it reads its own session, anything else the default rule's. `GET /v1/playback/sessions` lists every session that has an item, with its screen and whether it is in use. `GET /v1/playback/up-next` and `GET /v1/tracks` take `?deviceId=`.
- `POST /v1/playback/pause`, `/resume`, `/stop`, `/seek`, `/next`, `/previous`, and `PUT /v1/playback/tracks` take `deviceId`; without it the default rule applies.
- `PUT /v1/playback/device` takes `{ deviceId, from?, replace? }`, as above.
- `POST /v1/playback/play` without `deviceId` plays on the requesting screen when it can play, else by the default rule; with it, `replace` answers `screen_busy`.
- `GET /v1/queue`, `POST /v1/queue`, `/reorder`, `DELETE`, and `POST /v1/playlists/:id/enqueue` take `deviceId`, by default the requesting screen's.
- `GET /v1/history` and `DELETE /v1/history` take `profile` (an id or a name), by default the requesting screen's default profile; entries carry `deviceId`, the screen that played them last. Library listings lay that profile's history over what the source lists.
- `GET /v1/profiles` lists the profiles; the owner pages add, rename, and remove them under `/v1/owner/profiles`, behind the passkey session. `PATCH /v1/devices/:id` and `/v1/owner/devices/:id` take `profile`, and `POST /v1/owner/pairing/approve` takes it too.
- `POST /v1/agent` passes the node `playing`, the asking screen's own session, and `others`, the other sessions in use, so "this" stays the screen's own and "what's on the TV" can be answered.

**A protocol-1 client** gets the shapes it had, scoped to itself: its welcome's `state` and every `state` it hears are its own session, its `queue` is its own, and a takeover from it is the `pause` it already handles. It plays on its own beside other screens; it cannot see other sessions or continue them until it is updated. Its `/v1` requests with its own credential are scoped to its own session by rule 1.

### D1

Migration [`0015_screen_sessions.sql`](../../../../service/control/migrations/0015_screen_sessions.sql) adds `profiles`, `devices.profile_id`, `queue_items.device_id`, `history.device_id`, `profile_history`, and `profile_track_preferences`, and works with the previous release's code. The owner's history keeps `history`'s primary key, so the previous release's `ON CONFLICT (user_id, source_key)` writes work unchanged and MCP's `history` keeps its meaning; a separate table, rather than a `profile_id` in that key, avoids rebuilding `history`. The same holds for `track_preferences`. Every new table has `user_id` ([D1 data model](2026-10-07-d1-data-model.md)).

### MCP

| Tool | Behavior |
|---|---|
| `get_status` | Lists every session (screen, profile, item, position, status, in use, up next, its queue in short) and `target`: the screen a command without `device` reaches now, or why it is ambiguous |
| `play` | Without `device`, the default rule. A named screen another profile is using is refused with `screen_busy` unless `replace: true` |
| `control`, `seek`, `skip`, `set_tracks`, `list_tracks`, `get_playback_health`, `set_danmaku` | `device` optional, with the default rule |
| `transfer` | `{ device, from?, replace? }`: continues `from`'s session (by default the rule's) on `device` with its whole context, and `from` pauses; `screen_busy` when someone is using `device` |
| `queue_list`, `queue_add`, `queue_remove`, `queue_clear`, `playlist_enqueue`, `playlist_import` | `device?`: the screen whose queue it is, by the default rule |
| `history` | `profile?`, a profile's name or id, the owner's by default; entries carry the screen that played them last |
| `list_devices` | Each screen's default profile and its session in short, and the list of profiles |
| `rename_device` | `profile?`: a profile's name or id, the screen's new default |

The server's instructions state the default rule in one sentence: the screen that asked, else the one screen of the owner's that is playing, else ask ([`mcp/server.js`](../../../../service/control/src/mcp/server.js)). The agent plugins' prompts add a line per other screen in use from `others`.

### The browser player

- [`play-target.js`](../../../../clients/player/src/play-target.js): a tap plays here whenever this browser can play, in car mode and web mode; a remote plays on the only other screen online, or the owner picks one.
- [`store.js`](../../../../clients/player/src/store.js): `hub` is this screen's own session and `sessions` every other screen's, by device id; previous, next, and up-next read the own session, and `inUse()` mirrors the Hub's rule.
- [`main.js`](../../../../clients/player/src/main.js): `hello` with protocol 2; `state` and `queue` by `deviceId`; `deactivate` only for `replaced`.
- [`remote.js`](../../../../clients/player/src/remote.js): the bar controls one session, this screen's own left with Back or continued elsewhere first, else the newest other session in use, and every command names its `deviceId`. Its sheet lists every session in use with its screen and profile; a tap controls one, "Continue here" takes it over here, "Move to" sends the controlled one elsewhere and asks on `screen_busy`, and "Stop playing" stops it.
- [`browse.js`](../../../../clients/player/src/browse.js): the takeover row and its warm, above; a remote's tap that plays elsewhere asks on `screen_busy` too.
- [`settings.js`](../../../../clients/player/src/settings.js): "Who watches" lists the profiles and adds, renames, and removes them; a screen's editor sets "Who watches here".

### The Apple clients

The Apple TV and iPhone and iPad apps speak protocol 2 through YoloKit ([Apple TV client](../../proposed/feature/2026-10-19-apple-tv-client.md), [iPhone and iPad client](../../proposed/feature/2026-10-23-iphone-and-ipad-client.md)):

- [`Sessions.swift`](../../../../clients/apple/YoloKit/Sources/YoloKit/Sessions.swift) keeps the own session and the others' by device id from the welcome, every `state`, and `devices`, with the profiles, as `store.js` does: `continueCandidates()` and "in use" follow the player's rules, `moveTargets` are the other online screens that play, `BusyScreen` reads a `screen_busy` refusal, and `transfer(to:from:replace:)` is `PUT /v1/playback/device`.
- [`AppModel.swift`](../../../../clients/apple/Shared/AppModel.swift), shared by both apps, reconciles only the own session: a `state` or a welcome naming `handedTo` closes the player without a report and resumes nothing, a `deactivate` other than `replaced` is not one, and another screen's `queue` is not shown.
- Both apps' Home starts with "Continue from another screen" (or "Continued on …"), whose first session is warmed; the player's Move to (the TV's transport bar, the phone's top bar) asks on `screen_busy` before it sends `replace: true`.

## Alternatives considered

**Keep one active device and add "Continue here".** Spotify Connect's model, with a faster transfer. It gives the quick resume but not the independent use: the family's TV and the owner's phone still cannot play at once.

**A shared queue with a target screen on each item.** Every screen's end would have to pick its own items from a list the others also edit, and an item without a target would go to whichever screen ended first. The per-screen queue with a shared Watch Later playlist says the same with less.

**Separate Yolo users for family members**, each with a sign-in, sources, and permissions. It opens the one-owner model the whole system rests on: the passkey, the Hub per user, `user_id` on every D1 row, the node's sources. Profiles give households separate histories at a fraction of that, and stay compatible with separate users if they ever come.

**A fixed pair of profiles, the owner and Family.** It costs about the same as a list: the tables, the protocol's `{ id, name }`, and the approval page's question are the same shape. A fixed pair would need a protocol change and a migration for the third person, such as a child with their own history; a list needs a new entry.

**A family flag on the screen instead of a profile on the session.** Viewing on a family screen would never count for the owner, so the owner who continues their episode on the TV after a drive loses that progress, and a second family member's history would need a migration. A profile on the session follows the person through a takeover.

**One Hub per screen.** The takeover row, the bar's session list, and the takeover itself read and change two screens at once; across Durable Objects that is a call per screen and a fan-out per broadcast. One Hub per owner already holds every connection, and per-screen keys cost nothing more.

**Continuing automatically on a new screen**, as Spotify does when an app opens while playback is paused elsewhere. On a family TV that would play the owner's episode to the family. Takeover stays one explicit tap, and the row makes it one.

**The most recently used screen as the agents' default.** It silently picks the wrong screen when two are in use, such as pausing the family's film when the owner meant the phone. Asking costs one turn and only when two of the owner's screens are in use. A queue edit with none in use is the exception: it goes to the owner's screen that played last, since a queued item plays nothing yet and "queue this" with the car parked has no one to ask about.

**Asking on the target screen before Move to** ("Phone wants to play here"). It needs someone at the TV to answer and leaves the sender waiting; the sender's own confirm, with what plays there, is enough for a household.

**Asking before replacing the owner's own session on a named screen.** An agent told "play X on the car" while the car plays the owner's Y means it; asking again costs a turn for nothing. The question is for someone else's viewing.

## Consequences

- Family and the owner watch at once on different screens, each with their own history, continue watching, and track choices, and the owner's agent never touches the family's film without naming the TV.
- Any screen continues another's session in one tap, newly paired screens and a parked car's session included, with the item's tracks, what follows, and the queue.
- **The node carries several streams at once.** Two transcodes, or a transcode and a relay, can exceed a home machine's CPU or Plex's transcode limit. A refusal surfaces on the screen that asked, with its error panel.
- **Per-screen state multiplies the Hub's hardest code**: supersession, the welcome's recovery of a lost `load`, and missed commands are per screen, and the Hub's tests cover two screens playing at once.
- **The same item on two screens of one profile** writes one history row from both; the last report wins, and both show in the takeover row.
- **A family screen's takeover row shows the owner's sessions**, so the family sees what the owner watched in the car. It is what makes the car-to-TV takeover one press.
- **Agents ask more.** With two of the owner's screens in use, a command without a device costs a question.
- **A rollback** to the previous release finds no `state` key and shows nothing playing until a screen plays; it reads every screen's queue rows as one queue, and other profiles' history waits in `profile_history`. The `yolo-upgrade` block in [`CHANGELOG.md`](../../../../CHANGELOG.md) says so.

## Testing

[`screen-sessions.test.js`](../../../../service/control/test/unit/screen-sessions.test.js) proves, over the Hub, the services, and real migrations: the family TV and the owner's phone playing at once with separate histories and an agent's pause reaching only the phone; plays on two screens not superseding each other; a newly paired screen continuing the phone's episode with its subtitles' choice, queue, and run, the phone paused with `handedTo` and not resumed by its welcome; a parked car's session continued on the family TV as the owner's; `screen_busy` and `replace` for a move and a named play; the default rule's `device_ambiguous` and `nothing_playing`; the bar pausing another screen's session; protocol-1 scoping; a third profile's history over `/v1`; and the migration of the old storage. The player's [`store.test.js`](../../../../clients/player/test/unit/store.test.js) covers what the takeover row offers and "in use", and YoloKit's [`SessionsTests.swift`](../../../../clients/apple/YoloKit/Tests/YoloKitTests/SessionsTests.swift) the same rules in Swift. The [conformance kit](../../../../test/conformance/client-protocol.test.js) proves a real client of protocol 2: other screens' sessions offered and their `state` and `queue` leaving its own alone, Continue here as one request, a session continued elsewhere closing and not resumed by the next welcome, and Move to asking on `screen_busy`; both Apple apps pass it in the Simulator.

## Deferred

- **The Apple clients' now-playing bar**: controlling another screen's session from the TV or the phone, with its sheet of every session ([iPhone and iPad client](../../proposed/feature/2026-10-23-iphone-and-ipad-client.md#stages)).
- **Which profiles an account's rows show for**, with account plugins ([site accounts](../../proposed/feature/2026-10-28-site-accounts.md)).
- **A profile tag inside the player** beside the one in the bar, and a profile picker when a screen starts.
- **The next release drops protocol 1.**
