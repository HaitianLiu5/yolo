# Agent Note: dash_split 流跳转后画面分辨率看起来不对

Status: proposed

[English](2026-10-11-dash-split-resolution-after-seek.md) | 中文

## 问题

在一个以 `dash_split`（分离的音视频拼成 fMP4 HLS）交付的 Bilibili 视频上，用户本人看到跳转之后分辨率看起来不对。这个问题还没有复现。流内跳转会保留原来的流，而跳到流之外（或一次恢复）会用新的 `prepare` 重建流，所以画面不对可能来自插件选了另一种格式、节点的交付、解码器，或者画布尺寸。

## 提案

用来捕捉它的埋点已经上线（[设备埋点](../../implemented/feature/2026-10-11-device-telemetry.zh.md)）：`stream_selected` 记录每次加载时片源给出的宽、高、帧率、编码、码率、`formatId`、上限和视口；`stream_first_frame` 记录解码器实际给出的画面尺寸和编码以及画布尺寸，每个流一次，每次跳转后再一次（`seeks`）。端到端测试「seeking a dash_split stream keeps its format and picture size」覆盖本地的情况。

下次在车上发生时：

1. 在 Workers Logs 里取出这台设备在该会话的 `stream_selected` 和 `stream_first_frame` 事件（`kind = "device_event" AND deviceId = "dev_…"`，按 `at` 排序）。
2. 比较跳转前后片源给出的尺寸和实际尺寸，以及跳转是否以另一个 `formatId` 或上限重建了流。
3. 修复出现偏差的那一层——yt-dlp 插件的格式选择、节点把分离音视频拼成 HLS 的交付，或客户端的画布尺寸——并在能证明它的最低一层加上回归测试。

## 曾考虑的替代方案

**没有数据就猜一个修复。** 这个 bug 还没有复现，而且有四层都可能导致它；猜出来的改动既可能改坏原本正确的行为，又可能漏掉真正的原因。

## 验收标准

要么一次真实发生的埋点找到了出现偏差的那一层，并且带回归测试的修复已经合入；要么在本地复现并以同样方式修复。`dash_split` 跳转之后的分辨率与插件选择的格式一致。

## 风险

这个问题可能很少出现，而免费计划下 Workers Logs 只保留 3 天，所以出现后必须尽快排查。Bilibili 的镜像和格式会在对方那边变化，所以本地复现可能永远对不上车上的条件。
