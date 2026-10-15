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
| `report` | `sessionId, status, position, duration, playing, viewport?, health?, keep?` | 只有当前设备上报，至少每 5 秒一次，状态变化时立即上报。`sessionId` 不是当前会话的报告被忽略。播放时大约每 15 秒带一次 `health`，换了新流、出现新的卡顿或缓冲状态变化时立即带上：`{ engine, bufferSeconds, throughputKbps, buffering, stalls, stallSeconds, recentStalls: [{ ago, seconds }], width, height, videoCodec, droppedFrames }`，都是播放器自己测得的；Hub 为每台设备保存最新一份，连同它最近加载的流和最近的重建，供播放健康使用（[`playback-health.js`](../../../../service/control/src/hub/playback-health.js)）。`status: "idle"` 表示设备自己离开了视频（返回键）：Hub 记下位置，把条目保持为该设备上的暂停状态、标上 `leftAt`，留给它的正在播放栏接着播。带 `keep: true` 时，设备把暂停的播放器留在首页后面：Hub 还给条目标上 `kept`，节点上的会话继续保留，直到设备从这个播放器再次上报（播放器重新显示了），或上报不带 `keep` 的 `idle`（设备释放了播放器）；不带 `keep` 时，Hub 停掉节点上的会话（[进度和续播](../feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)）。不带 `keep` 的 `idle` 若被失效的连接吞掉，会在下一次 welcome 之后重发（见下文） |
| `ended` | `sessionId` | 播放结束；Hub 从队列取下一项，每条流只取一次：Hub 还在为同一条流取下一项时到达的 `ended` 被忽略 |
| `error` | `sessionId, code, message` | 播放失败；由 Hub 决定是重建会话还是停止 |
| `ack` | `id` | 确认收到命令；确认的是 agent 的弹幕设置改动时，Hub 随即不再保留它（见下文） |
| `network` | `path, reason?, probes?, hairpin?` | 设备走的媒体路径（`lan`、`wan`、`relay`，没有路径时为 null）和每次探测的结果；被 welcome 标为在家的设备还带 `hairpin`（`ok` 或 `failed`），说明路由器能否回环到家里的公网地址：选择变化时、每次 welcome 之后一次、一条流在它的路径上失败时发送。Hub 按设备保存最新值，在下次 `prepare` 时把路径交给节点；设备没有找到路径时，Hub 给它中转，除非用户本人关掉了中转，这时以 `media_unreachable` 拒绝。设备自己的播放请求也带它，并以请求里的为准。Hub 不认识的路径算作没有路径，不带 `path` 的报告也一样，比如 0.5 之前的播放器只带 `lan` 的报告（[媒体流离开 Worker](2026-10-13-media-off-the-worker.zh.md)） |
| `ping` | 无 | 心跳字符串 |

**服务端发给设备：**

