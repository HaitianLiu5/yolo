# Agent Note: 每块屏各自播放，任意屏一键接手另一块屏

Status: proposed

[English](2026-10-31-screen-sessions.md) | 中文

## 问题

Hub 为每个 owner 只保存一份 `PlaybackState`、一个队列和一个 active device（[Hub 和实时通道](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md)）。另一块屏开始播放时，原来在播的屏会收到 `deactivate` 并停下（[`hub-core.js`](../../../../service/control/src/hub/hub-core.js) 的 `play()`）。当初的理由是一个人不会同时在两块屏上看。一个家庭里这不成立：家人在客厅电视上看，owner 在手机上看，任何一方开播都会停掉另一方。

这份单一状态渗进了每个地方：

- **web profile 里点一下，会播到当前在播的地方**，像 Spotify Connect 一样（[`play-target.js`](../../../../clients/player/src/play-target.js)、[Yolo Web](../../implemented/feature/2026-10-11-yolo-web-client.zh.md#where-a-tap-plays)）。家人在电视上看时，owner 在手机上点一下，会播到电视上。
- **agent 的 `play` 不带 `device` 时，播到 active device**（[`mcp/tools.js`](../../../../service/control/src/mcp/tools.js)），也就是最后播过的那块屏。
- **历史只从 active device 的 report 写入**（[进度和续播](../../implemented/feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)），任何人在任何屏上看的东西都进了 owner 的历史和"继续看"。
- **上一个、下一个、walk、run 和队列每个 owner 只有一份**（[接下来播什么](../../implemented/feature/2026-10-23-up-next.zh.md)），电视上一集播完，会拿走 owner 在手机上排进队列的东西。

需求的另一半，正是单一状态做得好的地方：换到另一块屏时，条目和位置都还在。Yolo 要保留这一点，并且更快：在任何屏上，不管是不是刚配对的，点一下就能接着另一块屏在播的东西看，条目、位置、字幕、音轨、接下来播什么都一样。

## 提案

### 术语

- **档案**（profile）：一个正在看的人，比如 owner 或家人。档案拥有历史、继续看、已看标记和音轨偏好，每块屏选一个档案。
- **账号**（account）：在某个网站或片库上的登录，比如一个视频网站或一台 Plex 服务器，由节点保存，供插件使用（[账号插件，PR #110](https://github.com/HaitianLiu5/yolo/pull/110)）。账号不是一个人：任何档案都能通过任何账号播放。

### 模型

1. **每块屏有自己的会话**：自己的 `PlaybackState`、在历史里的 walk、run、队列、流和待补的命令。任意多块屏可以同时播放。
2. **人要留下的东西在各屏之间共享**：进度、已看标记和音轨偏好按档案划分（见下），播放列表（包括稍后再看）所有人共用。
3. **在哪块屏上点，就在哪块屏上播。** 控制别的屏要在正在播放条里显式操作。车机已经是这样。
4. **"在这里继续"一下接手另一块屏的整个上下文**：条目、位置、字幕和音轨、walk、run 和队列。另一块屏暂停。首页提前预热第一个候选，所以点下去和点一个预热过的历史条目一样快。
5. **"移到电视"是同一个操作的反方向**，目标屏上有别人在看时先询问。
6. **会话属于一个档案。** 档案是一个列表：owner 的在最前，然后是其他档案，通常是家人。每块屏有一个默认档案；家庭屏就是默认档案为家人的屏。家人的观看写进家人的历史，从不写进 owner 的。
7. **agent 有一条规则决定没指定屏时播到哪**（见下）。
8. **正在播放条列出每个会话**，owner 选一个来控制。

### 档案

**档案**说明是谁在看：会话写谁的历史、进谁的"继续看"和已看标记、记住谁的音轨选择、出现在谁的接手卡片里。Yolo 只有一个 owner、一个 passkey、一个 Hub、一套来源和账号；档案不改变这些。它是屏和会话上的一个标签，不是一种登录。

- **档案是一个列表**，每项是 `{ id, name }`。owner 的档案始终存在、排在最前，id 是 `owner`，不能删除。其他档案都是平等的一项：家人在第一次有屏设成它时创建，owner 在 owner 页面的 设置 › 档案 里添加、改名或删除其他档案。删除一个档案会删掉它的历史和偏好，并把它的屏改回 owner 的档案。第三个人就是新的一项，协议、Hub 和 D1 都不用改。
- **屏的默认档案**是 owner 的，除非设成别的。owner 批准一块类型是电视的屏时，批准页会问"谁在这块屏上看"，列出"我"、家人和其他档案，默认选"我"（[`auth/pages.js`](../../../../service/control/src/auth/pages.js)）。以后 owner 可以在 设置 › 屏幕 里改，agent 也可以用 `rename_device` 改。
- **会话的档案在它开始时决定**：接手保留被接手会话的档案，其他播放用屏的默认档案。所以 owner 在家庭电视上接着看自己的那一集，写的是自己的历史；家人之后在那里点的下一个，是家人的。
- **屏的首页显示它默认档案的**"继续看"、已看标记和续播位置：家庭屏显示家人的，从不显示 owner 的。它的接手卡片仍然列出 owner 的会话，owner 可以在上面接着看。
- **账号的行**（它的关注、订阅或稍后再看）显示在这个账号所列档案的首页上，默认只有 owner 的；owner 在 设置 › 账号 里把家人加到某个账号上。这个列表是账号的设置，和账号保存在一起（PR #110）。它只决定哪些首页显示这些行：任何档案的会话都能通过这个账号播放。
- **播放器标出这是谁的会话**：和屏的默认档案不同时，显示一个写着档案名的小标签，owner 能看出家庭电视正在写自己的历史。

owner 的历史留在 `history`，音轨选择留在 `track_preferences`，这是上一个版本读写的表；其他每个档案的放在 `profile_history` 和 `profile_track_preferences`（见下面的 D1）。像流媒体服务那样在屏幕启动时选人，以后可以建立在同一个列表上。给每个人一个独立的 Yolo 用户，各自登录、各自来源和权限，是另一回事，不在 1.0 里（见备选方案）。

### Hub 里的会话

Hub 仍然是每个 owner 一个 Durable Object。现在每个 owner 一份的存储键变成每块屏一份：`state:<deviceId>`、`walk:<deviceId>`、`run:<deviceId>`；`commands:`、`danmaku:`、`stream:`、`health:`、`rates:`、`network:` 和 canvas 本来就按设备分。Hub 的 `generation` 计数器让较新的播放取代仍在准备的较旧播放，它变成每块屏一个，电视上的播放永远不会取代手机上的。`lastProgressWrite` 也变成每块屏一个。

`PlaybackState` 新增：

| 字段 | 含义 |
|---|---|
| `profile` | 会话档案的 `{ id, name }`；owner 的 id 是 `owner` |
| `handedTo` | 另一块屏接手这个会话之后为 `{ deviceId, at }`；会话处于暂停，这块屏不会自己续播它 |
| `handedFrom` | 接手了另一个会话的会话上为 `{ deviceId }` |
| `updatedAt` | 会话最后一次变化的时间，用于接手卡片的排序和"在用" |

`deviceId` 本来就指明是哪块屏；每份 state 都带着它。

**report。** 每块屏都 report 自己的会话，Hub 把每个会话的历史写到它的档案下。"只接受 active device 的 report"变成"只接受这台设备自己会话的 report"；`sessionId` 检查保留。

**在用的会话**有条目、屏在线，状态是 `playing`、`loading` 或 `buffering`，或者在最近 30 分钟内是 `paused`。"在用"决定 agent 的默认目标，也决定"移到"要不要询问。

**结束会话。** 一块屏上的 `stop` 结束它的会话（状态 `idle`，没有条目）。owner 移除一块屏时，它的会话一起删除。

### 队列每块屏一份

队列成为会话的一部分，和 walk、run 并列：`queue_items` 新增 `device_id`，一块屏上的 `next` 取这块屏的队列。接手时，队列和其余上下文一起移过去，排在接手那块屏原有队列的前面。

每屏一份队列胜过一份共享队列加上每项"播到哪"，因为队列回答的是"这块屏接下来播什么"，和 walk、run 一样。共享队列下，电视上一集播完会拿走 owner 在手机上排的东西，否则每块屏都得判断哪些项是自己的，那其实就是绕了个弯的每屏队列。owner 想以后在任意屏上看的东西放进稍后再看，这是一个所有屏共享的播放列表；`playlist_enqueue` 把播放列表的条目放进某一块屏的队列。

### 在这里继续

接手卡片在每个首页的顶部："从其他屏幕继续"，最多三个会话，每个显示屏名、条目的图片和标题、位置，以及多久之前。它列出其他屏上属于 owner 的会话、以及属于这块屏默认档案的会话，条件是有条目且没看完，按最近排序，也包括现在离线的屏的会话：停好的车的会话就在这里，位置是它最后一次 report 的位置。别的档案的会话从不出现在默认档案为 owner 的屏上；owner 从正在播放条里找到它。

卡片出现时，这块屏先为第一张卡片的条目请求 `POST /v1/playback/warm`，再为历史条目请求。`warm` 除了来源，也接受 `{ source, startTime }` 项，并把 `startTime` 传给节点；这是新增字段，不升级 `NODE_PROTOCOL`。

点一下就是 `PUT /v1/playback/device` `{ deviceId: <这块屏>, from: <那块屏> }`。Hub 一步完成：

1. 读 `from` 上的会话：条目、推算到现在的位置、字幕和音轨、walk、run、档案。
2. 在目标屏上从那个位置播放这个条目（`reason: "transfer"`），把选中的字幕和音轨作为偏好传过去（音轨 id 属于某一条流），`autoplay` 为 true。
3. 复制 walk 和 run，把 `from` 的队列行移到目标屏队列的前面，让目标屏的会话用 `from` 会话的档案，并带上 `handedFrom`。
4. `from` 在播时给它发 `pause`，把它的会话标为 `paused` 并带上 `handedTo`，停掉它的节点会话，和释放保留的播放器时一样；那块屏保留暂停的画面，如果 owner 在那里继续播放，就像保留的播放器在流失效后再显示一样，用一条新流恢复。
5. 按档案为目标屏的会话写历史。

会话已经 `handedTo` 别的屏的那块屏，在 welcome、重新加载或车辆唤醒时都不续播它（[`resume-decision.js`](../../../../clients/player/src/resume-decision.js)）：它的首页显示"已在客厅电视上继续"，并有"在这里继续"可以拿回来。

### 移到

正在播放条的选择器用同一个调用把一个会话移到另一块屏：`{ deviceId: <目标屏>, from: <会话所在的屏> }`。目标屏有在用的会话、而请求又不是从目标屏本身发出时，Hub 以 `screen_busy` 拒绝，并说明那里在播什么、是谁的；这块屏问"家人正在客厅电视上看《标题》。改为在那里播这个吗？"，确认后带 `replace: true` 再发一次。被替换的会话的位置写进它档案的历史，那块屏开始播新的条目。从目标屏本身发起的接手从不询问：人就在那块屏前。

### agent 播到哪块屏

一个函数决定所有没指定屏的请求去哪块屏，`/v1` 和 MCP 都一样：

1. **从某块屏发出的请求，目标就是那块屏**：配对屏用自己的凭据发的请求，以及从它发起的 Ask，控制面已经会传它的 `device`（[从屏幕上问 agent](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)）。只能遥控的浏览器进入第 2 条。
2. **否则，看 owner 在用的会话**：正好一个，就发到那里。
3. **一个都没有**：播放发到唯一一块在线、默认档案是 owner、能播放的屏；控制命令（`pause`、`seek`、`skip`……）以 `nothing_playing` 拒绝。
4. **有好几个，或者没有可选的**：以 `device_ambiguous` 拒绝，列出每块屏和它在播什么，agent 在回复里问人要哪一块。

别的档案的会话、以及默认档案是别的档案的屏，永远不是默认目标：agent 只能按名字找到它们。所以 owner 的 agent 说暂停，永远不会停掉家人的电影。

### 协议：`CLIENT_PROTOCOL` 2

一个通道里有好几块屏的状态，改变了 `state` 的含义：协议 1 的客户端看到一个指向别的设备的 `state`，会理解为播放已经移走了（Apple TV app 的 `AppModel` 会拿 `state.deviceId` 和自己比较）。所以这次把 `CLIENT_PROTOCOL` 升到 2，Hub 在一个版本里同时服务 1 和 2（[客户端协议](../../implemented/architecture/2026-10-19-client-protocol.zh.md#versions)）。

**协议 2 在实时通道上的变化：**

| 消息 | 协议 2 |
|---|---|
| `welcome` | `state` 是这块屏自己的会话（没有会话时为空状态）。新增：`sessions`，其他每块有条目的屏的会话；`profile`，这块屏的默认档案 `{ id, name }`；`profiles`，档案列表。`queue` 是这块屏的队列 |
| `state` | 每块屏的会话变化都发给每个协议 2 连接；state 的 `deviceId` 说明是谁的 |
| `queue` | `{ deviceId, items }`，每块屏的，发给每个协议 2 连接 |
| `pause` | 也发给会话被另一块屏接手的屏；随后的 `state` 带 `handedTo` |
| `deactivate` | 只有 `reason: "replaced"`，即同一块屏从另一个窗口连上。别的屏开播不再让任何屏 deactivate |
| `report`、`ended`、`error` | 来自每块屏，针对它自己的会话 |

**`/v1`：**

- `GET /v1/playback` 接受 `?deviceId=`；屏用自己的凭据不带它时读自己的会话，其他情况按默认规则。新增 `GET /v1/playback/sessions` 列出每个会话。`GET /v1/playback/up-next` 接受 `?deviceId=`。
- `POST /v1/playback/pause`、`/resume`、`/stop`、`/seek`、`/next`、`/previous` 和 `PUT /v1/playback/tracks` 接受 `deviceId`；不带时按默认规则。
- `PUT /v1/playback/device` 接受 `{ deviceId, from?, replace? }`，同上。
- `POST /v1/playback/play` 不带 `deviceId` 时，请求的屏能播放就播在它上面，否则按默认规则。
- `GET /v1/queue`、`POST /v1/queue`、`/reorder` 和 `DELETE` 接受 `deviceId`，默认是发请求的屏。
- `GET /v1/history` 接受 `?profile=`，默认是发请求的屏的默认档案；条目带 `deviceId`，即最后播放它的屏。片库列表把这个档案的历史叠加到来源列出的内容上，播放也从它续播。
- `GET /v1/profiles` 列出档案；owner 页面在 `/v1/owner/profiles` 下添加、改名和删除档案，需要 passkey 会话。
- `PATCH /v1/devices/:id` 和 `/v1/owner/devices` 接受 `profile`，一个档案的 id。
- `POST /v1/agent` 传的 `playing` 是发问那块屏自己的会话，另传 `others`，其他在用的会话，这样"这个"仍然指这块屏自己的，"电视上在放什么"也能回答。

**协议 1 的客户端**拿到的是它现在的数据形状，范围只限它自己：`welcome.state` 和它收到的每个 `state` 只是它自己的会话，`queue` 是它自己的队列，从它那里接手时，它收到的是它已经会处理的 `pause`。它在别的屏旁边独立播放；更新之前，它看不到也接手不了别的会话。协议 1 的 `/v1` 请求（`Yolo-Protocol` 头）同样这样限定范围。

### D1

迁移 `0015_screen_sessions.sql`，写成上一个版本的代码也能在上面运行：

```sql
-- Profiles other than the owner's: who is watching. The owner's profile
-- has the reserved id 'owner' and no row; NULL profile_id means it.
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_profiles_user ON profiles(user_id);

ALTER TABLE devices ADD COLUMN profile_id TEXT;    -- a screen's default profile
ALTER TABLE queue_items ADD COLUMN device_id TEXT; -- the screen whose queue it is
CREATE INDEX idx_queue_items_user_device ON queue_items(user_id, device_id, position);
ALTER TABLE history ADD COLUMN device_id TEXT;     -- the screen that played it last

-- A profile's history, as `history` is the owner's, newest 500 per profile.
CREATE TABLE profile_history (
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail TEXT,
  position REAL NOT NULL DEFAULT 0,
  duration REAL,
  play_count INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  watched_at INTEGER,
  show_key TEXT,
  season_key TEXT,
  device_id TEXT,
  PRIMARY KEY (user_id, profile_id, source_key)
);
CREATE INDEX idx_profile_history_updated ON profile_history(user_id, profile_id, updated_at DESC);

-- A profile's track choices, as `track_preferences` holds the owner's.
CREATE TABLE profile_track_preferences (
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  selection TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile_id, source_key)
);
```

owner 的历史留在 `history` 里，主键不变，所以上一个版本照常读写它，MCP 的 `history` 含义也不变。用一张单独的表，而不是把 `profile_id` 加进 `history` 的主键，就不用重建 `history`，上一个版本的 `ON CONFLICT (user_id, source_key)` 写入依赖这个主键。`track_preferences` 也是如此。每张新表都有 `user_id`（[D1 数据模型](../../implemented/architecture/2026-10-07-d1-data-model.zh.md)）。每类数据两张表只是存储上的细节：Hub 和 `/v1` 用同一个函数读每个档案，所以以后的版本可以把 owner 的行搬进档案表，而不改变模型。

### MCP

| 工具 | 变化 |
|---|---|
| `get_status` | 列出每个会话：屏、档案、条目、位置、状态、是否在用、接下来播什么。说明不带 `device` 的命令现在会到哪块屏，或者说明无法确定 |
| `play` | 不带 `device` 时按默认规则。指定的屏有别人在用时以 `screen_busy` 拒绝，除非 `replace: true` |
| `control`、`seek`、`skip`、`set_tracks`、`list_tracks`、`get_playback_health`、`set_danmaku` | `device` 可选，按默认规则；`device_ambiguous` 列出各块屏 |
| `transfer` | `{ device, from?, replace? }`：把 `from` 的会话（按默认规则）连同整个上下文在 `device` 上继续，`from` 暂停；`screen_busy` 同 `play` |
| `queue_list`、`queue_add`、`queue_remove`、`queue_clear`、`playlist_enqueue` | `device?`：队列所属的屏，按默认规则 |
| `history` | `profile?`，档案的名字或 id，默认是 owner 的；条目带最后播放它的屏 |
| `list_devices` | 每块屏的默认档案和它会话的摘要，以及档案列表 |
| `rename_device` | `profile?`：档案的名字或 id，作为这块屏新的默认档案 |

服务器说明从"默认播到 active device"改成一句话讲清默认规则：发问的屏，否则 owner 正在用的那一块屏，否则问。agent 插件的系统提示本来就是播到发问的屏。

### 客户端

**web 和车机**（[`clients/player/`](../../../../clients/player/)）：

- `play-target.js`：只要这个浏览器能播，两种 profile 下点一下都在这里播；只能遥控的浏览器保留选择器。
- `store.js`：按 `deviceId` 保存每个会话和这块屏自己的会话；上一个、下一个和接下来播什么读自己的会话。
- `remote.js`：正在播放条列出每个会话，这块屏保留的那个在最前，每个都带屏名和档案；owner 选一个来控制，它的选择器带着 `from` 移动那个会话，遇到 `screen_busy` 时询问。
- `browse.js`：首页顶部的接手卡片和它的预热。
- `resume-decision.js` 和 `kept-player.js`：已经 `handedTo` 别的屏的会话不续播；它的播放器保持暂停，显示"已在……上继续"和"在这里继续"。
- `main.js`：`hello` 带协议 2；`state` 和 `queue` 按 `deviceId` 处理；`deactivate` 只处理 `replaced`。
- `settings.js` 和 owner 页面：设置 › 屏幕 显示每块屏"谁在这里看"。
- 车机保持原有布局；卡片和播放条的会话列表和它其他的面板一样放在驾驶员一侧（[设计原则](../../implemented/architecture/2026-07-13-in-car-design-principles.zh.md)）。

**Apple TV**（[`clients/apple/`](../../../../clients/apple/)）：

- YoloKit：`hello` 带协议 2；`RealtimeMessages` 和 `Playback.swift` 按 `deviceId` 读 `sessions` 和 `state`；`MissedCommands.swift` 只读自己的会话；`APIClient.swift` 在上面那些路由上加 `deviceId` 和 `from`。
- `AppModel.swift` 保存每个会话，不再把别的屏的 `state` 当作 deactivate。
- `HomeScreens.swift`：接手卡片作为 Home 的第一行，提前预热，按一下选择键就继续。
- `TVPlayer.swift`：已经 `handedTo` 别的屏的会话显示为暂停，带"已在……上继续"。
- 设置里显示这块屏的档案；owner 在批准时或在 owner 页面里设置，电视上不需要选择器。
- 正在播放的会话列表和"移到"是 W8 里电视的遥控工作，建立在这些路由上。

**iPhone 和 iPad**（PR #72，未合并）：这个 app 和电视共用 YoloKit 和应用层，所以从第一个版本起就说协议 2，从不发布协议 1。在电视的改动之上，它加上手机该有的：Home 顶部的接手卡片、列出每个会话并控制选中那个的正在播放条，以及带 `screen_busy` 询问的"移到"。AirPlay 仍然是系统自己的，不算 Yolo 的接手。

**一致性测试套件**：新增场景：带 `sessions` 的协议 2 welcome；别的屏的 `state` 不能改变客户端在播的东西；接手时的 `pause` 带 `handedTo`，之后重连不续播；带 `reason: "transfer"` 和音轨的 `load`；协议 1 客户端只看到自己的会话。

### 升级和兼容

1. **发布这项改动的版本**用 `0015` 迁移 D1，Hub 第一次加载时搬运旧存储：`state` 搬到 `state:<它的 deviceId>`，`walk` 和 `run` 搬到那块屏的键，没有 `device_id` 的队列行归给最后播放的屏。它同时服务协议 1 和 2。浏览器播放器随 Worker 发布，立即说协议 2；之前加载的标签页像每次发布一样重新加载。
2. **协议 1 的原生客户端**在更新之前，如上所述继续在自己的屏上播放。带协议 2 的 Apple TV 版本和第一个 iPhone 版本在下一个版本之前发布。
3. **下一个版本**去掉协议 1。

回滚到上一个版本时找不到 `state` 键，所以显示没有在播的东西；屏幕点一下就能再播。它把每块屏的队列行读成一个队列，也看不到家人的历史，那些历史留在 `profile_history` 里。`CHANGELOG.md` 的 `yolo-upgrade` 块要写明这些。隐私页（`site/public/privacy.html` 和它的中文页）在同一个改动里说明服务器会保存每个档案的名字、历史和音轨选择，以及播放过某条目的屏。

### 这份提案改动的笔记

上线时，这份提案取代 [Hub 和实时通道](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md) 里的"一个队列，一个 active device"和"每台设备一个队列"这个备选方案，并在同一个改动里更新：那份笔记的消息表；[Yolo Web](../../implemented/feature/2026-10-11-yolo-web-client.zh.md) 的"点一下在哪里播放"和"遥控器"；[进度和续播](../../implemented/feature/2026-10-11-yolo-owns-progress-and-resume.zh.md) 的记录、继续看和续播；[接下来播什么](../../implemented/feature/2026-10-23-up-next.zh.md)；[`/v1`](../../implemented/architecture/2026-10-07-v1-http-api.zh.md)；[远程 MCP 服务器](../../implemented/feature/2026-10-07-remote-mcp-server.zh.md)；[D1 数据模型](../../implemented/architecture/2026-10-07-d1-data-model.zh.md)；[客户端协议](../../implemented/architecture/2026-10-19-client-protocol.zh.md)；以及[从屏幕上问 agent](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)。Hub 那份笔记仍然有效：实时通道、它的限制、断掉的连接带走了什么，都不变，只是按会话来。

### 计划

1. **Hub 和协议**：每屏会话、每屏队列、默认规则、接手、`/v1`、MCP、迁移 `0015`，以及浏览器播放器（点一下在这里播、播放条里的会话、卡片）。和浏览器播放器在同一个版本里，因为两者都随 Worker 发布。
2. **档案**：启用档案列表和它的表、批准页的问题、设置 › 档案 和 › 屏幕、账号的行显示给哪些档案、播放器的标签。可以在同一个版本里发布。
3. **Apple 客户端**：Apple TV app 升到协议 2，PR #72 建立在它上面（W8）。
4. **下一个版本**去掉协议 1。

## 备选方案

**保留一个 active device，加上"在这里继续"。** 这是 Spotify Connect 的模型，也就是现在的模型加上更快的转移。它能快速续看，但不能独立使用：家人的电视和 owner 的手机仍然不能同时播放。

**一份共享队列，每项带目标屏。** 每块屏播完时都得从别的屏也在改的列表里挑出自己的项，没有目标屏的项会被最先播完的那块屏拿走。每屏队列加一个共享的稍后再看播放列表，用更少的东西表达了同样的意思（见上）。

**给家人独立的 Yolo 用户**，各自登录、各自来源和权限。它会打开整个系统依赖的单 owner 模型：passkey、每个用户一个 Hub、每行 D1 上的 `user_id`、节点的来源。档案以很小的代价给家庭分开的历史，而且如果以后真要做独立用户，也和它兼容。

**固定的两个档案：owner 和家人。** 它的代价和列表差不多：表、协议里的 `{ id, name }`、批准页的问题，形状都一样。固定的两个档案在有第三个人时，比如一个有自己历史的孩子，需要改协议和迁移；列表只需要新加一项。

**在屏上加家庭标记，而不是在会话上加档案。** 家庭屏上的观看永远不算 owner 的，所以 owner 开完车回家在电视上接着看那一集，进度就丢了；以后要给第二个家人单独的历史还要迁移。会话上的档案在接手时跟着人走。

**每块屏一个 Hub。** 接手卡片、播放条的会话列表和接手本身都要同时读写两块屏；跨 Durable Object 就是每块屏一次调用、每次广播一次扇出。每个 owner 一个 Hub 已经持有所有连接，按屏分键不多花什么。

**在新屏上自动继续**，像 Spotify 在别处暂停时打开 app 那样。在家庭电视上，这会把 owner 的那一集放给家人看。接手保持为一次明确的点击，卡片让它只需要一下。

**agent 默认用最近用过的屏。** 两块屏都在用时，它会悄悄选错，比如 owner 想暂停手机，却暂停了家人的电影。询问只多一轮，而且只在 owner 有两块屏在用时才发生。

**"移到"之前在目标屏上询问**（"手机想在这里播放"）。这需要有人在电视前回答，发起的一方还要等；发起方自己确认、并看到那里在播什么，对一个家庭来说就够了。

## 验收标准

1. **家人看电视，owner 看手机。** 电视（默认家人）在播一部电影；owner 在手机上点一集。两边都在播，谁也不暂停。owner 的历史只多了这一集；家人的历史多了这部电影。owner 的 agent 不指定设备说"暂停"：手机暂停，电影继续播。
2. **新配对的屏一键接手。** 手机正在播第 3 集，带中文字幕，队列里排了两集，owner 配对了一个浏览器。它的首页在"从其他屏幕继续"里第一个显示手机的会话。点一下，第 3 集从手机的位置开始播，带中文字幕，和预热过的历史条目一样快；手机暂停并显示"已在……上继续"；下一个先播队列里的第一集，然后是 run。
3. **停好车，回家用电视。** 车上在播第 5 集，停车后休眠，它的会话保留最后一次 report 的位置。到家后，家庭电视的卡片显示"Model Y · 第 5 集 · 23:10"。按一下，它在电视上作为 owner 的会话继续，写 owner 的历史。车醒来时不续播第 5 集，而是显示"已在客厅电视上继续"。
4. **家人在看时移到电视。** 在手机的播放条上选"移到客厅电视"，会先询问，并说出家人在看的电影。取消什么都不变。确认后手机的这一集在电视上从原位置播放，电影的位置记在家人的历史里。
5. **agent。** 从车上发起的 Ask 在车里播，电视继续播。手机和车都在用时，外部 agent 的"播放 X"以 `device_ambiguous` 被拒，列出两块屏，agent 问要哪一块。只有家庭电视在用时，owner 的 agent 说"播放 X"，会播到 owner 唯一在线的屏上，从不播到电视上。
6. **播放条。** 手机的正在播放条列出电视和车的会话；在手机上暂停电视的会话，只暂停电视。
7. **协议 1。** 协议 1 的 Apple TV 版本在手机播别的东西时播自己的条目，手机接手它的会话时它暂停。
8. **第三个档案。** owner 在 设置 › 档案 里添加"孩子"，把卧室的平板设成它。不更新任何客户端，平板的首页就显示孩子的历史，它的观看写进孩子的历史，和家人、owner 的分开。
9. **账号的行。** owner 登录的视频账号，它的关注显示在 owner 的手机上，不显示在家庭电视上。owner 把家人加到这个账号之后，电视上也显示它们，在电视上从这里播放写的是家人的历史。
10. **检查。** `npm run check` 通过，Hub 的测试覆盖每屏会话、默认规则、`screen_busy`、接手、旧存储的迁移和协议 1 的范围限定；一致性测试套件的新场景在 Apple TV 和 iPhone app 上通过。

## 风险

- **节点同时承担好几条流。** 两路转码，或者一路转码加一路中继，可能超过家里机器的 CPU 或 Plex 的转码限制。节点已经在一条在播的流旁边服务预热会话；拒绝会显示在发起的那块屏上，带它的出错面板。
- **每屏状态让 Hub 最难的代码翻倍。** 取代、welcome 对丢失的 `load` 的恢复、错过的命令，原来按 owner，现在按屏；`generation` 计数器最微妙。Hub 的测试要为每一项覆盖两块屏同时播放。
- **同一档案的两块屏播同一个条目**，两边写同一行历史；最后一次 report 生效，卡片里两个都显示。
- **家庭屏的卡片显示 owner 的会话**，家人能看到 owner 在车上看了什么。正是这一点让从车到电视的接手只需按一下；如果在意，以后可以加一个设置把它隐藏。
- **协议 1 的 Apple TV 版本**在更新之前不能接手，从它那里接手只会让它暂停。
- **回滚**会显示没有在播的东西并合并队列，如上所述。
- **agent 问得更多。** owner 有两块屏在用时，不带设备的命令要多问一句。
