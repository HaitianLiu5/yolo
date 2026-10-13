# Agent Note: One repository, rewritten in one pass

Status: implemented

English | [中文](2026-10-07-one-yolo-repository.zh.md)

## Problem

Turning Drive-In into Yolo meant renaming the project and splitting a single server process, its CLI, and its player into a service, plugins, and clients. The playback engine's history matters: many Tesla-specific details exist only because of a past failure, and their reasons live in old commits. The migration also had to avoid leaving the owner without a working player in the car.

## Decision

- **Service and clients first.** The protocol was designed for several devices and clients from the start, before any MCP work landed, so the later rename only changed names.
- **One pass, then a move.** The code was rewritten in one pass, module by module, inside the drive-in repository up to 0.2. From 2026-10-11 development continues in the public repository [`HaitianLiu5/yolo`](https://github.com/HaitianLiu5/yolo), which carries the full Git history of Drive-In; the drive-in repository is archived.
- **One repository for all of Yolo.** npm workspaces hold the service in `service/` (`core`, `plugin-api`, `control`, `node`), the official plugins in `plugins/`, and the clients in `clients/`. Drive-In is Yolo's Tesla client (`clients/tesla`), not a separate product or repository.
- **The old server went last.** The old Drive-In server (`server/`), its CLI (`cli/`), and the node's bridge to it (the `node:legacy` renderer) are deleted; the condition for merging their removal was that `npm run check` pass on the new architecture and that the four stream types (`hls`, `direct`, `dash_split`, `plex`) be checked in the car. Their removal also took the CLI out of the workspaces, CI, the release workflow, `CODEOWNERS`, the pull-request template, the README, and `.env.example`, and rewrote the shipped skill, now [`skills/yolo/SKILL.md`](../../../../skills/yolo/SKILL.md), for the MCP server.

### Deferred

`@drive-in/cli` is still published on npm without a deprecation notice; deprecating it with `npm deprecate @drive-in/cli "Use the Yolo MCP server"` (never `unpublish`) is a manual owner step. Removing the `drivein.haitian.site` route and the old server's launchd service (`com.haitian.drivein.server`) also happens outside the repository.

## Alternatives considered

**Build MCP for Drive-In first and split the service later.** That would have meant a second rewrite once the split came.

**Incremental replacement (strangler pattern).** Not used: Yolo was rewritten in one pass, and checking every stream type in the car before deleting the old server replaces a long period of running both.

**Split the repository only at the 1.0 rename, or start the new repository from a clean initial commit.** A clean start would lose the reasons behind the engine's Tesla-specific behavior that Git history records.

**Directories by runtime, or Drive-In in its own repository as an independent client.** The service, plugins, and clients evolve together, and keeping them in one repository lets one commit change the protocol on both ends; the owner decided on 2026-10-11 that Drive-In merges into Yolo.

## Consequences

A protocol change, its server side, its client side, and their tests land in one commit and one `npm run check`. `git log --follow` reaches Drive-In's history for any engine file. The repository is public, so configuration examples and notes must never carry secrets. The one-pass rewrite concentrated risk in a single switch-over, which the car check mitigated; the remaining retirement steps depend on the owner.
