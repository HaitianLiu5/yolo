# Agent Note: One repository, rewritten in one pass

Status: implemented

English | [中文](2026-10-07-one-yolo-repository.zh.md)

## Problem

Yolo grew from a single home server process, its CLI, and a Tesla-only browser player into a service, plugins, and clients. The playback engine's history matters: many Tesla-specific details exist only because of a past failure, and their reasons live in old commits. The change also had to keep a working player in the car throughout.

## Decision

- **One repository for all of Yolo.** npm workspaces hold the service in `service/` (`core`, `plugin-api`, `control`, `node`), the official plugins in `plugins/`, and the player in `clients/` (`clients/tesla`). The player is part of Yolo, not a separate product or repository.
- **The full history is kept.** Yolo began as Drive-In, a Tesla-only player with its own home server, and the public repository [`HaitianLiu5/yolo`](https://github.com/HaitianLiu5/yolo) carries that project's whole Git history, so `git log --follow` reaches the reasons behind the engine's Tesla-specific behavior.
- **Service and clients first, rewritten in one pass.** The protocol was designed for several devices and clients before any MCP work landed, and the code was rewritten module by module in one pass. The earlier server (`server/`), its CLI (`cli/`), and the node's bridge to it (the `node:legacy` renderer) were deleted only after `npm run check` passed on the new architecture and the four stream types (`hls`, `direct`, `dash_split`, `plex`) were checked in the car.

## Alternatives considered

**Add MCP to the earlier server first and split the service later.** That would have meant a second rewrite once the split came.

**Incremental replacement (strangler pattern).** Not used: Yolo was rewritten in one pass, and checking every stream type in the car before deleting the earlier server replaces a long period of running both.

**Split the repository only at the 1.0 rename, or start the new repository from a clean initial commit.** A clean start would lose the reasons behind the engine's Tesla-specific behavior that Git history records.

**Directories by runtime, or the player in its own repository as an independent client.** The service, plugins, and clients evolve together, and keeping them in one repository lets one commit change the protocol on both ends.

## Consequences

A protocol change, its server side, its client side, and their tests land in one commit and one `npm run check`. `git log --follow` reaches the earlier project's history for any engine file. The repository is public, so configuration examples and notes must never carry secrets. The one-pass rewrite concentrated risk in a single switch-over, which the car check mitigated.
