# Agent Note: Showing what Spotify plays, with lyrics and book text

Status: proposed

English | [中文](2026-10-14-spotify-now-playing.zh.md)

## Problem

Spotify plays music and audiobooks on the owner's phone, computer, or the car's own Spotify app, and Yolo's screens know nothing about it. The intended experience:

1. The owner links Spotify to Yolo once.
2. A Yolo screen shows what Spotify plays, a track or an audiobook chapter, and on which device.
3. Yolo never takes over playback by itself.
4. The owner chooses whether to move playback, and Yolo then shows the song's lyrics or the book's text beside it.

This is low priority. Music, podcasts, and audiobooks are outside [Yolo 1.0](2026-10-11-yolo-1-0.md), and no other work waits on this note.

Spotify's audio is DRM-protected and may not pass through the node, so Spotify cannot be a Yolo source. The [capability negotiation](../../implemented/architecture/2026-10-07-capability-negotiation.md) note already reserves the `external` renderer for this case: Yolo controls Spotify through Spotify Connect and lets Spotify's own devices play.

## Proposal

### The boundary

- Yolo never extracts, decrypts, records, transcribes, or re-serves Spotify audio, because it is DRM-protected. No Spotify audio passes through the node or the Worker.
- Yolo uses only Spotify's documented Web API and Web Playback SDK. It never calls Spotify's private endpoints, such as the `color-lyrics` endpoint behind Spotify's own web player ([Lyrics](#lyrics)).
- Yolo never starts, pauses, or moves Spotify playback without an explicit tap or agent request. Option A calls no Spotify write endpoint at all.

### Plan

