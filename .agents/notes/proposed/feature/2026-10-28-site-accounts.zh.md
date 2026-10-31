# Agent Note: 账号插件把用户本人在其他网站上关注和看过的东西带到每个首页和每个 agent

Status: proposed

[English](2026-10-28-site-accounts.md) | 中文

## 问题

用户本人按自己理解媒体的方式跟 agent 说话：“给我播一个我关注的 YouTube 频道的歌单”、“我在 B 站追的那部番的下一集”、“我想看列表里的随便一部”、“我昨晚在 B 站看的那个视频”。agent 知道 Yolo 的历史、队列和播放列表，却对用户本人在别处的账号一无所知，于是回答不知道用户关注了什么，或者用网页搜索去猜。用户的口味早已在那些网站上：订阅的频道和 UP 主、收藏夹、追的剧、打过分的电影、想看列表、漫画书架，以及在那里看过的东西。

屏幕也有同样的缺口。没有 Plex 或一个文件夹时，首页是空的：没有理由打开 Yolo。即使有，它也不显示用户关注的任何东西，所以想找点新的看，用户会去开网站自己的 App，Yolo 只剩下播放用户转给 agent 的链接。Yolo 的主流程是打开就有东西看、看、看完接着看下一个；对大多数用户来说，填满第一步和最后一步的正是他们的关注。即使用户从不登录某个网站，选它也有原因，它的公开列表也能填满一行。

Yolo 需要一种读取这些列表的方式，同时服务两边：用户用的每个 agent（屏幕上的 Ask、Claude、ChatGPT、Codex），以及每块屏幕的首页（网页和车机、Apple TV、iOS）。它必须是插件：核心不能出现任何网站的名字（[插件架构](../../implemented/architecture/2026-10-11-plugin-architecture.zh.md)），而 Bilibili 和 YouTube 只是最早的两个网站；豆瓣、IMDb 和漫画网站之后用同样的形状接入。

## 提案

新增一种插件类型 **account（账号）**，读取某一个网站的列表：通过用户本人在那里的账号读他自己的列表，不登录时读网站的公开列表。node 保存每个账号插件列表的快照并在后台刷新。屏幕在首页得到由它生成的行，以及冷启动填满空首页所需要的东西；agent 得到两个只读的 MCP 工具；一个条目播完之后接着播什么，也可以从它取材。账号插件自己从不播放任何东西：能播放的条目带着一个 URL，由片源插件认领，所以点一下或 agent 播放，都跟现在播放任何网页视频一样。

```
site sign-in (QR, cookies) ──▶ node's sign-ins (.yolo/sign-ins/) ──▶ link playback, signed in
                                       │
                                       ▼
site ──public lists, or the account's──▶ account plugin (node) ──▶ node snapshot (.media-cache/accounts/)
                                                                         │ /internal/v1/accounts/*
screens ──/v1/accounts/rows──▶ control plane ──nodeFetch─────────────────┤
agents ──MCP get_accounts / account_entries──▶ control plane ──nodeFetch─┘
  tap or play { source } ──▶ source plugins (link playback, Plex, …) ──▶ Yolo's history and up next
```

### 账号和档案

<a id="accounts-and-profiles"></a>

两个词把两样东西分开：

- **账号**是在一个网站或媒体库（Bilibili、YouTube、Plex）上的登录，由 node 保存。它不是一个人。一次登录同时服务播放和这份笔记读取的列表，所以用户本人在一个网站上只需登录一次。
- **档案**是一个正在看的人：屏幕的会话用谁的历史、继续观看、已看标记和音轨字幕偏好（用户本人，或者 Family，见[屏幕会话](../architecture/2026-10-31-screen-sessions.zh.md)提案）。

**账号属于用户本人的档案。** 通过登录读到的列表生成的行，只在会话属于用户本人的屏幕上显示，也只有用户本人的 agent 能读到。档案是 Family 的屏幕只得到公开的行（标记为 `account: false` 的列表），上面叠加的是 Family 自己的进度，那里一个条目播完之后也不会接着播用户本人列表里的候选。在屏幕有档案之前，每块屏幕都是用户本人的。以后 Family 档案也可以连接自己的账号：那时一次登录会写明它属于哪个档案，而行本来就按档案选择，不需要别的改动。

### 插件

