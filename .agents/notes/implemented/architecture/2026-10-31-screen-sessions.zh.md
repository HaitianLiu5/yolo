# Agent Note: 每块屏各自播放，任意屏一键接手另一块屏

Status: implemented

[English](2026-10-31-screen-sessions.md) | 中文

## 问题

每个 owner 只有一份 `PlaybackState`、一个队列和一个 active device 的 Hub（[Hub 和实时通道](2026-10-07-hub-and-realtime-channel.zh.md)），在另一块屏开播时会停掉原来的屏：这次播放给原来在播的屏发 `deactivate`。一个人一次只在一块屏上看时，这没问题。一个家庭里就不成立：家人在客厅电视上看，owner 在手机上看，任何一方开播都会停掉另一方。

这份单一状态渗进了每个地方：

- **网页模式里点一下，会播到当前在播的地方**，像 Spotify Connect 一样，所以家人在电视上看时，owner 在手机上点一下会播到电视上。
- **agent 的 `play` 不带 `device` 时，播到 active device**，也就是最后播过的那块屏。
- **历史只从 active device 的 report 写入**，任何人在任何屏上看的东西都进了 owner 的历史和"继续看"。
- **上一个、下一个、walk、run 和队列每个 owner 只有一份**（[接下来播什么](../feature/2026-10-23-up-next.zh.md)），电视上一集播完，会拿走 owner 在手机上排进队列的东西。

需求的另一半，正是单一状态做得好的地方：换到另一块屏时，条目和位置都还在。Yolo 要保留这一点，并且更快：在任何屏上，不管是不是刚配对的，点一下就能接着另一块屏在播的东西看，条目、位置、字幕、音轨、接下来播什么都一样。

## 决定

### 术语

- **档案**（profile）：一个正在看的人，比如 owner 或家人。档案拥有历史、继续看、已看标记和音轨偏好，每块屏有一个默认档案。
- **账号**（account）：在某个网站或片库上的登录，由节点保存，供插件使用（[站点账号](../../proposed/feature/2026-10-28-site-accounts.zh.md)）。账号不是一个人：任何档案都能通过任何账号播放。

### 模型

1. **每块屏有自己的会话**：自己的 `PlaybackState`、在历史里的 walk、run、队列、流和待补的命令。任意多块屏可以同时播放，一块屏上的播放从不停掉另一块屏。
2. **人要留下的东西在各屏之间共享**：进度、已看标记和音轨偏好按档案划分，播放列表（包括稍后再看）所有人共用。
3. **在哪块屏上点，就在哪块屏上播。** 控制别的屏要在正在播放条里显式操作。
4. **"在这里继续"一下接手另一块屏的整个上下文**：条目、位置、字幕和音轨、walk、run 和队列。另一块屏暂停。首页提前预热第一个候选，所以点下去和点一个预热过的历史条目一样快。
5. **"移到"是同一个操作的反方向**，目标屏上有人在看时先询问。
6. **会话属于一个档案。** 档案是一个列表，owner 的在最前。家庭屏就是默认档案为家人的屏，家人的观看写进家人的历史，从不写进 owner 的。
7. **一条规则决定没指定屏的请求去哪块屏**，`/v1` 和 MCP 都一样。
8. **正在播放条列出每个在用的会话**，owner 选一个来控制。

### 档案

档案说明是谁在看：会话写谁的历史、进谁的"继续看"和已看标记、记住谁的音轨选择。Yolo 只有一个 owner、一个 passkey、一个 Hub、一套来源和账号；档案是屏和会话上的一个标签，不是一种登录（[`store/profiles.js`](../../../../service/control/src/store/profiles.js)）。

