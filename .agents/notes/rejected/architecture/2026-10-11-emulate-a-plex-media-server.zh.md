# Agent Note: 为第三方客户端模拟 Plex Media Server

Status: rejected — plex.tv's claim mechanism and Plex's terms do not allow it

[English](2026-10-11-emulate-a-plex-media-server.md) | 中文

## 问题

Apple TV、iPhone、iPad 和 Mac 上没有 Yolo 客户端，而原生 App 要应对 App 审核和每年的维护。这些设备上都已经有讲 Plex 协议的成熟播放器——包括 Plex 自己的 App 和 Infuse——所以让 Yolo 看起来像一台 Plex Media Server，就能一下子用上这些客户端。

## 提案

Yolo 实现 Plex Media Server 的 API，让 Plex App 和 Infuse 把 Yolo 当成 Plex 服务器来连接：浏览它的片库，通过它的媒体管线播放，并把进度报回来。

## 曾考虑的替代方案

**兼容 Jellyfin 的协议插件**（[提案](../../rejected/feature/2026-10-11-jellyfin-protocol-plugin.zh.md)）。Jellyfin 的 API 是开放的，已有兼容的服务端（AioFin、Remux），Infuse 可以用它手动播放，Swiftfin 接受服务器推送的遥控命令。这是 Apple 设备选定的路径。

**原生 App。** 它们需要通过 App 审核（条款 2.1 和 5.2.3），每年还要维护；原生 tvOS App 只在 Swiftfin 的遥控被证明不可靠时才作为退路。

**为什么否决：**Plex 客户端通过 plex.tv 发现和授权服务器，服务器要由一个 Plex 账号认领，而 Plex 的条款不允许模拟服务端；冒充 Plex 的 Yolo 会依赖一个它无权使用的机制。
