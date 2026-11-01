# Agent Note: 元数据插件说明一个条目是什么

Status: implemented

[English](2026-10-25-metadata-plugins.md) | 中文

## 问题

一个条目的海报、简介和演职员过去只来自它的片源。Plex 插件为自己的片库提供这些；其他条目只有片源碰巧知道的那些。没有 Plex 的用户完全没有元数据，即使文件本身带着信息（文件名、内嵌标签、Kodi 风格的 NFO 文件）；[插件架构](2026-10-11-plugin-architecture.zh.md)也把元数据列为一种还没有接口的插件类型。

网络视频更差。一个标题为 `救援高手/Nathan For You-第一季 [译制 by 电波字幕组][美剧] p08 救援高手.Nathan.For.You.S01E08.WEB-720p…` 的 B 站投稿是《Nathan For You》第 1 季第 8 集：标题用三种写法说了这件事（`第一季`、`p08`、`S01E08`），这部剧的详情也是公开的。`source-ytdlp` 只给它这个标题、一个时长和上传者的简介，所以 Yolo 把它显示成一个以发布名为标题的普通视频。

同一条路径上还有两个小缺口。[`service/core/src/insight.js`](../../../../service/core/src/insight.js) 里的 `normalizeDetails()` 只保留人物的名字、角色和饰演的角色，所以 Plex 提供的演员照片（`Role.thumb`）谁也拿不到。`/v1` 也没有条目详情的路由：屏幕能显示标题和封面，却显示不了简介和演员表，这些只有 MCP 的 `get_item` 返回。

## 决策