| type | 发给谁 | 说明 |
|---|---|---|
| `welcome` | 刚连上的设备 | `deviceId`，当前的 `state`、`queue`、`playlists`，`commands`（发给这台设备、针对 `state` 所指那条流的最后一次 `pause` 或 `resume` 和最后一次 `seek`，有才带；见下文），`media`：`{ paths: [{ path, origin, notAfter, home? }], relayMode, domain? }`，即带有效证书正常服务的节点监听端口（`wan` 只在从外部到达了它时列出）；设备从家里的公网地址连上时，`wan` 带 `home: true`；中转的模式（`auto`、`on` 或 `off`）；没有域名的实例还带 `domain: false`。`state` 里这台设备还在播时（页面刷新、车醒过来），设备带上 `reason: "recovery"` 请求新流。Hub 每个 `load` 只发一次，发到这台设备当时的各条连接上，`load` 一发出就更新 `state`。一条连接在读取它的 welcome 之前就归这台设备：此后 Hub 发出的消息都会送到这条连接，`load` 可能比 welcome 早到一点；而 welcome 里最后读取的 `state`，会写明在那之前已发出 `load` 的流。所以 `state` 里给这台设备的流若不是它正在播的那条（跳转、换画质、恢复建的流，或代理的播放），说明那个 `load` 随旧连接丢了，而它正在播的流已被 Hub 在建新流时停掉。设备先请求 Hub 的这条流，替换它，等回来的 `load` 再切换画面：同一项目时，有跳转在等就从跳转目标开始（`reason: "seek"`），否则从它播到的位置开始（`reason: "recovery"`），即使丢掉的 `load` 是代理从别的位置播这个项目；换了项目时，按 `state` 给出的位置和播放与否，像刚打开的页面那样播。被拒为 `superseded`（welcome 比屏幕上的流旧，或 Hub 已经换了别的流）时，屏幕上的流继续播；因别的原因失败时，设备带着错误离开这条流。Hub 建好跳转的流 10 秒后仍没送到，设备 ping 自己的连接，没有回应就换掉；连接有回应、再过 10 秒仍没送到，这次跳转按失败结束。设备请求的回答里写明了 Hub 建好的流时，设备接着从原来的位置请求一条新流，替换 Hub 建好的那条；请求被拒为 `superseded` 时，它不知道有这样一条流，就继续播原来的流。设备自己请求流时，只要被拒为 `superseded`，它也会 ping 自己的连接 |
| `load` | 当前设备 | 流描述（`stream`）、带 Source 的条目（重建流时要用）、`startTime`、`autoplay` 和 `reason`（`play`、`recovery`、`seek`、`quality`、`transfer`、`tracks`）。在屏幕上报之前，Hub 的状态是 `loading`；`autoplay: false` 的 `load` 则一开始就是 `paused`。`tracks` 表示换音轨需要新会话，例如 Plex 的图片字幕或换音轨。设备一次只为一次跳转请求新流：请求或它的 `load` 还在路上时再跳转，只改目标，新流从最后一个目标开始。最后一个目标若在这条流的起点之前，就等流加载完再跳过去：流里能到就在流里跳，到不了就为它另请求一条流；加载期间车主或代理又跳转了的话，就不再跳。跳转的流还在加载时，设备还不知道这条流能跳到哪里，所以这时的跳转无论去哪都另用一条流：第一次这样的跳转请求一条，之后的跳转只改它的目标，所以最后一次跳转的位置就是接着播放的位置。正在加载的那条流暂停等着；新流始终没来时（那次跳转按失败结束），它接着播 |
| `pause`、`resume`、`stop`、`seek` | 当前设备 | 控制命令。`pause`、`resume` 和 `seek` 带屏幕要确认的 `id`，以及它们针对的那条流的 `sessionId`（见下文） |
| `tracks` | 当前设备 | 更换字幕或音轨，带上字幕的 VTT URL |
| `danmaku` | agent 指定的设备，或当前设备 | `settings`：要在该屏幕上改的弹幕设置（`enabled`、`density`、`opacity`、`area`、`fontSize`），由屏幕自己保存（[弹幕](../feature/2026-10-13-danmaku.zh.md)）。屏幕确认之前，Hub 一直保留这次改动的设置项，并在屏幕下一次 welcome 之后立即重发，带 `again: true`（见下文） |
| `deactivate` | 原来的当前设备 | 播放被切到别处；本机停止，变成遥控器。`reason: "replaced"` 表示同一台设备在另一个窗口连上了 |
| `state`、`queue`、`playlists`、`devices` | 所有设备 | 状态变化的广播 |
| `media` | 所有已连接的设备 | 发给该设备的 welcome 里的 `media`；welcome 列出的远程源变化时发送，比如没有域名时家里有了新地址（[媒体流离开 Worker](2026-10-13-media-off-the-worker.zh.md)） |
| `pong` | 发 `ping` 的设备 | 由运行时的自动回复发出 |

Hub 把当前设备的报告写进 Yolo 的历史（[进度和续播](../feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)）；醒来的设备的请求顺序见[醒来时的请求顺序](../bug-fix/2026-10-11-wake-request-ordering.zh.md)。一次播放的历史记录没写成时，流照常播放，Hub 记一条 `history_write_failed`：这次观看不在历史里，所以之前没有记录的项目不会保留这次的进度，之后不带 `startTime` 再播它时，从片源给出的位置开始。

