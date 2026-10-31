# Agent Note: 让 agent 读到用户本人在其他网站上的关注和观看记录

Status: proposed

[English](2026-10-28-owner-profiles.md) | 中文

## 问题

用户本人按自己理解媒体的方式跟 agent 说话：“给我播一个我关注的 YouTube 频道的歌单”、“我在 B 站追的那部番的下一集”、“我想看列表里的随便一部”、“我昨晚在 B 站看的那个视频”。agent 知道 Yolo 的历史、队列和播放列表，却对用户本人在别处的账号一无所知，于是回答不知道用户关注了什么，或者用网页搜索去猜。用户的口味早已在那些网站上：订阅的频道和 UP 主、收藏夹、追的剧、打过分的电影、想看列表、漫画书架，以及在那里看过的东西。Yolo 需要一种办法，让 agent 能读到这些：读一次、开销小，并且用户用的每个 agent（屏幕上的 Ask、Claude、ChatGPT、Codex）都能读到。

它必须是插件：核心不能出现任何网站的名字（[插件架构](../../implemented/architecture/2026-10-11-plugin-architecture.zh.md)），而 Bilibili 和 YouTube 只是最早的两个网站；豆瓣、IMDb 和漫画网站之后用同样的形状接入。

## 提案

新增一种插件类型 **profile**，读取用户本人在某一个网站上的列表。node 保存每个 profile 插件列表的快照并在后台刷新；两个只读的 MCP 工具让任何 agent 看到概览并搜索条目。profile 本身不播放任何东西：条目带着 URL 或 id，agent 像现在一样通过片源播放。

```
site account ──cookies / export file──▶ profile plugin (node) ──▶ node snapshot (.media-cache/profiles/)
                                                                         │ /internal/v1/profiles
agent ──MCP get_profile / profile_entries──▶ control plane ──nodeFetch──┘
  └──▶ search / browse { url } / play ──▶ source plugins (yt-dlp, Plex, …)
```

### 插件

node 入口调用 `yolo.registerProfile(id, impl)`，`id` 遵循片源 id 的规则：