媒体节点上有一种**元数据**插件类型（[`service/node/src/metadata.js`](../../../../service/node/src/metadata.js)）。元数据插件不引入内容，也不播放；它说明一个条目是什么（一部电影、一部剧、某部剧的一集），并描述这部作品：标题、简介、带照片的人物、图片、日期、类型、评分和外部 id。节点识别它描述的每个条目，模型优先：节点有模型时（默认借用用户为 Ask 登录的 Codex 或 Claude Code，见[插件用用户自己的订阅调用模型](2026-10-25-models-for-plugins.zh.md)），模型像人一样读这个条目，说出它是哪部作品，元数据插件再用自己的记录确认并描述这部作品。没有模型时，核心里的标题解析器代替它。节点按一条规则把各插件的回答和片源的详情合并，并缓存结果；控制面只保存用户自己做的更正。接口随五个官方插件一起发布，默认都会加载：`metadata-local` 读文件本身；`metadata-wikimedia`、`metadata-tvmaze` 和 `metadata-bangumi` 读不需要 key 的公开数据库；`metadata-tmdb` 用用户自己的 key 读 The Movie Database，是可选的补充（[官方插件](#the-official-plugins)）。

[自己的片库和 NAS 片源](../../proposed/feature/2026-10-11-own-library-and-nas.zh.md)提案保留文件夹和 WebDAV 片源、重新封装、D1 里的片库目录和 Docker 镜像，元数据部分链接到这里。

<a id="the-metadata-entry"></a>

### 元数据入口

元数据插件是普通的插件包，它的 `node` 入口调用 `yolo.registerMetadata(id, impl)`，与 `registerSource` 并存或代替它。它只在节点上运行：它需要文件、家里的网络和插件的 `cacheDir`，它的 key 也留在节点的 `.env` 里，而不是打包进 Worker。和片源一样，每个方法都是可选的（[`service/plugin-api/src/index.js`](../../../../service/plugin-api/src/index.js) 的 `MetadataImpl`）。

| 方法 | 用途 | 返回 |
|---|---|---|
| `identify(subject, { language })` | 说出一个条目可能是哪些作品 | `Candidate[]`，最好的在前；都不符合时为 `[]` |
| `lookup(candidate, { language })` | 描述一部作品 | `WorkMetadata` |
| `search(query, { kind, year, language, limit })` | 按名字找作品，供智能体更正匹配 | `Candidate[]` |
| `image(ref, { file })` | 插件只在本地有的图片，比如视频旁边的海报文件；`file` 是条目的文件 | 一个图片 `Response` |
| `health()` | 给 `/internal/v1/health` 和 `yolo doctor` 的状态；`{ configured: false, reason }` 让 `doctor` 显示这个原因 | 任意对象 |

**Subject** 是任何元数据插件开口之前节点对一个条目的了解：`{ sourceKey, kind, title, duration, date, year, description, channel, series, url, ids, file, hints, identity }`。`kind`、`title`、`duration`、`date`、`year`、`description`、`channel`（上传者）、`series` 和 `url` 来自片源的 `details()`（或 `describe()`）；`ids` 是片源或排在前面的元数据插件已经知道的外部 id，比如 Plex 的 `tmdb://` 和 `imdb://` guid，或 NFO 的 `<uniqueid>`；`file` 是 `{ path, size }`，在片源通过可选的片源方法 `file(source)` 指明一个节点能读的文件时才有（[片源插件 API](2026-10-11-source-plugin-api.zh.md#methods)）；`hints` 是标题解析器的解读（[标题线索](#title-hints)）；`identity` 是模型的回答（[匹配一个条目](#matching-an-item)），没有时为 `null`。`file` 从不离开节点。

**Candidate** 是 `{ id, kind, title, year?, season?, episode?, episodeTitle?, confidence, ids? }`：`id` 是插件自己对这部作品的 id，比如 `tv/1234` 或 `movie/5678`；对一集来说，`id` 指这部剧，`season` 和 `episode` 指剧里的这一集；`confidence` 在 0 到 1 之间，1 表示通过外部 id 找到。**WorkMetadata** 是插件 API 的 `Details`，加上图片、一集所属的剧，以及它的数据要求附带的声明：

```js
{
  kind: "episode", title: "…", description: "…", date: "2013-…", year: 2013,
  series: { title: "Nathan For You", season: 1, episode: 8, episodeTitle: "…" },
  show: { title: "Nathan For You", description: "…", year: 2013, poster: "https://…/w342/….jpg" },
  people: [{ name: "Nathan Fielder", role: "cast", character: "Himself", photo: "https://…/w185/….jpg" }],
  genres: ["Comedy", "Reality"], ratings: [{ value: 8.3, max: 10, source: "audience" }],
  poster: "https://…/w342/….jpg", backdrop: "https://…/w780/….jpg", still: "https://…/w300/….jpg",
  ids: { tmdb: "tv/…", imdb: "tt…" },
  attribution: { text: "This product uses the TMDB API but is not endorsed or certified by TMDB.", url: "https://www.themoviedb.org/" },
}
```

`attribution` 是插件的数据要求附带的那一条声明，形如 `{ text, url? }`；节点把每个记录被采用的插件的声明收进匹配的 `attributions`（[到达 /v1 和 get_item](#reaching-v1-and-get_item)）。`ids` 的键是插件自己起的名字；核心只把它们当作不透明的字符串读。`language` 是节点的 `YOLO_METADATA_LANGUAGE`，没有时为 `en`；插件自己的 `language` 选项优先，某个字段没有译文时，插件退回到作品原语言的版本。

<a id="matching-an-item"></a>

### 匹配一个条目

识别一个条目是两个问题：它是哪部作品，以及插件持有这部作品的哪条记录。第一个由模型回答，因为它能像人一样读杂乱的标题、简介和上传者；第二个由插件回答，因为它们的记录是事实，而模型只能凭记忆。

节点在第一次有人请求一个条目的详情时识别它，`/internal/v1/metadata` 描述它或 `/internal/v1/prepare` 播放它时也在后台识别，但从不挡在一次播放的第一帧之前：两者都只合并缓存里已有的东西，否则把识别放进队列，一次一个，最多 200 个排队。`/internal/v1/details` 最多等它 17 秒，在控制面 20 秒的超时之内，然后先用片源的详情回答，识别继续进行（[节点内部 API](2026-10-07-node-internal-api.zh.md)）。同一个条目同一时间只识别一次，不管有多少请求在问。

1. **用户的匹配优先。** 用户为条目固定了匹配、或拒绝了所有匹配时，控制面随请求把它传给节点，节点直接查记录，不再识别。
2. **有外部 id 就不用猜。** Subject 已经带着 id 时，比如 Plex 的 guid 或 NFO 的 `<uniqueid type="tmdb">12345</uniqueid>`，不问模型，插件按 id 查询作品。
3. **模型说出它是哪部作品。** `yolo.models` 可用时，节点问它（`purpose: "identify"`），发送条目的标题、简介的前 500 个字符、上传者、网站、时长、日期、文件名、解析器的解读作为提示，片源的 `sequence()` 列出分 P 时还有它们的标题。回答符合一个扁平的严格 schema（`kind`、`showTitle`、`originalTitle`、`year`、`title`、`season`、`episode`、`episodeTitle`、`confidence`、`reason` 和 `parts`，每个属性都必填），节点把它转成 Subject 的 `identity`：`{ kind: "episode" | "movie" | "show" | "other", show: { title, originalTitle, year }, title, season, episode, episodeTitle, confidence, reason }`。`other` 表示它不是某部作品的拷贝：片段、预告、合集、反应视频、vlog。
4. **插件确认它。** 节点按加载顺序对每个元数据插件调用 `identify(subject)`。有记录的插件先按 identity 的原名搜索，再按它的其他名字和年份，并核对模型可能记错的细节：这一季有没有这一集，条目的时长和片长是否相符。一个插件被采用的匹配会把它的 `ids` 加进下一个插件看到的 Subject，所以 Wikidata 里记着的 TVmaze、Bangumi 和 TMDB 的 id，能让排在 Wikimedia 后面的插件按 id 找到作品。
5. **两边一致时匹配才生效。** 模型的置信度至少 0.8、插件最好的候选至少 0.85、且比这个插件的下一个候选至少高 0.15 时，节点采用这个候选；通过外部 id 找到的候选（置信度 1）单独就能生效。不需要 key 的插件按名字找到记录时用同一种打分：名字相同，得 0.85 加名字得分的十分之一，约 0.95，最多 0.97；一个名字只是包含另一个（续作、OAD、衍生作品），或名字相同但年份不符，得 0.7，于是只留作候选，从不单独生效。所以搜进击的巨人时，被采用的是《进击的巨人》而不是《进击的巨人 OAD》：0.95 对 0.7，差距足够。与模型矛盾的记录（没有这一集、片长差得很远）会让条目最多留下 8 个候选，显示在 `get_item` 的 `metadata.candidates` 里，让用户的智能体可以问用户是哪一个。
6. **只有模型的回答时，给出身份，不给详情。** 模型对一集或一部电影有把握（至少 0.8）、但没有插件的记录被采用时（没有配置，或数据库里没有这部作品），条目只采用身份：种类、所属的剧、季、集，以及模型给出的分集标题，标为 `from: "model"`。简介、演员表和图片只来自记录，从不来自模型的记忆。
7. **什么也没找到也是一个答案。** 模型有把握判为 `other`、或什么也匹配不上的条目，作为未匹配缓存起来，只保留片源给出的详情。

没有模型时跳过第 3 步，插件改按解析器的线索搜索，核对和阈值不变；对规范的标题结果一样，不规范的会漏掉更多。

文件名读得清楚的文件（带季和集的名字，或者带年份的电影名，见 `readsClearly()`），即使有模型也先走这条路：记录确认了线索，条目就匹配上，不调用模型；只有记录不确认的文件才继续走第 3 步。媒体库里的文件大多是这样的名字，所以一个上千个文件的文件夹只为少数名字不清楚的文件调用模型，在每日调用次数之内。标题不规范的网络投稿仍然先问模型。

B 站的分 P 是不同的条目（`?p=8` 是条目 id 的一部分），所以一个十 P 的投稿是十个条目。片源注册表的 `sequence()` 列出一个条目和它之后的分 P，所以一次模型调用就覆盖这个条目和它之后的分 P，最多 30 个，节点缓存每个分 P 的身份；排在它们前面的分 P 被问到时单独调用一次。数据库插件缓存它们的 API 回答，所以后面的分 P 也不用再经网络搜索，只需要查自己那一集。

2026-10-25 用这个例子做过一次试验：经本地网关，用用户订阅里的两个小模型。两者都答出是《Nathan For You》第 1 季第 8 集，用时 5.5 秒和 11.6 秒；其中一个还给出了分集标题 *Private Investigator / Taxi Company*，公开的分集列表证实了它，但它把标题填进了提示里留给剧名的字段。所以回答把剧和分集分成不同字段，经过 schema 校验，并用记录确认。

2026-10-26 把整条路径跑了一遍：这个版本的节点跑在用户家里的机器上，对着用户真实的播放历史，即一个分 p01 到 p08 的《Nathan For You》第一季 B 站投稿，语言为 `zh-CN`，没有 TMDB key。一次 Codex 调用识别出整组分 P（921 + 428 个 token，约 15 秒）。之后 p02 和 p08 各在 2 到 4 秒内返回，分别是 `救援高手 S1E2 — Santa / Petting Zoo` 和 `救援高手 S1E8 — Private Investigator / Taxi Company`，带分集的简介和剧照、剧的海报和简介、带照片的演员表，以及三条声明（Wikipedia、TVmaze、Bangumi）。p01 的第一次请求用了 19.6 秒，超过了 17 秒的等待，所以先用片源的详情回答，识别随后完成；它的下一次请求在 2 秒内给出 `救援高手 S1E1 — Yogurt Shop / Pizzeria`。

<a id="title-hints"></a>

### 标题线索

[`service/core/src/release-title.js`](../../../../service/core/src/release-title.js) 里的 `parseReleaseTitle()` 把每个标题读成 `subject.hints`。它不是匹配器：模型拿它的解读作为提示，没有模型时插件按它搜索。它认识的是发布名和投稿的惯例，而不是服务商：

| 写法 | 读出 | 强度 |
|---|---|---|
| `S01E08`、`s1e8`、`S01 E08`、`1x08`、`S01E08-E09`（取第一个） | 季和集 | 强 |
| `Season 1`、单独的 `S01`、`第一季`、`第1季`、`第十二季`（中文数字） | 季 | 强 |
| `第8集`、`第八话`、`第8話`、`EP08`、`E08`、`Episode 8` | 集 | 强 |
| 单独出现的 `p08`、`P8`（B 站分 P） | 集 | 弱：只在没有强的集号、或与强的集号一致时使用 |
| 标题后的 `[08]`、` - 08 `（字幕组风格） | 集 | 弱 |
| `(2013)`、`.2013.`、`[2013]` | 年份 | 中；它本身就是标题时忽略 |
| `720p`、`1080p`、`WEB`、`WEB-DL`、`HDTV`、`BluRay`、`x264`、`HEVC` 等 | 发布标签；标题在第一个标签之前结束 | — |
| `【…】`、`[…]` | 标签，单独保存；`美剧`、`日剧`、`电影`、`TV`、`Movie` 提示种类 | — |

候选标题来自剩下的文字：带点的发布名（`Nathan.For.You.S01E08`）给出季集号之前的词，`第…季`或强标记之前的文字给出另一个，`/`、`|` 以及两侧有空格的短横线或全角破折号把一个名字和它的译名分开。上面的例子读出 `{ titles: ["Nathan For You", "救援高手"], season: 1, episode: 8, part: 8, year: null, kind: "episode", agree: ["S01E08", "第一季", "p08"], tags: ["译制 by 电波字幕组", "美剧", "WEB", "720p"] }`。

已经知道作品的片源不用猜：网站提供时，`source-ytdlp` 传入 yt-dlp 的 `series`、`season_number` 和 `episode_number`，Plex 插件把它的 guid 作为 `ids` 传入。

### 与片源合并

节点用核心里 `normalizeDetails()` 旁边的 `mergeDetails(source, metadata)`，把片源的详情和被采用的元数据逐字段合并。哪一边优先，取决于片源描述的是作品本身，还是只是它的一份拷贝：

- **知道作品的片源优先，元数据补缺。** `kind` 是作品（`movie`、`show`、`season` 或 `episode`）的片源条目，比如 Plex 的条目，保留它已有的每个字段；元数据补上它缺的字段、它没有的图片，并按名字给人物补上照片。有 Plex 的用户保留 Plex 精心整理的详情，再得到 Plex 没有的部分。
- **对投稿来说，匹配描述作品。** 其他种类（`video`、`live`）的片源条目在有记录被采用时，取用作品的简介、人物、类型、日期、年份、评分、剧集信息、所属的剧、id 和图片，并变成 `kind: "episode"` 或 `"movie"`。投稿自己的信息移到 `upload` 下：`{ title, description, channel, date, url, stats }`。条目的 `title` 变成作品的显示标题 `Nathan For You S1E8 — <分集标题>`，季集号不补零，和 Plex 插件给分集起标题的方式一样（核心里的 `workTitle()`）。
- **只有身份、没有记录时，只改名字。** 模型认出、但没有插件确认的投稿（[第 6 步](#matching-an-item)）采用显示标题、`kind` 和 `series`，保留它自己的简介、人物和图片，自己的标题放在 `upload.title`。
- **有些字段始终属于片源。** `duration`、`url`、`stats`、`progress`、音轨和字幕、章节和弹幕描述的是用户播放的这份拷贝，所以元数据从不替换它们。
- **元数据插件之间按加载顺序决定。** 每个字段取最早拥有它的插件，所以手写的 NFO 胜过数据库，Wikipedia 用用户的语言写的剧集简介胜过 TVmaze 的英文简介。`series`、`show` 和 `ids` 也这样逐个子字段合并；前面的插件列出了某个人却没有照片时，后面的插件按名字给他补上照片。

`normalizeDetails()` 在已有的上限内保留人物的 `photo` 以及字段 `poster`、`backdrop`、`still`、`show`、`upload`、`ids` 和 `metadata`；图片是 http(s) URL 或条目的 artwork 路径。[`service/core/test/metadata.test.js`](../../../../service/core/test/metadata.test.js) 负责合并和解析器的规则。

### 缓存和用户的匹配

| 内容 | 位置 | 有效期 |
|---|---|---|
| 一个条目的识别结果：模型给出的身份，以及被采用的候选或未决的候选，按 source key 存放，并用 Subject 的哈希核对 | 节点，`.media-cache/metadata/` | 匹配到时 30 天；没匹配到时 3 天，这样数据库后来才收录的投稿也能匹配上 |
| 模型对一个条目的身份判断，包括同组的其他分 P | 节点，`.media-cache/metadata/` | 30 天 |
| 一个插件对一部作品、一种语言的 `lookup` | 节点，`.media-cache/metadata/` | 7 天 |
| Wikidata 和 Wikipedia、TVmaze、Bangumi 以及 TMDB 的 API 回答 | 各插件的 `cacheDir` | 30 天 |
| 远程图片 | 不存储：节点的缩略图抓取把它们放在内存里（[节点内部 API](2026-10-07-node-internal-api.zh.md)） | 它的内存预算 |
| 用户为一个条目固定或拒绝的匹配 | D1 的 `item_matches`（迁移 `0013`）：`user_id`、`source_key`、`plugin`、`candidate`（JSON）、`created_at`；拒绝时 `plugin` 和 `candidate` 为 null | 直到用户修改 |

节点的缓存随时可以删除，下一次请求时重建；每个有效期都远低于 TMDB 对缓存数据六个月的上限。用户的匹配是唯一不能重建的状态，所以和用户的其他数据一样放在 D1（[D1 数据模型](2026-10-07-d1-data-model.zh.md)）。上一个版本的代码从不读取这张表，所以迁移能和那个版本一起工作。片库条目移动时，它的匹配随历史记录一起移动，除非新 id 已经有自己的匹配（[移动了的片库条目](../feature/2026-10-21-moved-library-items.zh.md)）。

两个 MCP 工具让用户的智能体更正匹配（[远程 MCP 服务器](../feature/2026-10-07-remote-mcp-server.zh.md)）。`match_item` 接收 `item_id`，以及以下三者之一：来自 `get_item` 或 `search_metadata` 的 `candidate`（带它的 `plugin`），用 `none` 拒绝任何匹配，或用 `clear` 忘掉用户的选择，让节点重新识别这个条目；它返回条目现在的详情。`search_metadata`（`query`、值为 `movie` 或 `show` 的 `kind`、`year`）调用插件的 `search`。两者都需要 `manage` 权限，和播放列表一样。

### 图片

图片字段（`thumbnail`、`poster`、`backdrop`、`still`，以及人物的 `photo`）和 `thumbnail` 一样有两种形式（[v1 HTTP API](2026-10-07-v1-http-api.zh.md)）：

- **公开图片的 http(s) URL**，各个数据库的图片就是这样。屏幕通过 `/v1/thumbnail` 加载它，由节点带着防服务端请求伪造的检查去抓取；智能体拿到的是 `/i/*` 链接。插件返回屏幕需要的尺寸（342 像素的海报、780 像素的背景图、185 像素的头像），而不是原图。
- **只有节点能读的图片**，比如文件旁边的 `poster.jpg`。插件在回答里把它写成 `"local:<ref>"`，节点把它变成条目的一个 artwork 变体 `/v1/library/items/<id>/artwork?variant=m-<插件 id>-<ref>`（变体超过 32 个字符时丢弃），由节点用那个插件的 `image(ref, { file })` 回答，而不是片源的 `artwork`。这个变体由条目和 ref 推出，所以节点的缓存被删除后，指向它的 `/i/*` 链接仍然有效。

[`service/control/src/image-links.js`](../../../../service/control/src/image-links.js) 里的 `createImageLinks().present()` 封装每一个图片字段（`thumbnail`、`poster`、`backdrop`、`still` 和 `photo`），所以 MCP 结果里的每张图片都是不用登录就能加载的链接。不需要新的图片路由。

<a id="reaching-v1-and-get_item"></a>

### 到达 /v1 和 get_item

- **MCP `get_item`** 返回合并后的详情：上面的字段、带 `photo` 的人物，以及 `metadata: { plugin, id, confidence, origin: "auto" | "owner", from: "records" | "model", candidates?, attributions? }`，其中 `candidates` 列出未决的匹配，`attributions` 列出每个记录被采用的插件的声明，形如 `{ text, url? }`，最多 5 条，不重复。它的描述告诉智能体：`metadata.candidates` 不止一个时去问用户，再用 `match_item` 定下来。
- **`GET /v1/library/items/:id`** 返回和 `get_item` 相同的对象，需要 `read` 权限，让屏幕能显示简介、演员表和背景图。`:id` 是任意 source key，网络视频的也可以。播放器的详情页（[`clients/player/src/details.js`](../../../../clients/player/src/details.js)）从播放器的信息按钮打开，显示图片、标题、一行元信息、简介和剧的简介、带照片的演员表、它播放的那份投稿（"This copy"）及其上传者，以及 `attributions` 里的每一条声明。
- **媒体库列表**（`/internal/v1/library/:id/items`、`/library/items/:id/children` 和 `/library/search`）把匹配上的条目显示成它的作品：类型不是作品的条目（`video`，比如文件夹里的文件）在节点缓存里有匹配时，用作品的显示标题、`kind`、`series` 和 `poster`，并用作品的图片作为 `thumbnail`（这一集的剧照，否则用背景图或海报），替换片源自己的图，比如文件的一帧截图；没匹配上的条目保留自己的图。还没识别的条目按片源给的样子列出并排进队列，从不等待，所以媒体库的网格会随着队列的处理逐渐补全。片源自己知道作品的条目，比如 Plex 的，按原样列出，也不会为了列表去识别。
- **`/internal/v1/metadata`** 在节点缓存里有匹配时，加上作品的显示标题、`series`（`{ title, season, episode }`）和 `poster`。控制面用这个标题给队列和播放列表里的条目命名。缓存里有匹配时，`/internal/v1/prepare` 打开的视频流也用同一个显示标题，所以播放状态和历史显示作品的名字；`series` 和 `poster` 还没有传到控制面，视频流的其他字段保持原来的形状。

每项改动都是增量的：一个新路由、一些新的可选字段，以及 `title` 里更好的字符串。忽略未知字段的客户端，比如播放器的 JavaScript 和 YoloKit 的 `Decodable` 类型，继续可用，所以 `CLIENT_PROTOCOL` 和 `NODE_PROTOCOL` 都不需要提高（[客户端协议](2026-10-19-client-protocol.zh.md)）。这个版本的控制面连着旧节点时，拿到的是没有元数据的详情；旧控制面会忽略节点的新字段。

<a id="the-tmdb-key"></a>

### TMDB key

大多数剧集的完整详情不需要 key：Wikimedia 认出这部剧并描述它，TVmaze 描述这一集，Bangumi 覆盖动画和中日剧集，都不用 key。TMDB key 是补充：覆盖更多电影，带背景图，海报也是屏幕用的尺寸。

TMDB 的 API 条款给每个开发者的是不可转让、不可再许可的非商业使用许可，所以 Yolo 不能内置一个所有实例共用的 key。想用 TMDB 的用户在 themoviedb.org 免费申请一个 key，设为 `TMDB_API_KEY`（v3 key 作为 `api_key` 发送，v4 read access token 作为 bearer 令牌发送），或插件的 `apiKey` 选项。

- 没有 key 时，`metadata-tmdb` 照常启动但什么也不做；它的 `health()` 会说明这一点并附上申请链接，`yolo doctor` 把它显示为可选的 `info` 一行 `node.metadata.tmdb`，而不是一个失败。其他官方元数据插件都不需要 key。
- `yolo-deploy` 技能把 key 作为可选步骤提供，和 Plex 一样。
- 插件把 TMDB 的声明作为自己的 `attribution` 返回；只要条目详情来自 TMDB，播放器的详情页就在条目的声明里显示它。
- 插件把 TMDB 的回答保留 30 天，只在缓存未命中时请求 TMDB，每个新条目只有几次请求，每次超时 8 秒。

<a id="the-official-plugins"></a>

### 官方插件

| 插件 | 读取 | 说明 |
|---|---|---|
| `@useyolo/metadata-local`（`plugins/metadata-local`，id 为 `local`） | 文件旁边的 `<base>.nfo` 或 `movie.nfo`，以及所在文件夹或上一级文件夹里的 `tvshow.nfo`；旁边的图片（`<base>-poster`、`poster`、`folder`、`cover`；`<base>-fanart`、`fanart`、`backdrop`；`<base>-thumb`）、剧所在文件夹的海报和背景图，以及 `.actors/First_Last.jpg` 里的演员照片；经 ffprobe 读取文件内嵌的 `show`、`season_number` 和 `episode_sort` 标签（`FFPROBE_PATH`，或 `ffprobe` 选项） | 需要 `subject.file`，所以服务同一台机器上的 Plex 插件和未来的文件夹、WebDAV 片源，不服务网络视频。NFO 以置信度 1 匹配，并把它的 `<uniqueid>` 传给后面的插件；内嵌标签给出置信度 0.9 的候选；只有图片时给出置信度 0.9、记录里只有图片的候选，用来补上片源缺的图片。不读内嵌的封面。候选 id 是 `f-<hash>`，在它的 `cacheDir` 里映射到路径，所以路径从不离开节点。不走网络 |
| `@useyolo/metadata-wikimedia`（`plugins/metadata-wikimedia`，id 为 `wikimedia`） | Wikidata 的条目搜索、声明搜索和条目数据；Wikipedia 的页面摘要；Wikimedia Commons 的图片 | 按任何语言的名字找电影和剧（救援高手就是 *Nathan for You*，`Q10935299`），只保留"属于"（instance of）类别是电影或电视剧的条目；也通过 Wikidata 的声明搜索按 `imdb`、`tvmaze` 或 `tmdb` id 查找。把 `wikidata`、`imdb`、`tmdb`（`movie/<id>` 或 `tv/<id>`）、`tvmaze`、`bangumi` 和 `douban` 这些 id 传下去。完整地描述一部电影：用户语言的标题（`zh-CN` 先试 `zh-cn`，再试 `zh-hans` 的标签）、用这种语言的 Wikipedia 摘要（`zh-CN` 用 `zh-cn` 变体），没有时用英文、一张图片（条目文章的缩略图，没有时用 Wikidata 经 Commons 给出的图片）、最多 12 位演员和 3 位导演及其 Commons 上的照片、类型，并核对片长在 25% 以内。对一集只描述它所属的剧（`series`，剧的标题、简介、年份和海报，类型），这一集本身留给分集数据库。声明："Descriptions from Wikipedia under CC BY-SA 4.0; data from Wikidata."，链接到那篇文章。选项 `language`（否则 `YOLO_METADATA_LANGUAGE`，再否则 `en`） |
| `@useyolo/metadata-tvmaze`（`plugins/metadata-tvmaze`，id 为 `tvmaze`） | TVmaze 的剧集搜索、按 IMDb 或 TheTVDB id 查找、带演员的剧集和按集号查分集 | 只有电视剧，只有英文。凭前面插件给的 `tvmaze`、`imdb` 或 `tvdb` id，这部剧是确定的（置信度 1），这一集仍要核对：这一季没有这一集得 0.3，片长差 15% 以上得 0.6；按名字时搜索剧集，最多核对三条记录。描述这一集：标题、简介、播出日期、剧照、剧的海报和简介、最多 12 位带照片的演员、类型、评分和 id。声明："TV data from TVmaze under CC BY-SA 4.0."，链接到这部剧的 TVmaze 页面。没有选项 |
| `@useyolo/metadata-bangumi`（`plugins/metadata-bangumi`，id 为 `bangumi`） | Bangumi（bgm.tv）的条目搜索、条目、章节和角色接口 | 动画和三次元条目（类型 2 和 6），带中文标题和简介。Bangumi 把每一季存为单独的条目，所以第二季及以后按 `<名字> 第二季` 和 `<名字> Season 2` 搜索，条目是第几季从它的名字读出。在条目的章节列表里核对这一集，片长在 20% 以内（电影 25%）；Wikidata 给出的 `bangumi` id 让条目确定。只回答语言是中文或日文的用户（选项 `always` 让所有人都用）。描述时给出这一集的中文标题，条目的简介放在剧集上；一集的简介留给 TVmaze，因为 Bangumi 上一集自己的文字大多是制作人员名单；另有最多 12 位主角和配角及其声优的照片、作为类型的标签和评分。声明："Anime and show data from Bangumi (bgm.tv)."，链接到这个条目。选项为 `language` 和 `always` |
| `@useyolo/metadata-tmdb`（`plugins/metadata-tmdb`，id 为 `tmdb`） | TMDB 的按外部 id 查找、搜索、电影、剧集、季和集接口 | 先按作品的 `tmdb`、`imdb` 或 `tvdb` id 查找，否则按 identity 或线索里的名字搜索（最多核对三条记录），给名字和年份打分，检查这一季有没有这一集、片长差距在 15% 以内（电影 25%），给出 `movie/<id>` 和 `tv/<id>` 形式的 id。描述作品时带最多 12 位演员、导演、主创和编剧、一集的客串演员、类型、评分和图片。选项 `apiKey`（否则 `TMDB_API_KEY`）和 `language`（否则 `YOLO_METADATA_LANGUAGE`，再否则 `en`） |

要联网的四个插件都用 `yolo.fetch` 发请求，所以用户的出口规则对它们同样有效（[出口代理层](2026-10-13-node-egress-proxy.zh.md)）。

三个不需要 key 的插件按 Wikimedia 和 Bangumi 的要求发送一个写明 Yolo 的 User-Agent，每次请求限时 8 秒，并把每个 API 回答（包括 404）在自己的 `cacheDir` 里保留 30 天。

`plugins/official.json` 的目录（catalog）把元数据插件列在片源、智能体和模型提供方插件之后。合并时每个字段取最早拥有它的插件，所以顺序就是合并依赖的顺序；从屏幕上打开的插件，不论何时打开，都按这个顺序写进配置（[从任何屏幕选择插件](../../proposed/feature/2026-10-31-home-cold-start.zh.md)）：

1. `metadata-local`：用户自己的文件最清楚自己是什么。
2. `metadata-wikimedia`：它用用户的语言说出作品的名字，并把 id 传下去，让后面的插件按 id 而不是按名字找到作品。
3. `metadata-bangumi`，用户读中文或日文时：用这门语言给出的分集标题，以及动画和中日剧集，其他数据库在这方面覆盖得少。
4. `metadata-tvmaze`：这一集本身，包括简介和剧照，Wikimedia 不管这部分。
5. `metadata-tmdb`，最后且可选：用户设了 key 时，补上其他插件缺的部分。

`scripts/provider-names.js` 把 `metadata-local` 列为不指向服务商的目录，因为它读的是用户自己的文件；它给 `tmdb` 加上别名 `themoviedb`，给 `wikimedia` 加上别名 `wikipedia` 和 `wikidata`，所以服务代码里不能出现这些名字。

Plex 插件把它的 guid（`imdb`、`tmdb`、`tvdb`，详情用 `includeGuids=1` 取得）作为 `ids` 传入，在 `Role.thumb` 是 http(s) URL 时把它作为演员的 `photo`，并在节点所在机器能读到时通过 `file()` 给出 part 的文件（[片源插件 API](2026-10-11-source-plugin-api.zh.md#the-official-plugins)）。

## 曾考虑的替代方案

**把元数据放进每个片源插件。** 每个片源都要重复标题解析、数据库客户端和它的 key，投稿也永远借不到数据库对这部剧的了解。片源描述拷贝，元数据插件描述作品，节点把两者连起来。

**把元数据插件放在控制面。** 控制面入口可以从 Worker 调用 TMDB，节点离线时也能工作。但它读不了 NFO 文件、内嵌标签和文件旁边的图片，所以本地插件仍要在节点上运行，元数据就会在两个地方合并。放在控制面插件选项里的 key 也会被打包进 Worker 的代码。详情本来就来自节点，所以元数据也在那里合并。

**把每个结果都缓存进 D1。** 这能让节点离线时也显示条目详情，但那时节点也无法播放任何东西；而且 D1 会存着 TMDB 的内容，条款要求在许可终止时清除。节点的缓存可以重建，只存被请求过的内容；D1 只存用户的决定。[自己的片库](../../proposed/feature/2026-10-11-own-library-and-nas.zh.md)在 D1 里的目录以后可以带上每个目录条目合并后的标题和海报。

**节点缓存一个标题解析到的剧。** 这能让同组后面的分 P 省掉一次搜索剧，但数据库插件已经把它们的 API 回答保留 30 天，第二个分 P 的搜索不花一次请求；节点这边再存一份映射，等于用节点核对不了的键重复插件的记录。

**详情必须有 TMDB key。** 单靠 TMDB 就能覆盖多种语言的电影和剧集，但 key 要注册，大多数用户从来不会去注册，于是大多数实例什么详情都没有。Wikidata、Wikipedia、TVmaze 和 Bangumi 不用 key 就能回答，合起来能认出并描述大多数剧集，包括用用户的语言描述一个投稿所属的剧；TMDB 留作可选插件，补它们缺的部分。

**项目共用的 key，或项目自己的代理。** Infuse 的详情经过它的开发者在应用和数据库之间运行的一个服务。Yolo 没有这样的服务：开发者不运行任何实例会连接的东西，隐私政策也这么写。共用一个 TMDB key 违反条款，条款规定许可不可转让、不可再许可，而且所有实例会共用一个速率限制和一次吊销；代理则会让开发者夹在每个用户和他们的查询之间，还是一个要运行、要付费、要维护的服务。从用户自己的节点直接调用不需要 key 的数据库，这两样都不需要。

**对每个条目都规则优先，模型只处理规则漏掉的。** 解析器不花钱，每次答案都一样，但每个网站、每个字幕组、每种命名习惯都要再加一条规则，而且没有规则知道救援高手就是《Nathan For You》，或者一个带剧名的二十分钟投稿是片段而不是正片。模型一次读完整个条目，什么语言都行，每个条目只花用户自己订阅里的一次短调用。解析器保留为模型的提示、没有模型时的路径，以及文件名读得清楚的文件的第一步尝试；对文件名，它比对投稿标题准得多。

**不经记录就采信模型的话。** 模型认出了这个例子，其中一个连分集都说对了，但简介、演员表和播出日期正是模型的记忆最常出错的地方，而屏幕上什么也不会提示；后来一次试验里，Claude Code 的 Haiku 说对了是哪一集，分集标题却是编的。模型说出是哪部作品；记录描述这部作品；只有身份、没有记录时，只改条目的名字。

**没有数据库回答时，用模型的记忆补简介和照片。** 模型已经认出了作品，也能写一段简介、说出演员。但简介正是它的记忆最容易出错的地方，上一条替代方案已经说过；而且模型根本给不出照片，只能给出一个它记得或编出来的 URL，这个 URL 可能不存在，也可能是别人的照片。有了不需要 key 的数据库，大多数剧集都有记录，剩下要补的已经很少；没有任何数据库认识的条目保留片源的详情。

**每个条目都运行用户的智能体。** 智能体插件已经能用上用户的订阅，也能搜网页，但一次运行是几十秒以上的完整智能体会话，而且和屏幕的 Ask 请求一次只能跑一个。每个条目一次结构化的模型调用，通过 [`yolo.models`](2026-10-25-models-for-plugins.zh.md)，就足够了；智能体只通过 `match_item` 解决有歧义的条目。

**不论置信度都采用最佳候选。** 错的一集比普通视频更糟：它用一个错误的标题替换了正确的标题。带差距的阈值把可疑的匹配留作候选，等用户确认。

**元数据总是胜过片源。** 这会用数据库的详情替换 Plex 精心整理的详情，包括用户在 Plex 里自己做的修改。描述作品的片源保留自己的字段；只有字段描述的是拷贝的投稿才让位。

**新开 `/v1/items/:id/details` 路由，而不是 `/v1/library/items/:id`。** 片库条目的 id 已经是 source key，artwork 路由也在 `/v1/library/items/:id` 下；在同一个前缀下再加一个路由，让条目的详情和图片放在一起。

## 后果

一个已知分集的投稿显示为那一集，带剧的简介、海报和演员表；Plex 条目得到演员照片和 Plex 没有的图片；用户什么都不用注册：官方数据库对大多数剧集不需要 key，TMDB key 只是锦上添花；用户自己的文件通过 NFO 文件和图片描述自己。测试固定了节点的识别、阈值和缓存（[`service/node/test/metadata.test.js`](../../../../service/node/test/metadata.test.js)），经 `/v1` 和 MCP 的用户匹配（[`service/control/test/integration/metadata.test.js`](../../../../service/control/test/integration/metadata.test.js)），以及每个插件对自己记录的读取。

- **模型可能自信地答错**，不同模型的回答也不同。每个匹配都由记录确认，时长检查能拦住一个自信但错误的分集，错误的匹配只要一次 `match_item` 就能改正。合集（`S01E01-E03`）、特别篇（`S00`）和动画的绝对集数对模型和解析器来说都仍然困难。
- **识别要花模型调用**，用的是用户的订阅：每个新条目或每组分 P 大约一次，每次几百个 token，受节点给 `metadata` 的每日调用次数上限约束；30 天的缓存让重播不再花费。条目的标题、简介、上传者和文件名会发给模型厂商，隐私政策写明了这一点。
- **错误的匹配比没有匹配更误导人。** 它会改掉条目在队列、播放列表和智能体回答里的名字。阈值是保护措施，可能需要在真实的投稿上调整。
- **TMDB 的条款可能变化**，它的商业使用示例里包括带来流量或收入的 AI 系统。用户的私人智能体读自己的条目两者都不沾，每个用户自己的 key 让每个实例各自守在条款之内。条款还要求在显示其数据的地方放 TMDB 的标志；播放器只显示文字声明，设置里也没有。
- **声明会显示出来。** Wikipedia 的文字和 TVmaze 的数据采用 CC BY-SA 4.0，要求署名并附链接，所以详情页显示每个被采用插件的声明，MCP 结果也在 `metadata.attributions` 里带上它们，供引用它们的智能体使用。
- **TVmaze 只有英文。** 用户读中文或日文时，Bangumi 排在它前面，所以 Bangumi 认识的一集用这门语言的分集标题，简介和剧照仍是 TVmaze 的英文；只有 TVmaze 认识的一集保留英文标题，比如 `救援高手 S1E8 — Private Investigator / Taxi Company`。
- **一个新条目要问好几个服务。** Wikidata、Wikipedia、TVmaze 和 Bangumi 各收到几次请求，带着作品的名字和季、集号，从不带媒体本身或用户的历史，隐私政策写明了这一点；30 天的缓存让同组后面的分 P 和重播不再走网络。
- **中文标题的覆盖不均匀。** Wikidata 知道很多作品的中文名，Bangumi 覆盖动画，但 TMDB 和 TVmaze 的中文标题不完整或干脆没有，所以在这两处大多数匹配按原名进行：发布名里的原名、模型为中文标题给出的原名，或 Wikidata 的 id。没有模型时，没有原名的投稿要看中文标题有没有被收录。社区的豆瓣插件以后可以通过同一个接口补上，从 Wikimedia 传下来的 `douban` id 开始。
- **一个新条目的第一次详情请求要等模型和插件**，约 5 到 15 秒，最多 17 秒，因为如果描述这个条目时没有提前开始识别，识别就在这时进行；超过之后，条目先显示片源的详情，直到识别结束。模型慢的时候，新一组分 P 的第一个条目可能错过它的第一次请求，就像 2026-10-26 那次 p01 用了 19.6 秒；同组的其他分 P 几秒内从缓存返回。
- **条目详情需要节点**，和以前一样；D1 里的目录由[自己的片库](../../proposed/feature/2026-10-11-own-library-and-nas.zh.md)来设计。
- **只有浏览器播放器的详情页显示详情。** 主屏幕和 Apple TV 应用都不显示；两者都可以基于 `GET /v1/library/items/:id` 来做。
- **接口由五个插件塑造**：用户自己的文件、三个不需要 key 的数据库和一个需要 key 的数据库，在 1.0 之前保持实验性。
