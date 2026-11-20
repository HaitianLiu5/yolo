# Agent Note: A library protocol for the owner's other media apps

Status: proposed

English | [中文](2026-11-11-library-protocol.zh.md)

## Problem

The owner runs other apps of their own that keep video Yolo should play. The first is a pipeline that downloads videos, adds Chinese subtitles, and keeps each one in a private Cloudflare R2 bucket behind its own Worker: an original file (often AV1 with Opus), an H.264 and AAC copy when the original is not, a zh-CN WebVTT track, a cover, and a description, for about 30 days. None of it reaches Yolo today. That app's own record says Yolo may only watch, and must read a stable read-only export rather than its job folders.

Writing one source plugin per app would put each app's layout into Yolo. What is missing is one read-only contract that any such app can serve and one plugin that reads it, so a new app needs work only on its own side. Whatever Yolo plays from it can then be kept on a device for offline viewing, because downloads keep the stream Yolo serves, whatever source is behind it.

## Proposal

A protocol, `yolo-library/1`: read-only HTTPS with JSON, a bearer token, and media read with byte ranges. A generic official plugin, `source-library`, reads any number of libraries that serve it. Neither knows a specific app: the plugin's configuration names each library's address, and nothing else.

### The protocol

| Request | Answer |
| --- | --- |
| `GET {base}/` (no token) | `{ protocol: "yolo-library/1", title, authorize, token }`, and with a token `libraries: [{ id, title, kind }]` |
| `GET {base}/libraries/{id}/items?cursor=&limit=` | `{ items: [Entry], next }`, newest first |
| `GET {base}/search?q=&limit=` | `{ items: [Entry] }` |
| `GET {base}/items/{id}` | `Item` |
| A media or subtitle URL | The bytes, with `Range` and 206; an MP4 has its index first |

