# Agent Note: Hub、单一队列和实时通道

Status: implemented

[English](2026-10-07-hub-and-realtime-channel.md) | 中文

## 问题

在 agent（智能体）、车和其他屏幕之间，必须有一方负责「当前在播什么」，把命令推给正在播放的屏幕，并听取播放到了哪里。Drive-In 只有一个播放器连一个服务，第二个播放器窗口会把第一个踢掉。Yolo 每个用户有多台设备，控制面常驻在线、按 Durable Object 运行时长计费，客户端还可能有 bug，或在停着的车里睡着。

## 决策

### 一条队列，一台当前设备

每个用户有一个 **Hub**，它是一个 Durable Object（[`service/control/src/hub/hub-core.js`](../../../../service/control/src/hub/hub-core.js)，由 `hub.js` 包装）。它持有该用户唯一的 `PlaybackState`、唯一一条 Spotify 式队列，以及哪台设备是**当前设备**：同一时间最多只有一台设备在播。把播放切到另一台设备（`PUT /v1/playback/device`、`transfer` 工具）会带上进度，原来的设备收到 `deactivate`，变成遥控器。同一台设备在另一个窗口连上时，只有最新的连接负责播放；旧窗口收到带 `reason: "replaced"` 的 `deactivate`，显示一个重新连接即可接管的按钮。没有指定设备的播放请求交给当前设备，否则交给唯一一台在线且能播放的设备；遥控器（[能力描述](2026-10-07-capability-negotiation.zh.md)里 `renderer: "remote"` 的设备）永远不会被选中，也不能被指定。

### 实时通道

设备用 token 换到票据后连接 `wss://…/v1/realtime`（[OAuth](2026-10-07-oauth-authorization-server.zh.md)）。所有消息共用一个信封格式 `{ v: 1, type, id?, ... }`；带 `id` 的命令需要设备回 `ack`。

**心跳由设备发起。** 设备每 25 秒发一次 `{"v":1,"type":"ping"}`，因为 Cloudflare 会关闭空闲 100 秒的 WebSocket。这个字符串必须一字不差（`@useyolo/core` 里的 `HEARTBEAT_PING`）：Durable Object 的 WebSocket 自动回复会返回 `{"v":1,"type":"pong"}`，不唤醒 Hub，所以心跳不产生 Hub 的运行时长。服务端不设定时器，也不主动发心跳。

**限额**，防止有 bug 的客户端让 Hub 一直醒着、不停计费：

- 每个用户最多 16 条连接，每分钟最多新建 20 条；超出时返回 `429 rate_limited`。
- 每条连接每 10 秒最多 30 条消息，心跳不算；超出时服务端用 `1008 rate_limited` 关闭连接。
- 客户端断线后按指数退避重连，收到 `1008` 或 `429` 后至少等 30 秒。
- 客户端从不对广播（`state`、`queue`、`playlists`、`devices`）回发 `report` 或任何其他消息，否则会和 Hub 形成来回循环。

**设备发给服务端：**

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `deviceId?, name, kind, capabilities` | 没有 `deviceId` 时由服务端分配。配对过的设备（票据来自设备凭据）只能是它自己，`deviceId` 被忽略；已被删除的设备用 4003 关闭 |
| `report` | `sessionId, status, position, duration, playing, viewport?` | 只有当前设备上报，至少每 5 秒一次，状态变化时立即上报。`sessionId` 不是当前会话的报告被忽略。`status: "idle"` 表示设备自己离开了视频（返回键）：Hub 记下位置、停掉节点上的会话，并把条目保持为该设备上的暂停状态、标上 `leftAt`，留给它的正在播放栏接着播（[进度和续播](../feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)） |
| `ended` | `sessionId` | 播放结束；Hub 从队列取下一项 |
| `error` | `sessionId, code, message` | 播放失败；由 Hub 决定是重建会话还是停止 |
| `ack` | `id` | 确认收到命令 |
| `network` | `lan, reason?` | 设备能否连到节点的局域网源：探测结果变化时、每次 welcome 之后一次发送，局域网流失败时发送 `lan: false`。Hub 按设备保存最新值，在下次 `prepare` 时把 `network: "lan"` 或 `"tunnel"` 交给节点；设备自己的播放请求也带它，并以请求里的为准（[局域网直连播放](../feature/2026-10-12-lan-direct-play.zh.md)） |
| `ping` | 无 | 心跳字符串 |