- **档案是一个列表**，每项是 `{ id, name }`。owner 的档案始终在最前，id 是保留的 `owner`（[`@useyolo/core`](../../../../service/core/src/playback.js) 的 `OWNER_PROFILE`），没有对应的行，不能删除或改名。家人在第一次有屏设成它时创建（任何接受档案的请求里，"family"都指它）。owner 在播放器设置的"谁在看"里添加、改名和删除其他档案；删除一个档案会删掉它的历史和音轨选择，并把它的屏改回 owner 的档案。第三个人就是新的一项，协议、Hub 和 D1 都不用改。
- **屏的默认档案**是 owner 的，除非设成别的（`devices.profile_id`）。对类型是电视的屏，批准页会问"谁在这块屏上看"，列出"我"、家人和其他档案，默认选"我"（[`auth/pages.js`](../../../../service/control/src/auth/pages.js)）。owner 在设置里某块屏的编辑器（"谁在这里看"）里改，agent 用 `rename_device` 改。
- **会话的档案在它开始时决定**：接手保留被接手会话的档案，上一个、下一个和流的重建保留会话自己的档案，其他播放用屏的默认档案。owner 在家庭电视上接着看自己的那一集，写的是自己的历史；家人之后在那里点的下一个，是家人的。
- **屏读它默认档案的历史**：家庭屏上的 `GET /v1/history`、片库列表的续播位置和已看标记、首页的"继续看"都是家人的。它的接手卡片仍然列出 owner 的会话，owner 可以在那里接着看。
- **正在播放条给会话标上档案**：会话的档案不是这块屏的默认档案时显示，owner 能看出家庭电视正在写自己的历史。

owner 的历史和音轨选择留在 `history` 和 `track_preferences`，这是上一个版本读写的表；其他每个档案的放在 `profile_history` 和 `profile_track_preferences`。各个存储用同一个函数读每个档案，即 [`store/rows.js`](../../../../service/control/src/store/rows.js) 的 `profileScope()`，所以以后的版本可以把 owner 的行搬进档案表，而不改变模型。

### Hub 里的会话

<a id="sessions-in-the-hub"></a>

Hub 仍然是每个 owner 一个 Durable Object（[`hub-core.js`](../../../../service/control/src/hub/hub-core.js)）。会话按屏保存在 `state:<deviceId>`、`walk:<deviceId>` 和 `run:<deviceId>` 下，旁边是本来就按设备分的 `commands:`、`danmaku:`、`stream:`、`health:`、`rates:`、`network:` 和 canvas。播放按请求的先后编号，同一块屏上最新的那个占住它，所以仍在为这块屏准备的较旧播放被取代，另一块屏上的播放永远不会。最后一次写进度的时间和正在处理的 `ended` 也按屏分。

`PlaybackState` 带着：

| 字段 | 含义 |
|---|---|
| `deviceId` | 会话所属的屏 |
| `profile` | 会话档案的 `{ id, name }` |
| `handedTo` | 另一块屏接手这个会话之后为 `{ deviceId, at }`；会话处于暂停、不算在用，它的屏不会自己续播它 |
| `handedFrom` | 接手了另一个会话的会话上为 `{ deviceId }` |
| `updatedAt` | 会话最后一次变化的时间，用于接手卡片的排序和"在用" |

**report。** 每块屏都 report 自己的会话，Hub 把每个会话的进度写到它的档案下；`sessionId` 检查保留。

**在用的会话**有条目、屏在线、没有 `handedTo`，状态是 `playing`、`loading` 或 `buffering`，或者在最近 30 分钟内是 `paused`（`@useyolo/core` 的 `sessionInUse()`）。"在用"决定默认规则，也决定一次播放或移动要不要先询问。

**结束会话。** 一块屏上的 `stop` 结束它的会话（状态 `idle`，没有条目）。owner 移除一块屏时，它的会话连同 walk、run 和队列一起删除。

**旧存储。** `HubCore.migrateStorage()` 在 Hub 每次启动时运行（[`hub.js`](../../../../service/control/src/hub/hub.js)）：之前版本的那一份 `state`、`walk` 和 `run` 成为播放它们的那块屏的会话，档案是 owner 的；没有屏的队列行归给那块屏（或最后见到的屏）。之后有一个标记让它什么都不做，除非回滚又写了 `state`。

### 队列每块屏一份

队列是会话的一部分，和 walk、run 并列：`queue_items.device_id` 指明是哪块屏，一块屏上的 `next` 取这块屏的队列，接手时队列移过去，排在接手那块屏原有队列的前面（[`store/queue.js`](../../../../service/control/src/store/queue.js)）。

每屏一份队列胜过一份共享队列加上每项"播到哪"，因为队列回答的是"这块屏接下来播什么"，和 walk、run 一样。owner 想以后在任意屏上看的东西放进稍后再看，这是一个所有屏共享的播放列表；`playlist_enqueue` 把播放列表的条目放进某一块屏的队列。

### 在这里继续

<a id="continue-here"></a>