- **Entry**: `id`, `title`, `kind` (`video`, `movie`, or `episode`), `thumbnail`, `duration` in seconds, `date`, `updatedAt`. The `id` stays the same for the same content: history, resume, and saved track choices are keyed by it.
- **Item**: an Entry with `description`, `url` (the work's public page), `people`, `tags`, `chapters: [{ start, end?, title }]`, `expiresAt` (when the library removes it, or null), `media`, and `subtitles`.
- **media**: versions of the same work, each `{ id, url, alternates?, container, video: { codec, width, height, fps }, audio: [{ codec, channels, language? }], bytes, kbps, sha256? }`. Codecs use the RFC 6381 prefixes that [capability negotiation](../../implemented/architecture/2026-10-07-capability-negotiation.md) uses (`av01`, `avc1`, `opus`, `mp4a`). At least one version is H.264 and AAC in MP4, because Yolo passes a remote file through without transcoding it. `alternates` are other URLs of the same bytes, such as a LAN address.
- **subtitles**: `[{ id, language, name, url, default? }]`, each WebVTT, with ids that stay the same.
- JSON answers carry an `ETag`. An error is an HTTP status with `{ error: { code, message } }`: 401 for a missing or revoked token, 404 for an item that is gone, 503 for a library that cannot answer now. A field added stays `/1`; only an incompatible change makes `/2`.

Version 1 leaves out writes (the app's own interface keeps them), HLS and live streams, timed comments, and the app's own watch progress, which Yolo keeps itself.

### Authorization

Every library issues its token through one device-code grant, the shape Yolo's own [screen pairing](../../implemented/feature/2026-10-07-device-code-pairing.md) uses, so no one copies a token by hand:

1. The plugin sends `POST {authorize}` with `{ client: "Yolo", name }` and gets `{ deviceCode, userCode, verificationUri, interval, expiresIn }`.
2. Yolo shows the link and the code, also as a QR code, through the plugin's setup entry in `npm run yolo -- accounts`, the entry Tencent's WeChat sign-in uses ([Tencent Sports replays](../../implemented/feature/2026-10-26-tencent-sports-replays.md)).
3. The owner approves the code on the library's own page, behind the library's own sign-in.
4. The plugin polls `POST {token}` with the device code and gets `{ accessToken }`, which it keeps in its state directory, mode 600, outside Git and `yolo.config.json`.
5. The library lists the clients it authorized and revokes any of them; the plugin then gets 401 and asks for a new grant.

A token reads only, and lasts until it is revoked.

### The plugin

```json
{ "source": "./plugins/source-library",
  "options": { "libraries": [{ "id": "studio", "url": "https://studio.example/api/v1/library", "title": "Studio" }] } }
```

It maps the protocol onto the [source plugin API](../../implemented/architecture/2026-10-11-source-plugin-api.md): `libraries()`, `items()`, and `search()` onto the lists; `describe()`, `details()`, and `chapters()` onto `GET items/{id}`, held briefly in memory; `tracks()` and `subtitle()` onto `subtitles`; `health()` onto `GET {base}/`. `prepare()` asks the context's `playable()` about each version and returns the first the device plays directly within `limits.maxVideoKbps`, else the smallest H.264 one, as `{ type: "file", url, headers, alternates, cacheKey }`, with the version's `sha256` as the cache key. A Mac that decodes AV1 plays the original; a phone or a car plays the copy. Sources are `{ plugin: "library", id: "<library id>/<item id>" }`.

The plugin is added through the [`yolo-add-official-plugin`](../../../skills/yolo-add-official-plugin/SKILL.md) workflow, off by default. It changes neither `/v1` nor `/internal/v1`, so neither `CLIENT_PROTOCOL` nor `NODE_PROTOCOL` moves and no client changes.

### Offline copies

Downloads need nothing from a library beyond what playback needs, with two things a library's videos make visible: a download keeps the item's text subtitle tracks with the video, since they are separate WebVTT files; and it asks for the stream with the device's real capabilities, so `prepare()` picks a version the device decodes. A copy on a device outlives the library's `expiresAt`.

### Plan

1. This note.
2. `plugins/source-library` with unit tests against a scripted library and an e2e test that plays and seeks one item; `npm run check`.
3. The first library implements the protocol in its own repository and deploys it there.
4. With the release that carries the plugin and the owner's approval of the upgrade: the grant, then one item played in the car and on the phone, and one downloaded.

## Alternatives considered

**A plugin for one app that reads its job folders.** The fastest start on the machine both run on, and every video on its disk. It ties Yolo to another app's private layout, which that app itself ruled out, and works only on that machine.

**The app's R2 bucket read directly with an S3 key.** No new routes on the app, but Yolo would hold a key to the whole bucket, learn its key layout, and still need the catalog the Worker keeps in D1.

**A token pasted into an environment variable.** Simpler to build, but every library would need its own instructions, and a leaked or stale token has no place where the owner sees or revokes it.

**HLS as the only delivery.** Universal on Apple devices, but it makes every library segment its files. Every app in view already keeps MP4, which Yolo reads by range and serves to any screen.

## Acceptance criteria

- A library added in `yolo.config.json` and authorized with `npm run yolo -- accounts` lists its items on the home screen and in search, and an agent finds them with `search`.
- An item plays and seeks in the car and on an iPhone without an AV1 decoder, with its WebVTT subtitles, from the H.264 version; a device that decodes the original plays the original.
- History and resume survive a restart of the node and of the library.
- A revoked token makes the library's items say so, and a new grant brings them back without a restart.
- An item downloaded on the iPhone plays with its subtitles in airplane mode after the library removed it.

## Risks

- A library that keeps items for a short time leaves gaps in history and Continue rows; `expiresAt` lets screens say so but cannot keep the video.
- Media goes from the library to the node and on to the device: through a Worker, the library's own egress and request limits apply.
- Share links let a friend watch one item. Videos that belong to other creators may need the plugin to refuse share links for a library, which the owner decides per library.
