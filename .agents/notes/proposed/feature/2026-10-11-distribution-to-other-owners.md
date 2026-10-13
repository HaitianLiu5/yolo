# Agent Note: Distribute Yolo to other owners

Status: proposed

English | [中文](2026-10-11-distribution-to-other-owners.zh.md)

## Problem

An owner's agent can now deploy, check, upgrade, and roll back an instance from a clone of the repository, stopping at the steps only the owner can take ([agent deployment](../../implemented/feature/2026-10-13-agent-deployment.md)). A person without an agent still has to run those commands from a terminal on a Mac or Linux machine, a NAS has no package at all, and plugins are added by editing JSON and redeploying.

## Proposal

Version 0.9 builds on those commands so that anyone can install Yolo ([the path to 1.0](2026-10-11-yolo-1-0.md)), each owner on their own Cloudflare account and domain:

- **Node packages:** Docker images for Synology, QNAP, Unraid, and TrueNAS, and a macOS installer that runs the node as a LaunchDaemon, which LAN plugins need (Apple TN3179); `npm run yolo -- service install --daemon` only stages one for an administrator today.
- **A first-run setup wizard** that runs `init`, `provision`, `migrate`, `deploy`, and `service install`, and ends with the passkey registered through the node's code.
- **`yolo install`** for plugins from npm, git, or a local directory at pinned versions: it updates the configuration, redeploys the control plane (Workers cannot load code at runtime), and restarts the node, the steps [`skills/yolo-add-source-plugin`](../../../../skills/yolo-add-source-plugin/SKILL.md) takes by hand.
- **Plugin API documentation**, beyond the [example plugin](../../../../plugins/source-example/); the `useyolo.app` promotional site and documentation go live.
- **Backup and restore of a whole instance** (D1, KV, the instance file, and `.env`), beyond the D1 export before each migration; **usage guardrails**; and **a security review**.

The complexity is medium: the work is wide rather than deep, packaging and testing on many platforms.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Acceptance criteria

A new owner with a Cloudflare account and a NAS, computer, or Mac installs Yolo with the published instructions — one command for the control plane, a package for the node, and the setup wizard — registers a passkey with the node's code, pairs a screen, installs a plugin with `yolo install`, and restores from a backup.

## Risks

Every NAS platform and macOS version needs its own packaging and testing. Publishing Yolo for others puts every owner's account under Cloudflare's terms for proxied video ([media off the Worker](../architecture/2026-10-13-media-off-the-worker.md)), and owners without Cloudflare remain unsupported ([self-hosting without Cloudflare](../architecture/2026-10-07-self-hosting-without-cloudflare.md)). The plugin API must be stable enough at 1.0 to document.

`useyolo.app`, the promotional site's address, is registered in the owner's Cloudflare account until 2027-10-10, with automatic renewal off, so the registration lapses on that date unless the owner renews it.
