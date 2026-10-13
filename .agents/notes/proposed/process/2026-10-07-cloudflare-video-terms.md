# Agent Note: Confirm Cloudflare's terms for proxied video

Status: proposed

English | [中文](2026-10-07-cloudflare-video-terms.zh.md)

## Problem

Away from home, every media byte Yolo plays passes through Cloudflare: the node sends it through the cloudflared tunnel and Workers VPC to the Worker, which passes it on ([same-origin passthrough](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.md), [Workers VPC](../../implemented/architecture/2026-10-08-workers-vpc-node-access.md)). At home, [LAN direct play](../../implemented/feature/2026-10-12-lan-direct-play.md) serves media from the node's LAN origin, whose name is a DNS-only record that Cloudflare does not proxy; a screen at home uses the tunnel only while that path is off or has failed. The open question is therefore about media away from home.

Cloudflare's CDN terms require video to be served through its paid services (the Developer Platform, Stream, and others). Read literally, proxying through a paid Worker stands on firmer ground than serving through a Tunnel directly, but there is no official statement about the Tunnel, and the September 2026 terms are not explicit about proxying video through a Worker. That it works today does not mean the terms allow it.

## Proposal

The owner confirms whether the terms allow proxying video through a Worker before Yolo 1.0 goes public and is recommended to other owners. If they do not, media away from home needs a public origin that Cloudflare does not proxy, as the LAN origin is at home; which origin that is stays open. Media URLs are replaceable: a media token in the path authorizes a request without depending on the Worker, so another origin can serve the same URL, as the LAN origin serves the same `/m/{token}/…` paths.

## Alternatives considered

**Rely on it working today.** Working is not permission; the owner has to confirm the terms.

## Acceptance criteria

The owner records a decision based on Cloudflare's terms or an answer from Cloudflare, and the relevant notes and the README reflect it. If proxying through a Worker is not allowed, a media path away from home that Cloudflare does not proxy plays all four stream types in the car before 1.0 goes public.

## Risks

LAN direct play covers only the home network. Serving media away from home without Cloudflare needs another public origin, which brings back exposing the home machine. The terms may change after the decision, so it needs revisiting whenever Cloudflare updates them.
