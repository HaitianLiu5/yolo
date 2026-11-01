# Agent Note: Share links

Status: implemented

English | [中文](2026-10-20-share-links.zh.md)

## Problem

Everything that plays on Yolo plays on a screen the owner paired with their passkey, and every stream goes through the owner's Hub, which owns one playback state: a play moves the owner's active screen, stops the stream there, writes history, and resumes from the owner's position. A friend the owner wants to show one video to has no paired screen, and pairing one would give that friend the owner's library, queue, history, devices, and agent. Yolo is one owner's service ([D1 data model](../architecture/2026-10-07-d1-data-model.md)); accounts for other people stay out of scope ([Yolo 1.0](../../proposed/feature/2026-10-11-yolo-1-0.md)).

## Decision

A share link is a URL, `https://<Yolo's origin>/s/<token>`, that plays one item in any browser for 7 days, without pairing or signing in. The friend sees that item and the player, nothing else of the owner's Yolo, and nothing the friend does reaches the owner's playback state, history, queue, track preferences, or a source's own watch position.

### Making and revoking a link

A paired screen makes one from the player's share button (`POST /v1/shares`, control scope, [v1 HTTP API](../architecture/2026-10-07-v1-http-api.md)), and an agent with the control scope makes one with the MCP tool `share` ([remote MCP server](2026-10-07-remote-mcp-server.md)); both share the item given, else what plays now. The node claims and describes the item first, so making a link needs the node online; what plays now is named from the Hub's state instead, which a web video's source would otherwise look up again. The answer carries the URL once: D1's `share_links` table keeps only the token's SHA-256 (migration `0010_share_links.sql`), as for device credentials, so a link can be revoked but never shown again. A link records who made it (`device:<id>` or `client:<id>`), and each new link drops the owner's links that ended more than 30 days ago and keeps the newest 200. The token is 16 random bytes, 22 base64url characters. The player hands the URL to the browser's share sheet where it has one, else copies it, else shows it to copy by hand, because the sheet and the clipboard need the tap still fresh and Yolo's answer can outlast it. While Yolo makes the link, the button stays pressed and, past the loading ring's half-second delay, shows the ring in place of its icon.

Settings list the open links under Share links with how often friends played them, behind the owner's passkey session (`GET /v1/owner/shares`). Revoking one (`POST /v1/owner/shares/:id/revoke`) refuses its next request at once and has the node stop the link's streams that play (`DELETE /internal/v1/shares/:id`). Making a link and revoking one each write a `kind: "security"` log line.

### The friend's page

`/s/<token>` is the player's own page: the static assets answer it with `index.html`, so it keeps COOP and COEP and plays with either engine, and a Tesla gets the canvas engine as any page there does ([two playback engines](../architecture/2026-10-12-two-playback-engines.md)). `main.js` recognises the route and starts `share.js` instead of pairing and the realtime channel. The page asks two routes that answer without a credential ([`service/control/src/share-links.js`](../../../../service/control/src/share-links.js)):

- `GET /v1/share/<token>`: the item (its title, cover, and duration, with a stand-in source `{ plugin: "share", id }` in place of the owner's), the link's expiry, and the media paths a friend may try.
- `POST /v1/share/<token>/stream`: `{ startTime?, reason?, autoplay?, sessionId?, maxVideoKbps?, network?, capabilities, viewport? }` → `{ stream, item, startTime, autoplay, reason }`, the same fields as the `load` message a paired screen gets over the realtime channel.

`playback.js` sends every stream request to the link on this page (`setShareStreams()`), and hands each answer to `onLoad`, so the player plays, recovers, seeks outside the stream, and changes quality as on a paired screen; `sessionId` names the stream a rebuild replaces. Text subtitles change on the page; an audio track that needs a new stream cannot be changed, so the page shows no audio button for the source's tracks (the stream's own renditions still switch), and a failure to open or play the item offers **Try again**, which reloads the page, except for a link that is gone. The router never moves the page to `/play` or home, so a reload opens the same link, and the friend's place is kept in the browser's `localStorage`, not in Yolo. CSS under `:root[data-share]` hides Back, the share button, settings, previous and next, the now-playing bar, and the device picker.

