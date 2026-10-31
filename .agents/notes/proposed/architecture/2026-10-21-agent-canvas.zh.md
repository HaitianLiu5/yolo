# Agent Note: 每块屏幕上一张供 agent 摆放内容的画布

Status: proposed

[English](2026-10-21-agent-canvas.md) | 中文

## 问题

agent 找到想看的内容后只能直接行动，或者说话：`play` 会替换正在播放的内容；有几个都说得通时，[agent 插件](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)什么都不放，用一句话说出最多三个，由人的下一个请求来回答。人看不到这三个是什么、长什么样、有多长，还得再说一次或再打一次字来选，而这在车里恰恰最难。除了播放和 Ask 面板里的一句话，agent 做的任何事都没法显示在屏幕上；除了再问一个问题，人在屏幕上做的任何事也传不回 agent。

在结果之间做选择，只是一个更大需求的第一种情况。agent 应该能往主人的屏幕上放东西，并在有人使用它们时得到回应：一组选项、一张便签、一张图片、一段视频，在电脑或电视上还可以是所有窗口后面的壁纸或最上层的悬浮层，就像 Wallpaper Engine 和 Lively Wallpaper 那样。这些屏幕包括 Tesla 的浏览器、其他浏览器、[Apple TV app](../feature/2026-10-19-apple-tv-client.zh.md)、iPhone 和 iPad app，以后还有桌面和 Android 宿主，而 Apple TV 没有网页引擎。底下的通道在所有平台上必须一样，这样新平台只需要一个渲染器。

## 提案

Hub 为每块屏幕保存一张**画布**：画布由若干叫 **surface** 的层组成，层上是 agent 摆放、修改、移除的**对象**。Hub 是唯一权威。屏幕通过 realtime 通道收到画布，用自己的组件画出来；人对对象做的操作以**事件**的形式回到 Hub，由 Hub 执行、记录，并交给 agent。通道完全不知道对象怎么画：平台之间唯一的差别是各自能画哪些对象类型（kind）。

![agent 通过 MCP 摆放对象、读取或等待事件；Hub 为每块屏幕保存一张画布和一份事件日志；屏幕通过 realtime 通道收到画布，通过 /v1 发回事件](2026-10-21-agent-canvas.svg)

### 分层

- **传输**就是 Yolo 现有的：向下是 [realtime 通道](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md)，向上是 `/v1` HTTP，agent 走 [MCP](../../implemented/feature/2026-10-07-remote-mcp-server.zh.md)。WebSocket、JSON 和 HTTP 在所有平台上都有；协议的 JavaScript 端放在 `@useyolo/core`，Swift 端放在 YoloKit。
- **画布协议**（surface、对象、操作、事件）是在所有平台上都保持一致的部分。
- **kind** 说明一个对象是什么。每个宿主声明自己能画的 kind 及其版本；画不了的对象显示它的 fallback。
- **宿主**在某个平台上画出画布，并把事件发回来。

### surface 和对象

**surface** 是一块屏幕上的一层：

| surface | 位置 |
|---|---|
| `panel` | 客户端已有的面板里，比如 Ask |
| `player` | 播放时叠在画面上 |
| `overlay` | 在其他一切之上；没有对象的地方，输入直接穿透 |
| `wallpaper` | 在所有窗口后面，作为桌面或电视背景 |

宿主在 `hello` 的 capabilities 里声明自己有哪些 surface，以及能画的 kind：`canvas: { surfaces: ["panel", "player"], kinds: { note: 1, image: 1, choices: 1 } }`。

所有 kind 的**对象**都用同一个外壳：

```json
{
  "id": "obj_7Qf2",
  "surface": "overlay",
  "kind": "note",
  "rev": 12,
  "layout": { "anchor": "top-right", "w": 0.25, "h": "auto", "z": 3 },
  "props": { "text": "Tyres at 9 tomorrow" },
  "actions": { "press": { "do": "notify" } },
  "fallback": { "title": "Note", "text": "Tyres at 9 tomorrow" },
  "owner": "agent:claude-code",
  "scope": "device",
  "transient": false,
  "expiresAt": null
}
```

- **布局用锚点和比例，不用像素。** `anchor` 是 surface 上九个点之一，`w` 和 `h` 是 surface 宽高的比例或 `auto`，`z` 决定同一 surface 上对象的前后顺序。车机窗口只有 601 CSS 像素高，电视是 1080 或 2160；agent 不可能知道，也不需要知道。宿主把对象放在自己的安全区域内，并遵守[车内设计原则](../../implemented/architecture/2026-07-13-in-car-design-principles.zh.md)的触控尺寸。
- **`fallback`** 是一个标题、一行文字和一张可选的图片，所有宿主都能画。kind 和宿主正是靠它各自演进：宿主不认识某个 kind 或它的新版本时，就画 fallback。
- **`scope`** 为 `device` 时，对象只在放置它的那块屏幕上（默认值，也就是 agent 被提问时所在的屏幕）；为 `all` 时，主人的每块屏幕都有它，各自在自己的画布上画，前提是有对应的 surface。
- **`transient`**（临时）对象只属于当下（比如等待回答的选项、一次确认）：它们会过期，也从不存进布局或被复制。
- **`owner`** 是放置者：node 上的 agent 插件是 `agent:<id>`，MCP 客户端是它 OAuth 客户端的名字，人自己是 `owner`。agent 能修改或移除自己放的对象；移除别人的需要 `manage` scope。

