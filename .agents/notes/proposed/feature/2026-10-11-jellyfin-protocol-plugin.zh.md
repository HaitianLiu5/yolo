# Agent Note: 面向 Apple 设备的兼容 Jellyfin 的协议插件

Status: proposed

[English](2026-10-11-jellyfin-protocol-plugin.md) | 中文

## 问题

Apple TV 上没有 Yolo 客户端，iPhone、iPad 和 Mac 上只有浏览器里的 Yolo Web（[两个引擎](../../implemented/architecture/2026-10-12-two-playback-engines.zh.md)），没有原生播放器。做原生 App 就要通过 App 审核，每年还要维护，而好用的第三方播放器已经存在。2026-10 的调研发现：Infuse 不接受服务器推送的遥控命令，Swiftfin 1.6 接受；兼容 Jellyfin 的 API 已有先例（AioFin、Remux）。

## 提案

0.6 版增加一个**暴露兼容 Jellyfin 的 API 的协议插件**，分控制面一半（API 和会话推送）和节点一半（媒体流）：

- Infuse（手动播放）和 Swiftfin（agent（智能体）遥控）直接连接 Yolo，它们的进度同步回 Yolo。
- 电视在 Quick Connect 里显示的配对码，可以由 agent 或在 Yolo Web 里批准。
- Jellyfin 会话接入 Hub 的设备模型，所以 agent 能通过 MCP 遥控 Swiftfin，不需要知道设备讲的是哪种协议。设备插件的接口就在这第一个第三方设备上设计（[Hub](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md)）。
- Android 上的 Jellyfin 客户端理论上可用，但不做保证。

**先做实验。** 在 Mac mini 上跑一个真的 Jellyfin 服务，确认三件事：Swiftfin 在 tvOS 上能执行哪些遥控命令；Infuse 的会话在 `GET /Sessions` 里报告的 `SupportsMediaControl` 是什么；Infuse 能直接播放哪些格式。实验结果决定 0.6 怎么做，以及要不要做原生 tvOS App（[Yolo 1.0](2026-10-11-yolo-1-0.zh.md) 的风险 1）。

## 曾考虑的替代方案

**原生 App 优先。** 它们要通过 App 审核（条款 2.1 和 5.2.3），每年还要维护。如果 Swiftfin 的遥控被证明不可靠，原生 tvOS App 仍是退路；它讲同一套 Jellyfin 会话协议，服务和 MCP 不用改，但会把 Swift 引入项目，需要用户本人另外批准。

**模拟 Plex 服务端。** [已否决](../../rejected/architecture/2026-10-11-emulate-a-plex-media-server.zh.md)：plex.tv 的认领机制和 Plex 的条款都不允许。

**遥控 Infuse。** Infuse 不接受服务器推送的命令，所以 Yolo 只把它用于手动播放。

## 验收标准

用户本人 Apple 设备上的 Infuse 和 Swiftfin 能连接 Yolo、浏览它的片库并播放；它们的进度出现在 Yolo 的历史里；Quick Connect 的配对码可以由 agent 或在 Yolo Web 里批准；agent 能通过 MCP 在 Apple TV 的 Swiftfin 上开始播放、暂停和跳转。

## 风险

兼容的 API 大约有 40 到 60 个端点，Infuse 还有很多特殊行为。没有现成项目实现过会话推送，这部分没有参考。一切都必须在真机上验证。如果 Swiftfin 的遥控不可靠，要让 agent 控制 Apple TV 就需要上面提到的原生 App。
