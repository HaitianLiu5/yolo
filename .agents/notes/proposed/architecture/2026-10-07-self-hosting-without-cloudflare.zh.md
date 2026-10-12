# Agent Note: 不用 Cloudflare 的自托管

Status: proposed

[English](2026-10-07-self-hosting-without-cloudflare.md) | 中文

## 问题

Yolo 的控制面只能跑在 Cloudflare 上：一个带 D1、Durable Object、KV、Workers Static Assets 和通往节点的 Workers VPC binding 的 Worker（[控制面放 Cloudflare](../../implemented/architecture/2026-10-07-control-plane-on-cloudflare-media-node-at-home.zh.md)）。用户本人先说过 Yolo 应该不用 Cloudflare 也能用、只是兼容 Cloudflare，后来又选择以 Cloudflare 方案为主。没有 Cloudflare 账号的用户完全无法运行 Yolo。

## 提案

让同一套 Worker 代码在媒体节点旁边的本地 `workerd` 上运行，这样控制面不需要 Cloudflare 账号也能放在家里。这需要先验证：在 `workerd` 下，D1、Durable Object、KV、Static Assets 和节点 binding 是否有可用的本地替代；以及不用 Cloudflare 时，控制面如何为远程 MCP 客户端提供公网 HTTPS 地址。

不用 Cloudflare 的自托管不在 v1 范围内，也不在 1.0 范围内（[Yolo 1.0](../feature/2026-10-11-yolo-1-0.zh.md)）；这份记录让这个问题在 1.0 之后保持待定。

## 曾考虑的替代方案

**不支持。** 这是现状：v1 和 1.0 都要求 Cloudflare 账号，在有理由去验证之前，这个提案一直保持待定。

## 验收标准

在一台没有 Cloudflare 账号的机器上，控制面用同一份源码提供特斯拉客户端、`/mcp`、`/v1` 和 `/v1/realtime`，能播放节点上的媒体，并且 ChatGPT 这样的 agent（智能体）能通过带 OAuth 的公网 HTTPS 访问它。

## 风险

`workerd` 可能无法重现 Yolo 依赖的 binding，那样「同一套 Worker 代码」就会变成第二套实现。ChatGPT 和 claude.ai 要求公网 HTTPS 地址，所以放在家里的控制面仍然需要某个公网入口，这又会带回 Cloudflare 方案所避免的、家里机器对外暴露的问题。
