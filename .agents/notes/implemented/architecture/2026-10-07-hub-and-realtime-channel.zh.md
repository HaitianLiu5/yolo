# Agent Note: Hub、单一队列和实时通道

Status: implemented

[English](2026-10-07-hub-and-realtime-channel.md) | 中文

## 问题

在 agent（智能体）、车和其他屏幕之间，必须有一方负责「当前在播什么」，把命令推给正在播放的屏幕，并听取播放到了哪里。最初只面向特斯拉的播放器只有一个窗口连一个服务，第二个播放器窗口会把第一个踢掉。Yolo 每个用户有多台设备，控制面常驻在线、按 Durable Object 运行时长计费，客户端还可能有 bug，或在停着的车里睡着。

## 决策

### 一条队列，一台当前设备

每个用户有一个 **Hub**，它是一个 Durable Object（[`service/control/src/hub/hub-core.js`](../../../../service/control/src/hub/hub-core.js)，由 `hub.js` 包装）。它持有该用户唯一的 `PlaybackState`、唯一一条 Spotify 式队列，以及哪台设备是**当前设备**：同一时间最多只有一台设备在播。把播放切到另一台设备（`PUT /v1/playback/device`、`transfer` 工具）会带上进度，原来的设备收到 `deactivate`，变成遥控器。同一台设备在另一个窗口连上时，只有最新的连接负责播放；旧窗口收到带 `reason: "replaced"` 的 `deactivate`，显示一个重新连接即可接管的按钮。一个窗口若在它自己的 `hello` 还在处理时就被替换，就收不到 `welcome`，因此不会据此行动；连接已归这台设备之后 `hello` 失败的，Hub 会关闭这条连接（`1011`），页面按它的退避重连。没有指定设备的播放请求交给当前设备，否则交给唯一一台在线且能播放的设备；遥控器（[能力描述](2026-10-07-capability-negotiation.zh.md)里 `renderer: "remote"` 的设备）永远不会被选中，也不能被指定。

### 实时通道

设备用 token 换到票据后连接 `wss://…/v1/realtime`（[OAuth](2026-10-07-oauth-authorization-server.zh.md)）。所有消息共用一个信封格式 `{ v: 1, type, id?, ... }`；带 `id` 的命令需要设备回 `ack`。

**心跳由设备发起。** 设备每 25 秒发一次 `{"v":1,"type":"ping"}`，因为 Cloudflare 会关闭空闲 100 秒的 WebSocket。这个字符串必须一字不差（`@useyolo/core` 里的 `HEARTBEAT_PING`）：Durable Object 的 WebSocket 自动回复会返回 `{"v":1,"type":"pong"}`，不唤醒 Hub，所以心跳不产生 Hub 的运行时长。服务端不设定时器，也不主动发心跳。

**限额**，防止有 bug 的客户端让 Hub 一直醒着、不停计费：

- 每个用户最多 16 条连接，每分钟最多新建 20 条；超出时返回 `429 rate_limited`。
- 每条连接每 10 秒最多 30 条消息，心跳不算；超出时服务端用 `1008 rate_limited` 关闭连接。
- 客户端断线后按指数退避重连，收到 `1008` 或 `429` 后至少等 30 秒。
- 客户端从不对广播（`state`、`queue`、`playlists`、`devices`）回发 `report` 或任何其他消息，否则会和 Hub 形成来回循环。`media` 消息让屏幕重新探测它的路径，只有路径变化时它才发送 `network`；Hub 对 `network` 不回任何广播。

