# Agent Note: Emulate a Plex Media Server for third-party clients

Status: rejected — plex.tv's claim mechanism and Plex's terms do not allow it

English | [中文](2026-10-11-emulate-a-plex-media-server.zh.md)

## Problem

Apple TV, iPhone, iPad, and Mac have no Yolo client, and native apps cost App Review and yearly maintenance. Polished players that speak Plex's protocol already exist on every one of those devices — Plex's own apps and Infuse among them — so making Yolo look like a Plex Media Server would give it those clients at once.

## Proposal

Yolo would implement the Plex Media Server API, so Plex apps and Infuse connect to Yolo as if it were a Plex server, browse its library, play through its media pipeline, and report progress back.

## Alternatives considered

**A Jellyfin-compatible protocol plugin** ([proposal](../../rejected/feature/2026-10-11-jellyfin-protocol-plugin.md)). Jellyfin's API is open, compatible servers already exist (AioFin, Remux), Infuse speaks it for manual playback, and Swiftfin accepts server-pushed remote commands. It is the chosen path for Apple devices.

**Native apps.** They need App Review (guidelines 2.1 and 5.2.3) and yearly maintenance; a native tvOS app remains only the fallback if Swiftfin's remote control proves unreliable.

**Why this loses:** Plex clients find and authorize servers through plex.tv, where a server is claimed by a Plex account, and Plex's terms do not allow an emulated server; a Yolo that impersonated Plex would depend on a mechanism it is not permitted to use.
