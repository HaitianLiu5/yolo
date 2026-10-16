# Changelog

Each release of Yolo has one section here, newest first. The prose says what changed for an owner; the `yolo-upgrade` block is what `npm run yolo -- upgrade` reads before it asks the owner for approval: the internal protocol, the D1 migrations the release adds, new Worker secrets and node settings, new Cloudflare resources, whether the node restarts, whether a rollback needs the database restored, and the actions only a person can take. The format and the release procedure are in [versions and releases](.agents/notes/implemented/process/2026-10-13-versions-and-releases.md).

## v0.9.1 (2026-10-16)

Three fixes. The car no longer shows "This video can't play right now." near the end of a video whose links Yolo had to renew on the way. YouTube currently limits the captions that the home's public address may download, and it limits its machine-translated captions long before the others; Yolo now waits when YouTube refuses a caption instead of asking again and again, and the notice names the subtitles that did not load. And Bilibili's subtitles now appear when the node has a cookies file of a signed-in Bilibili account (`YTDLP_COOKIES_FILE`). The upgrade needs nothing from you.

### For the owner

- **The end of a video in the car.** After a seek near the end, YouTube can refuse the links Yolo saved for the video, and Yolo renews them. The car reads up to 3½ minutes ahead, and a segment refused during that renewal stayed refused: when playback reached it, the car showed the error panel instead of ending the video and playing the queue's next item. Now the node asks again with the renewed links, and the car asks again for a segment that was refused while it read ahead, so the video plays to its end. When the source refuses the segment that playback itself asks for, the car still shows the error.
- **YouTube's caption limit.** YouTube currently limits how many captions the home's public address may download, and it limits its machine-translated captions, such as Chinese for an English video, long before its other captions. This release does not lift that limit: while it lasts, the limited subtitles do not show. What changes is that Yolo stops making it worse. Before, Yolo asked again at once, nine requests for each refused caption on every new stream, and that kept the limit going until YouTube refused every caption from the home's address. Now, after a site refuses a subtitle this way, the node does not ask the site for that subtitle again until the site's wait is over; when the site names no wait, the node waits a minute, and doubles the wait with each refusal in a row, up to 15 minutes. The player asks once more after that wait, in the background, when the wait is 2 minutes or less. A subtitle that loads on that try shows without a notice. A limited subtitle no longer delays the start of the video.
- **Which subtitle failed.** The notice now names the subtitles that did not load, such as "Chinese (Simplified) (auto) subtitles could not be loaded", instead of "A subtitle could not be loaded" while the other subtitles show. It comes once the player has stopped trying. A Plex subtitle that the node is still taking out of the video file gets the same second try, 5 seconds later; before, the player gave up on it after about a second.
- **Bilibili's subtitles.** yt-dlp lists Bilibili's subtitles only when it is asked for them, and Yolo did not ask, so no Bilibili video had subtitles in Yolo. Yolo now asks. Bilibili's AI subtitles count as automatic captions in their language, so a saved Chinese preference now matches them. Bilibili gives its subtitles only to a signed-in account: to get them, set `YTDLP_COOKIES_FILE` in the node's `.env` (or the yt-dlp plugin's `cookiesFile` option in `yolo.config.json`) to a cookies file of a signed-in Bilibili account, and restart the node (`npm run yolo -- service restart node`). A cookies file takes the place of `YTDLP_COOKIES_FROM_BROWSER` for every site that yt-dlp opens, so if you use that setting, put the other sites' cookies in the same file. Without a signed-in account's cookies, Bilibili videos still have no subtitles, and the node's log says that Bilibili's subtitles need a login. A video whose title says 中字 may have its Chinese subtitles in the picture instead.
- **Reload screens that stay open.** A screen keeps the player it loaded. The node's half of the end-of-video fix, and its wait for a limited subtitle, work without a reload. The car's half of the fix, the player's second try, and the notice that names subtitles come when the page loads again. Settings > About shows the player's version on the row named Yolo.

### For the operator

- **Upgrade order**, which `npm run yolo -- upgrade` follows: back up D1, restart the node, deploy the Worker, then run `doctor`. There are no migrations to apply.
- **The node restarts, and its code changed**: the media pipeline and the yt-dlp plugin. The Worker's own code did not change; deploying it brings the new player, which its static assets carry. `upgrade` waits for the node to report 0.9.1, then requires `doctor` to find 0.9.1 on both the Worker and the node.
- **The internal protocol stays 1.** No request or response shape in `/internal/v1` changed. The node's new `429` with `Retry-After` is on `/m/*`, the media path between the node and the screen, which the Worker's relay passes through unchanged. One `/internal/v1` answer changes its code: when the site limits a subtitle, `/internal/v1/transcript` now answers `rate_limited` (429) with `details.retryAfter`, where 0.9.0 answered `internal` (500). The error body keeps its shape, and the 0.9.0 Worker already knows `rate_limited`, so with either Worker an agent's transcript gets a retryable `rate_limited` that says when to try again.
- **Mixed versions work.** A 0.9.0 player with the 0.9.1 node gets `429` with `Retry-After` for a subtitle the site limits. It retries twice at once, as before, and the node answers those retries from its wait without asking the site; the page then shows "A subtitle could not be loaded". A 0.9.1 player with a 0.9.0 node gets `500` for such a subtitle, as before, and names the subtitle in its notice; the 0.9.0 node still asks the site nine times for it. A `425` with `Retry-After`, which both nodes send for a subtitle still being prepared, gets the 0.9.1 player's second try.
- **Every Bilibili play now starts a second yt-dlp run**, the one that asks for subtitles, alongside the formats' run; before, only the danmaku started it. The danmaku shares that run, and its warnings about subtitles go to the node's log.
- **Rollback** runs the Worker first, then the node, and needs no D1 restore. The 0.9.0 node lists no Bilibili subtitles and asks the site again at once for a limited subtitle.

### For contributors

- `createYtdlp()`'s `danmaku(url)` is now `subtitled(url, { onWarning })`, the run that asks for subtitles, shared by the danmaku and Bilibili's subtitle list. `requestBytes()` takes `retryStatus`. `clients/player/src/subtitle-loading.js` decides the second round and the notice. A subtitle source may throw `rate_limited` with `details.retryAfter`, which the node answers `429` with `Retry-After`; the plugin API's JSDoc says so.
- [A refused read-ahead is not the end of a stream](.agents/notes/implemented/bug-fix/2026-10-16-refused-read-ahead.md) records why only playback's own refused request ends a stream in the car.
- New tests: the node asks again with links a refresh replaced, a subtitle limit answers `429` with `Retry-After`, the yt-dlp plugin's subtitle wait and Bilibili's subtitles, the HLS prefetcher's refused read-ahead, the subtitle notice, and `test/e2e/ytdlp-playback.test.js`, which plays separate audio and video files to their end in the car and the web profile, with and without a queue item, with refused links in the car, and with a limited subtitle. The Bilibili test runs a stand-in for yt-dlp; nothing calls YouTube or Bilibili.

### Migrations

None. Rolling back needs no D1 restore.

### New secrets and settings

None: no new Worker secrets, node `.env` settings, or Cloudflare resources. Bilibili's subtitles use `YTDLP_COOKIES_FILE`, an optional setting that 0.9.0's `.env.example` already lists, so the block does not list it; `.env.example` now names Bilibili's subtitles beside it.

### Human actions

None for the upgrade. A cookies file of a signed-in Bilibili account is optional, and only for Bilibili's subtitles. Reloading screens that stay open is recommended, not required.

### Names

This release renames and removes no names. `createYtdlp()`'s `danmaku` → `subtitled` is inside the yt-dlp plugin, which upgrades with the node.

```yolo-upgrade
{
  "protocol": 1,
  "migrations": [],
  "secrets": [],
  "settings": [],
  "resources": [],
  "node": "restart",
  "rollback": "code",
  "human": []
}
```

## v0.9.0 (2026-10-14)

A screen whose connection to Yolo died without either side noticing now catches up when it reconnects: a pause, resume, seek, subtitle switch, or danmaku change that went into the dead connection takes effect then, once. A missed resume does not overrule your own pause or Back on the screen meanwhile, and a missed seek or danmaku change does not overrule your own seek or danmaku setting there. A pause or Back that you made on such a screen also holds when the page loads again before it reconnects, and a page that loads again keeps an item paused at its end paused instead of starting the queue's next item. `doctor` now knows Workers Paid. This release also removes old names that earlier releases kept after renaming them. If your instance uses a domain and its Worker still holds the DNS token only under its name from before 0.5.0, `LAN_DNS_TOKEN`, store it as `MEDIA_DNS_TOKEN` before you upgrade (see Names). Otherwise you need to do nothing.

### For the owner

- **Commands reach the screen after a reconnect.** A screen's connection to Yolo can die without the screen or Yolo noticing, for example when a car loses signal or sleeps. An agent's or a remote's pause, resume, or seek, a switch of text subtitles, or an agent's danmaku change sent then went into that connection: Yolo said it worked, and the screen went on as before. Now the screen does what it missed when it reconnects, once. A missed resume or seek does not overrule what you did on the screen after its connection died: a missed resume does not start playback when you paused there or went Back, and a missed seek does not undo a seek you made there. A missed pause always goes, since it starts nothing. A danmaku change that Yolo sends again does not undo a danmaku setting you changed there, unless the page was loaded again since.
- **An agent's play, then its resume.** When an agent's play of another item went into a dead connection and the agent's resume came over the new one, the screen no longer plays the item still on screen while it switches to the agent's item.
- **A pause you made stays.** When you pause on a screen whose connection has died, and the page loads again before it reconnects, as after a reload or a car's wake, the item now comes back paused where you paused it. Before, Yolo still had the item playing, and the page played it on.
- **The queue and Back.** When the screen's own "ended", or its Back from a player it could not keep, went into a dead connection, Yolo now hears it after the reconnect: the queue plays its next item, or the item you left stays paused in the now-playing bar. Before, the queue stopped there, or the item played on. When the dead connection also took a pause or a seek from Yolo, the screen does that instead, and the next item does not play. An item you left with Back stays paused also when the page loads again in the same tab before it reconnects.
- **An item paused at its end stays paused.** When a page that loads again finds its item paused within the last second, it now loads the item paused 3 seconds before the end. Before, it told Yolo the item had ended, and the queue's next item started playing. An item that was playing to its end still goes on to the next. What this gives up: when the screen's own "ended" went into a dead connection and the page loads again before it reconnects, Yolo has the item paused at its end, so the queue's next item now waits for you.
- **An item Yolo loads paused stays paused.** When Yolo loads an item paused, such as one a page brings back paused, and the connection drops before the screen reports, the item now stays paused when the screen comes back. Before, Yolo counted it as playing, and the screen played it.
- **`doctor` knows Workers Paid.** It reads the account's plan from the account's entitlements. On Workers Paid, which has no daily limits, `cloudflare.limits` is now information instead of a warning against Workers Free's limits. When `doctor` cannot read the plan, the warning stays, and its fix says why and how to let `doctor` read the plan, instead of telling you to ignore it on Workers Paid.
- **Reload screens that stay open.** A screen keeps the player it loaded, so a screen left open, such as the car's browser, gets most of these fixes only after it loads the page again. A page loaded with 0.7.0 or later keeps working until then. Two fixes need no reload, because Yolo makes them: an item Yolo loads paused stays paused, and an agent's danmaku change that the screen never acknowledged comes again after a reconnect. An older page applies that change whole, so it can undo a danmaku setting you changed on that screen meanwhile. A page loaded before 0.7.0, or before 0.5.0, loses more until it loads again: see Names. Settings > About shows the player's version on the row named Yolo.

### For the operator

- **Upgrade order**, which `npm run yolo -- upgrade` follows: back up D1, restart the node, deploy the Worker, then run `doctor`. There are no migrations to apply. On an instance on a domain whose Worker holds the DNS token only as `LAN_DNS_TOKEN`, first store it as `MEDIA_DNS_TOKEN` (Names).
- **The node restarts, and its code changed.** Its LAN listener no longer answers `/lan/probe`, the probe's path before 0.5.0. `upgrade` waits for the node to report 0.9.0, then requires `doctor` to find 0.9.0 on both the Worker and the node.
- **The internal protocol stays 1.** Nothing in `/internal/v1` changed. `/lan/probe` was on the node's LAN media listener, not in `/internal/v1`, and only player pages from before 0.5.0 asked for it: the 0.8.0 Worker's outside check of the remote listener and the 0.8.0 player's probes use `/edge/probe`, which both nodes answer. Both Workers send the node the path names `lan`, `wan`, and `relay`, and the node still takes any other name as the relay. A 0.8.0 Worker with a 0.9.0 node, and the reverse, play as before.
- **The realtime messages gain fields.** The welcome carries `commands`, `{ sessionId, playback?: { id, action }, seek?: { id, position } }`: the last pause or resume and the last seek the Hub sent the screen for the stream its `state` names. `pause`, `resume`, and `seek` carry `sessionId`, the stream they are for. A danmaku change that the Hub sends again right after a welcome, because the screen never acknowledged it, carries `again: true`. The Hub takes the next queue item once per stream: an `ended` that arrives while it is still taking the next item for the same stream is ignored. A `load` with `autoplay: false` now sets the state `paused` from the start; before, it was `loading` until the screen's first report. The welcome no longer carries `lan`, and neither it nor the `media` message carries the boolean `relay` (Names).
- **Two new entries per device in the Hub's Durable Object storage**: `commands:<deviceId>`, the last pause or resume and seek for the device's current stream, and `danmaku:<deviceId>`, the agents' danmaku changes the screen has not acknowledged, removed on its `ack`. Both are deleted when the device is removed. There are no new bindings.
- **A 0.8.0 player page left open keeps working with the 0.9.0 Hub.** It ignores `commands`, `sessionId`, and `again`, so it does what 0.8.0 did when a dead connection took a command: nothing. It acknowledges every command as before, so the Hub sends a danmaku change again only when the acknowledgement was lost, and the page then applies it whole. `paused` is a status it already reads: for a stream loaded paused, its now-playing bar shows the item paused, and a reconnect before the screen reports keeps the item paused, where `loading` made it play. Reloading the page brings the rest.
- **Rollback** runs the Worker first, then the node, and needs no D1 restore. The 0.8.0 Hub reads its Durable Object storage only by the keys it knows and never lists it, so it ignores `commands:` and `danmaku:`. They stay; if the instance upgrades again later, a danmaku change that was unacknowledged at the rollback goes to its screen once more. `paused` is a status 0.8.0 reads, so the states 0.9.0 wrote need nothing. The 0.8.0 Worker reads `MEDIA_DNS_TOKEN` first, so a token stored under that name keeps working.
- **A 0.9.0 player page left open after a rollback** ignores the 0.8.0 welcome's `lan` and `relay` and reads `media.paths` and `relayMode`, which 0.8.0 sends. After a reconnect it still follows text subtitles and says `ended` and `idle` again, but makes up for no missed pause, resume, or seek, because the 0.8.0 welcome names none. A reload loads the 0.8.0 player, which does not read the pause or Back that the 0.9.0 page kept in the tab. The 0.8.0 Hub takes every `ended` it gets: it takes two queue items only when the first `ended` reached it but the answer to the page's ping after it was lost, and the page's second `ended` arrived while the Hub was still starting the next item. It also counts a stream loaded paused as playing until the screen reports, as 0.8.0 always did.

### For contributors

- `clients/player/src/missed-commands.js` decides what a welcome says the screen never heard, and `realtime.confirm()` pings over the welcomed connection and calls back on the answer; the heartbeat still sends `HEARTBEAT_PING` exactly. "What a dead connection takes" in the [Hub and realtime channel](.agents/notes/implemented/architecture/2026-10-07-hub-and-realtime-channel.md) note has the rules.
- New tests. Car e2e tests lose a pause, a resume, a seek, a kept player's resume and seek, a subtitle switch, a danmaku change, an `ended`, and a plain `idle` in a dead socket, hold a new connection's welcome while the owner pauses, and reload pages that paused or went Back unheard or whose item is paused at its end; a web e2e test, in Chromium and WebKit, loses a pause and a seek. Unit tests cover the Hub's `commands`, the danmaku changes sent again, one `ended` per stream, `missed-commands.js`, `realtime.confirm()`, the resume decision, the plan read from the entitlements, and the removed names. Nothing calls Cloudflare.

### Migrations

None. Rolling back needs no D1 restore.

### New secrets and settings

- No new Worker secrets. The block lists `MEDIA_DNS_TOKEN`, the DNS token's name since v0.5.0, for one case only: an instance on a domain whose Worker holds the token only as `LAN_DNS_TOKEN` (Names). `npm run wrangler -- secret list` shows the Worker's secret names. The 0.8.0 `doctor` does not warn about this case; the 0.9.0 `doctor` does (`cloudflare.media-dns`).
- No new node `.env` settings and no new Cloudflare resources.

### Human actions

None for the upgrade, unless the Worker holds the DNS token only as `LAN_DNS_TOKEN`: then storing it as `MEDIA_DNS_TOKEN` needs the owner to paste the token in their own terminal, or, for a new token, possibly to approve `cf`'s sign-in page (Names). Reloading screens that stay open is recommended, not required.

### Names

This release renames nothing. It removes old names that earlier releases kept after renaming them. v0.6.0 should have removed the names that v0.5.0 renamed, and v0.8.0 the relay's switch that v0.7.0 replaced with modes, but v0.8.0 still accepted them all:

- `LAN_DNS_TOKEN` → `MEDIA_DNS_TOKEN`. The Worker reads only `MEDIA_DNS_TOKEN`. On an instance on a domain whose Worker has the token only as `LAN_DNS_TOKEN`, the 0.9.0 Worker stops looking after the node's media names: it renews no certificate and moves no record when the node's LAN address or the home's public address changes, settings show LAN and remote direct play as off, and `doctor` warns. Screens keep direct play by name only until a certificate expires or an address changes. Before the upgrade, store the token as `MEDIA_DNS_TOKEN`: the same token with `npm run wrangler -- secret put MEDIA_DNS_TOKEN`, or a new one with `npm run yolo -- provision media-dns`. The 0.8.0 Worker already reads `MEDIA_DNS_TOKEN` first. Then delete the old name with `npm run wrangler -- secret delete LAN_DNS_TOKEN`.
- The welcome's `lan` → `media.paths`; `/lan/probe` → `/edge/probe`; the path name `tunnel` → `relay`; `/v1/owner/lan` and `/v1/owner/lan/check` → `/v1/owner/media` and `/v1/owner/media/check`. Only a player page loaded before v0.5.0 and never reloaded since used these names. Such a page now finds no LAN path and plays through the relay, or, with the relay Off, gets `media_unreachable`. Its settings no longer show LAN direct play's state. Reloading the page ends this.
- The relay's switch from before v0.7.0: the boolean `relay` in the welcome and the `media` message → `relayMode`, and `relay: true` or `false` in `PATCH /v1/owner/media` → `"on"` or `"off"`, which is now refused with `invalid_request`. Only a player page loaded before v0.7.0 and never reloaded since used these forms. Such a page now takes the relay as on: with the relay Off, the Hub still refuses its relay streams with `media_unreachable`. Its settings can no longer change the relay. Reloading the page ends this. `GET /v1/owner/media` keeps `relay.on`, and D1 keeps the `relay` column, which 0.8.0 reads after a rollback.

```yolo-upgrade
{
  "protocol": 1,
  "migrations": [],
  "secrets": [
    { "name": "MEDIA_DNS_TOKEN", "required": false, "how": "Only for an instance on a domain whose Worker holds the zone's DNS token only as LAN_DNS_TOKEN, its name before 0.5.0; npm run wrangler -- secret list shows the Worker's secret names. Every other instance skips this. Before the upgrade, store the token as MEDIA_DNS_TOKEN, which the 0.8.0 Worker already reads first: the same token with npm run wrangler -- secret put MEDIA_DNS_TOKEN, which the owner pastes in their own terminal and never into a chat, or a new one with npm run yolo -- provision media-dns. Then npm run wrangler -- secret delete LAN_DNS_TOKEN. Without it, the 0.9.0 Worker renews no certificate for the media names and follows no address change, so LAN and remote direct play by name end when a certificate expires or an address changes; the 0.9.0 doctor then warns on cloudflare.media-dns." }
  ],
  "settings": [],
  "resources": [],
  "node": "restart",
  "rollback": "code",
  "human": []
}
```

## v0.8.0 (2026-10-14)

The home screen and search look ready sooner. A screen whose connection to Yolo drops now gets back the quality changes and agents' plays that the drop lost, and of several seeks in a row, the last one wins. An instance without a domain can now take a free name from deSEC for direct play at home and away. If your instance uses a domain at Cloudflare, you need to do nothing.

### For the owner

- **Home and search look ready sooner.** While a cover loads, its card shows a placeholder in the card's shape instead of an empty box, and the picture fades in over it. The home screen's first load, a search, and a show's episodes show placeholder cards of the real cards' size while their rows load, and the items replace them in place. Before, the home screen said "Connecting…" until every row had its items. The placeholder cards pulse gently, except in the car and where the system asks for reduced motion. Until Yolo welcomes the screen, it still says "Connecting…".
- **Plays recover after a dropped connection.** When a screen's connection to Yolo drops and comes back, the screen now compares the stream it plays with the one Yolo has for it. If a quality change, a recovery, or an agent's play on that screen was lost with the old connection, the screen asks for that stream again and keeps its picture under the spinner meanwhile. Before, it played on into a stream the home node had already stopped, and an agent's new item never showed; 0.7.1 fixed this for seeks only. When Yolo turns down a screen's request because another stream won, the screen also checks its connection at once, since the winning stream comes over it; a dead connection is then replaced within seconds instead of after 70 seconds without traffic.
- **The last seek wins.** Seeking again while an earlier seek's stream is loading now ends where you, or an agent, sought last. Before, playback could start at the first seek's place, or jump back to it.
- **Two windows of one screen.** When two windows of the same screen reconnect at the same moment, only one of them plays, and the other shows "Yolo is open in another window" with a button to take over. Before, both could act: one could rebuild the stream the other played, or go home with an error.
- **With a domain at Cloudflare, you need to do nothing.** Your media names stay in your zone with `MEDIA_DNS_TOKEN`, as before. The same is true on workers.dev if you do not choose deSEC.
- **Reload screens that stay open.** A screen keeps the player it loaded, so a screen left open, such as the car's browser, gets the placeholders and these recoveries only after it loads the page again. Until then it keeps working. Settings > About shows the player's version on the row named Yolo.

### A free deSEC name instead of a domain (optional)

An instance on workers.dev can now put the home node's media names under a free `<name>.dedyn.io` from deSEC (desec.io). That gives it what a domain gives: LAN direct play in every browser, and remote direct play by name without the router's port 80. Yolo's own address stays on workers.dev, and a domain at Cloudflare stays the recommended path.

If you choose deSEC, your agent walks you through it with the [`yolo-deploy`](skills/yolo-deploy/SKILL.md) skill, but these steps are yours:

1. Sign up at desec.io with a free `<name>.dedyn.io`, and confirm the email deSEC sends.
2. Create a token in deSEC's Token Management and copy it at once: deSEC shows it only once.
3. Run `npm run yolo -- provision media-dns --token-stdin` in your own terminal and paste the token there, never into a chat. Yolo checks it with deSEC and stores it without showing it.
4. As with a domain, turn on "Play over the home network" on each screen and allow the browser's Local Network prompt. If your router blocks DNS answers that hold private addresses (DNS rebinding protection), allow `<name>.dedyn.io` there.

What you accept with it: your direct play then depends on deSEC, because each certificate renewal and each change of your home's address goes through deSEC's API. The token can change every record in your deSEC account. The node's private address and your home's public address become public in DNS under your name. Each certificate takes about 4 minutes, and only the cron run every 5 minutes orders one, so the LAN name gets its certificate within about 10 minutes of the deploy, and the remote name 5 minutes later. Until then, "Check now" in settings shows them as pending.

**Not yet verified with a real deSEC account.** The deSEC plugin has been tested only against a stand-in for deSEC's API, built from deSEC's documentation and source. Signing up, the token check, the records, and a Let's Encrypt certificate through deSEC's nameservers have not been tried end to end. deSEC also does not say whether it limits requests from Cloudflare Workers' addresses.

### For the operator

- **Upgrade order**, which `npm run yolo -- upgrade` follows: back up D1, restart the node, deploy the Worker, then run `doctor`. There are no migrations to apply.
- **The node restarts, though no node code changed.** The changes are in the player, the Worker, the operator's commands, and a new plugin. The node reads its version when it starts, and `upgrade` waits for it to report 0.8.0, then requires `doctor` to find 0.8.0 on both the Worker and the node. The deSEC plugin has only a control entry, so the node loads the same plugins whether or not an instance chooses it.
- **The internal protocol stays 1.** Nothing in `/internal/v1` changed: the Worker sends the node the same requests, and a name under deSEC is just another name to the node. A 0.7.1 Worker with a 0.8.0 node, and the reverse, play as before.
- **The realtime messages are unchanged, but their order can differ.** The Hub now sets its state as soon as a `load` goes out, and makes a connection the device's before it reads the welcome. The welcome therefore names every `load` sent before, and a `load` or `state` sent after can reach the screen just before its welcome. A window that another window of the same device replaces while its hello is answered gets no welcome, only `deactivate`. A hello that fails after the connection became the device's closes it with 1011, and the page reconnects with its backoff.
- **A 0.7.1 player page left open keeps working with the 0.8.0 Hub.** It acts on a `load` or `state` without waiting for the welcome, shows "Yolo is open in another window" on `deactivate`, and reconnects after any close but 4003. Its realtime connection code is the same as 0.8.0's, and it still sends `HEARTBEAT_PING` exactly. One case costs a little: when a `load` arrives just before the welcome while the page's old player is still going away, the 0.7.1 page asks Yolo for that stream once more, so the node prepares it twice and the screen restarts it once, without an error. The 0.7.1 Hub lost such a `load` altogether. Reloading the page ends this.
- **One certificate order per cron run, on every instance.** The cron run now orders at most one certificate and holds a lease in KV, `yolo:edge:lease`, while it does. The lease is written only when an order starts, deleted when the run ends, and expires by itself after 15 minutes: one KV write and one delete per order. While another run holds it, a run chooses no new name and orders nothing, but still applies the remote-access switch and keeps existing records current. When both names need a certificate in the same run, as on a first setup, the remote name now gets its certificate one run, 5 minutes, after the LAN name. This holds for Cloudflare zones too.
- **Turning remote access off closes the node's remote listener first**, then removes the remote name's DNS records at best effort. A failed removal no longer keeps the listener open: the logs show `records_left`, and a later run tries again after 30 minutes, doubling up to a day. This holds for Cloudflare zones too.
- **A play whose history entry cannot be written now plays**, and the Hub logs `history_write_failed`; the item is then missing from history. Before, the play failed although its stream had already gone to the screen.
- **New Worker vars**, `MEDIA_DNS_PROVIDER` (default `cloudflare`) and `MEDIA_DNS_ZONE` (default empty), which `npm run yolo -- deploy` renders from the instance file's new `media.dns` (`{ "provider": "cloudflare", "zone": null }` by default). An instance file without `media.dns` gets these defaults and keeps its media names as before, so nothing needs to be added. When `media.dns` names a DNS provider plugin, `media.wan.certificate` defaults to `name`, also on workers.dev; set it to `ip` to keep the remote listener on the home's address.
- **Setting up deSEC.** `npm run yolo -- provision media-dns --provider desec --zone <name>.dedyn.io` records `media.dns` and prints the owner's steps. On an instance that loads the official plugin list, it writes a `yolo.config.json` with the official plugins and then `./plugins/dns-desec`. It never changes an owner's own `yolo.config.json`; it names the entry to add there instead. From then on the instance loads its plugins from that file, so an official plugin that a later release adds reaches it only once it is listed there too. `--token-stdin` reads the token without echo, checks it with one read at deSEC, and stores it as the Worker secret `DESEC_TOKEN` without printing it; `--rotate --token-stdin` replaces it. Then `npm run yolo -- deploy` bundles the plugin and sets the vars. New `doctor` checks run only when `media.dns` names a plugin's provider: `config.media-dns`, `cloudflare.media-dns`, `dns.delegation`, and `worker.media-dns`. [DNS provider plugins](.agents/notes/implemented/architecture/2026-10-14-dns-provider-plugins.md) has the design.
- **Rollback** runs the Worker first, then the node, and needs no D1 restore. The 0.7.1 Worker never reads `yolo:edge:lease`, which expires within 15 minutes. On an instance with a Cloudflare domain, the LAN and remote state in KV (`yolo:lan`, `yolo:wan`) keeps the shape 0.7.1 reads: 0.8.0 writes no `dns` field there, and 0.7.1 ignores the only new fields, the retry of records left behind. On an instance that chose deSEC, 0.7.1 ignores the `dns` field in that state and has no DNS provider plugins, so nothing renews the deSEC names' certificates or updates their records. Screens keep LAN direct play by the deSEC name until that certificate expires or the node's LAN address changes. On workers.dev, remote direct play goes back to a certificate for the home's address, with its port 80 check. The records stay at deSEC. 0.7.1's node and `doctor` report `./plugins/dns-desec` in `yolo.config.json` as a failed plugin; the node runs on, and removing that entry clears the report.

### For contributors

- A control entry can register a DNS provider with `yolo.registerDnsProvider(id, { title, secret, create })`, and a DNS provider plugin's `package.json` may name a `yolo.setup` module, which `provision media-dns` and `doctor` import on the owner's machine. The secret's name must start with the provider's id and be none of the Worker's own names. `@useyolo/dns-desec` is the first such plugin; it is official but not in `plugins/official.json`.
- `scripts/provider-names.test.js`: a provider name spelled with a hyphen or underscore between its letters (`yt-dlp`, `YT_DLP_PATH`) now counts only as a whole word; a name spelled whole still counts anywhere in a line. Without this, `desec` matched the `DE_SEC` inside `NODE_SECRET`.
- The lockfile resolves `proxy-addr` 2.0.8 for GHSA-jqcg-44mw-7w3h. Yolo was not exposed: `proxy-addr` comes in only through `express`, which the MCP SDK 1.x needs; it is not bundled into the Worker, and nothing in Yolo loads it at runtime.
- A new proposal, [showing what Spotify plays, with lyrics](.agents/notes/proposed/feature/2026-10-14-spotify-now-playing.md), records its policy and technical limits. It changes no code.
- New tests. Car and web e2e tests lose the `load` of a quality change and of an agent's play with the realtime socket, seek again while a seek's stream loads, deliver a welcome right behind the `load` it names, and rewrite a welcome to name an older stream. Hub unit tests answer a hello during a play, and a hello whose connection another window replaces. Edge tests run a stand-in DNS provider plugin, the lease, and the one-order runs. The deSEC plugin's tests run against a stand-in for deSEC's API. Nothing calls deSEC, Let's Encrypt, or Cloudflare.

### Migrations

None. Rolling back needs no D1 restore.

### New secrets and settings

- `DESEC_TOKEN`, a new optional Worker secret, only for an instance that chooses a deSEC name. The owner stores it from their own terminal with `npm run yolo -- provision media-dns --token-stdin`.
- New Worker vars, `MEDIA_DNS_PROVIDER` and `MEDIA_DNS_ZONE`, which `deploy` renders from `media.dns`. Existing instances need nothing for them.
- No new node `.env` settings and no new Cloudflare resources. The lease is a key in the existing KV namespace.

### Human actions

None for the upgrade. Choosing a deSEC name is optional; its steps at desec.io and the token are the owner's, as listed above. Reloading screens that stay open is recommended, not required.

### Names

This release renames and removes no names. The names renamed in v0.5.0 (`LAN_DNS_TOKEN`, the welcome's `lan`, `/lan/probe`, the path name `tunnel`, and `/v1/owner/lan`) are still accepted; a later release removes them.

```yolo-upgrade
{
  "protocol": 1,
  "migrations": [],
  "secrets": [
    { "name": "DESEC_TOKEN", "required": false, "how": "Only for an instance that chooses a free deSEC name for its media listeners (media.dns.provider \"desec\"); an instance on a Cloudflare domain, or one that stays on workers.dev without deSEC, skips it. The agent runs npm run yolo -- provision media-dns --provider desec --zone <name>.dedyn.io, which prints the owner's steps at desec.io. The owner creates the token in deSEC's Token Management and runs npm run yolo -- provision media-dns --token-stdin in their own terminal, pasting the token there and never into a chat; it is checked with deSEC and stored without being shown. Then the agent runs npm run yolo -- deploy and npm run yolo -- doctor." }
  ],
  "settings": [],
  "resources": [
    "Two Worker vars, MEDIA_DNS_PROVIDER (default \"cloudflare\") and MEDIA_DNS_ZONE (default empty), which npm run yolo -- deploy renders from the instance file's media.dns. An instance file without media.dns gets the defaults and keeps its media names as before, so nothing needs to be provisioned or set."
  ],
  "node": "restart",
  "rollback": "code",
  "human": []
}
```

## v0.7.1 (2026-10-14)

Two fixes in the player. After a seek, a track change, or a quality change, the progress bar no longer stays marked as seeking while the video plays, so the controls hide again. And a seek no longer waits forever when the screen's connection to Yolo drops while Yolo prepares the stream for it.

### For the owner

- **The controls hide again after a seek, a track change, or a quality change.** Some seeks, track changes, and quality changes make the player load a new stream of the same video. Until that stream shows its first picture, a pulsing ring around the progress bar's dot takes the place of the spinner. Before this release, the new stream kept that ring for as long as it played: each time it paused to load more video, the ring came back instead of the spinner and stayed after the video played on, and the controls, which stay up while a seek is in progress, never hid. This lasted until the player loaded another stream. Now, once the first picture shows, the stream behaves like any other: a pause to load shows the spinner, which goes away when the video plays on, and the controls hide as usual. It happened in the car and in browsers. Quality changes can happen without a tap, because the player changes the quality by itself, for example lowering it after a stall on a slow connection.
- **A seek no longer gets stuck when the connection drops.** A seek to a point before where the current stream begins, such as before the start of a transcode that began part way through the video, pauses the player while Yolo prepares a new stream. If the screen's connection to Yolo dropped during that time, the new stream never reached the screen, and the screen stayed paused with the seek ring and its controls up, with no end. Now the screen asks for that stream again when it reconnects. If the stream has not arrived 10 seconds after Yolo prepared it, the screen checks its connection and, if the connection is dead, replaces it and asks again; while the connection is down, the seek waits. If the connection answers and the stream still does not arrive within another 10 seconds, the seek ends with "Couldn't skip there. Try again." This covers seeks only: a quality change, a track change, or an agent's play whose stream is lost the same way is not fixed yet.
- A screen keeps the player it loaded, so it gets these fixes the next time it loads the page. Settings > About shows the player's version on the row named Yolo.

### For the operator

- **Upgrade order**, which `npm run yolo -- upgrade` follows: back up D1, restart the node, deploy the Worker, then run `doctor`. There are no migrations to apply.
- **The node restarts, though no node code changed.** The fixes are in the player, which the Worker serves. The node reads its version when it starts, and `upgrade` waits for it to report 0.7.1, then requires `doctor` to find 0.7.1 on both the Worker and the node.
- **The internal protocol stays 1.** Nothing in the node's internal API changed, so a 0.7.0 Worker with a 0.7.1 node, and the reverse, play as before. The realtime messages did not change either: a screen asks again for a seek's stream with the stream request it already uses.
- **Rollback** runs the Worker first, then the node, and needs no D1 restore.

### For contributors

- `npm run check`, and CI's `check:core`, now fail when a tracked file under `service/` names a provider. `scripts/provider-names.test.js` takes the names from the plugins under `plugins/`; only the 0001 and 0003 migrations and the migration test that converts 0.1 rows may name one. AGENTS.md stated the rule before, but nothing enforced it.
- The device-login test in `ops/test/auth.test.js` no longer fails now and then with "Unexpected end of JSON input": its fake `cf` now writes its state to a new file and renames it into place.
- New e2e tests, in the car and in the web profile's `<video>` engine: one holds a stream's video fragments after a seek built it and checks that the stall shows the spinner and that no seek mark stays once the video plays on; another drops the `load` of a seek's stream, closes the realtime socket (in the car, also leaves one silent as a connection that died unnoticed), and checks that the seek's stream plays after the reconnect.

### Migrations

None. Rolling back needs no D1 restore.

### New secrets and settings

None: no new Worker secrets, node `.env` settings, or Cloudflare resources.

### Human actions

None.

### Names

This release renames and removes no names. The names renamed in v0.5.0 (`LAN_DNS_TOKEN`, the welcome's `lan`, `/lan/probe`, the path name `tunnel`, and `/v1/owner/lan`) are still accepted; a later release removes them.

```yolo-upgrade
{
  "protocol": 1,
  "migrations": [],
  "secrets": [],
  "settings": [],
  "resources": [],
  "node": "restart",
  "rollback": "code",
  "human": []
}
```

## v0.7.0 (2026-10-14)

Videos start sooner, the player works like the YouTube app on a touch screen, and Back keeps a video ready to go on where it stopped. A screen that cannot reach the home node directly now plays through the relay instead of showing an error, unless the owner turned the relay off.

### For the owner

- **The relay is now the automatic fallback.** Settings > Your Yolo > Media paths > Relay through Cloudflare has three choices. Automatic, the default, sends a screen's media through your Cloudflare account only when no direct path from the home node works for that screen. On keeps the relay as the last path, as the old switch did. Off never relays. The upgrade keeps the relay On where it was on and Off where you turned it off yourself, and sets everyone else to Automatic. So if you never turned the relay on, media can now go through your Cloudflare account when no direct path works: look at the setting after the upgrade, and choose Off if you do not want that. A change of mode no longer asks for confirmation, and connected screens follow it at once. The card also shows the path each screen used last and how many streams took the relay in the last 7 days. With the relay Off, a screen that no path reaches says why and what fixes it, with a button that sets the relay to Automatic.
- **Faster starts.** The car's player starts once 3 seconds of video are buffered, instead of 15. Unless the relay is Off, a play no longer waits out checks of media paths that do not answer: a screen remembers what worked on each network, and on a new network it waits at most a second. For web links (the yt-dlp plugin), the home screen has the node look up its first three history items ahead, and the plugin reuses a lookup while its links stay valid, so a replay, a retry, or a recovery does not run yt-dlp again. In the maintainers' measurements, a Bilibili video tapped from history played after about 4 seconds instead of 12 on the web, and about 6 instead of 21 in the car. The costs: up to three yt-dlp lookups on the home machine for each home screen whose items are not looked up yet, and, on a connection that barely carries the stream, one early stall before the quality steps down.
- **While a video loads**, the screen shows its picture under a small spinner. Only after 8 seconds does one line say "Connecting to the home server…" or "Still loading…".
- **Touch controls like the YouTube app**, in the car and on phones. A tap shows the controls; another tap, or 3 seconds of playing, hides them; a tap never pauses by itself. Double-tap the left or right third of the picture to seek 10 seconds, swipe down to go back, and use the new previous and next buttons (previous when history has an earlier item, next when the queue has one). Outside the car, press and hold plays at twice the speed; in the car, a long press stays a tap. With a keyboard, Space or K, J and L, the arrow keys, F, and M work as on YouTube. The controls now fade after a tap on a menu or a button, and the audio button shows only when there is more than one track to choose.
- **Back keeps the video.** Back pauses and hides the player instead of stopping it. A tap on the now-playing bar, or a resume from a remote or an agent, goes on at once from the same place without loading again, and the bar shows the paused frame. The home node keeps that video's stream open until another video plays, the video is stopped or moved to another screen, or the page closes.
- **Danmaku looks and moves like Bilibili's own player:** in the top quarter of the picture, in smaller text with a thin outline, with comments entering one at a time, and, at normal density, without the comments Bilibili ranks low. A screen that never changed its danmaku settings takes the new defaults; settings chosen on a screen stay.
- **iPhone.** The fullscreen button opens the iPhone's own fullscreen player, with the selected subtitles; danmaku does not show there. Add to Home Screen opens Yolo without the browser's bars. It pairs as a screen of its own, because iOS keeps a home-screen app's storage apart from Safari's.
- Agents' `get_frame` and `get_storyboard` now read HLS videos on a node whose ffmpeg is older than 7, such as Ubuntu 24.04's 6.1, where they answered "No frame could be read". In the car, the picture and sound of fMP4 HLS, such as the node's own transcodes, now play in sync; they were up to 45 ms apart.

### For the operator

- **Upgrade order**, which `npm run yolo -- upgrade` follows: back up D1, apply migration 0008, restart the node, deploy the Worker, then run `doctor`. Between the migration and the deploy, the 0.6 Worker already relays for owners the migration made Automatic, as the last path their screens try.
- **The internal protocol stays 1.** The node's internal API gains one endpoint, `POST /internal/v1/warm`, and optional fields (the router mapping's `requestedPort` and a timed comment's `weight`). No request or response that 0.6 sends or reads changed shape, and no endpoint was removed. A 0.6 Worker with a 0.7 node plays as before. A 0.7 Worker with a 0.6 node also plays as before: the node answers `/warm` with 404, which the Hub ignores, so only the look-ahead of history items waits for the node's restart.
- **Rollback** runs the Worker first, then the node, and needs no D1 restore. After a rollback, 0.6's settings show the relay On for owners the upgrade made Automatic, and 0.6's `doctor` warns about it; the owner turns it off there if they want it off. A relay turned off under 0.6 stays Off after the next upgrade.
- **`npm run yolo -- auth`** is new and optional. It signs in to Cloudflare with `cf`'s device login, which the owner approves on any device, a phone included, and stores one account API token in `.yolo/cloudflare-token.json` (mode 600), which every wrangler that the operator's commands start then uses. Without it, wrangler keeps its own login (`wrangler login`), so an existing instance needs nothing new. Whoever can read that file can deploy and change D1, KV, the tunnel, and the zone's DNS. `doctor` now names the credential wrangler uses and whether it grants each operation.
- `doctor` reports the relay's mode and its streams of the last 7 days as information, and fails only when the relay is Off and no direct path works. `deploy` ends by naming the media path that works and, when remote direct play is not reachable, the router step; neither fails the deploy.

### For contributors

- The plugin API gains an optional source method, `warm(source, context)`, which resolves an item ahead for a device; the node runs one at a time, in the background, and ignores failures. A timed comment may carry `weight`, the provider's rank from 0 to 10; screens hide those below 3 at normal density.
- The MCP SDK is 2.3.1, and agents 0.28.1. The 34 tools, their input schemas, and the negotiated protocol versions are unchanged, so no agent reconnects; only the descriptions of `get_status` and of two `set_danmaku` fields changed. The SDK packages are now Apache-2.0.
- CI uses `actions/checkout` and `setup-node` v7 and runs on any branch with `gh workflow run CI --ref <branch>`. Also updated: mediabunny 1.61.3, Playwright 1.64.0, Vite 8.3.4, and better-sqlite3 13.0.3.

### Migrations

D1 `0008_relay_mode` adds the column `relay_mode` (`auto`, `on`, or `off`) beside `relay` in `media_settings`. A row with `relay = 1` becomes `on`. A row with `relay = 0` becomes `off` only where the owner chose it: they had accepted the relay's warning before, or their user predates migration 0006, which gave them the relay on. Every other row becomes `auto`, and its `relay` becomes 1. The previous release reads only `relay`, so it keeps working and relays for `auto` owners as the last path. Rolling back needs no D1 restore.

### New secrets and settings

None: no new Worker secrets, node `.env` settings, or Cloudflare resources. The token file of `npm run yolo -- auth` is optional.

### Human actions

None. An owner who does not want media to go through Cloudflare when no direct path works sets the relay to Off, as described above.

### Names

This release changes these names without keeping the old ones:

- `get_playback_health`: the media path's `relayOn` (true or false) is now `relayMode` (`auto`, `on`, or `off`).
- `/v1/owner/media`: `relay` takes `auto`, `on`, or `off` (true and false still mean on and off), and `acceptRelayWarning` is no longer needed. The answer drops `warning` and `relay.acceptedAt`, and adds `relay.mode`, `relay.note`, `screens`, and `streams`.

The names renamed in v0.5.0 are still accepted; a later release removes them, so move to the new names now:

- `LAN_DNS_TOKEN` → `MEDIA_DNS_TOKEN`
- The welcome's `lan` → `media.paths`; `/lan/probe` → `/edge/probe`; the path name `tunnel` → `relay`; `/v1/owner/lan` → `/v1/owner/media`

```yolo-upgrade
{
  "protocol": 1,
  "migrations": ["0008_relay_mode"],
  "secrets": [],
  "settings": [],
  "resources": [],
  "node": "restart",
  "rollback": "code",
  "human": []
}
```

## v0.6.0 (2026-10-13)

An instance no longer needs a domain, and agents can now look at and understand what plays. Without a domain, Yolo runs on the account's workers.dev subdomain and the node plays from the home's public address under its own certificate ([no-domain deployment](.agents/notes/implemented/feature/2026-10-13-no-domain-deployment.md)). Agents get frames, storyboards, transcripts, chapters, details, playback health, and viewers' timed comments; covers show in their chats; Bilibili's danmaku plays over the picture; and a browser gets the resolution its screen and media path carry instead of 720p.

### For the owner

- **No domain needed.** `npm run yolo -- init` without `--domain` serves a new instance on the account's workers.dev subdomain, at zero cost. Registering a subdomain stops for the owner's approval, because its name is public for good. Without a domain, remote direct play certifies the home's public IPv4 address on the node with a Let's Encrypt short-lived certificate and serves `https://<address>:9444`; the address enters Certificate Transparency logs. The node asks the router for port 80 only while a certificate order runs; a router that refuses needs one forward, which Settings > Media paths names. At home, a screen plays from that address only where the router loops back to it, and its settings say whether it does; a domain adds LAN direct play. An existing instance keeps its domain: its instance file is read as the domain tier without change.
- **Fewer KV writes**, which matters on Workers Free's 1,000 a day. Realtime tickets live in the user's Hub instead of KV, so a reconnecting screen costs no KV write, and the cron run writes a media name's state when it changes and otherwise once an hour, instead of on every 5-minute run. During the Worker deploy, a ticket from the previous Worker fails once and the screen asks for a new one.
- **Agents see what plays.** `get_frame` returns one JPEG of a video at a moment, by default the item playing now at its position; `get_storyboard` returns one labelled grid of evenly spaced frames (12 by default, at most 30). The node reads them with ffmpeg, or from the source's own storyboard images when its plugin offers them; no screen is involved. Each agent may take 20 frames and 20 storyboards a minute.
- **Agents understand what plays.** `get_transcript` and `search_transcript` read the item's text subtitles or captions (an item without them has no transcript, and search matches words, not meaning); `get_chapters` lists chapters and intro and credits markers, and `skip` seeks past the intro or to the next or previous chapter; `get_item` gives the source's details, the tracks, the owner's progress, and the cover; `get_playback_health` gives a screen's stream, cap, media path, buffer, throughput, stalls, and short hints.
- Existing agent grants cover every new tool: `skip` and `set_danmaku` need the control scope and the others need read, so no agent reconnects. The consent page now says that read includes pictures from your videos.
- **Covers show in agents' chats.** MCP results carry each thumbnail as a signed link on the instance's address, `/i/<token>`, which loads without a credential and never expires, so covers keep working in old chats. Anyone who holds a link sees that one cover until the owner resets image links; a reset makes every earlier link answer 410 within 30 seconds. A copy that a client already cached outlives the reset.
- **Danmaku.** Bilibili videos play with their viewers' timed comments, drawn over the picture in both engines without overlapping. A button in the controls, shown while the item has comments, turns them on and off; Settings > This screen holds density, opacity, area, and text size. Agents read the comments around a moment with `get_comments` and change a screen's danmaku with `set_danmaku`.
- **Vimeo links play without a Vimeo account**: when Vimeo's page asks for a sign-in, the yt-dlp plugin asks Vimeo's embed player instead. Vimeo's subtitles load, and its automatic captions are marked as such. A video whose HLS needs a DRM key is refused at once as DRM-protected, instead of failing on the screen or retrying without end.
- **The picture a browser can carry.** A browser asks for its screen's short side in physical pixels, rounded to 720, 1080, 1440, or 2160 lines; the car stays at 720p H.264. For web video, the yt-dlp plugin takes the best format up to that height (fast motion at most 1440p), H.264 first and then the other codecs the browser announced, so Chrome on a 1440p screen gets YouTube's 1440p60 AV1 and Safari without AV1 keeps 1080p H.264. Plex gives a browser its picture size wherever the path's ceiling carries more than 720p (1080p from 8 Mbps, 1440p from 12, 2160p from 20); the car, and any path under 8 Mbps such as the relay at its default 4,800 kbps, keep Plex's 720p ladder. The node also drops HLS variants taller than the device asks for. A screen under 900 physical pixels on its short side now direct-plays originals only up to 720p.
- **Each media path has its own ceiling.** On the LAN, `LAN_MAX_VIDEO_KBPS` (200,000, unchanged); on remote direct play, the new `WAN_MAX_VIDEO_KBPS` (20,000), where 0.5 used the relay's 4,800; on the relay, `STREAM_MAX_VIDEO_BITRATE_KBPS` (4,800). Adaptive quality gains rungs at 6,000, 9,000, and 13,000 kbps, so a stall on a direct path need not drop to 4 Mbps.

### For the operator

- **Upgrade order**, which `npm run yolo -- upgrade` follows: back up D1, apply migration 0007, restart the node, deploy the Worker, then run `doctor`. Every change in this release agrees with that order. Migration 0007 adds a table that 0.5 never reads. The node goes before the Worker, because the 0.6 Worker asks the node for frames, storyboards, transcripts, chapters, details, and comments, and, on an instance without a domain, for the address certificate, which a 0.5 node answers with an error. The Worker deploy brings the two new rate-limit bindings. A rollback runs the other way, the Worker first and then the node, and needs no D1 restore.
- **The internal protocol stays 1.** Every change to the node's internal API adds an endpoint (`/internal/v1/frame`, `/storyboard`, `/details`, `/chapters`, `/transcript`, `/comments`) or an optional field; no request or response that 0.5 sends or reads changed shape, and no endpoint was removed. A 0.5 Worker with a 0.6 node plays as before. A 0.6 Worker with a 0.5 node also plays as before, but the new tools that need the node fail: `get_frame`, `get_storyboard`, and `get_comments` answer that the media node runs a release without them and must be upgraded, and `get_item`, `get_transcript`, `search_transcript`, `get_chapters`, and `skip` answer `not_found` ("No such endpoint") until the node restarts. `get_playback_health` and `set_danmaku` need only the Worker; a screen applies `set_danmaku` only once it runs the 0.6 player.
- **New Worker bindings:** the rate limits `FRAME_LIMIT` (namespace 4203: 20 frames and 20 storyboards a minute per agent) and `IMAGE_LIMIT` (namespace 4204: 120 image-link requests a minute per address). `npm run yolo -- deploy` creates both from the config; nothing needs to be provisioned. The rendered config also routes `/i/*` to the Worker, turns preview URLs off on both tiers so the Worker answers on one origin, and sets the var `WAN_CERTIFICATE` from the instance file's `media.wan.certificate` (`name` with a domain, `ip` without one).
- **Image links** are sealed with keys derived from `NODE_SECRET`, so rotating `NODE_SECRET` also ends every image link. After a rollback to 0.5, the links that agents got from 0.6 do not load; they work again after the upgrade is repeated, because the key version stays in D1.
- **`npm run yolo -- provision media-dns`** creates `MEDIA_DNS_TOKEN` with Cloudflare's CLI `cf`, under a profile of its own that the owner signs in with one browser consent, and stores it with `wrangler secret put` on stdin without printing it. Run again, it keeps the Worker secret that exists; `--rotate` replaces it. Without `cf`, it prints a pre-filled dashboard page.
- **New `doctor` checks:** the account's workers.dev subdomain against the instance's host, whether the player's page is cross-origin isolated, and the account's busiest day of yesterday and today (UTC) against Workers Free's daily limits, which warns from half of a limit and never fails, because doctor cannot tell the account's plan and Workers Paid has no such limits. The KV writes that 0.5 made before the upgrade count, so the first `doctor` after the upgrade can warn on `cloudflare.limits` for up to two days. Reading the account's usage needs a token with Account Analytics Read: `CLOUDFLARE_API_TOKEN`, or wrangler's login.
- Playback health costs some Durable Object storage writes: about one every 15 seconds for each playing screen, and two for each stream load.

### For contributors

- The plugin API gains five optional source methods: `subtitle(source, trackId)` for WebVTT text, `chapters(source)`, `details(source)`, `storyboard(source)`, and `comments(source, { start, end })`. The core normalizes their answers and names no provider. `plugins/source-example` shows all but `storyboard` from its options; the yt-dlp plugin offers a site's storyboard sprites.
- The README's Mermaid diagram is replaced by a designed one. Its source is `.github/readme/architecture.html`, and `node scripts/render-readme-diagram.js` renders it with Chrome through Playwright.
- The two test files that create scratch git repositories drop every `GIT_*` variable first, so tests under a hook or `git rebase --exec` no longer change the real repository's config.

### Migrations

D1 `0007_image_links`: one row per user with the key version that image links are sealed with; a reset adds one. The previous release never reads it. Rolling back needs no D1 restore.

### New secrets and settings

- No new Worker secrets. `MEDIA_DNS_TOKEN` stays optional and applies only to an instance with a domain, for LAN and remote direct play by name; `provision media-dns` now creates it.
- New node settings in `.env`, all optional: `WAN_MAX_VIDEO_KBPS` (default 20000, at least 500); and, only without a domain, `WAN_CHALLENGE_PORT` (default 9480; 0 leaves only TLS-ALPN-01, which needs `WAN_EXTERNAL_PORT=443`) and `WAN_CHALLENGE_MAPPING` (`auto` or `manual`; default `WAN_MAPPING`'s value).

### Human actions

- Image links: if a cover link reached someone it should not, the owner resets image links in Settings > Your Yolo > Image links > Reset, or the operator runs `npm run yolo -- image-links reset`.
- On a home upload slower than about 20 Mbps, the owner lowers `WAN_MAX_VIDEO_KBPS` in `.env` below the upload and restarts the node, because remote direct play now uses up to 20 Mbps.

### Names renamed in v0.5.0, still accepted

The v0.5.0 entry said the next release would remove these names; v0.6.0 still accepts them. A later release removes them, so move to the new names now.

- `LAN_DNS_TOKEN` → `MEDIA_DNS_TOKEN`
- The welcome's `lan` → `media.paths`; `/lan/probe` → `/edge/probe`; the path name `tunnel` → `relay`; `/v1/owner/lan` → `/v1/owner/media`

This release renames and removes no names.

```yolo-upgrade
{
  "protocol": 1,
  "migrations": ["0007_image_links"],
  "secrets": [],
  "settings": [
    { "name": "WAN_MAX_VIDEO_KBPS", "required": false, "how": "The video bitrate ceiling on remote direct play: 20000 by default (at least 500), where 0.5 used the relay's 4800. When the home's upload is slower than about 20 Mbps, the owner sets it below the upload in .env (for example WAN_MAX_VIDEO_KBPS=8000) and the node is restarted with npm run yolo -- service restart node." },
    { "name": "WAN_CHALLENGE_PORT", "required": false, "how": "Only on an instance without a domain: the node's port for the CA's HTTP-01 check, which the router's port 80 reaches while a certificate order runs (default 9480). 0 leaves only TLS-ALPN-01, which needs WAN_EXTERNAL_PORT=443." },
    { "name": "WAN_CHALLENGE_MAPPING", "required": false, "how": "Only on an instance without a domain whose router will not map port 80: the owner forwards TCP port 80 to the node's WAN_CHALLENGE_PORT and sets WAN_CHALLENGE_MAPPING=manual in .env. The default is WAN_MAPPING's value." }
  ],
  "resources": [
    "Two Workers rate-limit bindings, FRAME_LIMIT (namespace 4203: 20 frames and 20 storyboards a minute per agent) and IMAGE_LIMIT (namespace 4204: 120 image-link requests a minute per address), which npm run yolo -- deploy creates from the config; nothing needs to be provisioned."
  ],
  "node": "restart",
  "rollback": "code",
  "human": [
    "Image links: covers in agents' chats are now links that anyone holding one can open, and they never expire. If one reached someone it should not, the owner resets them in Settings > Your Yolo > Image links > Reset (or the operator runs npm run yolo -- image-links reset); every earlier link stops working within 30 seconds, and agents get new links on their next call.",
    "Remote direct play's ceiling rises from 4800 to 20000 kbps, so a browser away from home can draw up to 20 Mbps from the home's upload. If the upload is slower than about 20 Mbps, the owner lowers WAN_MAX_VIDEO_KBPS in .env below it and restarts the node."
  ]
}
```

## v0.5.0 (2026-10-13)

Media leaves the Worker. Relaying video through the Cloudflare Worker is most likely outside Cloudflare's terms on Free, Pro, and Business zones, so screens now play straight from the media node, at home over the LAN and away through a router port, and the Worker relays media only while the owner has the relay on ([media off the Worker](.agents/notes/implemented/architecture/2026-10-13-media-off-the-worker.md)). The player also stops loading anything from other hosts.

### For the owner

- **Remote direct play.** With remote access on in Settings > Media paths, a screen anywhere, the car on LTE included, plays from the node through one port of the home router, under its own DNS-only name with its own certificate. The node asks the router for that port by PCP, NAT-PMP, or UPnP IGD, renews it, and removes it when it stops or remote access goes off; a router without those protocols needs a port forward and `WAN_MAPPING=manual`. The node detects carrier-grade NAT, where remote direct play cannot work, and the Worker checks from outside the home that the port answers.
- **Each screen picks its path:** the home network, then remote direct play, then the relay if it is on. A stream that fails on its path continues on the next one at the same position. Settings show each screen's path and why the others failed, and device telemetry records it (`media_probe`, `media_path`, `media_path_fallback`).
- **The relay is off on a new instance.** Turning it on in Settings > Media paths shows a warning about Cloudflare's terms that the owner must accept. With no path and the relay off, playing says what each path needs (`media_unreachable`), to agents too.
- **The relay stays on after this upgrade** for an existing instance, so a car that plays away from home through the relay keeps working until remote direct play works. Turn it off in Settings > Media paths once Remote direct play says "Ready"; `yolo doctor` warns while it is on.
- The remote listener faces the internet with nothing in front: it serves only token-authorized media and its probe under its own name, limits each address, and logs no URL. Turning remote access off closes it.
- **Nothing loads from another host.** The Japanese and Korean subtitle fonts come from Yolo's own origin instead of Google Fonts, and web-video thumbnails come through `/v1/thumbnail` and the node instead of the source's image server. The node fetches only public http(s) addresses, checked again on each redirect, and only raster images of at most 4 MiB, so a thumbnail on a private address shows a placeholder; a source whose images are on the home network needs artwork variants.

### For the operator

- Upgrade in the usual order, which `npm run yolo -- upgrade` follows: back up D1, apply migration 0006, restart the node, deploy the Worker, then run `doctor`.
- The internal protocol stays 1: each half keeps working with the other half's previous release, so neither refuses the other during the upgrade or a rollback. A 0.4 Worker with a 0.5 node plays as before, but the node no longer answers `/internal/v1/renderers`, so the old Worker logs `renderers_failed` and, while no screen is online, refuses with `node_offline` instead of `device_offline`. A 0.5 Worker with a 0.4 node plays over the LAN and the relay; thumbnails show placeholders and remote direct play cannot start until the node restarts.
- The zone token is now the Worker secret `MEDIA_DNS_TOKEN`. `LAN_DNS_TOKEN` keeps working until the next release; to move, store the same token under the new name and delete the old one.
- New node settings, all optional: `WAN_PORT` (9444; 0 turns remote direct play off on the node), `WAN_MAPPING` (`auto` or `manual`), `WAN_EXTERNAL_PORT`, `WAN_GATEWAY`, `WAN_ADDRESS`, and `WAN_IPV6`.
- `doctor` reports the remote listener, its router port, carrier-grade NAT, the check from outside, and whether the relay is on; `get_status` reports the relay and remote access.

### For contributors

- The README is new: it leads with what the owner controls and who sees what.
- The end-to-end suite keeps only the journeys that unit tests cannot prove (23 tests in about 280 s, from 32 in 579 s), and the LAN fallback test no longer flakes. A new test fails when the player's build or an owner page references another host.

### Migrations

D1 `0006_media_settings`: the owner's media path switches. It gives the users that exist when it runs the relay on. Rolling back needs no D1 restore.

### New secrets and settings

- `MEDIA_DNS_TOKEN`, optional: replaces `LAN_DNS_TOKEN` for LAN and remote direct play.
- `WAN_*` in `.env`, optional: see `.env.example`.

### Human actions

- To play away from home without the relay: turn on Remote direct play in Settings > Media paths; forward TCP 9444 to the node only if the card says the router made no mapping.
- Once Remote direct play says "Ready", turn the relay off in Settings > Media paths.

### Removed names

- The names renamed in v0.4.0: the node no longer reads the `X-Drive-In-Prefetch` header or writes `#EXT-X-DRIVE-IN-*` tags, and nothing reads `DRIVEIN_ENV_FILE`. A car tab still running a player from before v0.4.0 must reload.
- Node renderers, which never shipped: the node's `/internal/v1/renderers` and `/internal/v1/sessions/:id/control`, the prepare body's `renderer`, and the `nodeOnline` and `via` fields of device lists (`list_devices`, `/v1/devices`, settings). `get_status` still reports the node.

### Renamed names, accepted until the next release

- `LAN_DNS_TOKEN` → `MEDIA_DNS_TOKEN`
- The welcome's `lan` → `media.paths`; `/lan/probe` → `/edge/probe`; the path name `tunnel` → `relay`; `/v1/owner/lan` → `/v1/owner/media`

```yolo-upgrade
{
  "protocol": 1,
  "migrations": ["0006_media_settings"],
  "secrets": [
    { "name": "MEDIA_DNS_TOKEN", "required": false, "how": "Only for LAN or remote direct play. An instance with LAN_DNS_TOKEN keeps working until the next release removes that name; before then the owner stores the same token with npm run wrangler -- secret put MEDIA_DNS_TOKEN and deletes the old one with npm run wrangler -- secret delete LAN_DNS_TOKEN. Otherwise the owner creates a Cloudflare API token with Zone Read and DNS Edit on the hostname's zone and stores it the same way (skills/yolo-deploy)." }
  ],
  "settings": [
    { "name": "WAN_MAPPING", "required": false, "how": "Only on a router without PCP, NAT-PMP, or UPnP IGD: the owner forwards TCP 9444 to the node and sets WAN_MAPPING=manual in .env (.env.example lists WAN_PORT, WAN_EXTERNAL_PORT, WAN_GATEWAY, WAN_ADDRESS, and WAN_IPV6)." }
  ],
  "resources": [],
  "node": "restart",
  "rollback": "code",
  "human": [
    "Remote direct play, to play away from home without the relay: the owner turns it on in Settings > Media paths (it exposes one port of the home that serves only token-authorized media); the node maps the router port itself, and a router without PCP, NAT-PMP, or UPnP IGD needs a forward of TCP 9444 and WAN_MAPPING=manual.",
    "The relay stays on for this existing instance after the upgrade: once Settings > Media paths says Remote direct play is Ready, the owner turns the relay off there, because relaying video through the Worker is likely outside Cloudflare's terms."
  ]
}
```

## v0.4.0 (2026-10-13)

The first tagged release. It covers everything since the project became Yolo, and an owner's agent can now deploy, upgrade, and roll back an instance from release tags.

### For the owner

- One player at the site root. The player (car profile) decodes to a `<canvas>` in the Tesla browser; in any other browser, iPhone included, the web profile plays through the browser's `<video>` with Picture-in-Picture and lock-screen controls and is a remote for whichever screen is playing.
- Agents search, play, and control playback over MCP once the owner approves them with a passkey. Screens pair by scanning a QR code.
- Yolo keeps one history with resume, a queue, and playlists for every screen, and resumes after a wake with sound when the browser allows it.
- Plex and web video (yt-dlp) are source plugins. At home, screens can play straight from the node (LAN direct play), where Plex originals play as they are. Quality adapts to the connection.
- Security: a passkey sign-in returns only to a path on Yolo's own origin; media tokens, tickets, and pairing codes stay out of Workers Logs; unauthenticated routes are rate-limited per address; and the canvas engine no longer retries a failing segment forever.

### For the operator

- `service/control/wrangler.jsonc` is a template. An instance's domain, D1 and KV ids, and Workers VPC service live in the ignored `yolo.instance.json`, and deploys use the rendered `service/control/wrangler.instance.jsonc`.
- `npm run yolo -- <command>` sets up (`init`, `provision`, `migrate`, `deploy`, `service`), checks (`doctor`), upgrades, and rolls back an instance; the skills in [`skills/`](skills/) walk an agent through each task.
- Every package is 0.4.0. The Worker reports its version, internal protocol, and migration level at `/.well-known/yolo`, and the node accepts the control plane's protocol and the one before.
- `npm run owner-code` works from checkouts with long paths, and the node explains a missing `NODE_SECRET`.
- An instance deployed before v0.4.0 kept its values in `service/control/wrangler.jsonc`. Before upgrading, write them to `yolo.instance.json` with `npm run yolo -- init --import-wrangler <a copy of the old wrangler.jsonc>` ([`skills/yolo-upgrade`](skills/yolo-upgrade/SKILL.md)).

### Migrations

D1 `0001_init` through `0005_device_kind_other`. Rolling back needs no D1 restore.

### New secrets

- `NODE_SECRET`, required: shared by the Worker and the node. `npm run yolo -- init` writes it to `.env`, and `npm run yolo -- deploy` uploads it to the Worker.
- `LAN_DNS_TOKEN`, optional: turns on LAN direct play. The owner creates a Cloudflare API token that can edit the zone's DNS and stores it with `npm run wrangler -- secret put LAN_DNS_TOKEN`.

### Human actions

- Approve the Cloudflare login (`npx wrangler login`).
- On a new instance, create the tunnel in the Cloudflare dashboard and hand over only its token.
- On a new instance, or to reset passkeys, create the owner's passkey with the 6-digit code from `npm run owner-code`; the code replaces every existing passkey.
- On the Workers Paid plan, set a budget alert in the Cloudflare dashboard.

### Renamed names, accepted until the next release

v0.4.0 uses the new names and still accepts the old ones; 0.5 removes the old ones.

- `X-Drive-In-Prefetch` → `?prefetch=1`
- `#EXT-X-DRIVE-IN-*` → `#EXT-X-YOLO-*`
- `DRIVEIN_ENV_FILE` → `YOLO_ENV_FILE`

The node no longer reads `DRIVEIN_RUNTIME_DIR`; set `YOLO_RUNTIME_DIR` instead.

```yolo-upgrade
{
  "protocol": 1,
  "migrations": ["0001_init", "0002_drop_init_codes_used", "0003_plugin_sources", "0004_device_pairing", "0005_device_kind_other"],
  "secrets": [
    { "name": "NODE_SECRET", "required": true, "how": "npm run yolo -- init writes it to .env; npm run yolo -- deploy uploads the same value to the Worker." },
    { "name": "LAN_DNS_TOKEN", "required": false, "how": "Only for LAN direct play: the owner creates a Cloudflare API token with Zone Read and DNS Edit on the hostname's zone and runs npm run wrangler -- secret put LAN_DNS_TOKEN (skills/yolo-deploy)." }
  ],
  "settings": [],
  "resources": [
    "A D1 database, a KV namespace, a tunnel, and a Workers VPC service, which npm run yolo -- provision creates; the Hub Durable Object, a 5-minute cron trigger, and two Workers rate-limit bindings, which npm run yolo -- deploy creates from the config."
  ],
  "node": "restart",
  "rollback": "code",
  "human": [
    "Cloudflare login: the owner approves `npx wrangler login`, or gives the agent an API token (skills/yolo-deploy).",
    "Tunnel, only on a new instance: the owner creates it in the Cloudflare dashboard (Workers VPC > Tunnels > Create) and hands over only its token for `npm run yolo -- provision tunnel --token-file <file>`.",
    "Passkey, only on a new instance or for a reset the owner asks for: the owner creates it at /login with the 6-digit code from `npm run owner-code`, which replaces every existing passkey.",
    "Budget alert, only on the Workers Paid plan: the owner sets one in the Cloudflare dashboard (Manage Account > Billing > Billable Usage > Set Budget Alert)."
  ]
}
```