操作只有 `put`、`patch` 和 `remove`。每次操作都让画布的 `rev` 加一，同一对象按最后写入者为准（last-writer-wins）合并：所有修改都经 Hub 排序，所以不需要 CRDT。人在屏幕上拖动便签，也像 agent 一样发一个 `patch`。welcome 里带上每块屏幕的完整画布和它的 `rev`；之后的修改以 `canvas_ops` 下发，附带修改后的 `rev`，宿主发现跳号就重新要一次画布。

### 每块屏幕一张画布，用布局来复制

每块屏幕有自己的画布，因为屏幕的尺寸、surface 和 kind 都不同：车机没有壁纸层，电视不能触摸。每块屏幕都该显示的东西，用 `scope: all` 的对象。

**布局**是一张画布的保存副本：只含持久对象，不含临时对象、`scope: all` 的对象（它们已经在每块屏幕上了）和事件日志。布局存在 D1（`canvas_layouts`，带 `user_id`，遵循 [D1 数据模型](../../implemented/architecture/2026-10-07-d1-data-model.zh.md)），这样主人的页面能列出它们，D1 备份也会保存它们；正在使用的画布仍存在 Hub 的 storage 里。

- **保存**：把一块屏幕的画布存成一个有名字的布局，屏幕上和 agent 都能做。
- **应用**：把布局应用到一块屏幕，替换它的画布或合并进去。应用就是复制：每个对象都拿到新 id，之后这块屏幕的画布是独立的，所以改一块屏幕绝不会改到另一块。
- **复制**：把一块屏幕的画布复制到另一块，相当于一步完成“存快照再应用”。
- **用布局初始化新屏幕**：配对时列出主人的布局；布局可以设为某种设备类型（`car`、`tv`、`computer` 等）的默认布局，这样第二台电视一开始就和第一台一样。

如果目标屏幕没有某个对象所在的 surface，这个对象仍保留在画布里但不画出来，宿主把它报告为隐藏。所以把桌面的画布复制到车机不会丢东西，再复制回去，壁纸也会恢复。

### kind

kind 分轻重两档。

**轻 kind** 由各宿主内置实现，props 是 Yolo 自己定义的简单 JSON schema，由服务端用 zod 校验。Hub 直接写入，立即显示，适合车里和电视上需要马上响应的选择。

