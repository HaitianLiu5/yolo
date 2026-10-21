# Agent Note: 片库条目换了 id

Status: implemented

[English](2026-10-21-moved-library-items.md) | 中文

## 问题

片库条目的 id 是片源自己的，例如 Plex 条目的 `ratingKey`；Yolo 按 `<plugin>:<id>` 保存历史、续播位置和音轨偏好（[片源插件 API](../architecture/2026-10-11-source-plugin-api.zh.md)）。片源可能给同一个文件换一个新 id：一次 Plex 片库重新扫描把 `plex:9916` 变成了 `plex:9919`，标题一样，时长同样是 4,039 秒。用户的屏幕、历史和 Hub 仍然指向旧 id，每次请求流都得到 `not_found`（插件说「Library item not found」），播放器显示「This video can't play right now.」，旁边的 **Try again** 怎么按都没用。

## 决定

### Hub 重新找到这个条目

一次播放中，节点的 `prepare` 回答 `not_found` 时，Hub 的 `relocate()`（[`hub-core.js`](../../../../service/control/src/hub/hub-core.js)）先在新 id 下找这个条目，找不到才拒绝：

- **找什么：**请求指明的条目（队列里的条目）的标题和时长；没有时用正在播放、id 相同的条目的；再没有就用旧 id 的历史记录。没有标题或时长不是正数时，什么也不找。
- **在哪里找：**用这个标题在节点的片库搜索（[节点内部接口](../architecture/2026-10-07-node-internal-api.zh.md)）里找，最多 20 个结果，最多等 15 秒。
- **怎样算是这个条目：**同一个片源（id 以 `<plugin>:` 开头）、id 不同的结果，标题经过 Unicode NFKC 规范化、去掉首尾空白、合并连续空白、转成小写后相同，`duration` 相差不超过 2 秒。恰好有一个这样的结果，它就是这个条目；没有，或者不止一个，就算没找到。

找到之后，Hub 记一条 `item_relocated`（`from`、`to`）日志，把旧 id 的历史记录（连同位置和播放次数）和保存的音轨选择移到新 id 下；新 id 已经有自己的记录时保留新 id 的。然后用在旧 id 下读到的起播位置和音轨偏好为新 id 准备流。流、Hub 的状态和历史之后的写入都用新 id。移动历史和音轨选择尽力而为：失败时记一条 `relocate_write_failed` 日志，流照常播放。

没找到时，这次播放以 `not_found` 被拒绝：「This video is no longer in the library」，后面附上片源自己的回答。

### 屏幕把这件事说出来

[`player.js`](../../../../clients/player/src/player.js) 里的 `showPlaybackError()` 在错误或它的 cause 链上任何一层是 `not_found`、且不是媒体死路时，显示「This video is no longer in the library.」并隐藏 **Try again**，保留 **Back**。

## 曾考虑的替代方案

**用片源自己的稳定标识。**Plex 每个条目都有一个重新扫描后不变的 GUID，但不是每个片源都有这样的标识，条目的 `id` 由片源自己决定，而且核心代码不能知道某个提供方的标识（[插件架构](../architecture/2026-10-11-plugin-architecture.zh.md)）。有这种标识的插件可以自己把它用作条目的 `id`。

**只按标题匹配。**标题会重复：翻拍片、一部电影和它的预告片、同名的剧集。时长相差不超过 2 秒能把其中大多数区分开。

**在多个匹配里挑最好的播放。**播错视频，还把用户的历史移到它上面，比说这个视频没了更糟。

**给插件加一个重新定位条目的方法。**每个片源都得实现它；每个片库片源都有的 `search` 已经能回答这个问题，插件 API 也不用改。

## 后果

片库重新扫描后换了 id 的视频，下一次请求就能再播放，从用户停下的地方开始，带着为它选好的字幕，历史也跟着它走。代价是在流之前多一次失败的 `prepare` 和一次片库搜索。第一次这样播放时，历史和音轨选择就移过去了，但队列条目、播放列表条目和分享链接仍然保存创建时的 id：队列或播放列表里的条目每次播放都要重新找一次，指向换了 id 的条目的分享链接则不再能播放。

如果另一个文件标题相同、长度和旧文件相差不超过 2 秒，例如同一部电影的另一份拷贝，而它又是唯一的匹配，它会被当成换了 id 的那个条目；有两个这样的文件时什么也不播。`prepare` 的任何 `not_found` 都会触发搜索，包括节点没有加载某个片源插件时的那种；这时回答仍然说视频已不在片库里，后面附上片源自己的话。搜索需要片源能按 Yolo 知道的标题找到这个条目，并以秒为单位返回它的 `duration`（[`service/plugin-api/src/index.js`](../../../../service/plugin-api/src/index.js) 里的 `LibraryItem`）；标题里不只有条目自己的名字时，例如剧集的标题带着剧名和集数，片源的搜索可能匹配不上，这个条目也就找不回来。

## 测试

[`hub-core.test.js`](../../../../service/control/test/unit/hub-core.test.js) 播放一个 `prepare` 回答 `not_found` 的条目，按空白和大小写不同的标题、相差 1.5 秒的时长找到它唯一的新 id，从旧 id 的位置开始播放，历史和音轨选择也移了过去；有两个匹配、只有另一个片源的结果、时长相差 2.5 秒时，什么也不播，回答 `not_found`。[`history.test.js`](../../../../service/control/test/unit/history.test.js) 覆盖移到一个已有自己记录的 id 上的情况。播放器的这句话和隐藏的 **Try again** 没有单独的测试。
