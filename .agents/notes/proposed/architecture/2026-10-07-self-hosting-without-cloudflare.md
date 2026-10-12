# Agent Note: Self-hosting without Cloudflare

Status: proposed

English | [中文](2026-10-07-self-hosting-without-cloudflare.zh.md)

## Problem

Yolo's control plane runs only on Cloudflare: a Worker with D1, a Durable Object, KV, Workers Static Assets, and a Workers VPC binding to the node ([control plane on Cloudflare](../../implemented/architecture/2026-10-07-control-plane-on-cloudflare-media-node-at-home.md)). The owner first said Yolo should be usable without Cloudflare and merely compatible with it, and then chose the Cloudflare plan as the primary one. An owner without a Cloudflare account cannot run Yolo at all.

## Proposal

Run the same Worker code on a local `workerd` next to the media node, so the control plane can live at home without a Cloudflare account. This needs validation first: whether D1, the Durable Object, KV, Static Assets, and the node binding have workable local equivalents under `workerd`, and how the control plane gets a public HTTPS address for remote MCP clients without Cloudflare.

Self-hosting without Cloudflare is outside v1 and outside 1.0 ([Yolo 1.0](../feature/2026-10-11-yolo-1-0.md)); this note keeps the question open for after 1.0.

## Alternatives considered

**Leave it unsupported.** This is the current state: v1 and 1.0 require a Cloudflare account, and the proposal stays open until there is a reason to validate it.

## Acceptance criteria

On a machine with no Cloudflare account, the control plane serves the Tesla client, `/mcp`, `/v1`, and `/v1/realtime` from the same source code, plays media from the node, and an agent such as ChatGPT reaches it over public HTTPS with OAuth.

## Risks

`workerd` may not reproduce the bindings Yolo depends on, which would turn "the same Worker code" into a second implementation. ChatGPT and claude.ai require a public HTTPS address, so a home-hosted control plane still needs some public entry point, which brings back the exposure of the home machine that the Cloudflare plan avoids.