### 失效的连接吞掉的消息

Hub 每条消息只发一次，发到这台设备当时的各条连接上；只要设备的某个 socket 接下了命令，就算送达。一条连接若已失效、两端都还没察觉，就会吞掉这条命令，而 agent 得到的答复是成功了；屏幕发进这条连接的报告也同样丢失。于是屏幕的下一次报告会覆盖命令设下的状态，或者 Hub 照旧运行，好像屏幕从没播完或离开它的流。重连之后，welcome 和屏幕按种类分别补上，做法和补上丢失的 `load` 一样（见 `welcome` 一行）：

- **暂停、继续和跳转。** Hub 按设备保留它为这台设备的流发出的最后一次 `pause` 或 `resume`，以及最后一次 `seek`，连同它们的命令 id；只要 `state` 指的还是这条流，welcome 就写明它们：`commands: { sessionId, playback?: { id, action }, seek?: { id, position } }`。新流开始时一条也没有。屏幕记着它处理过的最后一次暂停或继续、最后一次跳转的 id，记在每条命令写明的那条流（`sessionId`）名下，所以屏幕切换流时到达的命令算新流的；Hub 不写明时，记在屏幕已有或正要开始的那条流名下。welcome 写明的、针对屏幕正在播放或留在首页后面那条流的命令，若屏幕从没处理过，屏幕现在补做，然后只上报一次：先暂停或继续，再跳转。补上的继续会让留着的播放器重新显示；仍然留着的播放器先补上跳转，再告诉 Hub 它还留着，所以 Hub 保留的是跳转后的位置。不论补做还是不做，welcome 写明的命令都算处理过：之后的 welcome 再写明同样的命令，什么也不变（[`missed-commands.js`](../../../../clients/player/src/missed-commands.js)）。
- **车主在这期间做的事。** 在屏幕上暂停（在 Yolo 的控件里、系统的媒体控件里、画中画或系统播放器里，或因来电）、按返回、在屏幕上跳转、改一项弹幕设置，在 Yolo 回应页面紧接着从它已被 welcome 的连接发出的一次 ping 之前，都算 Yolo 没听到。这条连接按顺序送达，所以 Yolo 在那次回应之后发的，或已经发出而页面没收到的，都是在车主这次操作之后发的；不读任何时钟。这只对 Hub 已经 welcome 过的连接成立：新连接的 hello 把它绑定之前，Hub 仍往旧连接发，所以新连接上的回应说明不了旧连接丢了什么。因此页面只从已被 welcome 的连接 ping，没有这样的连接时车主做的事，在下一次 welcome 之前都算没听到。同一时间只有一次 ping 在途；它的回应覆盖发出它之前车主做的事，之后做的等下一次。这条规则还假定运行时只在送出 Hub 先前从这条连接发出的消息之后才回应 ping。Cloudflare 没有写明运行时的自动回应与 Durable Object 的输出闸门如何排序；存储写入还没确认时，输出闸门会扣住 Hub 发出的消息。回应若越过了这样一条命令，页面就可能把它当成比车主的操作更新，但前提是连接恰好也在这几毫秒里断掉。welcome 时，只要车主的暂停或返回还没被听到，补上的继续就不做，因为那次暂停可能更新，拿不准就不开始播放；车主的跳转还没被听到时，补上的跳转也不做。补上的暂停总是照做，因为它不会开始播放。车主在一次 welcome 之前做的事，在它之后都算听到了，因为 Yolo 从新连接发来的一切都更新。
- **字幕。** welcome 里的 `state.tracks` 是 Hub 为这条流选定的轨道。其中的字幕和屏幕显示的文本字幕不同、且切换不需要新流时（和 `tracks` 消息一样），屏幕改显示 Hub 选的。换成或换掉烧录字幕，以及换音轨，都需要新流。
- **弹幕。** Hub 按设置项保留 agent 的改动最后设下的值和那次改动的 id，直到屏幕确认那次改动。屏幕下一次 welcome 之后，Hub 立即重发它们：每次改动用它自己的 id，只带之后没有改动再设过的设置项，并标上 `again: true`。对这样的消息，屏幕跳过它已经从这次改动应用过的设置项（车主之后可能又改过），也跳过车主改过、还没被听到的设置项，其余照做。在那之后重新加载过的页面两者都不知道，会整条应用。
- **`ended`。** 屏幕播到结尾并告诉 Yolo `ended` 的流，屏幕会记着，直到它又被播放、暂停、跳转，或开始了别的流；Yolo 回应了 `ended` 之后从已被 welcome 的连接发出的一次 ping，这个 `ended` 就算听到了（Hub 绑定新连接之前从它发出的 `ended` 会被丢掉）。welcome 指的还是这条流、而 `ended` 还没被听到时，屏幕重发 `ended`，除非同一个 welcome 补上的暂停或跳转让它暂停或移开。同一条流，Hub 只取一次下一项：Hub 还在为同一条流取下一项时到达的 `ended` 被忽略。
- **不带 `keep` 的 `idle`。** 屏幕离开一条流而没有留住播放器时，会记着这条流，直到某个 `state` 给它标上 `leftAt`，或指向别的流；也记在浏览器标签页的 `sessionStorage` 里，所以在这个标签页里重新加载的页面（刷新、车醒来）也记得。welcome 指的若还是这台设备上的这条流、且没有 `leftAt`，屏幕就带着离开时的位置重发 `idle`，也不续播它。

