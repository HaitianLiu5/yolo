# Agent Note: Confirm Cloudflare's terms for proxied video

Status: proposed

English | [中文](2026-10-07-cloudflare-video-terms.zh.md)

## Problem

Every media byte Yolo plays passes through Cloudflare ([same-origin passthrough](../../implemented/architecture/2026-10-07-same-origin-media-passthrough.md)). Cloudflare's CDN terms require video to be served through its paid services (the Developer Platform, Stream, and others). Read literally, proxying through a paid Worker stands on firmer ground than serving through a Tunnel directly, but there is no official statement about the Tunnel, and the September 2026 terms are not explicit about proxying video through a Worker. That it works today does not mean the terms allow it.

## Proposal

The owner confirms whether the terms allow proxying video through a Worker before Yolo 1.0 goes public and is recommended to other owners. If they do not, media moves to a LAN-direct path with a media origin that Cloudflare does not proxy. Media URLs have been replaceable since 0.3: a media token in the path authorizes a request without depending on the Worker, so the same URL can be served by another origin.

## Alternatives considered

**Rely on it working today.** Working is not permission; the owner has to confirm the terms.

## Acceptance criteria

The owner records a decision based on Cloudflare's terms or an answer from Cloudflare, and the relevant notes and the README reflect it. If proxying through a Worker is not allowed, a non-Cloudflare media path plays all four stream types in the car before 1.0 goes public.

## Risks

A LAN-direct path works only on the home network unless another public origin serves media, which brings back exposing the home machine. The terms may change after the decision, so it needs revisiting whenever Cloudflare updates them.