node 入口调用 `yolo.registerAccount(id, impl)`，`id` 遵循片源 id 的规则，并在 manifest 里声明网站的 `hosts`，和首页冷启动提案下的每个插件一样（[登录](#signing-in)）：

| 方法 | 用途 | 返回 |
|---|---|---|
| `title` | 给人看的网站名（“Bilibili”） | 字符串 |
| `identity({ signal })` | node 为这个网站保存的登录是谁；没有登录时为 null；登录已经失效时抛出 `unauthorized`，并说明该怎么做 | `{ id, name, url? }` 或 null |
| `lists({ signal })` | 插件现在读取的列表：公开列表始终在，登录后加上账号的列表 | `[{ id, title, kind, home?, account?, private?, refreshMinutes?, keep? }]`，`kind` 是其中条目的类别，`home` 是它生成的行（[首页上](#on-the-home-screen)），`account: false` 表示不登录也能读的公开列表，其余说明它怎么读取（[变化频繁的列表](#history-and-other-lists-that-change-often)） |
| `entries(listId, { cursor, signal })` | 列表的一页；网站按时间排序时最新的在前 | `{ entries: Entry[], cursor? }`；没有 `cursor` 表示列表结束 |
| `connect` | 可选：屏幕怎样登录这个网站，即冷启动提案里通用的 `connect`（[登录](#signing-in)） | `{ start(), poll(attempt), forget() }` |
| `health()` | 可选，`/internal/v1/health` 里显示的状态 | 任意对象 |

**Entry** 是 `{ id, kind, title, url?, about?, by?, thumbnail?, at?, progress?, duration?, status?, next?, rating?, tags?, ids?, links? }`：

- `kind` 是 `channel`（YouTube 频道、B 站 UP 主）、`title`（电影、剧集、番剧、书或漫画）、`playlist`（收藏夹、收藏的播放列表）、`person`（关注的演员或导演）或 `video`（新上传、稍后再看、收藏、观看历史、热门视频）。
- `about` 是网站给出的简短描述（频道简介、作品的一句话），最多 200 个字符；正是它让“我关注的那个音乐频道”能匹配到名字里看不出是音乐的条目。
- `by` 是 `{ title, url? }`，`video` 条目的频道或 UP 主，这样“我昨天看的那个 UP 主”能找到它。
- `at` 是用户本人关注、标记或最后一次观看它的时间，或者新上传的发布时间。`progress` 和 `duration` 以秒为单位：历史条目看到了哪里，以及它的时长。
- `status` 是 `want`、`doing`、`done` 或 `dropped`；`rating` 是网站给出的 `{ value, scale }`。`next` 是用户正在看的 `title` 条目上的 `{ title, url, label? }`：网站认为他接下来该看的那一集。
- `ids` 是外部 id，键名和[元数据插件](../../implemented/architecture/2026-10-25-metadata-plugins.zh.md)的一样，用插件自己的名字（IMDb 的 `tt…`、豆瓣的条目 id）；核心原样传递、不读取其键名，因此不会出现服务商的名字。agent 可以把这样的条目的 id 交给元数据插件（通过 `search_metadata` 或条目详情），了解这部作品是什么。
- `links` 是条目的其他页面，用通用的 `rel` 标注：`videos`、`playlists`、`live`、`episodes`。频道条目给出它的播放列表页，agent 就不必知道每个网站的 URL 结构。
- `tags` 承载网站自己的分组，例如 B 站的关注分组。

插件只读：没有任何方法会在网站上关注、取关、打分或标记任何东西。

### 登录

<a id="signing-in"></a>

登录属于 node，而不属于插件：[首页冷启动](2026-10-31-home-cold-start.zh.md)提案给每个插件一个通用的 `connect`，并给 node 一个网站登录的存储（`yolo.signIns`，位于它已被忽略的 `.yolo/sign-ins/`，权限 600），每个登录只限于创建它的插件所声明的 hosts。链接播放读取同一个存储，所以 B 站扫一次码，既填满了这些行，也让 B 站链接以登录状态播放。账号插件有三种方式得到它的账号：

- **在屏幕上**，前提是网站允许。`connect.start()` 返回 `{ attempt, qr, expiresAt }`，一次由用户本人在网站自己的手机 App 里扫码确认的登录；`connect.poll(attempt)` 返回 `waiting`、`scanned`、`done` 或 `expired`，`done` 时插件用 `yolo.signIns.save()` 保存这个会话的 cookie。B 站的网页登录就是这样（P5）。屏幕只在用户本人通过 passkey 之后显示这个二维码，因为它会登录一个账号。
- **用用户本人自己的 cookie：**node 已有的、覆盖该网站 hosts 的 cookie 文件（`YTDLP_COOKIES_FILE`，或插件的 `cookiesFile`），或插件的 `cookiesFromBrowser` 选项。和冷启动提案一样，用户本人自己的 cookie 优先于 node 保存的登录，播放和读列表都是如此。不能在屏幕上登录的插件，在 `connect` 里把这些步骤作为 `instructions` 返回。
- **从导出文件**（`subscriptionsFile`、IMDb 的 CSV），用于只提供导出的网站。它给出的是列表，不是登录。

插件通过登录读取时用 `yolo.fetch(url, { signIn: true })`：当 URL 的 host 在插件的 `hosts` 里时，它带上 node 为这个 host 保存的 cookie；像 yt-dlp 这样的工具则用 `yolo.signIns.cookieFile(url)`。已启用但没有登录的插件只读取它的公开列表；没有公开列表时，它不发任何请求。断开会删除登录，并从快照里删掉账号的列表，保留公开的；它不会在网站上登出这个会话，那要用户本人在网站自己的安全设置里做。插件怎样启用、屏幕在哪里显示它的二维码，由冷启动提案定义；和那里的每个插件一样，账号插件默认不加载。

### node 上的快照

新的 `service/node/src/accounts.js` 保存已注册的账号插件，并承担每个插件本来都要重复做的工作：

- **刷新。** `start` 之后，超过自身间隔的列表会重新读取，之后每隔这个间隔再读一次，带十分之一的随机抖动；间隔是列表的 `refreshMinutes`，否则是 `refreshHours`（12）。一次只读一个插件、只发一个请求，页与页之间至少间隔 `paceMs`（1,000），让网站的限流或风控只看到一个慢速读者。`POST /internal/v1/accounts/refresh` 立即读取某一个插件或全部插件。保存一个登录时，node 立即读取那个插件，先读有 `home` 行的列表。
- **上限。** 每个列表最多 5,000 条，每个插件最多 2 MB，或者按列表自己的 `keep`；更长的列表保留最新的部分，并注明被截断。
- **失败时保留上次快照。** 刷新失败时保留已有内容，附上错误和 `stale: true`；`unauthorized` 说明该怎么做，`yolo doctor` 会显示出来。
- **能播放的条目会被认领。** 保存带 `url` 的条目（或 `title` 条目的 `next.url`）时，node 调用片源注册表的 `claim`（快速且不联网），保存得到的 `source`；条目的 item id 就是这个 source 的 `sourceKey`，和任何网页视频一样。没有片源认领的条目仍然可以被 agent 读到，但永远不会变成卡片。
- **存储。** 快照是 node 已被 Git 忽略的 `.media-cache/accounts/` 下的 JSON，删掉后会从网站重建；登录留在 node 的登录存储里。两者都不进入 D1 或 Worker；屏幕和 agent 通过控制面读取。
- **搜索**在快照旁边运行：对 `title`、`about`、`by.title` 和 `tags` 做不区分大小写、全半角和重音的匹配，完全匹配或前缀匹配优先于子串匹配，然后是所有词都出现在同一条目里的匹配。

`GET /internal/v1/accounts` 返回概览，`GET /internal/v1/accounts/entries` 返回过滤后的一页，`GET /internal/v1/accounts/rows?profile=` 返回某个档案的首页行，`GET /internal/v1/accounts/candidates` 返回接下来可能播放的东西。这些都是新端点，只有新的控制面会调用；旧的 node 返回 404，控制面把它变成没有行、`available: false` 和“Upgrade the media node”，因此 `NODE_PROTOCOL` 不变。

### 首页上

<a id="on-the-home-screen"></a>

每个列表用 `home` 说明它生成哪一行（如果有的话）；`channel`、`person` 和 `playlist` 列表不生成行，因为它们的卡片播不了。node 从快照生成这些行，所以每个客户端（网页播放器、Apple TV、iOS）拿到同样的行，只负责画出来：

| `home` | 行 | 卡片 | 排序和上限 |
|---|---|---|---|
| `continue` | 接着看用户本人在网站上看的东西 | 追的剧集的 `next` 那一集；打开历史时，还有用户在那里没看完的视频 | 最近看过的剧集和视频在前；视频只在 `progress` 小于 `duration` 的 90% 且在 7 天内时出现；最多 20 个 |
| `updates` | 用户关注的频道和 UP 主的新视频 | 网站自己的关注动态 | 最新在前，最近 14 天，最多 40 个 |
| `saved` | 稍后再看 | 网站上的这个列表 | 网站的顺序 |
| `collection` | 一个收藏夹或收藏的播放列表 | 里面的视频 | 网站的顺序（最新加入的在前），最多 40 个；一个插件最多生成 5 个这样的列表，默认收藏夹在前 |
| `popular` | 网站上的热门，一个公开列表 | 网站自己的榜单 | 网站的顺序，最多 20 个 |

- **页面上的顺序。** 这些行排在 Yolo 自己的继续观看之后，按上表的角色排序，同一角色内按插件的加载顺序；公开的 `popular` 行排在最后，在用户本人选的所有东西之后。客户端按角色给行起标题，并在客户端里翻译（“你关注的人的新视频”），用插件的 `title` 作为它的网站，`collection` 则用列表自己的标题；客户端和服务端的代码都不出现网站名。
- **谁的行。** `/v1/accounts/rows` 按发出请求的屏幕的档案回答（[账号和档案](#accounts-and-profiles)）：用户本人的档案得到所有行，Family 的档案得到公开的行。
- **档案已经看过的会离开。** 每张卡片都带着这个档案在 Yolo 里的进度，像库列表那样叠加上去（[`/v1`](../../implemented/architecture/2026-10-07-v1-http-api.zh.md)）。`updates` 和 `popular` 不显示 Yolo 标记为 `watched` 的，打开历史时也不显示网站历史里看过 90% 以上的；`continue` 不显示已经在 Yolo 继续观看里的条目，同一个东西不会出现两次。
- **点一下播放片源。** 卡片是带 `source` 的库条目；点一下就用 `POST /v1/playback/play { source }` 播放，和历史卡片一样，链接播放用同一个登录播放它。从此这次播放进入 Yolo 的历史，片源的序列在它之后接着播（[接着播放](../../implemented/feature/2026-10-23-up-next.zh.md)），剧集的 `next` 会落进它那一季的序列。来自网站历史的卡片，在 Yolo 没有它自己的位置时从它的 `progress` 开始：屏幕把它作为 `startTime` 传入，因此不需要把网站的 id 对应到 Yolo 的 id。
- **封面**是条目自己的图片，像网页视频的缩略图一样发给屏幕，并通过 `/v1/thumbnail` 加载，由 node 带着它的防护去取（[node 内部 API](../../implemented/architecture/2026-10-07-node-internal-api.zh.md)）；MCP 返回的同样图片是图片链接（[封面图](../../implemented/feature/2026-10-07-remote-mcp-server.zh.md#cover-images)）。
- **新鲜度。** 屏幕加载首页时请求这些行，和请求历史一样；刷新不会主动推送。`updates` 列表声明 `refreshMinutes: 30`，所以新上传大约半小时内会出现在首页。
- **node 离线时**，`/v1/accounts/rows` 像库的路由一样返回 `node_offline`。屏幕把上次显示的行保存在它为启动保留的记录里，和其他行一样（[网页客户端](../../implemented/feature/2026-10-11-yolo-web-client.zh.md)），照常显示；点一下会提示家里的媒体 node 离线，和库卡片一样。这些行从不保存到 D1。

以下 `/v1` 路由都转发给 node，需要 `read` scope，因此已配对屏幕自己的凭据就够了：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/v1/accounts` | `{ available, accounts }`：每个账号插件的 `id`、`title`、账号的 `name` 或 null、状态（`signed_out`、`reading`、`connected`、`unauthorized`、`failed`、`stale`）和 `reason`、连接方式（`qr`、`instructions` 或没有），以及它的列表，带 `kind`、`home`、`account`、`private`、是否读取、条目数和读取时间 |
| GET | `/v1/accounts/rows?limit=` | 屏幕所属档案的 `{ rows }`：每行 `{ id, account, list, role, title, total, items }`，`items` 是带这个档案进度的库条目（`id`、`source`、`title`、`by`、`thumbnail`、`duration`、`at`、`label`、`startAt`）；`limit`（默认 20，最多 40）限制每行的数量 |
| GET | `/v1/accounts/rows/:id?offset=&limit=` | 单独一行，分页，供屏幕的“查看全部”使用 |
| GET | `/v1/accounts/entries` | 和 MCP `account_entries` 相同的查询和返回 |

在用户本人的 passkey 会话之后，连接和断开使用冷启动提案在 `/v1/owner/plugins/:name/` 下的路由，插件读取哪些列表是它的 `lists` 选项，用那份提案的 `PATCH /v1/owner/plugins/:name` 修改。这份笔记只新增一个 [owner 路由](../../implemented/architecture/2026-10-07-v1-http-api.zh.md#owner-routes)：`POST /v1/owner/accounts/:id/refresh`。所有路由都是新的，因此 `CLIENT_PROTOCOL` 不变。设置 › 插件显示账号插件的状态、连接或断开、每个列表的开关（私密列表在打开前是关的），以及立即刷新。

### 账号给冷启动提供什么

<a id="what-accounts-give-a-cold-start"></a>

空首页怎样引导用户本人选择他在哪里看，由[首页冷启动](2026-10-31-home-cold-start.zh.md)提案定义，它也让插件能从任何屏幕启用。账号插件给它四样东西：

- **不登录也有一行**，前提是网站有公开列表：选了 B 站、跳过登录，首页仍然有它的热门视频。
- **在屏幕上登录**，前提是网站允许：`connect.start()` 和 `connect.poll()`（[登录](#signing-in)），用户本人用网站的手机 App 扫码就能连接，不需要家里的机器。
- **马上有行。** 保存一个登录时，node 立即读取这个插件，先读有 `home` 行的列表；第一批行读到之前，`GET /v1/accounts` 显示 `reading`。冷启动可以先显示它们的骨架，再显示行，在扫码后几秒内出现，而不必等下一次刷新。
- **这些行本身**，从此以后都在（[首页上](#on-the-home-screen)）。

### 一个条目播完之后

一个条目结束后接着播什么，超出现在[接着播放](../../implemented/feature/2026-10-23-up-next.zh.md)所做的部分，由它自己的笔记设计；这份笔记只说明账号能给它什么。那里的顺序打算是：系列的下一集，然后是队列，然后是同一频道的下一个，然后是关注的新视频，最后是 agent 挑的；账号为中间两步提供候选。`GET /internal/v1/accounts/candidates?after=<sourceKey>&by=<channel url>&profile=&limit=` 返回以下内容，每个都是带 `from: "account"` 和所属列表的库条目：

- **`sameBy`：**所有被读取的列表里，`by.url` 是刚结束条目所属频道、且没看过的条目：在刚结束条目之后发布的在前，按从旧到新，这样该频道的下一个上传紧接着播；然后是其余的，最新在前。这只覆盖用户关注的频道和快照里的上传；一个频道的完整列表由它的片源提供。
- **`updates`：**`updates` 行里有的，最新在前，没看过的。
- **`continuing`：**每部追的剧集的 `next`，最近看过的在前。

“没看过”采用和行相同的规则，针对会话所属的档案。候选遵循和行相同的列表开关和档案：关掉的列表不提供任何候选，Family 的会话不会得到用户本人账号里的任何候选。

### 观看历史和其他变化频繁的列表

<a id="history-and-other-lists-that-change-often"></a>

网站的观看历史和其他列表一样，是最新在前、带 `at`、`progress` 和 `duration` 的 `video` 条目，但它和关注有四点不同，由 `lists()` 返回的内容说明：

- **它是私密的。** 标记为 `private: true` 的列表只有在用户本人打开时才读取：在插件的设置里，或者把它写进插件的 `lists` 选项（`"lists": ["following", "history"]`）；用户没有写到的列表，除非是私密的，都会读取。历史比关注更能说明一个人，而 agent 读到的东西会发给它的模型服务商，所以默认从不打开。
- **它变化频繁。** 历史声明 `refreshMinutes: 60`；用户本人按列表设置的 `refreshMinutes` 选项（`{ "history": 30 }`）可以覆盖它。
- **它从最上面读。** 带 `keep` 的列表刷新时一页一页往下读，直到某一页出现快照里已有的、`at` 相同的条目（网站不给时间时按位置相同），再把新条目合并到前面；大多数每小时的刷新只要一个请求。
- **它只保留最近的。** 历史声明 `keep: { days: 30, entries: 500 }`；每次刷新时丢掉更早的条目。

谁能看到一个列表，只有一条规则：一个列表要么被读取，要么不被读取。被读取的列表，用户本人的 agent 和用户本人档案上的屏幕都能通过 `read` scope 看到，公开列表则每块已配对的屏幕都能看到；不被读取的列表，谁都看不到，也从不向网站请求，不生成任何行和候选。分享链接和未配对的页面永远看不到账号。屏幕会把显示过的行保存在自己的存储里，和保存继续观看一样，所以打开历史后，用户本人档案上的浏览器里会有用户在网站上没看完的视频的标题。

网站的历史和 Yolo 自己的历史分开：`history` 回答在 Yolo 里播过什么，`account_entries { list: "history" }` 回答在网站自己的 App 里看过什么，工具描述会说明哪个是哪个。两者互不合并，因为同一个视频在片源里和在网站上的 id 不同；卡片或 agent 用 `startTime` 或 `start_at` 从网站记录的位置开始播放。

### MCP 工具

两个只读工具，需要 `read` scope，位于 [`service/control/src/mcp/tools.js`](../../../../service/control/src/mcp/tools.js)，不出现任何网站名；agent 代表用户本人，所以读的是用户本人的账号：

- **`get_accounts`** 返回每个已启用的账号插件：网站、账号名或没有登录、每个列表的类别、是否公开、条目数、读取时间，以及最新 20 个条目的标题。无论条目多少都保持在约 2,000 个 token 以内，agent 可以在请求开始时就读它。`refresh: true` 在后台开始一次刷新，并返回已有的快照，附带 `refreshing: true`。
- **`account_entries`** `{ account?, list?, kind?, query?, status?, since?, offset?, limit? }` 返回匹配的条目，带 `url`、`links`、`ids`、`about`、`by`、`status`、`next`、片源认领后的 item id，以及历史条目的 `at` 和 `progress`；`since`（ISO 日期）只保留从那时起的条目；`limit` 默认 50、最多 200，缩略图像其他工具一样变成图片链接。

服务器描述和 [`skills/yolo/SKILL.md`](../../../../skills/yolo/SKILL.md) 写明：当对方说“我关注的”“我的订阅”“我的列表”，或把某个频道、作品说成是自己的，先读 `get_accounts`，再考虑网页搜索；agent 插件的指令也加上同一句（[屏幕向用户本人的 agent 提问](../../implemented/feature/2026-10-18-agent-from-the-screen.zh.md)）。账号数据不会自己进入提示词：只有请求需要时 agent 才去读。

### 浏览一个 URL

促成这件事的请求还差一步：一个频道的播放列表。`browse` 增加 `url`，返回片源 `expand(url)` 的结果但不导入；展开出来的条目如果本身是一个播放列表，可以标注 `collection: true`，这样 agent 能列出 `links.playlists`、选一个，再 `playlist_import` 或播放。yt-dlp 片源会给指向播放列表的扁平条目加上这个标注。

于是“给我播一个我关注的 YouTube 频道的歌单”依次是 `get_accounts` → `account_entries { kind: "channel", query: "music" }`（没有匹配时读整个列表）→ `browse { url: <links.playlists> }` → `playlist_import` → `playlist_enqueue` 或 `play`；有几个频道都合适时，像现在处理搜索结果一样问是哪个。

### 最早的插件

| 插件 | 列表 | 如何读取 |
|---|---|---|
| `plugins/account-bilibili` | 公开的：`popular`（`home: popular`）。账号的：`following`（UP 主，关注分组作为 `tags`）、`updates`（`home: updates`）、`bangumi`（追的番剧和剧集，带 `status` 和 `next`，`home: continue`）、`watch-later`（`home: saved`）、每个收藏夹一个列表（`home: collection`）、`history`（私密，`home: continue`） | B 站网页版 JSON，经由 `yolo.fetch`，因此遵循用户本人的出站规则：不登录时用 `x/web-interface/popular`（P7）；登录后用 `x/web-interface/nav` 取账号，`x/relation/followings`，账号关注的视频动态 `x/polymer/web-dynamic/v1/feed/all?type=video`，`x/space/bangumi/follow/list`，`x/v2/history/toview`，`x/v3/fav/folder/created/list-all` 及每个收藏夹的 `x/v3/fav/resource/list`，历史用 `x/web-interface/history/cursor`，其条目带观看时间、看到的位置、时长、UP 主，以及番剧这一集的位置。用 B 站网页的扫码登录以 `qr` 方式连接，这次登录也让链接播放以登录状态播放 B 站 |
| `plugins/account-youtube` | 账号的：`subscriptions`（频道）、`updates`（`home: updates`）、`playlists`（自己的和收藏的）、`watch-later`（`home: saved`）、`liked`、`history`（私密，`home: continue`）；暂无公开列表 | 用登录的 cookie 文件调用已固定版本的 yt-dlp：对 `feed/channels`、`updates` 用的 `feed/subscriptions`（P4）、`feed/playlists`、`:ytwatchlater` 和 `:ytfav` 执行 `--flat-playlist -J`。历史来自 `feed/history` 页面自身的数据，插件用同一份 cookie 读取：yt-dlp 对它的扁平列表只保留顺序和时长，而页面给出每天的标题和每个视频看过的比例（P3）；yt-dlp 的 tab 提取器已经能读出 `feed/channels` 里的频道条目及其订阅数。以 `instructions` 方式连接，说明在家里的机器上设置 `cookiesFromBrowser`；Google Takeout 的 `subscriptions.csv`（`subscriptionsFile`）不需要 cookie 就能给出 `subscriptions` |

两者都不在 [`plugins/official.json`](../../../../plugins/official.json) 的加载列表里；由用户本人启用想要的（[账号给冷启动提供什么](#what-accounts-give-a-cold-start)）。每个插件都按 [`yolo-add-official-plugin`](../../../skills/yolo-add-official-plugin/SKILL.md) 的流程添加。

这个接口不必改动就能接入后面的网站：豆瓣的收藏（带 `status` 和 `rating` 的 `title` 条目，用 cookie 读页面或读导出文件）、IMDb 的想看列表和评分（读它导出的 CSV 文件）、漫画网站的关注（kind 为漫画的 `title` 条目，有 API 时走 API）。只提供导出的网站就读用户放进来的文件，文件变化时同一个刷新会重新读取。它们的条目很少能播放，所以主要服务 agent；带 `next` 的 `title` 条目在有片源能播放时会生成一张 `continue` 卡片。

### 计划

1. 先做下面的用户本人检查 P4 到 P7；P1 到 P3 已经运行。
2. 基于冷启动提案的 `yolo.signIns`、`yolo.fetch` 的 `signIn` 和通用 `connect`：插件 API 的 `registerAccount` 和类型；`service/node/src/accounts.js`，包括公开和私密列表、按列表的间隔、从最上面读的刷新、登录后的立即读取、认领、按档案的行、候选，以及它的端点和测试；两个 MCP 工具和带 `collection` 的 `browse { url }`。
3. `/v1/accounts` 路由和刷新路由；在网页播放器里加入账号的行，并像其他行一样保存在启动记录里。启用插件、冷启动的引导，以及二维码显示在哪里，随冷启动提案一起做；按档案的行随屏幕会话提案一起做。Apple TV 和 iOS 在各自的改动里用同样的路由画同样的行。
4. 先 `account-bilibili`，再 `account-youtube`，都不加入 `plugins/official.json` 的加载列表；服务器描述、yolo skill 和 agent 插件里的那一句。
5. 隐私政策 `site/public/privacy.html` 和 `site/public/zh/privacy.html` 写明：node 保存用户本人从所连接网站读到的列表，以及在用户本人打开时那里最近 30 天的观看历史；用户的屏幕会显示并保存这些行；用户的 agent 会读取它们。登录本身由冷启动提案加入。

### 用户本人检查

| 检查 | 步骤 | 决定 |
|---|---|---|
| P1，YouTube 的频道列表 | `yt-dlp --cookies <file> --flat-playlist -J https://www.youtube.com/feed/channels`，再对 `feed/playlists` 做同样的事 | `account-youtube` 是读 cookie，还是先从 Takeout 文件开始 |
| P2，B 站的关注 | 用 cookie 文件把 `x/relation/followings?vmid=<自己的 mid>&ps=50` 翻到底，与这个账号在网站上的主页显示的数字对比；记录是否出现 `-352` 或 `-412` | 登录的用户能否读到完整列表，以及需要的节奏 |
| P3，YouTube 的历史 | `yt-dlp --cookies <file> --flat-playlist -J --playlist-end 50 :ythistory`；检查是否最新在前、条目有没有观看时间或位置，看一个视频后再跑一次 | YouTube 历史有 `at` 和 `progress`，还是只有顺序；从最上面读的刷新能否找到新条目 |
| P4，关注的动态 | 用 cookie 读 B 站的 `x/polymer/web-dynamic/v1/feed/all?type=video` 两页；`yt-dlp --cookies-from-browser chrome --flat-playlist -J --playlist-end 60 :ytsubs`，并像 P3 那样看它页面自身的数据 | 两边的动态能否在一两个请求里给出每个上传的频道、发布时间、时长和封面，以及 `updates` 哪些必须改从页面读取 |
| P5，在屏幕上登录 | B 站网页的扫码登录（`passport.bilibili.com/x/passport-login/web/qrcode/generate`，然后 `…/poll`），用 B 站 App 扫码；然后用它给出的会话做 P2，并用它播放一个 B 站链接 | `account-bilibili` 能否以 `qr` 方式连接，会话能保持多久，以及链接播放能否用它以登录状态播放 |
| P6，追的剧集的下一集 | 对 B 站上追的两部剧，比较 `x/space/bangumi/follow/list` 里的进度字段、这一季的剧集列表和用户本人的历史 | `next` 只靠追剧列表就能得出，还是需要这一季和历史 |
| P7，公开列表 | 在没有 B 站 cookie 的 node 上读 `x/web-interface/popular?ps=20&pn=1`，间隔一小时读两次；记录是否出现 `-352` 或 `-412` | `popular` 行是否不需要登录，以及它的节奏 |

2026-10-28 的结果，使用线上 node 的 `YTDLP_COOKIES_FILE` 和它固定版本的 yt-dlp 2026.10.21：

- **yt-dlp 片源的 cookie 文件没有登录 YouTube。** 其中的 YouTube cookie 是匿名的（`VISITOR_INFO1_LIVE`、`YSC`、`PREF`，没有 `SID`、`SAPISID` 或 `LOGIN_INFO`），所以 `feed/channels` 拿不到初始数据，`feed/playlists` 返回 401，`:ythistory` 要求登录。`account-youtube` 使用 `cookiesFromBrowser`，或从已登录 YouTube 的浏览器导出的 cookie 文件；随后 P1 和 P3 用 `--cookies-from-browser chrome` 运行。
- **P1 通过。** `feed/channels` 在 2.4 秒内列出 370 个频道，每个都带频道 id 和 URL、`@handle` 和订阅数，其中 337 个带可用作 `about` 的简介；没有条目说明何时订阅，所以订阅条目没有 `at`。`feed/playlists` 列出 18 个：点赞（`LL`）、稍后观看（`WL`）、`FL` 和 15 个播放列表，每个都带所有者的名字，可据此区分账号自己的和收藏的，但没有条目数和日期。
- **P3：yt-dlp 的列表不够，页面本身够。** `:ythistory` 按最新在前列出 50 个视频及其时长，但没有观看时间、没有位置，只有一个带频道。yt-dlp 读到的页面（`feed/history` 的 `ytInitialData`）两者都有：各段以日期为标题（`Monday` 往回到 `Thursday`，再往前是 `Oct 21` 这样的日期），每个视频的 `thumbnailOverlayProgressBarViewModel.startPercent` 是看过的比例（10、16、52、100……）。因此 YouTube 历史条目的 `at` 是它所在的那一天，`progress` 是比例乘以时长，最多精确到分钟。P3 的后半部分（再看一个视频后刷新）需要用户本人先去看。
- **P2 通过。** 处于登录状态（`nav` 的 `isLogin`），`x/relation/stat` 统计到 125 个关注，四页、每页 50 个读完了全部 125 个，每页 0.3 到 0.6 秒，页间隔一秒；从家里的地址直接访问，不经出站规则的代理，没有出现 `-352` 或 `-412`。条目带 `uname`、`sign`（简介，用作 `about`）、`official_verify`、`face`、`mtime` 和 `tag`（所属分组的 id，未分组时为 null）；`x/relation/tags` 给出账号的两个分组。
- **B 站的历史具备设计需要的字段。** `x/web-interface/history/cursor?ps=20` 一秒内返回 20 行，并带有翻下一页用的 `cursor`（`max`、`view_at`、`business`）。每行都有以秒为单位的 `view_at`、`progress` 和 `duration`；`history.business` 是 `archive`（视频，带 `bvid`、`page` 和 `author_name`）或 `pgc`（番剧或剧集的一集，带 `epid`、`show_title` 和 `long_title`）；20 行里 18 行是视频。

## 曾考虑的替代方案

**只让 agent 读账号。** 这份提案最初的形式：两个 MCP 工具，屏幕上什么都没有。没有本地媒体时首页仍然是空的，有本地媒体时也显示不出新东西，于是用户还是会去开网站的 App 找东西看，只把 Yolo 用来播放转给 agent 的链接。是这些行让 Yolo 成为开始的地方。

**把这种插件类型叫作 profile。** 这是它最初的名字，指用户本人在每个网站上的个人资料。但档案（profile）是一个正在看的人，屏幕为它写历史；账号是一次登录，几个人的屏幕都可能用到它。一个词同时指两样东西，“谁的档案”就回答不了。

**把列表并进片源插件。** 链接播放本来就读网站，每个网站一个插件也可以既播放又列出列表。但链接播放是一个内置插件，覆盖所有网站，而列表要按网站选择；像 IMDb 这样的网站根本没有片源；node 的登录存储已经让链接播放和账号插件共用一次登录，而不必共用代码。一个包仍然可以同时注册两种，就像现在一个包可以同时注册片源和元数据一样。

**把每个账号插件的登录放在它自己的状态目录里。** 插件不需要 node 提供任何东西，但这样 B 站扫码后只读到了关注，播放仍然是匿名的，否则用户就得登录两次。node 的存储限于声明的 hosts，两边都能用。

**每个客户端用 `/v1/accounts/entries` 自己生成行。** 网页播放器、Apple TV 和 iOS 会各自用自己的代码过滤、排序、去掉看过的，然后越来越不一致。node 在快照旁边一次生成，那里有已看状态和认领结果，客户端只负责画。

**轮询每个关注的频道看有没有新上传。** 370 个 YouTube 频道或 125 个 B 站 UP 主，每次刷新就是几百个请求。两个网站都有账号关注的动态，一两个请求就能读到，也正是网站自己 App 显示的东西。

**把快照或行放进 D1。** node 离线时 agent 和屏幕也能读到，而且 [Yolo 1.0](2026-10-11-yolo-1-0.zh.md) 的 1.1 计划把关注放在 D1。但离线的 node 播不了它们显示的东西；一次刷新几千行，花掉 Workers Free 的 D1 写入却收益很小；屏幕本来就为启动保存了显示过的行；个人账号的列表留在用户本人的机器上，和读取它们的登录在一起。等 1.1 的收件箱需要 Worker 按计划读取关注时，再把账号里的频道当作它的关注。

**每次请求都实时读网站。** 不用维护快照，但 B 站的关注列表要翻十页，YouTube 的要好几次续页：每个问题或每次加载首页都要几秒，而且这种请求频率正是触发风控的频率。快照一跳就能回答，每个列表按自己的间隔读取。

**在每个档案上都显示用户本人账号的行。** 只有一套行更简单，但用户本人的关注（以及打开时的历史）会显示在家里的电视上给坐在前面的任何人看，Family 看过的也会把它们标记为已看。公开列表不带任何个人信息，所以在每个档案上都显示。

**默认加载两个插件。** 这样冷启动不需要启用这一步就能提供这些网站。但运行哪些插件，对每个插件来说都是用户本人的选择，而一个在每个 node 上都加载的插件，对从不使用它的用户来说也是在那里运行的代码。

**全部放进 agent 的提示词。** 每个请求都带上几百个频道名，每个问题都要付这些 token，而大多数问题跟关注无关；claude.ai 和 ChatGPT 也没有由 Yolo 写的提示词。一个紧凑的概览工具只在需要时调用，平时没有开销。

**用 MCP resource 代替工具。** 大多数客户端只有在用户手动附加时才读 resource；服务器描述里点名的工具会在请求需要时被读取。

**网站的官方 API。** YouTube Data API 能读 `subscriptions?mine=true`，但需要 Google Cloud 项目和 OAuth 同意屏幕；同意屏幕停留在测试模式时，refresh token 七天就过期，而发布 `youtube.readonly` 又需要 Google 审核。B 站和豆瓣没有读取用户列表的公开 API。网站自己的登录、cookie 和导出文件，对用户本人能登录的每个网站都有效。

**把网站历史合并进 Yolo 的历史。** 一份历史能一次回答“我看过什么”，还能跨 App 接着播；但一个视频在片源里的 id（规范化后的 URL）和在网站上的 id 不同，匹配错了会挪动别人的进度，而 Yolo 的历史决定了接着播和已看状态。分开保存，卡片或 agent 从网站记录的位置开始，之后由 Yolo 的历史接手。

**把账号当作一种元数据插件。** 两者都读其他网站，一个豆瓣插件也可能两样都做。但元数据插件为任何人描述任何作品，来源是公开数据库或用户本人的 key，并且在条目播放时按条目调用；账号插件读取一个人的列表，按计划读取，回答的是关于这个人的问题。两者分开，一个包仍然可以同时注册两种。

**只用 Yolo 自己的关注。** 用户得在 Yolo 里把所有东西重新关注一遍；重点是利用用户本人已有的东西，Yolo 自己的关注可以之后叠加在上面。

## 验收标准

- `account-bilibili` 已启用但未登录时，首页出现一行 B 站热门视频，没有任何请求读取账号的东西。扫码登录后立即读取账号的首页列表：`GET /v1/accounts` 显示 `reading`，然后首页出现关注的新视频、追的剧集的下一集、稍后再看和收藏夹这些行，不必等刷新；之后 B 站链接以登录状态播放，node 上不需要任何 cookie 文件。
- 点任何一张卡片都通过它的片源在那块屏幕上播放；之后它出现在 Yolo 的继续观看里，看完后离开 `updates` 行，片源的序列在它之后接着播。追的剧集的卡片播放它的下一集，并在这一季里接着播。
- 网页播放器和车机上的行相同，带这个档案在 Yolo 里的进度，同一个东西不出现两次，封面通过 `/v1/thumbnail` 加载。node 离线时，重新加载显示上次的行，点一下提示 node 离线；没有行写入 D1。
- 档案是 Family 的屏幕只显示公开的行，带 Family 的进度，也不会得到用户本人账号里的任何候选。
- `account-bilibili` 和 `account-youtube` 都登录后，`get_accounts` 列出两个账号及其列表和条目数，在约 2,000 个 token 以内；`yolo doctor` 显示两者及各自的读取时间。在屏幕上问“给我播一个我关注的 YouTube 频道的歌单”（以及同样意思的英文），屏幕的 agent 读取账号、说出或选定一个关注的频道，该频道的一个播放列表开始播放或进入队列，期间不需要为用户的订阅做网页搜索。
- 历史只在打开后才读取；打开后，没看完的视频生成一行 `continue`，每个都从网站记录的位置开始，agent 也能读到；关掉后屏幕和 agent 都看不到，也不向网站发任何历史请求。历史没有变化时，每小时的刷新每个插件只发一个请求，历史里不保留超过 30 天的条目。
- 对一个频道被用户关注的、刚结束的视频，`/internal/v1/accounts/candidates` 在 `sameBy` 里先给出快照中该频道的下一个上传，关掉的列表不提供任何东西。
- 两个插件都不在 `plugins/official.json` 的加载列表里。登录过期的插件报告 `unauthorized` 和该怎么做，并保留它的公开行，其他插件的行和列表照常返回；刷新失败时保留上次快照并标记 `stale`。断开会删掉账号的列表，保留公开的。
- `service/` 和 `clients/` 下没有文件出现网站名：行的标题来自角色和插件的标题。加上两个新插件目录后 `scripts/provider-names.test.js` 仍通过；新目录会让 `bilibili` 成为服务商名称，所以 `service/` 下目前提到 Bilibili 的每一行（核心、插件 API 和 MCP 工具里的注释，以及元数据测试里的示例上传）都要改写。
- 没有方法写入网站上的列表；测试覆盖快照上限、节奏、认领、公开和私密列表、按档案的行的排序和过滤、候选、对行和工具同样生效的私密列表规则，以及旧 node 的 404。

## 风险

- **账号和条款。** 读取已登录的账号是网站自己的 App 也在做的事，但读得太快的账号可能被网站标记；节奏控制、按列表的间隔和只读调用让读取接近一个人的行为。每个账号都由用户本人自己连接。
- **保存在 node 上的登录。** 在屏幕上扫码登录得到的是用户账号的完整会话，保存在家里机器上 node 的登录存储里，链接播放也会用它；能读取那台机器的人就能使用它。断开会删除它，用户本人可以在网站上结束它。
- **会话过期或轮换。** 从一直开着的浏览器标签页导出的 YouTube cookie 会被轮换；在用户本人的 Mac 上用 `cookiesFromBrowser` 可以避免，设置和 `yolo doctor` 会提示何时需要重新连接。从 node 的服务读取 Chrome 的 cookie，可能需要在 macOS 钥匙串里批准一次。
- **个人数据到达 agent 的服务商，也出现在屏幕上。** agent 读到的东西会发给它的模型服务商，Yolo 的历史和字幕现在也是如此。用户本人档案上的屏幕把它的行显示给坐在前面的任何人，在车里也包括乘客，并保存在它的存储里。历史是其中最私密的列表，打开前是关的，并且只保留 30 天；隐私页面写明这一切。
- **更多请求。** `updates` 列表每 30 分钟读一次、历史每小时读一次，每个网站每天大约 70 个请求，每次一页，节奏相同；公开列表每 12 小时读一次，再加两个。每张卡片的封面都是一个经过 Worker 的 `/v1/thumbnail` 请求，计入 Workers Free 的每日请求数，不过屏幕会缓存它们。
- **网站变化。** B 站的接口和 YouTube 的页面会变；yt-dlp 这条路随固定版本的 yt-dlp 一起更新，插件的测试用录制下来的响应固定其解析。
- **按字词匹配，而不是按含义。** “那个音乐频道”只有在标题、简介或分组里写了才能匹配；否则 agent 读整个列表，一次几千个 token。
- **放弃的：** node 离线时，屏幕保存的之外的行和列表；比列表间隔更新的行；关注动态之外的频道上传；以及用户本人以外的档案的账号。