**服务端发给设备：**

| type | 发给谁 | 说明 |
|---|---|---|
| `welcome` | 刚连上的设备 | `deviceId`，当前的 `state`、`queue`、`playlists`，以及 `lan`：节点的局域网监听端口带有效证书正常服务时为 `{ origin, notAfter }`，否则为 null。`state` 里这台设备还在播时（页面刷新、车醒过来），设备带上 `reason: "recovery"` 请求新流 |
| `load` | 当前设备 | 流描述（`stream`）、带 Source 的条目（重建流时要用）、`startTime`、`autoplay` 和 `reason`（`play`、`recovery`、`seek`、`quality`、`transfer`、`tracks`）。`tracks` 表示换音轨需要新会话，例如 Plex 的图片字幕或换音轨 |
| `pause`、`resume`、`stop`、`seek` | 当前设备 | 控制命令 |
| `tracks` | 当前设备 | 更换字幕或音轨，带上字幕的 VTT URL |
| `deactivate` | 原来的当前设备 | 播放被切到别处；本机停止，变成遥控器。`reason: "replaced"` 表示同一台设备在另一个窗口连上了 |
| `state`、`queue`、`playlists`、`devices` | 所有设备 | 状态变化的广播 |
| `pong` | 发 `ping` 的设备 | 由运行时的自动回复发出 |

Hub 把当前设备的报告写进 Yolo 的历史（[进度和续播](../feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)）；醒来的设备的请求顺序见[醒来时的请求顺序](../bug-fix/2026-10-11-wake-request-ordering.zh.md)。

### 实时通道留在核心里

实时通道属于 Yolo 核心，不是设备插件。Drive-In 是它的第一台设备，按自己的[能力描述](2026-10-07-capability-negotiation.zh.md)协商播放方式；电脑或手机浏览器里的 Yolo Web 也走同一条通道，并充当正在播放的那台设备的遥控器。设备插件的接口等第一个第三方设备（Jellyfin 会话或 Apple TV）出现时，再按它的真实需求设计。

### 与 Drive-In 旧消息的对应关系

特斯拉客户端只讲 v1。Drive-In 的 `play` 变成 `load`；`subtitlesAvailable` 和 `subtitleSelect` 变成 `load.tracks` 和 `tracks`；`status` 和 `playerState` 变成 `report`；单播放器的 `playerAccepted`/`playerRejected` 变成 `welcome`/`deactivate`；`queueUpdated`/`playlistsUpdated` 变成 `queue`/`playlists`；`reload` 去掉了。

## 曾考虑的替代方案

**像 Plex 那样每台设备一条队列。** 一个人只有一双眼睛，不会同时在两块屏幕上看，所以一条队列加一台当前设备符合 Yolo 的使用方式。

**一开始就把实时通道做成设备插件。** 一阶段的两个客户端（特斯拉客户端和 Yolo Web）都是 Yolo 自己的，讲同一套协议；只有一个实现的接口设计不好（2026-10-11 定）。

**由服务端发起心跳。** 服务端定时器每个周期都会唤醒 Hub，为每台连着的设备计费；由设备发 ping、靠自动回复应答则没有成本。

## 后果

每台设备看到的是一致的播放状态，在屏幕之间切换播放只需一次调用。心跳和空闲连接不占 Durable Object 的运行时长，限额也限制了出错客户端能造成的开销。一个账号上不能两个人同时看不同的内容，这符合单个用户本人的模型，换成家庭场景时需要重新考虑。第三方播放器需要一个现在还不存在的设备插件接口。