The control plane checks the link, signs a media token for the owner's user id that expires with the link or after the usual 12 hours, whichever is first, and calls the node's `/internal/v1/prepare` itself with `share` set to the link's id. The Hub never sees the stream, so the friend's stream is no device's, plays no queue, and has no reports: the node writes a source's watch position only from the Hub's reports. A play (not a rebuild) adds one to the link's `plays`. The cover comes as an image link on Yolo's origin ([cover images](2026-10-07-remote-mcp-server.md#cover-images)), and the stream's own thumbnail, an owner route, is replaced with it.

An expired link answers 410 "This share link has expired", a revoked one 410 "This video is no longer shared", and an unknown token 404; the page shows the message in place of the player. Both routes count against `PUBLIC_LIMIT` per address under their own key, so a friend's page never spends the owner's sign-in allowance.

### Media paths

As far as Yolo knows, a friend is never on the owner's home network: the paths offered are remote direct play when the owner turned it on, then the relay as the owner's relay mode allows ([media off the Worker](../architecture/2026-10-13-media-off-the-worker.md)). The LAN listener is never offered, since its name and address are the home's. With the relay off and no remote path, the stream is refused with `media_unreachable`.

### Friends' sessions on the node

Friends' streams never take the owner's: the node ([`service/node/src/media/pipeline.js`](../../../../service/node/src/media/pipeline.js)) keeps sessions with a `share` apart, and the cap of 8 sessions that retires the oldest counts only the owner's. At most 2 friends' sessions play at once across all links. A third is admitted before its source resolves anything only when one of the two has had no media request for 2 minutes, which is retired; otherwise it is refused with `rate_limited`, "Two friends are already watching from share links; try again in a few minutes". A rebuild's `replaces` frees its own place first, but only for a session of the same link. Friends' sessions are released after 15 minutes without a media request, the owner's after 2 hours ([node's internal API](../architecture/2026-10-07-node-internal-api.md)).

## Alternatives considered

**Watching together.** A friend would join the owner's playback and follow its pauses and seeks. It is the Hub's playback state shared with a second, unpaired kind of screen, two to three times the work of one item, and it still needs everything a link does first.

**A guest device.** Pairing the friend's browser as a device with fewer scopes would reuse the realtime channel, but every device takes part in the owner's one playback state: a play moves the owner's active screen and writes history, and device credentials never expire.

**A link to a playlist or a whole show.** It needs a page to choose from and decides what a friend may browse; one item covers sending a friend a video, and a later link kind can add more.

**A choice of expiry, or none.** Seven days without a choice is enough to watch one video, and a link forwarded further stops by itself. Revoking covers the rest.

**Storing the token to show the link again.** A database export or backup would then hold every open link. Making a new link costs one tap.

**A password on the link.** It would have to travel beside the link to the same friend; the link itself is the secret.

**Offering the LAN path.** It names the home's address and serves only peers on the home network, where a friend with the link is rarely.

## Consequences

Anyone who holds a link watches that one item until it expires or is revoked, the owner's agents included; forwarding it forwards access, which is bounded by the 7 days, revocation, and the node's 2 friends' streams. Away from remote direct play every friend's stream crosses the relay, under its 4.8 Mbps ceiling and on the owner's Workers requests, and AI subtitles a friend turns on run on the owner's speech service. Resetting image links in settings also replaces the covers on open share links' pages. A friend's stream is not in history, playback health, or the media paths' stream counts. A previous-release node ignores `share` and `replaces`, so friends' streams then count toward the owner's 8 sessions; the upgrade restarts the node before deploying the Worker, and no `NODE_PROTOCOL` change is needed.

## Testing

`service/control/test/unit/auth.test.js` plays a link without a credential and checks the prepare it sends, that the owner's playback state and history stay empty, the relay off, a rebuild's `replaces`, and 404, 405, and 410 for unknown, wrong-method, expired, and revoked links. `service/node/test/media-pipeline.test.js` checks the friends' cap apart from the owner's, admission before the source resolves, `replaces` only within a link, and stopping one link's sessions. `test/e2e/web-playback.test.js` makes a link with the MCP tool, plays it in a browser that never paired, checks that the owner's playback and history did not change, revokes it in settings' route, and sees the page say so.