"从其他屏幕继续"是每块能播放的屏首页的第一行（[`browse.js`](../../../../clients/player/src/browse.js)）：最多三个其他屏的会话，每个显示屏名、条目的图片和标题、位置，以及多久之前（[`store.js`](../../../../clients/player/src/store.js) 的 `continueCandidates()`）。它列出属于 owner 档案和这块屏自己默认档案的、有条目且没看完的会话，按最近排序，也包括离线的屏：停好的车的会话就在这里，位置是它最后一次 report 的位置。这块屏自己的会话被别处接手时，接手的那块屏的会话排在最前，标着"已在……上继续"。

这一行在第一个会话会开始的位置预热它的条目：`POST /v1/playback/warm` 除了来源，也接受 `{ source, startTime }` 项，节点把起点作为 `startTime` 传给插件的 `warm()`（这是新增字段，按来源键放在 `startTimes` 里，不升级 `NODE_PROTOCOL`）。

点一下就是 `PUT /v1/playback/device` `{ deviceId: <这块屏>, from: <那块屏> }`（[`playback.js`](../../../../clients/player/src/playback.js) 的 `continueHere()`）。`HubCore.transfer()` 一步完成：

1. 读 `from` 上的会话：条目、推算到现在的位置、walk、run 和档案。
2. 在目标屏上以那个档案从那个位置播放这个条目（`reason: "transfer"`，`autoplay` 为 true），所以由档案保存的字幕和音轨选择来挑音轨；音轨 id 属于某一条流。
3. 复制 walk 和 run，把 `from` 的队列行移到目标屏队列的前面，并给新会话标上 `handedFrom`。
4. `from` 在播时给它发 `pause`，把它的会话标为 `paused` 并带上 `handedTo`，停掉它的节点会话。那块屏保留暂停的画面；如果 owner 在那里继续播放，就像保留的播放器在流失效后那样，用一条新流恢复。
5. 按档案为新会话写历史。

会话已经 `handedTo` 别的屏的那块屏，在 welcome、重新加载或车辆唤醒时都不续播它（[`resume-decision.js`](../../../../clients/player/src/resume-decision.js)）。会话被别处接手时，屏上的播放器像按返回键那样退到首页后面，正在播放条显示"已在客厅电视上继续"；它的播放键一下就把会话从那里拿回来（[`remote.js`](../../../../clients/player/src/remote.js)）。

### 移到

正在播放条的面板用同一个调用把它控制的会话移到另一块屏：`{ deviceId: <目标屏>, from: <会话所在的屏> }`。目标屏有在用的会话、而请求又不是从目标屏本身发出时，Hub 以 `screen_busy` 拒绝，`details` 里写明屏、条目和这是谁的会话；面板问"家人正在客厅电视上观看「标题」。"，确认后带 `replace: true`。被替换的会话的位置写进它档案的历史，那块屏开始播移过去的条目。从目标屏本身发起的接手从不询问：人就在那块屏前。

指定屏的播放（`POST /v1/playback/play` 带 `deviceId`，MCP 的 `play` 带 `device`）在那里在用的会话属于别的档案时，也同样先询问，除非请求就来自那块屏，或带了 `replace: true`。替换 owner 自己在那里的会话不需要询问：是 owner 要求的。

### 请求去哪块屏

<a id="which-screen-a-request-reaches"></a>

`HubCore.resolveScreen()` 决定所有没指定屏的请求去哪块屏，`/v1` 和 MCP 都一样：

1. **从某块屏发出的请求，目标就是那块屏**：配对屏用自己的凭据发的请求（`requester`）。不能播放的遥控器进入第 2 条。从屏幕上发起的 Ask 本来就把这块屏告诉它的 agent（[从屏幕上问 agent](../feature/2026-10-18-agent-from-the-screen.zh.md)）。
2. **否则，看 owner 在用的会话**：正好一个，就发到那里。
3. **一个都没有**：播放发到唯一一块在线、默认档案是 owner、能播放的屏；针对在播内容的命令（`pause`、`seek`、`skip`、`next`……）以 `nothing_playing` 拒绝；队列修改发到 owner 最后播放过的那块屏，不管在不在线；读取在播内容的请求回答说没有在播。
4. **有好几个，或者没有可选的**：以 `device_ambiguous` 拒绝，它的 `details.screens` 列出每块屏的档案和在播什么，agent 去问人要哪一块。

别的档案的会话、以及默认档案是别的档案的屏，永远不是默认目标：agent 只能按名字找到它们。所以 owner 的 agent 说暂停，永远不会停掉家人的电影。错误码 `screen_busy`、`device_ambiguous` 和 `nothing_playing` 在 [`errors.js`](../../../../service/core/src/errors.js) 里。

