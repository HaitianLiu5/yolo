# Agent Note: Downloads to watch offline on iPhone and iPad

Status: implemented

English | [中文](2026-11-11-offline-downloads.zh.md)

## Problem

The owner travels with no network, on a plane or abroad, and wants the iPhone and iPad app to keep videos on the device and play them there. Yolo had no way to do that: every stream is prepared by the node for a screen that plays it as it arrives. A copy must not depend on which source plays the item, because new sources, such as an editing project's renders served by a plugin, should be kept offline the same way.

## Decision

The iPhone and iPad app keeps a whole stream of an item on the device, as Yolo serves it, and plays it from there with the system's player. It needs no server change, so it works on any release with share links.

### Where the stream comes from

A copy asks for its stream the way a friend's browser does ([share links](2026-10-20-share-links.md)): `POST /v1/shares` for the item, then `POST /v1/share/<token>/stream` with the device's real capabilities and viewport (`APIClient.offlineStream` in [`Offline.swift`](../../../../clients/apple/YoloKit/Sources/YoloKit/Offline.swift)). That stream never reaches the Hub, so making a copy changes no screen's session, history, progress, or track preferences, and the node keeps it apart from the owner's own sessions. It is prepared for remote direct play when the probes found that path working from here, else for the relay. The share link stays on the device only, for asking again when a copy goes on later; it expires after seven days as any other and the owner can revoke it in settings.

Because the copy is of what Yolo serves, it knows no source: whatever a source plugin returns from `prepare()`, transcoded or not, is what is kept. The capabilities sent are the device's own, so a source chooses what this device decodes.

### How a stream is kept

`OfflineCopier` writes each item into its own folder:

- **MP4** is fetched in 8 MiB ranges and appended to a partial file, then played from the file.
- **HLS** is mirrored file by file. A master playlist keeps one variant, the highest bandwidth, with its default audio rendition; I-frame and subtitle renditions go. Every segment, init section, and AES-128 key is fetched four at a time and named by its path without the media token, so a new stream of the same item names its files alike and a copy left part way goes on from what it has. A playlist still growing (a transcode being made) is read again every two seconds until it ends; a sliding live window, or one that stops growing for three minutes, is refused. FairPlay keys are refused.
- **Text subtitles** the stream delivers as WebVTT are kept beside the video, except tracks still being made. The one Yolo chose shows by default, else one in Chinese.

AVPlayer plays HLS only over HTTP, so `LocalMediaServer` ([`LocalMediaServer.swift`](../../../../clients/apple/YoloKit/Sources/YoloKit/LocalMediaServer.swift)) serves the folders on 127.0.0.1 at a free port, with byte ranges, refusing any path outside them.

### The app

[`Downloads.swift`](../../../../clients/apple/iOS/Downloads.swift) keeps the list in Application Support/Offline, excluded from backups, and copies one item at a time while the app is open: the screen stays on, and the app asks for time to finish when it is left. A copy that stopped for want of the network goes on when the app comes back; one Yolo refused says why. An item's page has a Download button beside Play, with the best quality this device plays or a smaller file (2 Mbps); the Downloads tab lists the copies, plays them from where they were left with the system's player and the kept subtitle drawn over it, and chooses or turns off the subtitle and deletes a copy from a long press. The tab works without a network, since the paired app opens without one.

## Alternatives considered

**`AVAssetDownloadURLSession`.** It downloads HLS in the background and plays the result natively, but it does not run in the Simulator, it treats a playlist that is still growing as live, and it gives no way to keep the separate WebVTT tracks Yolo serves, so it could not be proven on the Mac or used for transcodes.

**A download route on the server.** A `/v1` route for a copy's stream, or the node packaging a file for download, would be cleaner than a share link but needs an upgrade of the control plane and the node before any copy works.

**A download through the Hub, as a screen plays.** It would take over this screen's session and write history and progress for a video nobody watched.

**Background downloads.** A background `URLSession` would go on with the app closed, but the system delays and batches many small segment requests, and a transcode's playlist must be read while it grows.

## Consequences

The owner can keep any video Yolo can play, from every source, on an iPhone or iPad, with its subtitles. Each copy leaves a share link on the owner's list, and while copying it holds one of the node's two places for friends' streams. Copies are made only while the app is open, so a long one wants the phone left on a charger. Copies are not shared with the Mac or other devices, and progress watched offline stays on the device; Yolo's history does not hear it. A stream whose source protects it with FairPlay, or a live one, cannot be kept.
