# Agent Note: Distribute Yolo to other owners

Status: proposed

English | [中文](2026-10-11-distribution-to-other-owners.zh.md)

## Problem

Yolo is deployed by hand for one owner: wrangler commands for the control plane, a cloned repository and a launchd service for the node, and plugins configured by editing JSON and redeploying ([deployment](../../implemented/architecture/2026-10-07-control-plane-on-cloudflare-media-node-at-home.md)). Nobody else could set it up without reading the code.

## Proposal

The versions from 0.7 to 1.0 make Yolo installable by other owners, each on their own Cloudflare account and domain:

- **One command deploys the control plane.**
- **Node packages:** Docker images for Synology, QNAP, Unraid, and TrueNAS, and a macOS installer that runs the node as a LaunchDaemon, which LAN plugins need (Apple TN3179).
- **A first-run setup wizard**, ending with the passkey registered through the node's code.
- **`yolo install`** for plugins from npm, git, or a local directory at pinned versions: it updates the configuration, redeploys the control plane (Workers cannot load code at runtime), and restarts the node.
- **Plugin API documentation and an example plugin**; the `useyolo.app` promotional site and documentation go live.
- **Backup and restore, usage guardrails, and a security review.**

The complexity is medium: the work is wide rather than deep, packaging and testing on many platforms.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Acceptance criteria

A new owner with a Cloudflare account and a NAS, computer, or Mac installs Yolo with the published instructions — one command for the control plane, a package for the node, and the setup wizard — registers a passkey with the node's code, pairs a screen, installs a plugin with `yolo install`, and restores from a backup.

## Risks

Every NAS platform and macOS version needs its own packaging and testing. Publishing Yolo for others raises the question of Cloudflare's terms for proxied video ([open question](../process/2026-10-07-cloudflare-video-terms.md)), and owners without Cloudflare remain unsupported ([self-hosting without Cloudflare](../architecture/2026-10-07-self-hosting-without-cloudflare.md)). The plugin API must be stable enough at 1.0 to document.