### 协议：`CLIENT_PROTOCOL` 2

一个通道里有好几块屏的状态，改变了 `state` 的含义：协议 1 的客户端看到一个指向别的设备的 `state`，会理解为播放已经移走了（Apple TV app 的 `AppModel` 会拿 `state.deviceId` 和自己比较）。所以 `CLIENT_PROTOCOL` 是 2，Hub 在一个版本里同时服务 1 和 2（[客户端协议](2026-10-19-client-protocol.zh.md#versions)）。

**协议 2 的实时通道：**

| 消息 | 协议 2 |
|---|---|
| `welcome` | `state` 是这块屏自己的会话（没有会话时为空状态）。另有 `sessions`，其他每块有条目的屏的会话；`profile`，这块屏的默认档案 `{ id, name }`；`profiles`，档案列表。`queue` 是这块屏的队列 |
| `state` | 每块屏的会话变化都发给每个协议 2 连接；state 的 `deviceId` 说明是谁的 |
| `queue` | `{ deviceId, items }`，每块屏的，发给每个协议 2 连接 |
| `devices` | 每台设备带它默认档案的 `profile` id 和它会话的摘要 `session`；协议 2 还收到 `profiles` |
| `pause` | 也发给会话被另一块屏接手的屏；随后的 `state` 带 `handedTo` |
| `deactivate` | 只有 `reason: "replaced"`，即同一块屏从另一个窗口连上 |
| `report`、`ended`、`error` | 来自每块屏，针对它自己的会话 |

**`/v1`**（[`api/v1.js`](../../../../service/control/src/api/v1.js)）：

- `GET /v1/playback` 接受 `?deviceId=`；屏用自己的凭据不带它时读自己的会话，其他情况按默认规则。`GET /v1/playback/sessions` 列出每个有条目的会话，带它的屏和是否在用。`GET /v1/playback/up-next` 和 `GET /v1/tracks` 接受 `?deviceId=`。
- `POST /v1/playback/pause`、`/resume`、`/stop`、`/seek`、`/next`、`/previous` 和 `PUT /v1/playback/tracks` 接受 `deviceId`；不带时按默认规则。
- `PUT /v1/playback/device` 接受 `{ deviceId, from?, replace? }`，同上。
- `POST /v1/playback/play` 不带 `deviceId` 时，请求的屏能播放就播在它上面，否则按默认规则；带它时，用 `replace` 回答 `screen_busy`。
- `GET /v1/queue`、`POST /v1/queue`、`/reorder`、`DELETE` 和 `POST /v1/playlists/:id/enqueue` 接受 `deviceId`，默认是发请求的屏。
- `GET /v1/history` 和 `DELETE /v1/history` 接受 `profile`（id 或名字），默认是发请求的屏的默认档案；条目带 `deviceId`，即最后播放它的屏。片库列表把这个档案的历史叠加到来源列出的内容上。
- `GET /v1/profiles` 列出档案；owner 页面在 `/v1/owner/profiles` 下添加、改名和删除档案，需要 passkey 会话。`PATCH /v1/devices/:id` 和 `/v1/owner/devices/:id` 接受 `profile`，`POST /v1/owner/pairing/approve` 也接受。
- `POST /v1/agent` 给节点传 `playing`，即发问那块屏自己的会话，以及 `others`，其他在用的会话，这样"这个"仍然指这块屏自己的，"电视上在放什么"也能回答。

**协议 1 的客户端**拿到它原来的数据形状，范围只限它自己：welcome 的 `state` 和它收到的每个 `state` 都是它自己的会话，`queue` 是它自己的，从它那里接手时，它收到的是它已经会处理的 `pause`。它在别的屏旁边独立播放；更新之前，它看不到也接手不了别的会话。它用自己凭据发的 `/v1` 请求按第 1 条限定在自己的会话上。

### D1

迁移 [`0015_screen_sessions.sql`](../../../../service/control/migrations/0015_screen_sessions.sql) 新增 `profiles`、`devices.profile_id`、`queue_items.device_id`、`history.device_id`、`profile_history` 和 `profile_track_preferences`，上一个版本的代码也能在上面运行。owner 的历史保留 `history` 的主键，所以上一个版本的 `ON CONFLICT (user_id, source_key)` 写入照常工作，MCP 的 `history` 含义也不变；用一张单独的表，而不是把 `profile_id` 加进那个主键，就不用重建 `history`。`track_preferences` 也是如此。每张新表都有 `user_id`（[D1 数据模型](2026-10-07-d1-data-model.zh.md)）。

### MCP

| 工具 | 行为 |
|---|---|
| `get_status` | 列出每个会话（屏、档案、条目、位置、状态、是否在用、接下来播什么、它队列的摘要）和 `target`：不带 `device` 的命令现在会到哪块屏，或者为什么无法确定 |
| `play` | 不带 `device` 时按默认规则。指定的屏有别的档案在用时以 `screen_busy` 拒绝，除非 `replace: true` |
| `control`、`seek`、`skip`、`set_tracks`、`list_tracks`、`get_playback_health`、`set_danmaku` | `device` 可选，按默认规则 |
| `transfer` | `{ device, from?, replace? }`：把 `from` 的会话（默认按规则）连同整个上下文在 `device` 上继续，`from` 暂停；有人在用 `device` 时 `screen_busy` |
| `queue_list`、`queue_add`、`queue_remove`、`queue_clear`、`playlist_enqueue`、`playlist_import` | `device?`：队列所属的屏，按默认规则 |
| `history` | `profile?`，档案的名字或 id，默认是 owner 的；条目带最后播放它的屏 |
| `list_devices` | 每块屏的默认档案和它会话的摘要，以及档案列表 |
| `rename_device` | `profile?`：档案的名字或 id，作为这块屏新的默认档案 |

服务器说明用一句话讲清默认规则：发问的屏，否则 owner 正在播放的那一块屏，否则问（[`mcp/server.js`](../../../../service/control/src/mcp/server.js)）。agent 插件的提示根据 `others` 为每块其他在用的屏加一行。

### 浏览器播放器

- [`play-target.js`](../../../../clients/player/src/play-target.js)：只要这个浏览器能播，车机模式和网页模式下点一下都在这里播；遥控器播到唯一一块在线的其他屏，否则由 owner 选。
- [`store.js`](../../../../clients/player/src/store.js)：`hub` 是这块屏自己的会话，`sessions` 按设备 id 保存其他每块屏的会话；上一个、下一个和接下来播什么读自己的会话，`inUse()` 和 Hub 的规则一致。
- [`main.js`](../../../../clients/player/src/main.js)：`hello` 带协议 2；`state` 和 `queue` 按 `deviceId` 处理；`deactivate` 只处理 `replaced`。
- [`remote.js`](../../../../clients/player/src/remote.js)：播放条控制一个会话，先是这块屏自己按返回键留下或被别处接手的会话，否则是最近的其他在用会话，每个命令都带它的 `deviceId`。它的面板列出每个在用的会话，带屏名和档案；点一下就控制它，"在这里继续"在这里接手它，"移到"把控制的会话送到别处并在 `screen_busy` 时询问，"停止播放"停掉它。
- [`browse.js`](../../../../clients/player/src/browse.js)：上面的接手这一行和它的预热；遥控器点一下播到别处时，遇到 `screen_busy` 也会询问。
- [`settings.js`](../../../../clients/player/src/settings.js)："谁在看"列出档案，并添加、改名和删除它们；屏的编辑器设置"谁在这里看"。

## 备选方案

**保留一个 active device，加上"在这里继续"。** 这是 Spotify Connect 的模型，加上更快的转移。它能快速续看，但不能独立使用：家人的电视和 owner 的手机仍然不能同时播放。

**一份共享队列，每项带目标屏。** 每块屏播完时都得从别的屏也在改的列表里挑出自己的项，没有目标屏的项会被最先播完的那块屏拿走。每屏队列加一个共享的稍后再看播放列表，用更少的东西表达了同样的意思。

**给家人独立的 Yolo 用户**，各自登录、各自来源和权限。它会打开整个系统依赖的单 owner 模型：passkey、每个用户一个 Hub、每行 D1 上的 `user_id`、节点的来源。档案以很小的代价给家庭分开的历史，而且如果以后真要做独立用户，也和它兼容。

**固定的两个档案：owner 和家人。** 它的代价和列表差不多：表、协议里的 `{ id, name }`、批准页的问题，形状都一样。固定的两个档案在有第三个人时，比如一个有自己历史的孩子，需要改协议和迁移；列表只需要新加一项。

**在屏上加家庭标记，而不是在会话上加档案。** 家庭屏上的观看永远不算 owner 的，所以 owner 开完车回家在电视上接着看那一集，进度就丢了；第二个家人的历史还要迁移。会话上的档案在接手时跟着人走。

**每块屏一个 Hub。** 接手这一行、播放条的会话列表和接手本身都要同时读写两块屏；跨 Durable Object 就是每块屏一次调用、每次广播一次扇出。每个 owner 一个 Hub 已经持有所有连接，按屏分键不多花什么。

**在新屏上自动继续**，像 Spotify 在别处暂停时打开 app 那样。在家庭电视上，这会把 owner 的那一集放给家人看。接手保持为一次明确的点击，这一行让它只需要一下。

**agent 默认用最近用过的屏。** 两块屏都在用时，它会悄悄选错，比如 owner 想暂停手机，却暂停了家人的电影。询问只多一轮，而且只在 owner 有两块屏在用时才发生。没有在用的会话时的队列修改是例外：它去 owner 最后播放过的那块屏，因为排进队列的东西还不会播，车停着时说"把这个排上"也没有谁可问。

**"移到"之前在目标屏上询问**（"手机想在这里播放"）。这需要有人在电视前回答，发起的一方还要等；发起方自己确认、并看到那里在播什么，对一个家庭来说就够了。

**在指定屏上替换 owner 自己的会话前也询问。** agent 被告知"在车上播 X"时，车上正在播 owner 的 Y，这正是 owner 的意思；再问一遍只是白白多一轮。询问是为别人的观看准备的。

## 后果

- 家人和 owner 同时在不同的屏上看，各有自己的历史、继续看和音轨选择；owner 的 agent 不点名电视，就从不碰家人的电影。
- 任何屏都能一键接手另一块屏的会话，包括刚配对的屏和停好的车的会话，条目的音轨、接下来播什么和队列都跟着过来。
- **节点同时承担好几条流。** 两路转码，或者一路转码加一路中继，可能超过家里机器的 CPU 或 Plex 的转码限制。拒绝会显示在发起的那块屏上，带它的出错面板。
- **每屏状态让 Hub 最难的代码翻倍**：取代、welcome 对丢失的 `load` 的恢复、错过的命令都按屏，Hub 的测试覆盖两块屏同时播放。
- **同一档案的两块屏播同一个条目**，两边写同一行历史；最后一次 report 生效，接手这一行里两个都显示。
- **家庭屏的接手这一行显示 owner 的会话**，家人能看到 owner 在车上看了什么。正是这一点让从车到电视的接手只需按一下。
- **agent 问得更多。** owner 有两块屏在用时，不带设备的命令要多问一句。
- **回滚**到上一个版本时找不到 `state` 键，在某块屏播放之前显示没有在播的东西；它把每块屏的队列行读成一个队列，其他档案的历史留在 `profile_history` 里。[`CHANGELOG.md`](../../../../CHANGELOG.md) 的 `yolo-upgrade` 块写明了这些。

## 测试

[`screen-sessions.test.js`](../../../../service/control/test/unit/screen-sessions.test.js) 在 Hub、服务层和真实迁移之上证明：家庭电视和 owner 的手机同时播放、历史分开，agent 的暂停只到手机；两块屏上的播放互不取代；新配对的屏接手手机的那一集，带它的字幕选择、队列和 run，手机暂停并带 `handedTo`，它的 welcome 不续播；停好的车的会话在家庭电视上作为 owner 的会话继续；移动和指定屏播放的 `screen_busy` 与 `replace`；默认规则的 `device_ambiguous` 和 `nothing_playing`；播放条暂停另一块屏的会话；协议 1 的范围限定；通过 `/v1` 读第三个档案的历史；以及旧存储的迁移。播放器的 [`store.test.js`](../../../../clients/player/test/unit/store.test.js) 覆盖接手这一行提供什么和"在用"。

## 推迟

- **Apple 客户端升到协议 2**：YoloKit 按 `deviceId` 读 `sessions` 和 `state`，接手这一行作为 Apple TV Home 的第一行，它的播放器里显示"已在……上继续"，以及建立在它上面的 iPhone app（PR #72），带播放条的会话列表和"移到"。在那之前，Apple TV app 用协议 1 播放，范围只限它自己。
- **一致性测试套件的协议 2 场景**，随这些客户端一起来。
- **账号的行显示给哪些档案**，随账号插件一起来（[站点账号](../../proposed/feature/2026-10-28-site-accounts.zh.md)）。
- **播放器里面的档案标签**（播放条上已有），以及屏幕启动时选择档案。
- **下一个版本去掉协议 1。**