| kind | 是什么 | 在哪里 |
|---|---|---|
| `note` | 短文本，可带简单强调 | 所有宿主 |
| `image` | 图片，只能用 Yolo 自己的图片链接（`/i/*`） | 所有宿主 |
| `choices` | 供选择的条目：媒体库 id 或 URL，每项附一句说明；标题、封面和时长来自 Yolo 自己的查询，从不来自 agent | 所有宿主 |
| `card` | 一组固定的小部件（标题、文字、图片、最多三个按钮），用来表达便签和选项说不清的内容 | 所有宿主 |
| `cues` | 跟着播放走的文字：歌词、文字稿、书的正文（[随播文字](#timed-text-cues)） | 所有宿主 |
| `answer` | agent 找到的信息，图文并茂（[回答](#answers-answer)） | 所有宿主；车里只显示几行 |
| `media` | 作为环境媒体播放的条目或 URL（见下文） | 有 `<video>` 或 AVPlayer 的宿主 |

`choices` 的条目在服务端解析：agent 给出 `item_id` 或 `url`，每项最多附一行自己的话。agent 编出来的图片或标题永远到不了屏幕上。新增一种轻 kind，就是在 `@useyolo/core` 里加一个 schema，再在每个宿主里加一个渲染器；还没学会它的宿主画 fallback。

**重 kind `module`** 是一个 [Native Shell](https://nsh.dev) 包（`.nshpkg`，Apache-2.0，Longbridge 出品）：agent 写的一个 TSX 文件，用来画轻 kind 画不了的东西。agent 依照 Native Shell 给模型的文档（[`llms.txt`](https://nsh.dev/llms.txt)）编写，用 `canvas_put` 放置；Yolo 先无界面运行它（`nsh test`、`compile_module`），不通过就带着错误拒绝，让 agent 修改；通过后用实例自己的 Ed25519 密钥签名，然后才下发。宿主用配对时得到的公钥验证签名，再用原生视图画出模块（UIKit、Android 的 View、AppKit、Win32 加 Direct2D、GTK 4，或网页里的 HTML）；每个模块一个 QuickJS VM，有内存、调用时长和节点数上限。宿主只授予模块 Yolo 的能力：发送一个事件（和其他事件一样成为画布事件），以及请求一个内置 action（`play`、`queue`、`dismiss`）；不能联网，除了对象自己的 props 之外没有存储。校验和签名放在 Worker 还是 media node 上运行，要等测过 Native Shell 编译器在 Workers 体积和 CPU 限制下的表现再定。`module` 默认关闭，需要主人开启；在车里和 Apple TV 上从不运行，而是显示它的 `degrade` 对象或 fallback。

模块对象只是对包的引用，和所有对象一样带 fallback。它还可以带一个 `degrade`，即在模块无法运行的地方显示的轻对象，这样没有 Native Shell 的屏幕也能交互，而不只是显示一张静态的图：

```json
{
  "kind": "module",
  "props": { "pkg": "<package id>", "sig": "ed25519:<signature>" },
  "degrade": { "kind": "choices", "props": { "title": "Tonight?", "options": [{ "item_id": "<item id>" }, { "label": "Something else", "action": { "do": "ask", "text": "Suggest something else" } }] } },
  "fallback": { "title": "Tonight?", "text": "Keep watching, or something else" }
}
```

### 轻 kind 还是模块

同一张带两个选项的“今晚看什么”便签，两种做法都行：agent 填好一个 `choices` 对象；或者写一个 TSX 模块把它画出来，再通过宿主授予的能力回调。

| | 轻 kind | 模块 |
|---|---|---|
| agent 要写什么 | props，几十个 token | 一段程序，几百个 token |
| 怎么发现错误 | schema 校验立刻就知道 | 要实际运行（`nsh test`）才知道 |
| 多久显示到屏幕上 | Hub 写入：毫秒级 | 编写、校验、签名、下发、验签：秒级 |
| 能画什么 | 只有宿主已实现的 kind | 任意布局，有本地状态、动画和多步交互 |
| 状态 | 没有；每次点击都回 Hub | 模块自己用 signal 管理 |
| Apple TV | SwiftUI 渲染，焦点由 SwiftUI 管 | 不运行：显示 `degrade` 或 fallback |
| Web、Android、桌面 | 每个宿主各写一个渲染器 | 一个包到处运行 |
| 移动或编辑 | 向 Hub 发一个 `patch` | 由模块处理，再回报给 Hub |
| 安全 | 只是数据 | 是代码，靠签名、沙箱和授予的能力约束 |
| 新增界面的成本 | 每个宿主都要实现这个 kind | 不用改任何宿主 |

轻 kind 承载常用、固定的界面：便签、图片、选项、“继续播放”卡片、通知。它们在所有平台上都能显示，包括 Apple TV，而且响应迅速，所以车里和电视上以它们为主。模块承载一次性、定制化的界面：agent 为今晚的比赛做的比分面板、多步表单、小工具。它们不用改任何宿主就能上线，需要主人开启。

轻 kind 从模块中来。agent 反复生成的某类模块，说明它值得做成内置的轻 kind；做成之后它就能在所有平台上显示，包括 Apple TV，运行时也不再需要代码。

### 小组件存在哪里

小组件要么是内置的，要么是 agent 写的：

- **内置的轻 kind** 随各宿主发布，只随版本更新而改变。
- **agent 写的模块**存在 D1（`canvas_modules`，带 `user_id`）：名字、写它的 agent、TSX 源码、编译好的包、签名，以及构建时对应的 Native Shell 版本。画布上的对象按 id 引用它。只放过一次的模块，在最后一次放置 30 天后删除。主人，或者被要求这么做的 agent，可以把它**保存**为有名字的小组件，一直保留到被删除；agent 能列出已保存的小组件，按名字再次放置，不用重写；修改一个小组件会产生新版本，已经放出去的对象仍用原来的版本。
- **插件也可以带小组件**，比如宠物包或社区做的小组件：插件加载时，Yolo 用实例的密钥校验并签名，和 agent 写的一样。

所以一个小组件会从一次性的，到保存下来，再到分享出去；很多主人都保留的小组件，就成为内置 kind。

### 屏幕上下文和绑定

和正在播放的内容相关的小组件，得知道正在播放什么。每块屏幕本来就会把自己的播放状态报告给 Hub（`PlaybackState`：条目、`position` 及读取它的时间 `positionAt`、状态、播放速度、选中的音轨和字幕轨）；画布读的是同一份状态，所以画布和播放器是一个模型，而不是两个。

- **agent 能读到它。** 这一部分已经做好了：从屏幕上发出的每个问题都带着 `playing`，也就是 Hub 所知的正在播放的内容（`{ itemId, title, position, duration, status, device }`）；agent 插件把“这个”“这里”“现在”理解为这一刻，用 `get_transcript` 读说了什么，用 `get_frame` 看画面上是什么（[在屏幕上问 agent](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)）。所以看旅行视频时问“他们现在在哪”，不用多解释。画布只新增一点：`canvas_read` 在每块屏幕的画布旁边返回它的上下文，供从别处被问到的 agent 使用。
- **对象能绑定它。** prop 可以是一个引用而不是值：`{ "bind": "playback.position" }`、`"playback.status"`、`"playback.item"` 或 `"playback.rate"`。宿主每次绘制时自己解析：正在播放的屏幕用自己的时钟，精确到帧；其他屏幕用 Hub 的 `position` 和 `positionAt`，播放中就往前推算。不需要每帧发送任何东西，agent 也从不推送播放位置。
- **对象能操作它。** `do: "seek"` 加一个时间，让正在播放的屏幕跳到那里，走的是 `seek` 工具的同一条路径。

<a id="timed-text-cues"></a>
### 随播文字：`cues`

歌词就是一首歌的文字稿；播客的文字稿、有声书的正文也是一样：带时间的一行行文字，当前行跟着播放时钟走，点一行就跳到那里。一个 kind `cues` 画所有这些，用 `style` 决定样子：

| `style` | 用于 | 画成什么样 | 人看到的名字 |
|---|---|---|---|
| `lyrics` | 音乐 | 几行文字，当前行随演唱逐字填色 | 歌词 |
| `transcript` | 播客、讲座、访谈 | 一页带说话人的文字，可搜索，滚走后有“回到当前” | 文字稿 |
| `readalong` | 有声书 | 按章节排的正文，标出当前句 | 跟读 |
| `subtitle` | 视频 | 画面旁边成页的台词，可以是一种或两种语言 | 字幕 |

人看到的名字跟着条目走，而不是跟着 kind：宿主只显示一个按钮，按钮上的名字取自来源报告的条目类型，或者 agent 选的 style。播放器自己的字幕保持原样，在画面下方和字幕菜单里；`cues` 是成页的文字。

```json
{ "kind": "cues", "surface": "player", "props": { "style": "lyrics", "source": { "from": "track:auto" }, "at": { "bind": "playback.position" } } }
```

`track:auto` 按顺序取第一个存在的：条目自己的文字轨；node 的转写插件生成的 AI 字幕，像 [`growing-subtitles.js`](../../../../clients/player/src/growing-subtitles.js) 那样随着生成按窗口读取（唱歌的识别比说话差）；或者 agent 找到并以 WebVTT 或 LRC 交来的文字，Yolo 把它转成 WebVTT，作为多出来的一条文字轨和条目放在一起，下次播放不用再问就有。每一行的 `press` 是 `do: "seek"` 到它的开头。

<a id="answers-answer"></a>
### 回答：`answer`

agent 针对正在播放的内容找到的信息（这个博主在哪、那里的酒店多少钱，或者一款手机和另一款比起来怎样），是排好版的文字和图片。`answer` 是 Markdown，再加上几种用 JSON 写的围栏块，宿主把它们画成比文字更丰富的样子：

| 块 | 画成什么 |
|---|---|
| `compare` | 几样东西并排，各一张图，一行行参数，较好的一项标出来 |
| `cards` | 地点或商品：图片、标题、一句话、价格、链接 |
| `gallery` | 一排图片 |
| `quote` | 条目里的一个时刻和那时说的话；点一下跳过去 |
| `sources` | 信息来源，显示为链接，在电视和车里显示为二维码 |
| `followups` | 接下来可以问的问题；点一下就问 agent（`do: "ask"`） |

宿主不认识的块按文字显示。agent 边做边流式输出回答：先用 `canvas_put` 放出前几行，再用 `canvas_patch` 往后加，所以屏幕上能看到回答一点点成形，就像这段对话里的回答一样。

**图片由 Yolo 取，从不由屏幕取。** agent 给出图片的 URL；Yolo 去取，确认它是图片，缩小，再用自己的图片链接（`/i/*`）提供。反正页面的 COEP 头也会拦掉别处的图片，而且屏幕从不访问 agent 读过的网站。图片到之前，宿主用占位块留出它的位置；取不到的图片只留下它的文字。

回答在哪里显示、什么样子，由屏幕决定，而不是 agent：视频播放时，它是侧边的一张卡片，视频照常播放，点“展开”视频缩到角落；在首页或手机上，它是一整页；在电视上更大，用遥控器翻页；在车里只有两三行和**到手机上看**。到手机上看会把这个对象复制到主人手机的画布上，id 是新的，和复制布局一样。

对话目前最多保存一个回答的 4,000 个字符的文字；回答对象在 props 的 16 KB 之内整个保存在旁边，所以重新打开对话时还能画出来。

### 宿主怎么呈现对象

agent 说要显示什么；怎么显示由每个宿主根据自己所在的位置和正在做的事决定：

- **首页上的选项**是聚光灯：第一个选项放大，带图片和 agent 的那句话，其余的排成一行，可以切换。
- **播放中的选项**是叠在画面底部的一排，视频在后面继续播放。每个选项可以现在播，也可以**看完接着放**，也就是 `do: "queue"`，于是它进入 Hub 接下来要播的内容：先是队列，再是正在播放内容所在的系列（[接下来播什么](../../implemented/feature/2026-10-23-up-next.zh.md)）。这一排用的卡片和播放器自己的“接下来”卡片、结束屏一样（[`dom.js`](../../../../clients/player/src/dom.js) 里的 `cardElement`），而且画面底部同一时间只有一排：在条目的最后几秒，选项打开时“接下来”卡片先等着；放在结束屏上的选项替换结束屏的那一排，直到被选中或关掉。
- **车里的选项**是几个带编号的大块；手机上是可以滑动的卡片；电视上是一排，用遥控器移动焦点。
- **agent 的状态**（在听、在想、在回答）是 Ask 旁边的一个小状态和它说的一行话。也可以由一只**宠物**来表现：插件提供的一个包，带图片（sprite、Lottie 或 Rive）和一个按信号（`idle`、`agent.thinking`、`agent.speaking`、`playing`、`pressed`）切换的小状态机。宠物是可选的，而且从来不是某样东西唯一的显示位置，所以没有宠物的屏幕什么也不缺。
- **车里没有输入框。** 人用现有的[语音输入](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md#voice-input)提问，或者点宿主根据正在播放的内容给出的几个建议问题（放歌时是“歌词”，看旅行视频时是“这是哪”）。

### 交互和事件

对象的 `actions` 把一个手势（`press`、`submit`、`dismiss`、`move`）映射到要发生的事：

- **`do: "play" | "queue" | "seek" | "dismiss" | "remove"`**，附带要操作的条目或时间：Hub 立刻执行，走的是同名 MCP 工具的同一条路径，所以历史、进度和续播都和平时一样。不用先等 agent 回应，这在车里很重要。
- **`do: "copy"`**，附带一台设备：Hub 把对象复制到那块屏幕的画布上，id 是新的。
- **`do: "notify"`**：事件写入日志，供 agent 读取。
- **`do: "ask"`**：事件通过 [agent 插件](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)在对象所属的对话里开始新的一轮，开头一行说明按了什么。agent 即使已经结束，也能收到。

无论 action 是什么，每个事件都会记入日志：`{ cursor, deviceId, objectId, gesture, payload, at }`，payload 最多 1 KB，日志是一个环形缓冲，保留主人最新的 500 条事件、最长 24 小时；事件格式参考 AG-UI 在 agent 和前端之间的事件流。屏幕用 `POST /v1/canvas/events` 和自己的设备凭证（`control` scope）发送事件，不走 realtime 通道，因为客户端在那条通道上从不回应广播。对 `choices` 来说，第一个选择生效：Hub 在其他所有屏幕上关闭这个对象。

agent 有三种方式得到回应：

- **等待。** `canvas_events({ since, objects?, wait_seconds })` 一有匹配的事件就返回，否则等到时间结束（最多 45 秒，低于常见 MCP 客户端的工具超时）。`offer` 在一次调用里放置一个 `choices` 对象并等待，返回 `{ status: "chosen" | "dismissed" | "waiting" | "expired", option?, played? }`。两个官方 agent 插件在等待时都让它们的 CLI 一直运行（Claude Code 是 `claude -p`，Codex 是 `codex exec`），所以无论屏幕问的是哪个 agent，选择都会在同一轮里作为工具结果回到它手里，它再说一句放了什么。
- **稍后读取。** 用之前回答里的游标调用 `canvas_events({ since })`。Ask 对话的下一个问题开头会有一行，说明上次回答之后用户选了什么，就像续接的请求已经会说明是在哪块屏幕上问的。
- **被通知。** `do: "ask"` 会开始新的一轮。订阅了资源的 MCP 客户端会收到 `yolo://canvas` 的 `notifications/resources/updated`。

### MCP 工具和路由

| 工具 | scope | 作用 |
|---|---|---|
| `canvas_read` | `read` | 一块屏幕的画布，或所有屏幕的画布 |
| `canvas_put` / `canvas_patch` / `canvas_remove` | `control` | 放置、修改或移除对象；移除别人的对象需要 `manage` |
| `canvas_events` | `read` | 某个游标之后的事件，可选择等待 |
| `offer` | `control` | 放置选项并等待用户选择 |
| `canvas_layouts` | `control` | 列出、保存和应用布局；删除布局需要 `manage` |
| `canvas_widgets` | `control` | 列出和保存主人的小组件，放置一个已保存的；删除需要 `manage` |

`/v1` 路由有 `GET /v1/canvas`（本屏幕的画布）、`POST /v1/canvas/events`、`PATCH /v1/canvas/objects/{id}`（人移动或编辑一个对象），以及 `GET`、`POST`、`DELETE /v1/canvas/layouts` 和 `POST /v1/canvas/layouts/{id}/apply`。工具和路由调用同一个服务层，和其他所有工具一样。

现在两个 agent 插件的指令都是：有一个明显匹配就播放；有几个都说得通时什么都不放，说出最多三个，由下一个请求来回答。有了画布之后，它们改为调用 `offer`；只有当屏幕不声明画布、`offer` 返回 `unsupported` 时，才退回用文字问。所以现在的做法就是降级方案，对没有画布的屏幕来说什么都不变。

### 宿主

| 宿主 | surface | 怎么画 |
|---|---|---|
| 播放器，web profile | `panel`、`player`、`overlay` | web 渲染器，[`clients/player/`](../../../../clients/player/) 里的纯 JavaScript 模块；画布存在 [`store.js`](../../../../clients/player/src/store.js) 里，和 Hub 的状态、队列、播放列表放在一起，`canvas_ops` 也像它们的变化一样经由它重绘；`module` 用 Native Shell 的 web player（`createPlayer`） |
| 播放器，car profile | `panel`、`player` | 同一个渲染器，只画 `note`、`image`、`choices`、`card`、`cues` 和 `answer`（几行），最多四个对象 |
| Apple TV | `panel`、`player`、`overlay` | 用 SwiftUI 画轻 kind，用 `.focusSection()` 处理遥控器焦点；`module` 显示它的 `degrade` 对象或 fallback，因为 Native Shell 没有 tvOS 目标，tvOS 也没有 web view |
| iPhone、iPad | `panel`、`player`、`overlay` | 和 Apple TV 同一套 SwiftUI 渲染器，用触摸操作；`module` 用 Native Shell 的 UIKit 视图，因为 iOS 是它支持的平台之一 |
| 桌面（macOS、Windows、Linux） | `overlay`、`wallpaper` | 一个很薄的原生外壳包住系统 web view，运行播放器的 web 渲染器，`module` 用 Native Shell 的桌面视图；原生代码负责放置窗口：放到桌面图标下面（macOS 的桌面窗口层级、Windows 的 WorkerW、Wayland 的 layer-shell 背景层或 X11 的桌面窗口类型），或放到所有窗口之上并让输入穿透，这些 Native Shell 都不负责 |
| Android、Android TV、Fire TV | `overlay`、`wallpaper` | 一个 `WallpaperService` 和一个 app，包住 Android 的 web view，运行同一个渲染器，`module` 用 Native Shell 的 Android 视图 |
| Samsung Tizen、LG webOS | `panel`、`player`、`overlay` | 用它们自带的网页运行时运行同一个渲染器；Samsung 电视应用以电视身份配对，打开实例的播放器，它画出画布，并用遥控器操作（[电视网页客户端](../feature/2026-10-26-tv-web-client.zh.md)） |

所有有网页引擎的平台都用同一个渲染器画轻 kind，Native Shell 在它支持的每个平台上画 `module`。Apple 的 app 只有一个原生渲染器：画布协议在 YoloKit 里只实现一次，轻 kind 的 SwiftUI 视图放在 Apple TV 与 iPhone、iPad app 共用的应用层里，所以每种轻 kind 只写一次，三种设备都能用。Apple TV（以及将来如果要支持的 Roku）显示模块的 `degrade` 对象或 fallback。Native Shell 不负责跨设备同步，这由 Hub 负责。桌面外壳用 Tauri 还是 Electron，等做这个宿主时再定。

### 环境媒体

Hub 为每个主人只保存一个 `PlaybackState`，同一时间最多一台当前设备（[一条队列，一台当前设备](../../implemented/architecture/2026-10-07-hub-and-realtime-channel.zh.md)）。壁纸上的视频不能占这个位置，否则一段背景循环会停掉有人正在看的电影。`media` 对象是**环境媒体**：除非人取消静音，否则静音播放；从不进历史和进度，从不续播，从不成为当前设备的播放；用能铺满它所在区域的最低画质；屏幕播放其他内容时暂停。它的流来自同一条媒体管线，用自己的 media token，遵守同样的直连路径和中继规则。

### 限制和安全

- 一张画布最多 50 个对象；一个对象的 `props` 最多 16 KB；每个主人下，一个 agent 每秒最多 10 次操作。临时对象 10 分钟内过期，任何对象都可以带 `expiresAt`。
- 车机只显示 `panel` 和 `player` 两层、只画车机支持的轻 kind、最多四个对象、不放 `media`，无论 agent 要求什么；这由宿主强制执行，不靠 agent 自觉。
- 图片只能来自 Yolo 的图片链接，回答里提到的图片也一样。`module` 默认关闭，需要主人在设置里开启；只有经过 Yolo 校验和签名才会运行，也只能使用上面列出的能力。
- 一个读过恶意网页的 agent，只能在这些限制内放置和修改对象，没有 `manage` 就不能移除人自己的对象。
- 画布会保存 Yolo 以前不保存的东西：Hub 里的画布和事件日志，D1 里的布局和 `canvas_modules`，和主人条目放在一起的找来的文字，对话旁边的回答，以及 Yolo 为回答抓取的图片。哪一步开始保存或发送其中一样，就在同一个改动里更新隐私政策（`site/public/privacy.html` 和 `site/public/zh/privacy.html`）（[useyolo.app](../../implemented/process/2026-10-23-useyolo-app-website.zh.md)）。

### 协议和版本

`canvas`（在 welcome 里，也可按需请求）和 `canvas_ops` 是新的 realtime 消息，`hello` 里的 canvas capability 也是新的。不声明 canvas 的客户端收不到这些消息，向这种屏幕调用 `offer` 会得到 `unsupported`，agent 就改用文字来问。旧客户端依赖的东西都没有变，所以 `CLIENT_PROTOCOL` 和 `NODE_PROTOCOL` 不变；[客户端协议](../../implemented/architecture/2026-10-19-client-protocol.zh.md)把画布列为客户端可以不实现的部分。conformance kit 增加一个脚本：放置选项、选中一项，检查播放和事件；它对 web 播放器和每个 Apple app 都要跑。

### 计划

每一步一个 PR，合并并部署，同时按这一步开始保存的东西更新隐私政策页面：

1. Hub 里的画布（surface、对象、操作、`rev`、事件日志）、MCP 工具、`/v1/canvas`，以及播放器宿主的 `note`、`image` 和 `choices`。`offer` 和两个 agent 插件使用它的指令在这一步上线。这一步已经做好：[`service/core/src/canvas.js`](../../../../service/core/src/canvas.js) 校验对象，[`service/control/src/hub/canvas.js`](../../../../service/control/src/hub/canvas.js) 保存画布和事件日志，[`clients/player/src/canvas.js`](../../../../clients/player/src/canvas.js) 把它们画出来；选项用 `pick` 手势加 `{ option, after? }` 来选，`submit` 和 `move` 等需要它们的 kind 出现时再加。以电视身份配对的屏幕（包括 Samsung 电视应用）也画出它们，并且只用遥控器就能操作（[`tv-remote.js`](../../../../clients/player/src/tv-remote.js)）：选项出现时焦点落到选项上，方向键能到达每张卡片和它的「看完接着放」，OK 键选中，返回键收起选项，便签的关闭按钮在一行控件的行尾之后。
2. 屏幕上下文和绑定、`do: "seek"`、`cues`，以及由 Yolo 取图的 `answer`，在播放器宿主里。
3. 布局：migration、保存、应用、复制，以及用布局初始化新屏幕。
4. 播放器 web profile 里的 `module`，由主人的设置开启：校验和签名、宿主验签、能力授予，以及 `canvas_modules` 和保存的小组件。先测 Native Shell 编译器能不能在 Worker 里运行。
5. `do: "ask"`、`card`，以及 Apple 宿主：YoloKit 里的协议和共用应用层里的轻 kind，Apple TV、iPhone 和 iPad 一次做完，`module` 在 iPhone 和 iPad 上可用。
6. 桌面宿主，先 macOS，再 Windows 和 Linux。
7. 环境媒体，然后是 Android 宿主。

## 考虑过的替代方案

**由 agent 写 HTML，像 Claude 的 artifacts 那样。** Apple TV 和 Roku 没有网页引擎，所以它不能作为通用格式；在车机页面里，它会和设备凭证、canvas 引擎跑在一起，而写它的 agent 可能读过恶意网页；它的样式和触控尺寸也由 agent 决定，而不是 Yolo。agent 需要写的东西由 `module` 承担，经过校验、签名，在沙箱里运行。

**轻 kind 采用通用的生成式 UI 格式，比如 json-render 或 A2UI。** 它们描述的是由组件表组成的任意组件树，远超一张便签、一组选项或一张小卡片的需要。json-render 的渲染器只有 React、Vue、Svelte、Solid 和 React Native，没有纯 JavaScript 和 Swift 的：播放器得引入一个框架，Apple TV 无论如何都得为一个外部格式自己写渲染器。而且它的 action 在客户端执行，Yolo 的 action 必须在 Hub 里执行，才能影响播放、通知 agent。Yolo 自己的轻 kind 保持足够小，每个宿主都能原生实现；更复杂的交给 `module`。

**所有 kind 都用 Native Shell。** 这样到处都是同一种格式，但它没有 tvOS 目标；每个对象都要先编译、检查、签名才能显示，对车里的一次选择来说太慢；它的运行时还要和 canvas 引擎共用车机页面。它只作为 `module` 的运行时。

**用沙箱 web view 显示 agent 写的网页（`web` kind）。** 它只能在有 web view 的地方显示，而且和 `module` 做的事重复，而 `module` 用的是原生视图和授予的能力。

**所有屏幕共用一张画布。** 屏幕的尺寸、surface 和 kind 差别太大，一种排布适应不了所有屏幕；共享的情况由 `scope: all` 解决，复制的情况由布局解决。

**布局和应用它的屏幕保持关联。** 改一块屏幕会悄悄改到其他屏幕。复制能让每块屏幕保持人上次在那里看到的样子。

**给画布用 CRDT。** 所有修改本来就经过同一个 Durable Object，由它排序；按对象 last-writer-wins 就够了，协议也足够小，Swift 和其他宿主都好实现。

**为画布单独建一条连接。** 每块屏幕的 socket、心跳和重连都会翻倍；realtime 通道已经承载设备的状态和它的规则。

**只用 MCP Apps。** 它们在聊天客户端里显示 UI，而不是在 Yolo 播放的屏幕上；以后可以用它们把画布上的对象镜像到聊天里。

**歌词、文字稿、跟读各一个 kind。** 它们是同一种东西，跟着播放走的文字，只是样子不同；一个 kind 只有一套来源顺序、一种和时钟的绑定，人看到的名字跟着条目走。

**屏幕把播放位置推到画布上。** 跟着播放走的小组件，会让每块在看的屏幕每秒发很多条消息；绑定在绘制的地方解析位置，用的是 Hub 已有的状态。

**agent 直接链接图片。** 页面的 COEP 头会拦掉它们，它们会让别的网站知道主人的屏幕上在放什么，而一个读过恶意网页的 agent 可以挑选它们；所以每张图片都由 Yolo 去取、去检查。

**每次点击都等 agent 回应。** 选中后要播放的内容必须立刻播放；内置 action 由 Hub 自己执行，agent 事后得知。

## 验收标准

- 被问到一个有歧义的标题时，agent 在提问的屏幕上放出选项；点一下就立刻播放，agent 的 `offer` 在同一轮里返回这次选择。
- agent 停止等待之后才做的选择，会出现在 `canvas_events` 里，并出现在下一个 Ask 问题的开头。
- 放在屏幕上的便签在刷新和重连后仍在；`scope: all` 的便签显示在每块有悬浮层的屏幕上。
- 一块屏幕的画布存成布局并应用到一块新屏幕后，新屏幕上有同样的对象，但 id 是新的；之后改其中一块屏幕，另一块保持不变。
- 宿主不认识某个 kind 时画它的 fallback；不声明画布的屏幕会让 `offer` 返回 `unsupported`，agent 就像现在一样用文字说出最多三个。
- 在条目最后几秒放出的选项，从不和“接下来”卡片同时显示；卡片会等到选项关闭。
- 在车里，超出车机 surface、kind 和数量限制的对象都不画，无论放了什么。
- 环境媒体从不改变当前设备、历史或进度。
- 放歌时要歌词，agent 放出跟着歌走的 `cues`；点一行就跳到那里，显示同一个对象的另一块屏幕在一秒内跟上。放播客时，同一个 kind 显示为“文字稿”。
- 看旅行视频时问“他们在哪”，agent 根据正在播放的这一刻回答，不用人说明在看什么，回答里的图片经 `/i/*` 送达；在车里同一个回答只有几行，点“到手机上看”就把完整的放到手机上。
- agent 保存过的小组件，在之后的对话里能按名字再次放置，不用重写。
- 没通过 Yolo 校验的模块到不了任何屏幕，错误会返回给 agent；通过的模块能在 web profile 里显示、发送事件、请求播放，除此之外它尝试的任何事都不生效。签名验证不过的模块不会被画出来。在 Apple TV 和车里，带 `degrade` 对象的模块显示这个对象，点击它的效果和在其他地方一样。

## 风险

- **在 Hub 里等待。** 一个等待中的 `canvas_events` 会让 Durable Object 的调用保持最多 45 秒，按 Workers 的计费会产生时长费用；等待有上限，屏幕的事件也会提前结束等待。
- **平台技巧。** 把窗口放到桌面图标后面，依赖的是各系统并不保证的行为，尤其是 Windows 的 WorkerW 和各个 Wayland 合成器之间的差异；每个桌面宿主上线前都要在真机上试过。
- **电视硬件弱。** Android TV 设备和旧的 web view 可能跟不上复杂的画布或环境视频；宿主限制自己画的内容，并降级显示。
- **Native Shell 还很新。** 它的格式和 API 可能随版本变化；Yolo 固定一个版本，宿主遇到为其他版本构建的模块就报告不支持，并画 fallback。它的文档没有提到电视遥控器的焦点，所以模块在 Android TV 上要先试过才开放。
- **模块的延迟。** 编写、校验、签名一个模块，比放置一个轻对象慢得多；凡是用户在等待的交互，agent 都用轻 kind。
- **找来的文字。** 唱歌的 AI 字幕经常出错，网上找到的歌词属于它的发行方；Yolo 只把找来的文字和主人的条目放在一起，从不放进分享链接。
- **过时的回答。** agent 找到的价格和营业时间会变；回答显示来源和找到的时间。
- **杂乱。** agent 可能把屏幕塞满；每张画布的数量上限、过期时间和人自己的移除操作可以控制住。
- **放弃了什么。** 宿主只画自己认识的 kind，所以新 kind 在旧宿主上显示得很朴素，直到它们学会；Apple TV 的渲染器要把每种通用 kind 再实现一遍。
