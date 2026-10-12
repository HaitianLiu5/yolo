# Agent Note: Yolo Web：带设置页的浏览器客户端

Status: proposed

[English](2026-10-11-yolo-web-client.md) | 中文

## 问题

特斯拉客户端是 Yolo 唯一的屏幕。在电脑或手机上，用户本人无法浏览片库、在浏览器里播放，也不能把浏览器当作车上播放的遥控器。也没有设置页：撤销 agent（智能体）只能手动删除它在 `OAUTH_KV` 里的记录，passkey 和设备也只能通过 `/v1` 和 MCP 管理（[OAuth](../../implemented/architecture/2026-10-07-oauth-authorization-server.zh.md)）。

## 提案

0.4 版增加 **Yolo Web**，完成一阶段（[Yolo 1.0](2026-10-11-yolo-1-0.zh.md)）：

- 在电脑或手机浏览器里打开同一个地址，用 passkey 登录后，看到的客户端可以浏览和搜索片库、在浏览器里播放，并遥控正在播放的设备，包括车。
- 它复用播放引擎，换一份[能力描述](../../implemented/architecture/2026-10-07-capability-negotiation.zh.md)，并使用留在核心里的同一条[实时通道](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md)；任何设备都可以当遥控器。
- 设置页管理片源、插件、设备、agent 授权和 passkey。

复杂度为中：主要是做新界面，因为播放引擎和实时通道都是复用的。

## 曾考虑的替代方案

**为网页客户端做一个设备插件。** 一阶段的两个客户端都是 Yolo 自己的，讲同一套协议，所以实时通道留在核心里；只有一个实现的接口设计不好。

## 验收标准

在电脑和手机上，用户本人打开控制面的地址，用 passkey 登录，浏览和搜索片库，在浏览器里播放一个条目，把播放切到车上再切回来，并在设置页撤销一个 agent、移除一台设备、添加或删除一个 passkey，整个过程不需要手动操作 `OAUTH_KV` 或调用 `/v1`。

## 风险

复用 canvas 引擎会把它的跨源隔离（COOP/COEP）带到网页客户端的每个页面，因此这里和车上一样不能用弹窗登录（[canvas 引擎](../../implemented/architecture/2026-04-04-canvas-playback-engine.zh.md)）。同时充当遥控器的浏览器绝不能回应 Hub 的广播，否则会和 Hub 形成循环。在设置页撤销 agent，需要用到 OAuth 授权服务器的授权列表和撤销功能，Yolo 目前还没有用到它们。