**设备发给服务端：**

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `deviceId?, name, kind, capabilities` | 没有 `deviceId` 时由服务端分配。配对过的设备（票据来自设备凭据）只能是它自己，`deviceId` 被忽略；已被删除的设备用 4003 关闭 |
| `report` | `sessionId, status, position, duration, playing, viewport?, health?, keep?` | 只有当前设备上报，至少每 5 秒一次，状态变化时立即上报。`sessionId` 不是当前会话的报告被忽略。播放时大约每 15 秒带一次 `health`，换了新流、出现新的卡顿或缓冲状态变化时立即带上：`{ engine, bufferSeconds, throughputKbps, buffering, stalls, stallSeconds, recentStalls: [{ ago, seconds }], width, height, videoCodec, droppedFrames }`，都是播放器自己测得的；Hub 为每台设备保存最新一份，连同它最近加载的流和最近的重建，供播放健康使用（[`playback-health.js`](../../../../service/control/src/hub/playback-health.js)）。`status: "idle"` 表示设备自己离开了视频（返回键）：Hub 记下位置，把条目保持为该设备上的暂停状态、标上 `leftAt`，留给它的正在播放栏接着播。带 `keep: true` 时，设备把暂停的播放器留在首页后面：Hub 还给条目标上 `kept`，节点上的会话继续保留，直到设备从这个播放器再次上报（播放器重新显示了），或上报不带 `keep` 的 `idle`（设备释放了播放器）；不带 `keep` 时，Hub 停掉节点上的会话（[进度和续播](../feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)） |
| `ended` | `sessionId` | 播放结束；Hub 从队列取下一项 |
| `error` | `sessionId, code, message` | 播放失败；由 Hub 决定是重建会话还是停止 |
| `ack` | `id` | 确认收到命令 |
| `network` | `path, reason?, probes?, hairpin?` | 设备走的媒体路径（`lan`、`wan`、`relay`，没有路径时为 null）和每次探测的结果；被 welcome 标为在家的设备还带 `hairpin`（`ok` 或 `failed`），说明路由器能否回环到家里的公网地址：选择变化时、每次 welcome 之后一次、一条流在它的路径上失败时发送。Hub 按设备保存最新值，在下次 `prepare` 时把路径交给节点；设备没有找到路径时，Hub 给它中转，除非用户本人关掉了中转，这时以 `media_unreachable` 拒绝。设备自己的播放请求也带它，并以请求里的为准。Hub 不认识的路径算作没有路径，不带 `path` 的报告也一样，比如 0.5 之前的播放器只带 `lan` 的报告（[媒体流离开 Worker](2026-10-13-media-off-the-worker.zh.md)） |
| `ping` | 无 | 心跳字符串 |

**服务端发给设备：**

| type | 发给谁 | 说明 |
|---|---|---|
| `welcome` | 刚连上的设备 | `deviceId`，当前的 `state`、`queue`、`playlists`，`media`：`{ paths: [{ path, origin, notAfter, home? }], relayMode, domain? }`，即带有效证书正常服务的节点监听端口（`wan` 只在从外部到达了它时列出）；设备从家里的公网地址连上时，`wan` 带 `home: true`；中转的模式（`auto`、`on` 或 `off`）；没有域名的实例还带 `domain: false`。`state` 里这台设备还在播时（页面刷新、车醒过来），设备带上 `reason: "recovery"` 请求新流。Hub 每个 `load` 只发一次，发到这台设备当时的各条连接上，`load` 一发出就更新 `state`。一条连接在读取它的 welcome 之前就归这台设备：此后 Hub 发出的消息都会送到这条连接，`load` 可能比 welcome 早到一点；而 welcome 里最后读取的 `state`，会写明在那之前已发出 `load` 的流。所以 `state` 里给这台设备的流若不是它正在播的那条（跳转、换画质、恢复建的流，或代理的播放），说明那个 `load` 随旧连接丢了，而它正在播的流已被 Hub 在建新流时停掉。设备先请求 Hub 的这条流，替换它，等回来的 `load` 再切换画面：同一项目时，有跳转在等就从跳转目标开始（`reason: "seek"`），否则从它播到的位置开始（`reason: "recovery"`），即使丢掉的 `load` 是代理从别的位置播这个项目；换了项目时，按 `state` 给出的位置和播放与否，像刚打开的页面那样播。被拒为 `superseded`（welcome 比屏幕上的流旧，或 Hub 已经换了别的流）时，屏幕上的流继续播；因别的原因失败时，设备带着错误离开这条流。Hub 建好跳转的流 10 秒后仍没送到，设备 ping 自己的连接，没有回应就换掉；连接有回应、再过 10 秒仍没送到，这次跳转按失败结束。设备请求的回答里写明了 Hub 建好的流时，设备接着从原来的位置请求一条新流，替换 Hub 建好的那条；请求被拒为 `superseded` 时，它不知道有这样一条流，就继续播原来的流。设备自己请求流时，只要被拒为 `superseded`，它也会 ping 自己的连接 |
| `load` | 当前设备 | 流描述（`stream`）、带 Source 的条目（重建流时要用）、`startTime`、`autoplay` 和 `reason`（`play`、`recovery`、`seek`、`quality`、`transfer`、`tracks`）。`tracks` 表示换音轨需要新会话，例如 Plex 的图片字幕或换音轨。设备一次只为一次跳转请求新流：请求或它的 `load` 还在路上时再跳转，只改目标，新流从最后一个目标开始。最后一个目标若在这条流的起点之前，就等流加载完再跳过去：流里能到就在流里跳，到不了就为它另请求一条流；加载期间车主或代理又跳转了的话，就不再跳。跳转的流还在加载时，设备还不知道这条流能跳到哪里，所以这时的跳转无论去哪都另用一条流：第一次这样的跳转请求一条，之后的跳转只改它的目标，所以最后一次跳转的位置就是接着播放的位置。正在加载的那条流暂停等着；新流始终没来时（那次跳转按失败结束），它接着播 |
| `pause`、`resume`、`stop`、`seek` | 当前设备 | 控制命令 |
| `tracks` | 当前设备 | 更换字幕或音轨，带上字幕的 VTT URL |
| `danmaku` | agent 指定的设备，或当前设备 | `settings`：要在该屏幕上改的弹幕设置（`enabled`、`density`、`opacity`、`area`、`fontSize`），由屏幕自己保存（[弹幕](../feature/2026-10-13-danmaku.zh.md)） |
| `deactivate` | 原来的当前设备 | 播放被切到别处；本机停止，变成遥控器。`reason: "replaced"` 表示同一台设备在另一个窗口连上了 |
| `state`、`queue`、`playlists`、`devices` | 所有设备 | 状态变化的广播 |
| `media` | 所有已连接的设备 | 发给该设备的 welcome 里的 `media`；welcome 列出的远程源变化时发送，比如没有域名时家里有了新地址（[媒体流离开 Worker](2026-10-13-media-off-the-worker.zh.md)） |
| `pong` | 发 `ping` 的设备 | 由运行时的自动回复发出 |

