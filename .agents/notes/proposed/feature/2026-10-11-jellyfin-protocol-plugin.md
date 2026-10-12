# Agent Note: A Jellyfin-compatible protocol plugin for Apple devices

Status: proposed

English | [中文](2026-10-11-jellyfin-protocol-plugin.zh.md)

## Problem

iPhone, iPad, Apple TV, and Mac have no Yolo client. Building native apps means passing App Review and maintaining them every year, while good third-party players already exist. Research in 2026-10 found that Infuse does not accept remote commands pushed by a server while Swiftfin 1.6 does, and that a Jellyfin-compatible API has been done before (AioFin, Remux).

## Proposal

Version 0.6 adds a **protocol plugin that exposes a Jellyfin-compatible API**, with a control-plane half (the API and session push) and a node half (media):

- Infuse (manual playback) and Swiftfin (agent remote control) connect straight to Yolo, and their progress syncs back to Yolo.
- The pairing code a TV shows in Quick Connect can be approved by an agent or in Yolo Web.
- Jellyfin sessions join the Hub's device model, so agents can remote-control Swiftfin through MCP without knowing which protocol a device speaks. This first third-party device is where the device-plugin interface gets designed ([Hub](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md)).
- Android's Jellyfin clients should work in theory but are not guaranteed.

**An experiment comes first.** Run a real Jellyfin server on the Mac mini and confirm three things: which remote commands Swiftfin on tvOS executes; what `SupportsMediaControl` an Infuse session reports in `GET /Sessions`; and which formats Infuse plays directly. The results decide how 0.6 is built and whether a native tvOS app is needed (risk 1 of [Yolo 1.0](2026-10-11-yolo-1-0.md)).

## Alternatives considered

**Native apps first.** They must pass App Review (guidelines 2.1 and 5.2.3) and be maintained every year. A native tvOS app remains the fallback if Swiftfin's remote control proves unreliable; it would speak the same Jellyfin session protocol, so the service and MCP stay unchanged, but it brings Swift into the project and needs the owner's separate approval.

**Emulating a Plex server.** [Rejected](../../rejected/architecture/2026-10-11-emulate-a-plex-media-server.md): plex.tv's claim mechanism and Plex's terms do not allow it.

**Remote-controlling Infuse.** Infuse does not accept server-pushed commands, so Yolo uses it for manual playback only.

## Acceptance criteria

Infuse and Swiftfin on the owner's Apple devices connect to Yolo, browse its library, and play; their progress appears in Yolo's history; a Quick Connect code is approved by an agent or in Yolo Web; and an agent starts, pauses, and seeks playback on Swiftfin on the Apple TV through MCP.

## Risks

The compatible API is about 40 to 60 endpoints, and Infuse has many special behaviors. No existing project implements session push, so that part has no reference. Everything must be verified on real devices. If Swiftfin's remote control is unreliable, agent control of Apple TV needs the native app above.