不认识 `commands` 的页面会忽略它；welcome 不带它时，屏幕播放或暂停的状态和位置保持原样。不认识 `again` 的页面会整条应用这样的弹幕消息。收到 `ended` 一律取下一项的 Hub，只有在第一次 `ended` 已经到达、而其后那次 ping 的回应丢失时，才可能取两项，因为屏幕只在 `ended` 还没被听到时重发它。

### 实时通道留在核心里

实时通道属于 Yolo 核心，不是设备插件。播放器在两个 profile 下都是这条通道的设备，按自己的[能力描述](2026-10-07-capability-negotiation.zh.md)协商播放方式。在车机 profile 下，点按的内容在车上播放；在 web profile 下，也就是在电脑或手机浏览器里，播放器自己能播放（浏览器支持时通过 `<video>`），同时充当遥控器：另一台设备正在播放或暂停时，点按的内容在那台设备上播放，否则在这个浏览器里播放（[点按在哪里播放](../feature/2026-10-11-yolo-web-client.zh.md)）。设备插件的接口等第一个第三方设备（Jellyfin 会话或 Apple TV）出现时，再按它的真实需求设计。

## 曾考虑的替代方案

**像 Plex 那样每台设备一条队列。** 一个人只有一双眼睛，不会同时在两块屏幕上看，所以一条队列加一台当前设备符合 Yolo 的使用方式。

**一开始就把实时通道做成设备插件。** 同一个播放器的两个 profile（车机和 web）都是 Yolo 自己的，讲同一套协议；只有一个实现的接口设计不好。

**由服务端发起心跳。** 服务端定时器每个周期都会唤醒 Hub，为每台连着的设备计费；由设备发 ping、靠自动回复应答则没有成本。

**welcome 之后把所有未确认的命令重发一遍。** 这适合弹幕设置：它们属于屏幕，在任何页面上都能生效。暂停、继续和跳转却属于某条流：刷新过的页面没有对应的播放器，已经按 `state` 播放；把继续重发给留着的播放器，或发给车主在连接失效期间暂停了的屏幕，就会不经屏幕判断地开始播放。只有屏幕知道自己在播哪条流、收到过哪些命令，所以由 welcome 写明命令，由屏幕决定。

## 后果

每台设备看到的是一致的播放状态，在屏幕之间切换播放只需一次调用。被失效连接吞掉的命令或报告会在重连时生效，代价是每台设备为它最后的命令存一条记录，再为它未确认的弹幕设置存一条。心跳和空闲连接不占 Durable Object 的运行时长，限额也限制了出错客户端能造成的开销。一个账号上不能两个人同时看不同的内容，这符合单个用户本人的模型，换成家庭场景时需要重新考虑。第三方播放器需要一个现在还不存在的设备插件接口。