Hub 把当前设备的报告写进 Yolo 的历史（[进度和续播](../feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)）；醒来的设备的请求顺序见[醒来时的请求顺序](../bug-fix/2026-10-11-wake-request-ordering.zh.md)。一次播放的历史记录没写成时，流照常播放，Hub 记一条 `history_write_failed`：这次观看不在历史里，所以之前没有记录的项目不会保留这次的进度，之后不带 `startTime` 再播它时，从片源给出的位置开始。

### 实时通道留在核心里

实时通道属于 Yolo 核心，不是设备插件。播放器在两个 profile 下都是这条通道的设备，按自己的[能力描述](2026-10-07-capability-negotiation.zh.md)协商播放方式。在车机 profile 下，点按的内容在车上播放；在 web profile 下，也就是在电脑或手机浏览器里，播放器自己能播放（浏览器支持时通过 `<video>`），同时充当遥控器：另一台设备正在播放或暂停时，点按的内容在那台设备上播放，否则在这个浏览器里播放（[点按在哪里播放](../feature/2026-10-11-yolo-web-client.zh.md)）。设备插件的接口等第一个第三方设备（Jellyfin 会话或 Apple TV）出现时，再按它的真实需求设计。

## 曾考虑的替代方案

**像 Plex 那样每台设备一条队列。** 一个人只有一双眼睛，不会同时在两块屏幕上看，所以一条队列加一台当前设备符合 Yolo 的使用方式。

**一开始就把实时通道做成设备插件。** 同一个播放器的两个 profile（车机和 web）都是 Yolo 自己的，讲同一套协议；只有一个实现的接口设计不好。

**由服务端发起心跳。** 服务端定时器每个周期都会唤醒 Hub，为每台连着的设备计费；由设备发 ping、靠自动回复应答则没有成本。

## 后果

每台设备看到的是一致的播放状态，在屏幕之间切换播放只需一次调用。心跳和空闲连接不占 Durable Object 的运行时长，限额也限制了出错客户端能造成的开销。一个账号上不能两个人同时看不同的内容，这符合单个用户本人的模型，换成家庭场景时需要重新考虑。第三方播放器需要一个现在还不存在的设备插件接口。