| 方法 | 用途 | 返回 |
|---|---|---|
| `title` | 给人看的网站名（“Bilibili”） | 字符串 |
| `account({ signal })` | 谁登录了；没人登录时抛出 `unauthorized`，并说明该设置什么 | `{ id, name, url? }` |
| `lists({ signal })` | 这个账号有哪些列表 | `[{ id, title, kind, private?, refreshMinutes?, keep? }]`，`kind` 是其中条目的类别（[变化频繁的列表](#history-and-other-lists-that-change-often)） |
| `entries(listId, { cursor, signal })` | 列表的一页；网站按时间排序时最新的在前 | `{ entries: Entry[], cursor? }`；没有 `cursor` 表示列表结束 |
| `health()` | 可选，`/internal/v1/health` 里显示的状态 | 任意对象 |

**Entry** 是 `{ id, kind, title, url?, about?, by?, thumbnail?, at?, progress?, duration?, status?, rating?, tags?, ids?, links? }`：

- `kind` 是 `channel`（YouTube 频道、B 站 UP 主）、`title`（电影、剧集、番剧、书或漫画）、`playlist`（收藏夹、收藏的播放列表）、`person`（关注的演员或导演）或 `video`（稍后再看、点赞、观看历史）。
- `about` 是网站给出的简短描述（频道简介、作品的一句话），最多 200 个字符；正是它让“我关注的那个音乐频道”能匹配到名字里看不出是音乐的条目。
- `status` 是 `want`、`doing`、`done` 或 `dropped`；`rating` 是网站给出的 `{ value, scale }`；`at` 是用户本人关注、标记或最后一次观看它的时间。
- `ids` 是外部 id，键名和[元数据插件](../../implemented/architecture/2026-10-25-metadata-plugins.zh.md)的一样，用插件自己的名字（IMDb 的 `tt…`、豆瓣的条目 id）；核心原样传递、不读取其键名，因此不会出现服务商的名字。agent 可以把这样的条目的 id 交给元数据插件（通过 `search_metadata` 或条目详情），了解这部作品是什么。
- `links` 是条目的其他页面，用通用的 `rel` 标注：`videos`、`playlists`、`live`、`episodes`。频道条目给出它的播放列表页，agent 就不必知道每个网站的 URL 结构。
- `by` 是 `{ title, url? }`，`video` 条目的频道或 UP 主，这样“我昨天看的那个 UP 主”能找到它。
- `progress` 和 `duration` 以秒为单位：历史条目看到了哪里，以及它的时长；`progress` 等于 `duration` 表示看完了。
- `tags` 承载网站自己的分组，例如 B 站的关注分组。

插件只读：没有任何方法会在网站上关注、取关、打分或标记任何东西。

### node 上的快照

新的 `service/node/src/profiles.js` 保存已注册的 profile，并承担每个插件本来都要重复做的工作：

- **刷新。** `start` 之后，超过自身间隔的列表会重新读取，之后每隔这个间隔再读一次，带十分之一的随机抖动；间隔是列表的 `refreshMinutes`，否则是 `refreshHours`（12）。一次只读一个插件、只发一个请求，页与页之间至少间隔 `paceMs`（1,000），让网站的限流或风控只看到一个慢速读者。`POST /internal/v1/profiles/refresh` 立即读取某一个插件或全部插件。
- **上限。** 每个列表最多 5,000 条，每个插件最多 2 MB，或者按列表自己的 `keep`；更长的列表保留最新的部分，并注明被截断。
- **失败时保留上次快照。** 刷新失败时保留已有内容，附上错误和 `stale: true`；`unauthorized` 说明该设置哪个选项或 cookie，`yolo doctor` 会显示出来。
- **存储。** 快照是 node 已被 Git 忽略的 `.media-cache/profiles/` 下的 JSON，删掉后会从网站重建。它从不进入 D1 或 Worker；agent 通过控制面读取。
- **搜索**在快照旁边运行：对 `title`、`about`、`by.title` 和 `tags` 做不区分大小写、全半角和重音的匹配，完全匹配或前缀匹配优先于子串匹配，然后是所有词都出现在同一条目里的匹配。

`GET /internal/v1/profiles` 返回概览，`GET /internal/v1/profiles/entries` 返回过滤后的一页。两者都是新端点，只有新的控制面会调用；旧的 node 返回 404，工具把它变成 `available: false` 和“Upgrade the media node”，因此 `NODE_PROTOCOL` 不变。

### 观看历史和其他变化频繁的列表

<a id="history-and-other-lists-that-change-often"></a>

网站的观看历史和其他列表一样，是最新在前、带 `at`、`progress` 和 `duration` 的 `video` 条目，但它和关注有四点不同，由 `lists()` 返回的内容说明：

- **它是私密的。** 标记为 `private: true` 的列表只有在用户本人把它写进插件的 `lists` 选项（`"lists": ["following", "history"]`）时才读取；没有这个选项时，读取除私密列表以外的全部列表。历史比关注更能说明一个人，而 agent 读到的东西会发给它的模型服务商，所以默认从不打开。
- **它变化频繁。** 历史声明 `refreshMinutes: 60`；用户本人按列表设置的 `refreshMinutes` 选项（`{ "history": 30 }`）可以覆盖它。
- **它从最上面读。** 带 `keep` 的列表刷新时一页一页往下读，直到某一页出现快照里已有的、`at` 相同的条目（网站不给时间时按位置相同），再把新条目合并到前面；大多数每小时的刷新只要一个请求。
- **它只保留最近的。** 历史声明 `keep: { days: 30, entries: 500 }`；每次刷新时丢掉更早的条目。

网站的历史和 Yolo 自己的历史分开：`history` 回答在 Yolo 里播过什么，`profile_entries { list: "history" }` 回答在网站自己的 App 里看过什么，工具描述会说明哪个是哪个。两者互不合并，因为同一个视频在片源里和在网站上的 id 不同。对于 Yolo 没有历史的条目，从网站历史记录的位置接着播，是之后的改动，它会把 profile 和片源的 id 绑在一起；本提案只让 agent 读到这个位置，并把它作为 `start_at` 传给 `play`。

### MCP 工具

两个只读工具，需要 `read` scope，位于 [`service/control/src/mcp/tools.js`](../../../../service/control/src/mcp/tools.js)，不出现任何网站名：

- **`get_profile`** 返回每个已连接的账号：网站、账号名、每个列表的类别、条目数、读取时间，以及最新 20 个条目的标题。无论条目多少都保持在约 2,000 个 token 以内，agent 可以在请求开始时就读它。`refresh: true` 在后台开始一次刷新，并返回已有的快照，附带 `refreshing: true`。
- **`profile_entries`** `{ account?, list?, kind?, query?, status?, since?, offset?, limit? }` 返回匹配的条目，带 `url`、`links`、`ids`、`about`、`by`、`status`，以及历史条目的 `at` 和 `progress`；`since`（ISO 日期）只保留从那时起的条目；`limit` 默认 50、最多 200，缩略图像其他工具一样变成图片链接。

服务器描述和 [`skills/yolo/SKILL.md`](../../../../skills/yolo/SKILL.md) 写明：当对方说“我关注的”“我的订阅”“我的列表”，或把某个频道、作品说成是自己的，先读 `get_profile`，再考虑网页搜索；agent 插件的指令也加上同一句（[屏幕向用户本人的 agent 提问](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)）。profile 数据不会自己进入提示词：只有请求需要时 agent 才去读。

### 浏览一个 URL

促成这件事的请求还差一步：一个频道的播放列表。`browse` 增加 `url`，返回片源 `expand(url)` 的结果但不导入；展开出来的条目如果本身是一个播放列表，可以标注 `collection: true`，这样 agent 能列出 `links.playlists`、选一个，再 `playlist_import` 或播放。yt-dlp 片源会给指向播放列表的扁平条目加上这个标注。

于是“给我播一个我关注的 YouTube 频道的歌单”依次是 `get_profile` → `profile_entries { kind: "channel", query: "music" }`（没有匹配时读整个列表）→ `browse { url: <links.playlists> }` → `playlist_import` → `playlist_enqueue` 或 `play`；有几个频道都合适时，像现在处理搜索结果一样问是哪个。

### 最早的插件

| 插件 | 列表 | 如何读取 |
|---|---|---|
| `plugins/profile-bilibili` | `following`（UP 主，关注分组作为 `tags`）、`favorites`（收藏夹）、`bangumi`（追的番剧和剧集，带 `status`）、`watch-later`、`history`（私密） | 用账号的 cookie 调 B 站网页版 JSON（`x/web-interface/nav` 取账号，`x/relation/followings`、`x/v3/fav/folder/created/list-all`、`x/space/bangumi/follow/list`、`x/v2/history/toview`，历史用 `x/web-interface/history/cursor`，其条目带观看时间、看到的位置、时长、UP 主，以及番剧这一集的位置），经由 `yolo.fetch`，因此遵循用户本人的出站规则 |
| `plugins/profile-youtube` | `subscriptions`（频道）、`playlists`（自己的和收藏的）、`watch-later`、`liked`、`history`（私密） | 用账号 cookie 调用已固定版本的 yt-dlp：对 `feed/channels`、`feed/playlists`、`:ytwatchlater` 和 `:ytfav` 执行 `--flat-playlist -J`。历史来自 `feed/history` 页面自身的数据，插件用同一份 cookie 读取：yt-dlp 对它的扁平列表只保留顺序和时长，而页面给出每天的标题和每个视频看过的比例（P3）；yt-dlp 的 tab 提取器已经能读出 `feed/channels` 里的频道条目及其订阅数。不需要 cookie 的退路是 Google Takeout 的 `subscriptions.csv`（`subscriptionsFile`） |

两者都接受 `cookiesFile` 或 `cookiesFromBrowser`，都没设置时退回到 `YTDLP_COOKIES_FILE`，也就是 yt-dlp 片源已经在读的 cookie 文件，所以这个文件里已登录的网站不需要再做任何设置。两者都不在 [`plugins/official.json`](../../../../plugins/official.json) 里：它们读取的是个人账号，由用户本人在 `yolo.config.json` 里打开。每个插件都按 [`yolo-add-official-plugin`](../../../skills/yolo-add-official-plugin/SKILL.md) 的流程添加。

这个接口不必改动就能接入后面的网站：豆瓣的收藏（带 `status` 和 `rating` 的 `title` 条目，用 cookie 读页面或读导出文件）、IMDb 的想看列表和评分（读它导出的 CSV 文件）、漫画网站的关注（kind 为漫画的 `title` 条目，有 API 时走 API）。只提供导出的网站就读用户放进来的文件，文件变化时同一个刷新会重新读取。

### 计划

1. 先做下面的用户本人检查 P1、P2 和 P3。
2. 插件 API 的 `registerProfile` 和类型、`service/node/src/profiles.js` 及其端点、按列表的间隔、私密列表、从最上面读的刷新和测试、两个工具，以及带 `collection` 的 `browse { url }`。
3. 先 `profile-bilibili`，再 `profile-youtube`；服务器描述、yolo skill 和 agent 插件里的那一句。
4. 隐私政策 `site/public/privacy.html` 和 `site/public/zh/privacy.html` 写明：node 保存用户本人从所连接网站读到的列表，以及在用户本人打开时那里最近 30 天的观看历史，用户的 agent 会读取它们。

### 用户本人检查

| 检查 | 步骤 | 决定 |
|---|---|---|
| P1，YouTube 的频道列表 | `yt-dlp --cookies <file> --flat-playlist -J https://www.youtube.com/feed/channels`，再对 `feed/playlists` 做同样的事 | `profile-youtube` 是读 cookie，还是先从 Takeout 文件开始 |
| P2，B 站的关注 | 用 cookie 文件把 `x/relation/followings?vmid=<自己的 mid>&ps=50` 翻到底，与个人主页显示的数字对比；记录是否出现 `-352` 或 `-412` | 登录的用户能否读到完整列表，以及需要的节奏 |
| P3，YouTube 的历史 | `yt-dlp --cookies <file> --flat-playlist -J --playlist-end 50 :ythistory`；检查是否最新在前、条目有没有观看时间或位置，看一个视频后再跑一次 | YouTube 历史有 `at` 和 `progress`，还是只有顺序；从最上面读的刷新能否找到新条目 |

2026-10-28 的结果，使用线上 node 的 `YTDLP_COOKIES_FILE` 和它固定版本的 yt-dlp 2026.10.21：

- **yt-dlp 片源的 cookie 文件没有登录 YouTube。** 其中的 YouTube cookie 是匿名的（`VISITOR_INFO1_LIVE`、`YSC`、`PREF`，没有 `SID`、`SAPISID` 或 `LOGIN_INFO`），所以 `feed/channels` 拿不到初始数据，`feed/playlists` 返回 401，`:ythistory` 要求登录。`profile-youtube` 使用 `cookiesFromBrowser`，或从已登录 YouTube 的浏览器导出的 cookie 文件；随后 P1 和 P3 用 `--cookies-from-browser chrome` 运行。
- **P1 通过。** `feed/channels` 在 2.4 秒内列出 370 个频道，每个都带频道 id 和 URL、`@handle` 和订阅数，其中 337 个带可用作 `about` 的简介；没有条目说明何时订阅，所以订阅条目没有 `at`。`feed/playlists` 列出 18 个：点赞（`LL`）、稍后观看（`WL`）、`FL` 和 15 个播放列表，每个都带所有者的名字，可据此区分账号自己的和收藏的，但没有条目数和日期。
- **P3：yt-dlp 的列表不够，页面本身够。** `:ythistory` 按最新在前列出 50 个视频及其时长，但没有观看时间、没有位置，只有一个带频道。yt-dlp 读到的页面（`feed/history` 的 `ytInitialData`）两者都有：各段以日期为标题（`Monday` 往回到 `Thursday`，再往前是 `Oct 21` 这样的日期），每个视频的 `thumbnailOverlayProgressBarViewModel.startPercent` 是看过的比例（10、16、52、100……）。因此 YouTube 历史条目的 `at` 是它所在的那一天，`progress` 是比例乘以时长，最多精确到分钟。P3 的后半部分（再看一个视频后刷新）需要用户本人先去看。
- **P2 通过。** 处于登录状态（`nav` 的 `isLogin`），`x/relation/stat` 统计到 125 个关注，四页、每页 50 个读完了全部 125 个，每页 0.3 到 0.6 秒，页间隔一秒；从家里的地址直接访问，不经出站规则的代理，没有出现 `-352` 或 `-412`。条目带 `uname`、`sign`（简介，用作 `about`）、`official_verify`、`face`、`mtime` 和 `tag`（所属分组的 id，未分组时为 null）；`x/relation/tags` 给出账号的两个分组。
- **B 站的历史具备设计需要的字段。** `x/web-interface/history/cursor?ps=20` 一秒内返回 20 行，并带有翻下一页用的 `cursor`（`max`、`view_at`、`business`）。每行都有以秒为单位的 `view_at`、`progress` 和 `duration`；`history.business` 是 `archive`（视频，带 `bvid`、`page` 和 `author_name`）或 `pgc`（番剧或剧集的一集，带 `epid`、`show_title` 和 `long_title`）；20 行里 18 行是视频。

## 曾考虑的替代方案

**把快照放进 D1。** node 离线时 agent 也能读，而且 [Yolo 1.0](2026-10-11-yolo-1-0.zh.md) 的 1.1 计划把关注放在 D1。但离线的 node 播不了 agent 找到的东西；一次完整刷新几千行，花掉 Workers Free 的 D1 写入却收益很小；个人账号的列表留在用户本人的机器上，和读取它们的 cookie 在一起。等 1.1 的收件箱需要 Worker 按计划读取关注时，再把 profile 里的频道当作它的关注。

**每次调用工具时实时读网站。** 不用维护快照，但 B 站的关注列表要翻十页，YouTube 的要好几次续页：每个问题都要几秒，而且这种请求频率正是触发风控的频率。快照一跳就能回答，每个网站一天只读两次。

**全部放进 agent 的提示词。** 每个请求都带上几百个频道名，每个问题都要付这些 token，而大多数问题跟关注无关；claude.ai 和 ChatGPT 也没有由 Yolo 写的提示词。一个紧凑的概览工具只在需要时调用，平时没有开销。

**用 MCP resource 代替工具。** 大多数客户端只有在用户手动附加时才读 resource；服务器描述里点名的工具会在请求需要时被读取。

**由片源插件注册 profile。** yt-dlp 片源已经持有两个网站的 cookie，可以顺便注册两个 profile。但 profile 不需要片源，用户可能只要其中一个，而像 IMDb 这样的网站根本没有片源；每个网站一个包、各自开关，让账号读取和播放分开。

**网站的官方 API。** YouTube Data API 能读 `subscriptions?mine=true`，但需要 Google Cloud 项目和 OAuth 同意屏幕；同意屏幕停留在测试模式时，refresh token 七天就过期，而发布 `youtube.readonly` 又需要 Google 审核。B 站和豆瓣没有读取用户列表的公开 API。cookie（yt-dlp 片源已在使用）和导出文件对用户本人能登录的每个网站都有效。

**把网站历史合并进 Yolo 的历史。** 一份历史能一次回答“我看过什么”，还能跨 App 接着播；但一个视频在片源里的 id（规范化后的 URL）和在网站上的 id 不同，匹配错了会挪动别人的进度，而 Yolo 的历史决定了接着播和已看状态。分开保存，agent 两边都读，自己判断；之后的改动可以在 id 确定的地方把它们对应起来。

**把 profile 当作一种元数据插件。** 两者都读其他网站，一个豆瓣插件也可能两样都做。但元数据插件为任何人描述任何作品，来源是公开数据库或用户本人的 key，并且在条目播放时按条目调用；profile 读取一个人已登录的账号，按计划读取，回答的是关于这个人的问题。两者分开，一个包仍然可以同时注册两种，就像现在一个包可以同时注册片源和元数据一样。

**只用 Yolo 自己的关注。** 用户得在 Yolo 里把所有东西重新关注一遍；重点是利用用户本人已有的东西，Yolo 自己的关注可以之后叠加在上面。

## 验收标准

- 加载并登录 `profile-bilibili` 和 `profile-youtube` 后，`get_profile` 列出两个账号及其列表和条目数，在约 2,000 个 token 以内；`yolo doctor` 显示两者都是 `started`，并给出各自的读取时间。
- 在屏幕上问“给我播一个我关注的 YouTube 频道的歌单”（以及同样意思的英文），屏幕的 agent 读取 profile、说出或选定一个关注的频道，该频道的一个播放列表开始播放或进入队列，期间不需要为用户的订阅做网页搜索。
- “我在 B 站追的那部番”按 `status` 找到追的番剧，并通过现有的接着播放的序列播放下一集。
- 插件的 `lists` 里有 `history` 时，“我昨晚在 B 站看的那个视频”能在网站历史里找到它，并从用户本人停下的地方播放；没有时不读取任何历史，`get_profile` 里也没有历史列表。
- 历史没有变化时，每小时的刷新每个插件只发一个请求，历史里不保留超过 30 天的条目。
- 没有 cookie 的插件报告 `unauthorized` 和应设置的选项，其他插件的列表照常返回；刷新失败时保留上次快照并标记 `stale`。
- `service/` 下没有文件出现网站名：加上两个新插件目录后 `scripts/provider-names.test.js` 仍通过；新目录会让 `bilibili` 成为服务商名称，所以 `service/` 下目前提到 Bilibili 的每一行（核心、插件 API 和 MCP 工具里的注释，以及元数据测试里的示例上传）都要改写。
- 没有方法写入网站；测试覆盖快照上限、节奏、搜索，以及旧 node 的 404。

## 风险

- **账号和条款。** 用 cookie 读取已登录账号，yt-dlp 本来就在这么做，但读得太快的账号可能被网站标记；节奏控制、一天两次的刷新和只读调用让读取接近一个人的行为。插件由用户本人自己打开。
- **cookie 过期或轮换。** 从一直开着的浏览器标签页导出的 YouTube cookie 会被轮换；在用户本人的 Mac 上用 `cookiesFromBrowser` 可以避免，`yolo doctor` 里的 `unauthorized` 会提示何时需要重新导出。
- **个人数据到达 agent 的服务商。** agent 读到的东西会发给它的模型服务商，Yolo 的历史和字幕现在也是如此；隐私页面写明这一点，而且工具只在 agent 请求时才返回。网站的观看历史是其中最私密的，所以只有用户本人打开时才读取，并且只保留 30 天。
- **历史读得更频繁。** 每小时读一次，每个网站每天 24 个请求，其余列表是两次；每次一页，节奏相同。
- **网站变化。** B 站的接口和 YouTube 的页面会变；yt-dlp 这条路随固定版本的 yt-dlp 一起更新，B 站插件的测试用录制下来的响应固定其解析。
- **按字词匹配，而不是按含义。** “那个音乐频道”只有在标题、简介或分组里写了才能匹配；否则 agent 读整个列表，一次几千个 token。
- **放弃的：** node 离线时的读取，以及比上次刷新更新的列表（除非 agent 要求刷新）。
