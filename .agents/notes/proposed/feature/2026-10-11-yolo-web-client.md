# Agent Note: Yolo Web, a browser client with settings

Status: proposed

English | [中文](2026-10-11-yolo-web-client.zh.md)

## Problem

The Tesla client is Yolo's only screen. On a computer or phone, the owner cannot browse the library, play in the browser, or use the browser as a remote for the car. There is also no settings page: revoking an agent means deleting its records from `OAUTH_KV` by hand, and passkeys and devices can be managed only through `/v1` and MCP ([OAuth](../../implemented/architecture/2026-10-07-oauth-authorization-server.md)).

## Proposal

Version 0.4 adds **Yolo Web**, completing phase one ([Yolo 1.0](2026-10-11-yolo-1-0.md)):

- Opening the same address in a computer or phone browser and signing in with a passkey shows a client that browses and searches the libraries, plays in the browser, and remote-controls whichever device is playing, including the car.
- It reuses the playback engine with a different [capability profile](../../implemented/architecture/2026-10-07-capability-negotiation.md), and the same [realtime channel](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.md) that stays in the core; any device can act as a remote.
- A settings page manages sources, plugins, devices, agent authorizations, and passkeys.

The complexity is medium: the work is mostly a new interface, since the engine and the realtime channel are reused.

## Alternatives considered

**A device plugin for the web client.** Both phase-one clients are Yolo's own and speak the same protocol, so the realtime channel stays in the core; an interface with a single implementation could not be designed well.

## Acceptance criteria

On a computer and on a phone, the owner opens the control plane's address, signs in with a passkey, browses and searches the libraries, plays an item in the browser, moves playback to and from the car, and in settings revokes an agent, removes a device, and adds or removes a passkey, without touching `OAUTH_KV` or calling `/v1` by hand.

## Risks

Reusing the canvas engine brings its cross-origin isolation (COOP/COEP) to every page of the web client, which rules out pop-up sign-in there as on the car ([canvas engine](../../implemented/architecture/2026-04-04-canvas-playback-engine.md)). A browser that is also a remote must not answer the Hub's broadcasts, or it loops with the Hub. Revoking agents from a settings page needs the OAuth provider's grant listing and revocation, which Yolo does not use yet.