1. **Two owner checks first.** [Owner checks](#owner-checks) P1 and P2 take about 15 minutes and no code. They decide whether audiobook chapters show up at all and whether the car is a usable Spotify Connect target.
2. **Then Option A on phones and computers:** a read-only "Now on Spotify" card with lyrics ([Options](#options)).
3. **Option B's on-screen controls are optional:** pause, seek, and moving playback between Spotify devices, added only if the owner wants them.
4. **Agent tools only after the owner accepts the policy risk.** Spotify's AI and voice clauses apply directly to MCP tools ([Terms and Policy](#terms-and-policy)).
5. **Option C is deferred.** Making Yolo itself a Spotify device works only on phones and computers, where the Spotify app already plays.

Audiobook text is a later, separate feature if it is wanted: Spotify offers none, and the only legitimate source is the owner's own DRM-free EPUB ([Audiobook text](#audiobook-text)).

### Owner checks

Each check runs with the owner's own account and needs no Yolo code.

| Check | Steps | Decides |
|---|---|---|
| P1, audiobook visibility | Play a chapter on the phone and call `GET /me/player?additional_types=episode`. Record `currently_playing_type`, `item.type`, the show or audiobook, `progress_ms`, and how fast a pause on the phone shows up. Then call `GET /chapters/{id}` and check `resume_point`. | Whether Option A shows audiobooks, and the lag that lyrics must tolerate |
| P2, the car as a Connect target | With the car's Spotify app open, call `GET /me/player/devices` and check that the car is listed with `is_restricted: false`. Then try `PUT /me/player` to the car with `play: false`, and a pause. | Whether Option B can move playback to the car |
| P3, chapter start | Call `PUT /me/player/play` with `uris: ["spotify:episode:<chapter id>"]` and `position_ms`. | Whether Option B can start a given chapter |
| P4, Widevine in the car | In the Tesla browser, call `navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{ audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }])`. It needs no Spotify account. | Whether Option C could ever run in the car |

### Open questions for the owner

- Is the account on full Spotify Premium, not a mobile-only plan, and is its country one of the audiobook markets? Development mode, every control call, and the SDK need Premium.
- Is linking Spotify again every 6 months acceptable?
- Does the owner accept LRCLIB's terms, which leave lyrics copyright with the user, and the risk that third-party lyrics beside Spotify playback match Spotify's "content from another service" clause?
- Should the card ever appear in the car profile, given that a car is not an Approved Device? This proposal turns it off there by default.
- Are Option B's on-screen controls wanted?
- Does the owner accept the AI and voice clauses' risk for MCP tools? Without that acceptance, Option B ships without agent tools.
- Is a later reader for the owner's own DRM-free EPUBs wanted?

## What Spotify offers

Sources were read on 2026-10-14. **Unverified** marks a claim that no official source confirms; community posts and inspection of Spotify's code count only as corroboration. An owner check settles most unverified items.

### Seeing playback and audiobook chapters

- `GET /me/player` returns the device, `progress_ms`, `is_playing`, `timestamp`, `currently_playing_type`, `actions`, and `item`, and `GET /me/player/currently-playing` is the lighter variant. Both can answer 200, 204, 401, 403, or 429 ([Get Playback State](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback), [Get Currently Playing Track](https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track)).
- `additional_types` accepts only `track` and `episode`, and "might be deprecated in the future" ([Get Playback State](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback)). Without `episode`, an episode comes back as `"item": null` ([community thread 5625103](https://community.spotify.com/forum/en/discussion/5625103/api-v1-me-player-currently-playing-item-is-null-when-currently-playing-is-an-episode)).
- **Audiobook chapters in `/me/player` are unverified.** The player endpoints document only tracks and episodes. Three facts suggest that a chapter arrives as an episode when `additional_types=episode` is sent: a Chapter object's `type` is `"episode"` with a `spotify:episode:` URI ([Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter)); a saved audiobook is returned by both `/me/audiobooks` and `/me/shows` ([community thread 7319327](https://community.spotify.com/forum/en/discussion/7319327/web-api-audiobooks-getting-returned-alongside-shows)); and the Web Playback SDK's code formats chapters as `type: "episode", content_type: "chapter"` ([embedded/index.js](https://sdk.scdn.co/embedded/index.js)). Owner check P1 settles it.
- `GET /chapters/{id}` returns the chapter number, name, description, duration, images, the audiobook's authors and narrators, and `resume_point`, which is set only with the `user-read-playback-position` scope ([Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter)). Since February 2026 the batch `GET /chapters` and `GET /audiobooks` endpoints are gone ([Feb 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)).
- Audiobooks exist only in the US, UK, Canada, Ireland, New Zealand, and Australia markets, and a user token's account country takes priority over `market` ([Get an Audiobook](https://developer.spotify.com/documentation/web-api/reference/get-an-audiobook)).
- Spotify has no push. The Web API documents no webhooks or event streams, and the SDK's `player_state_changed` covers only its own local player ([SDK reference](https://developer.spotify.com/documentation/web-playback-sdk/reference)), so Yolo polls.
- `timestamp` is when the playback state last changed. How quickly a change on another device shows up is **unverified**, and P1 measures it. Developers report 204 responses while music plays ([community thread 7039998](https://community.spotify.com/forum/en/discussion/7039998/currently-playing-api-return-an-empty-response-204)), so a 204 means "unknown", not "stopped".
- `GET /me/player/devices` lists Connect devices with `is_restricted`. A restricted device accepts no Web API commands, and some device models are never listed ([Get Available Devices](https://developer.spotify.com/documentation/web-api/reference/get-a-users-available-devices)). Sleeping or newly added devices may be missing ([spotify/web-api#1337](https://github.com/spotify/web-api/issues/1337)). Spotify's car page tells owners to check Connect support with the manufacturer ([Spotify in the car](https://support.spotify.com/us/article/spotify-in-the-car/)), so whether the car's Spotify app is listed unrestricted is **unverified**; P2 settles it.

### Controlling playback

- Every control endpoint works only for Premium users, needs `user-modify-playback-state`, and does not guarantee the order of execution across Player calls ([Start/Resume](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback)).
- Pause, resume, seek, next, previous, queue, and transfer exist. Transfer is `PUT /me/player` with a single `device_ids` entry and `play` ([Transfer Playback](https://developer.spotify.com/documentation/web-api/reference/transfer-a-users-playback)). There is no playback-speed endpoint ([Feb 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)).
- Starting a given chapter by its `spotify:episode:` URI, and next or previous inside an audiobook, are **unverified**: `play` documents track URIs, and an episode `context_uri` fails ([community thread 5040833](https://community.spotify.com/forum/en/discussion/5040833/episode-uri-not-supported-player-play)). P3 settles chapter start.
- Since February 2026 `GET /me` no longer returns `product`, so Yolo cannot ask whether the account has Premium; it can only surface a 403 from a control call ([Feb 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)).

### Scopes

Yolo requests only the scopes of the option it builds, as Spotify asks ([Scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes), [Building with AI](https://developer.spotify.com/documentation/web-api/tutorials/building-with-ai)).

| Scope | Why | Option |
|---|---|---|
| `user-read-playback-state` | `GET /me/player`, the device list, and the currently playing item | A, B, C |
| `user-read-playback-position` | A chapter's `resume_point` | A, B, C |
| `user-modify-playback-state` | Pause, seek, next, previous, transfer, play, and queue | B, C |
| `user-library-read` | Saved audiobooks, for "play my book" by an agent ([Get Saved Audiobooks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-audiobooks)) | B, optional |
| `streaming`, `user-read-email`, `user-read-private` | The Web Playback SDK ([SDK how-to](https://developer.spotify.com/documentation/web-playback-sdk/howtos/web-app-player)) | C |

### Development mode in 2026

A personal, non-commercial app can still use the player endpoints, under these rules:

- The app owner needs Premium; if it lapses, the app stops working ([Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), [migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)).
- An app allows at most 5 allowlisted users ([2026-02 blog](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)). Whether the app owner is allowlisted implicitly is **unverified**.
- Quota is counted per developer account, not per Client ID, and a 429 carries `"reason": "QUOTA_EXCEEDED"` ([July 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/july-2026)). The rate-limit numbers are unpublished ([Rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)).
- Refresh tokens expire 6 months after authorization, and refreshing does not extend them; access tokens last 1 hour ([Refreshing tokens](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens)).
- Extended quota is open only to organizations with at least 250k monthly active users, not to individuals ([Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)).
- The Player endpoints survived the February 2026 reduction ([Feb 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)).
- Redirect URIs must be HTTPS and match exactly ([Redirect URIs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)), and `GET /me` returns `account_id` for linking accounts ([May 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/may-2026)).

### The Web Playback SDK and COEP

- The SDK makes a browser page a Spotify Connect device. It needs full Premium, excluding mobile-only plans, runs in Chrome, Firefox, Safari, and Edge, and needs Spotify's written approval for commercial use ([Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk)). It plays through EME, and its code references the Widevine and PlayReady key systems ([SDK reference](https://developer.spotify.com/documentation/web-playback-sdk/reference), [embedded/index.js](https://sdk.scdn.co/embedded/index.js)). It documents tracks, episodes, and ads; its code handles chapters ([embedded/index.js](https://sdk.scdn.co/embedded/index.js)), but chapter playback is **unverified**. On iOS, playback after a transfer starts only after a tap ([SDK reference](https://developer.spotify.com/documentation/web-playback-sdk/reference)). Developers reported broken Safari playback, mostly in 2023 ([community thread 5591446](https://community.spotify.com/t5/Spotify-for-Developers/Spotify-WebSDK-Playback-stopped-working-on-Safari-for-Desktop/td-p/5591446)), and the state in 2026 is **unverified**.
- The SDK cannot run on Yolo's player page. The player sends COOP `same-origin` and COEP `credentialless` on every path (`clients/player/public/_headers`). The SDK script creates a hidden iframe to `https://sdk.scdn.co/embedded/index.html` ([spotify-player.js](https://sdk.scdn.co/spotify-player.js)), which on 2026-10-14 was served with neither COEP nor CORP, and the HTML standard blocks such an iframe inside a COEP page ([HTML embedder-policy check](https://html.spec.whatwg.org/multipage/browsers.html#check-a-navigation-response's-adherence-to-its-embedder-policy)). `<iframe credentialless>` exists only in Chrome ([Chrome blog](https://developer.chrome.com/blog/iframe-credentialless)), and the SDK creates its iframe without it. This conclusion follows from the standard; no browser test has confirmed it.
- The player build may not reference other hosts, so that no third party learns every screen's address (`service/control/test/integration/third-party-origins.test.js`).
- **The `/listen` page.** A same-origin `/listen` path can detach COEP with a `! Cross-Origin-Embedder-Policy` rule in `_headers` while `/*` keeps it ([Cloudflare headers](https://developers.cloudflare.com/workers/static-assets/headers/)). The page shares the origin's storage, and with it the device credential, and the player navigates to it and back in the same tab. It needs a path-scoped exception in the third-party-origins test and room for `sdk.scdn.co` in the content security policy that [Yolo 1.0](2026-10-11-yolo-1-0.md) plans. A popup is worse: COOP cuts its link to the opener, as the [canvas engine](../../implemented/architecture/2026-04-04-canvas-playback-engine.md) note records.

### The car and Approved Devices

Spotify's Developer Terms license an app only "on Approved Devices": "desktop computers, laptops, netbook PCs, tablets, mobile, and such other devices that we approve in writing" ([Developer Terms](https://developer.spotify.com/terms)). A car is not on that list, so read literally, any Spotify feature on the Tesla screen is outside the license. Widevine in Tesla's browser and SDK audio continuing while the car drives are both **unverified**, and Tesla can freeze a media element while the car moves ([canvas engine](../../implemented/architecture/2026-04-04-canvas-playback-engine.md)). In the car the audio stays on the car's own Spotify app, which since software 2024.38 signs in with the owner's own Spotify account ([Model Y Owner's Manual, Media](https://www.tesla.com/ownersmanual/modely/en_us/GUID-7A85FB6B-9DF6-4C55-A2F9-793207E48E9D.html)).

### Lyrics

- **Spotify offers no lyrics.** The Web API has no lyrics endpoint ([Feb 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)), and in-app lyrics come from a Musixmatch partnership ([Spotify newsroom 2021-11-18](https://newsroom.spotify.com/2021-11-18/you-can-now-find-the-lyrics-to-your-favorite-songs-in-spotify-heres-how/)). The undocumented `spclient.wg.spotify.com/color-lyrics/v2/…` endpoint needs a web-player token ([community thread 5429280](https://community.spotify.com/forum/en/discussion/5429280/get-lyrics)), and the Terms' "improperly access" clause excludes it ([Developer Terms](https://developer.spotify.com/terms)).
- **LRCLIB** is free and keyless, and its terms allow use in apps while leaving lyrics copyright with the user ([LRCLIB docs](https://lrclib.net/docs), [LRCLIB terms](https://lrclib.net/assets/TermsView-e07a6269.js)). `GET /api/get` with title, artist, album, and duration, matched within ±2 seconds, returns `syncedLyrics` in LRC and `plainLyrics`. A client identifies itself with a `User-Agent`, sends one request at a time, and honors 429 with `Retry-After`; a 503 can occur. A spot check of 14 popular Chinese and English songs on 2026-10-14 found synced lyrics for all 14; coverage of less popular songs is **unverified**.
- **Musixmatch** is the licensed route, but synced lyrics (`matcher.subtitle.get`) need the paid Grow plan ([matcher.subtitle.get](https://docs.musixmatch.com/api-reference/lyrics-catalog/matcher-subtitle-get)), and its pricing is **unverified** ([pricing](https://www.musixmatch.com/pro/api/pricing)).

### Audiobook text

Spotify exposes no audiobook text or transcript through any API. Chapter and audiobook objects carry only a description ([Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter)), and Page Match, which moves between a printed or e-book page and the audiobook, is an in-app feature with no developer access ([Spotify newsroom 2026-02-05](https://newsroom.spotify.com/2026-02-05/bookshop-partnership-page-match-announcement/)).

The only legitimate text source is a DRM-free EPUB that the owner already has. Yolo would map Spotify's chapter number and name to the EPUB's table of contents, and scroll within a chapter in proportion to `progress_ms / duration_ms`. This is approximate, and its accuracy is **unverified**: narration pace varies, and front matter shifts the mapping. Word-level sync would need the audio, which the boundary forbids. A DRM-protected ebook is out too, because removing its DRM is also circumvention.

### Terms and Policy

| Clause | Text, abridged | Bearing on Yolo |
|---|---|---|
| AI | Do not use Spotify Content "to train a machine learning or AI model or otherwise ingesting Spotify Content into a machine learning or AI model"; Spotify Content includes metadata and user data ([Developer Terms](https://developer.spotify.com/terms)) | Read literally, MCP tools that return titles and positions to ChatGPT or Claude ingest Spotify Content. This is the largest risk on the agent side. |
| Voice | "Do not create a voice-enabled SDA that enables a user to control Spotify with their voice" ([Developer Policy](https://developer.spotify.com/policy)) | An agent's voice mode controlling Spotify through Yolo would match, and Yolo cannot tell whether an agent uses voice. |
| Streaming | Controlling a background Spotify application counts as Streaming ([Developer Terms](https://developer.spotify.com/terms)), and Streaming may not be commercial ([Developer Policy](https://developer.spotify.com/policy)) | Option B's control and Option C's playback are both Streaming. |
| Other services | "Do not create any product or service which is integrated with streams or content from another service." ([Developer Policy](https://developer.spotify.com/policy)) | Spotify items in Yolo's queue would match. Third-party lyrics beside Spotify playback is an interpretation risk. |
| Overlap | Do not let a device overlap Spotify Content with other audio ([Developer Policy](https://developer.spotify.com/policy)) | Yolo offers "Pause Spotify?" as a prompt, never an automatic pause. |
| Storage | Do not store Spotify Content indefinitely, or build databases of it beyond what is strictly necessary ([Developer Terms](https://developer.spotify.com/terms)) | Yolo reads Spotify's position live and never writes it into history. |
| Attribution | Show Spotify's logo and a link back ([Developer Policy](https://developer.spotify.com/policy)), and do not crop or overlay cover art ([Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter)) | The card carries the logo, an "Open in Spotify" link, and uncropped art. |
| User data | Offer an easy way to disconnect, and delete the data on disconnect ([Developer Policy](https://developer.spotify.com/policy)) | "Disconnect Spotify" on the owner page deletes the tokens. |
| Naming | An app name should not begin with "Spot" ([Developer Policy](https://developer.spotify.com/policy)) | The owner names the dashboard app something like "Yolo". |

Spotify's remedy for a breach is to revoke access or the license ([Developer Policy](https://developer.spotify.com/policy), [Developer Terms](https://developer.spotify.com/terms)). For one private user this is a risk to judge, not a certainty either way.

## Fit with Yolo's architecture

### An external-session plugin

Spotify is neither a source plugin nor Hub state.

- **Not a source.** A source plays by returning an Input from `prepare()` that the node serves ([media pipeline](../../implemented/architecture/2026-10-11-node-media-pipeline.md)), and Spotify audio never passes through the node.
- **Not Hub state.** The Hub owns one queue, one active device, and Yolo's progress ([Hub and realtime channel](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md)). A Spotify session is a second, parallel session that Spotify owns, and folding it into the Hub's playback state would claim control that Yolo does not have.
- **An external-session plugin.** Its control entry reports Spotify's session in a provider-neutral shape. The player shows it beside Yolo's own state, never inside the queue, and Yolo's tap rules (`play-target.js`) never target it. Lyrics come from a separate metadata plugin.

### Host features

Plugins import only `@useyolo/plugin-api`, and `service/` names no provider ([plugin architecture](../../implemented/architecture/2026-10-11-plugin-architecture.md)). A control entry gets only `plugin`, `options`, `log`, `z`, `registerTool`, and `registerDnsProvider` today (`service/control/src/plugins.js`). The plugin needs four provider-neutral host features:

1. **Account linking.** Either `registerRoute` under `/v1/plugins/<plugin>/…`, or a narrower `registerAccountLink({ authorize, exchange, refresh })` that core drives from the passkey-protected `/account` page. The narrower form keeps routes and owner-session checks in core. A [protocol plugin](../../implemented/architecture/2026-10-11-plugin-architecture.md) would also need control-plane routes.
2. **Per-user sealed storage.** A provider-neutral D1 table such as `plugin_secrets(user_id, plugin, name, value, updated_at)`, whose values are sealed with a key derived from `NODE_SECRET`, as image links already are, in the next numbered migration ([D1 data model](../../implemented/architecture/2026-10-07-d1-data-model.md)).
3. **External sessions.** `registerExternalSession({ get(ctx) })` returns `{ provider: { name, logo }, kind, title, subtitle, artwork, durationMs, positionMs, playing, at, device: { name, type }, link, actions? }`. Core serves it at `GET /v1/external` under the `read` scope, and `remote.js` renders it as an external card below the now-playing bar. Option B adds `act(action, args)` under the `control` scope.
4. **Lyrics lookup.** A node entry calls `registerLyrics(id, { lookup({ title, artist, album, duration }) })`, which returns `{ synced: [{ t, text }] | null, plain: string | null, attribution: { name, url } }`. The node serves it at `/internal/v1/lyrics`, and `/v1/lyrics` proxies it through `nodeFetch()`. This is the first interface of the metadata plugin type, which the plugin architecture lists without one. The lookup runs on the node, so it caches on disk, spends no Worker subrequests, and keeps third-party hosts out of the player. The same lookup could later give Yolo's own music videos a lyrics subtitle.

Option C alone needs a fifth feature: a plugin-served page with its own headers, outside the player build.

### Progress read live, not stored

Spotify keeps each chapter's `resume_point` on its servers and follows the listener across devices ([Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter)). Yolo's history keeps 500 items indefinitely ([progress and resume](../../implemented/feature/2026-10-11-yolo-owns-progress-and-resume.md)), and the Terms forbid storing Spotify Content indefinitely. So Yolo reads Spotify's position live, extrapolates it with the local clock between polls, and never writes Spotify items into `history`. In the plugin API's terms this is the role of `Details.progress`, the source's own watch record, not Yolo's progress.

### Linking and tokens

- Linking uses the Authorization Code flow with PKCE ([PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)), so the plugin stores no client secret, and the public Client ID can sit in the plugin's `options`.
- "Connect Spotify" on `/account` keeps `state` and the PKCE verifier briefly in KV and redirects to Spotify. The callback, for example `https://<host>/v1/plugins/<plugin>/callback`, checks the owner session and `state`, exchanges the code, and stores the refresh token sealed, with Spotify's `account_id` to identify the linked account.
- An access token refreshes lazily on expiry or a 401, a returned refresh token replaces the stored one, and `invalid_grant` shows "Reconnect Spotify". Whether Spotify invalidates the old refresh token on rotation is **unverified**, so refresh stays single-flight per user and retries once after it reads the stored token again.
- `npm run yolo -- doctor` warns 14 days before the 6-month expiry. "Disconnect Spotify" deletes the stored rows.

### Polling cost

- Polling runs only while a Yolo screen shows the card and the page is visible, through a plain Worker route, not the Hub Durable Object. The node cannot push to the control plane, which reaches it only through `nodeFetch()` ([node access](../../implemented/architecture/2026-10-08-workers-vpc-node-access.md)), and a cron trigger would poll while nobody looks.
- The interval is 5 seconds with the lyrics panel open and 15–30 seconds for the card alone. A poll also runs at once when the extrapolated position passes the item's end, the interval grows to 60 seconds after 5 minutes paused, and polling stops while the page is hidden.
- One poll is one Worker request with at most 3 subrequests: the Spotify call, a token refresh at most once an hour, and a chapter lookup on a chapter change. At 5 seconds that is 720 requests an hour, and two hours of open lyrics a day is 1,440 requests, about 1.4% of Workers Free's 100,000 a day ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). Token writes are at most 24 a day. CPU per poll is expected to stay well under 10 ms; this is **unverified**.
- 720 calls an hour is 6 calls per 30-second window. Whether that fits Spotify's unpublished development-mode limits is **unverified**, so Yolo backs off on `Retry-After` and `QUOTA_EXCEEDED`.
- LRCLIB gets one lookup per new track, cached on the node.

### Provider names

The provider-names gate takes each provider from a `plugins/<kind>-<provider>` directory name (`scripts/provider-names.js`). A plugin directory such as `plugins/remote-spotify` makes "spotify" a forbidden name under `service/`, and the gate would then flag the "Spotify-style queue" comment at `service/control/src/store/queue.js:4`. That comment is reworded before or with the plugin. A `plugins/lyrics-lrclib` would forbid "lrclib", which `service/` does not mention. Because every owner must create their own Spotify app and accept the policy risk, the Spotify plugin ships disabled, outside `plugins/official.json`.

## Options

### Option A: a read-only "Now on Spotify" card with lyrics

- **Gives.** The owner links Spotify once. Yolo screens on phones and computers show what Spotify plays and where: the track, or the book with its chapter, position, and resume point. A lyrics panel shows LRCLIB's synced lyrics following the position; for an audiobook it shows the chapter title, description, and narrators. Yolo never writes to Spotify.
- **Scopes.** `user-read-playback-state` and `user-read-playback-position`.
- **Effort.** Small: host features 1 to 4, a control plugin of about 150 lines, a node lyrics plugin of about 100 lines, the external card and lyrics panel in `remote.js`, one D1 migration, and the `queue.js` comment. It needs no MCP tools and no SDK.
- **Risks.** Audiobooks depend on P1. LRCLIB's coverage and uptime are uncertain, and lyrics copyright rests with the owner. Lyrics beside Spotify playback may match the "other services" clause, and enabling the card in the car meets the Approved Devices clause. The owner links Spotify again every 6 months.

### Option B: Option A plus explicit control

- **Gives.** Card buttons for pause, resume, ±30 seconds, and next or previous chapter; a device menu with one-tap "Play in car" or "Play on phone" (`PUT /me/player` with `play: true`, only on a tap); and an optional "Pause Spotify?" prompt when a Yolo video starts on the same device. Only after the owner accepts the policy risk, MCP tools let an agent answer "what chapter am I on?" and "move my book to the car".
- **Agent tools.** Control-entry tools that act only on an explicit request: `spotify_now_playing`, `spotify_devices`, `spotify_control` (pause, resume, next, previous, and seek), `spotify_transfer`, and `spotify_play_audiobook` for a saved audiobook. Their names may say "spotify" because they live in `plugins/`.
- **Scopes.** Option A's, plus `user-modify-playback-state` and optionally `user-library-read`.
- **Effort.** Small to medium on top of Option A: `act()` on the external session, the buttons, five tools, and owner checks P2 and P3.
- **Risks.** The AI and voice clauses apply directly to the MCP tools, the largest policy exposure. Car control depends on P2, and chapter start is unverified. There is no speed control, and Player calls have no guaranteed order.

### Option C: Option B plus "Play here"

- **Gives.** On a phone or computer, one tap moves Spotify playback into Yolo, with lyrics or text beside it. The player navigates to the same-origin `/listen` page without COEP, which creates the SDK player and transfers playback with `play: true`.
- **Scopes.** Option B's, plus `streaming`, `user-read-email`, and `user-read-private`.
- **Effort.** Medium to large: a plugin-served page with its own headers, an exception in the third-party-origins test, room for `sdk.scdn.co` in the content security policy, iOS's tap before playback, and handing the access token to the page.
- **Risks.** Chapters are undocumented in the SDK, and the SDK has iOS limits and a history of breakage. It is not for the car: a car is not an Approved Device, and Widevine and audio in motion are unverified (P4). It gives up "every Yolo page is cross-origin isolated" for one path, and it adds the most surface for the least gain, because on a phone the Spotify app already plays.

## Alternatives considered

**Spotify as a source plugin.** A source returns an Input that the node serves, so Spotify audio would have to pass through the node. It is DRM-protected, and extracting or relaying it is out of bounds.

**Spotify's session inside the Hub.** Spotify items in the Hub's queue and playback state would let Yolo claim control that it does not have, and Spotify's Policy forbids integrating its content with other services' streams. The external card sits beside the Hub's state instead.

**Spotify's private endpoints, such as `color-lyrics`.** They carry Spotify's own synced lyrics, but they are undocumented, need a web-player token, can change at any time, and breach the Terms' "improperly access" clause.

**Musixmatch for lyrics.** It is the licensed source behind Spotify's own lyrics, but synced lyrics need the paid Grow plan, whose price is unverified. The lyrics lookup is provider-neutral, so a Musixmatch plugin can replace LRCLIB later.

**The player calling LRCLIB directly.** It is simpler, but the player may reference no other host, which keeps third parties from learning every screen's address, and the node caches answers on disk.

**Mirroring Spotify progress into Yolo's history.** History would then show audiobooks, but Spotify already keeps the resume point across devices, and the Terms forbid storing Spotify Content indefinitely.

**Polling in the Hub Durable Object or by cron.** The Hub would spend Durable Object requests and duration on state it does not own, and a cron trigger polls while nobody looks. A plain Worker route polled by a visible page costs only Worker requests.

**The Web Playback SDK on the player page.** COEP blocks the SDK's iframe, `<iframe credentialless>` exists only in Chrome, and the SDK creates its iframe without the attribute anyway. Dropping COEP from the player would break the canvas engine's audio clock.

**A popup for the SDK.** The player's COOP cuts the popup's link to its opener, so the two pages would have to talk through the Hub, and popups in Tesla's browser are unverified.

**A Worker secret, as DNS provider plugins use.** A [DNS provider plugin](../../implemented/architecture/2026-10-14-dns-provider-plugins.md) reads a static token that the owner stores with `wrangler secret put` while setting it up. A Spotify refresh token instead arrives at run time through the owner's callback, may change on every refresh, and belongs to one user, so it needs per-user storage that the Worker can write.

**The Authorization Code flow with a client secret.** Spotify accepts it with a secure backend, but PKCE stores no secret, and the Client ID alone can sit in the plugin's options.

**Option C now, or Yolo as a Spotify device in the car.** It is the only way to move the audio into Yolo, but on phones and computers the Spotify app already plays, and in the car it is not licensed, and Widevine and audio in motion are unverified.

**Book text from the audio.** Transcribing or force-aligning Spotify audio would give word-level text, but it processes DRM-protected audio, which the boundary forbids.

## Acceptance criteria

For Option A, the first build:

- `service/` names no provider, and `npm run check` passes with the Spotify plugin in `plugins/`.
- Without the plugin enabled, Yolo behaves as it did before.
- The owner links Spotify once from `/account`. The refresh token is stored sealed in a per-user table, and "Disconnect Spotify" deletes it.
- A web-profile screen shows a card with the playing track or chapter, the Spotify device, the position, Spotify's logo, an "Open in Spotify" link, and uncropped cover art. A 204 shows as unknown, not stopped. The car profile shows no card unless the owner turns it on.
- The lyrics panel shows LRCLIB's synced lyrics following the position, with LRCLIB credited.
- Yolo calls no Spotify write endpoint and no undocumented Spotify endpoint, and writes no Spotify item into the queue or history. No Spotify audio passes through the node or the Worker.
- Polling stops while the page is hidden and never reaches the Hub Durable Object.
- `npm run yolo -- doctor` warns 14 days before the refresh token expires.

## Risks

- **Policy.** The AI, voice, and other-services clauses can be read to cover Yolo's agent tools and its lyrics, and Spotify's remedy is to revoke access. The car is not an Approved Device.
- **Platform change.** Spotify narrowed developer access in 2024, 2025, and 2026, `additional_types` "might be deprecated", and the rate limits are unpublished, so the feature may break without notice. A Premium lapse stops the app.
- **Unverified premises.** Audiobook chapters in `/me/player`, the lag of Spotify's state, the car as a Connect target, chapter start, and chapters in the SDK all wait on owner checks.
- **Upkeep.** The owner creates their own Spotify app, stays its allowlisted user, and links Spotify again every 6 months.
- **LRCLIB.** It is a free community service, with uncertain coverage of less popular songs and uncertain uptime, and lyrics copyright rests with the owner.
- **What it gives up.** Yolo gets no playback-speed control, no audiobook text from Spotify, and by default no Spotify card in the car, and Option C would leave one path not cross-origin isolated.
