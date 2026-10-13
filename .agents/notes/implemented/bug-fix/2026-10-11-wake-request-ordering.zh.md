# Agent Note: 醒来的设备在收到 welcome 之后再发请求

Status: implemented

[English](2026-10-11-wake-request-ordering.md) | 中文

## 问题

2026-10-11 的线上问题：车睡了 52 分钟。醒来时下一个分片返回 `410`，播放器马上请求新流，而实时连接还在重连。请求比新连接的 `hello` 先到 Hub，Hub 认为设备离线，返回 `409 device_offline`（「Browser is offline」），一秒后连接才连上。`410` 触发的恢复和 `welcome` 之后的续播还会同时请求流，其中一个可能替换掉另一个，然后得到 `superseded`。

## 决策

现在两边都处理这个顺序（[`clients/player/src/stream-requests.js`](../../../../clients/player/src/stream-requests.js)、[`service/control/src/hub/hub-core.js`](../../../../service/control/src/hub/hub-core.js)）：

- **设备等待自己的 welcome。**设备为自己的播放发出的请求（恢复、`welcome` 之后的续播、跳转重建、换轨、在本机点播放），要等实时通道连上、并且这条连接收到 `welcome` 之后才发；正在重连时请求排队，`welcome` 之后再发。醒来时（`resume`、`pageshow`，或定时器晚到 20 秒以上），设备先对旧连接发一次心跳，5 秒内没有回应就换一条新连接；期间请求也等着。
- **恢复同一时间只发一个。**`410` 触发的恢复和 `welcome` 触发的续播合并成一个请求，不会互相替换。
- **有上限的重试。**`device_offline`、`node_offline`、`rate_limited` 和 `resolve_failed`（标为可重试的错误码）、网络错误，以及实时通道一直没回来，按 1、2、4、8 秒退避重试，总共最多 45 秒；之后播放器显示带原因的错误（「…（gave up after 5 tries in 15 s）」）。网络或实时通道一直没回来时，播放器自己的恢复循环之后还会再试，因为车可能离线好几分钟。收到 `device_offline` 而本机以为连接还在，说明连接在睡眠中已经断了，客户端会立刻换一条。
- **Hub 等待 hello。**用设备凭据发起、目标是这台设备自己（显式指定，或者省略 `deviceId` 而它是当前设备）的 `POST /v1/playback/play`，如果这台设备还没有说过 `hello`，Hub 最多等 5 秒，等到它的 `hello`（在它的 `welcome` 发出之后）再决定是否返回 `device_offline`。每台设备有自己的等待者，在 `hello` 时被唤醒；不轮询。agent（智能体）的请求和发给其他设备的请求从不等待。

`stream_request_*`、`page_wake` 和 `wake_to_playback` 事件以及 Hub 的 `hello_wait` 日志记录了每一步（[设备埋点](../feature/2026-10-11-device-telemetry.zh.md)）。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 后果

醒来的车可以直接续播，不会再出现莫名其妙的「Browser is offline」，两种触发恢复的方式也不再互相冲突。设备自己的请求最多可能要 45 秒才显示错误，Hub 也可能把一个请求挂起 5 秒；两者都有上限，也都有日志。
