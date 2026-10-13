# Agent Note: 进度和续播归 Yolo 管

Status: implemented

[English](2026-10-11-yolo-owns-progress-and-resume.md) | 中文

## 问题

观看进度分散在 Plex、早先的单进程服务和 Yolo 三个地方，这正是「播放不接着进度」的根本原因：《The Gentlemen》在 Plex 里有进度，却从 00:00 开始。没有 Plex 的 NAS 用户则根本没有别的地方保存进度。在车上，页面刷新或从睡眠中醒来时，还必须决定要不要继续播放，而浏览器可能不允许在没有点击的情况下带声音开始播放。

## 决策

Yolo 自己的历史是进度的权威来源，Plex 降为可选的片源插件，它自己的进度只作为后备。（同一决策中的 Yolo 自有片库还是[提案](../../proposed/feature/2026-10-11-own-library-and-nas.zh.md)。）

**记录。** Hub 把当前设备的 `report` 写进 Yolo 的历史——状态变化时立刻写，否则至少每 30 秒写一次——并转给节点的 `/sessions/:id/progress`，片源可以在那里写回自己的进度（Plex 就会写回）。历史保留最近 500 个条目（[D1 数据模型](../architecture/2026-10-07-d1-data-model.zh.md)）。

**决定起点。** 没有 `startTime` 的播放：Yolo 历史里有超过 5 秒、没看完的位置就从那里开始；看完了就从头开始；否则把 `startTime: null` 交给片源，片源用自己的进度（Plex 的 `viewOffset`），也没有就从头开始。

**刷新或醒来后的续播**，像 Spotify 在车里那样（[`clients/tesla/src/resume-decision.js`](../../../../clients/tesla/src/resume-decision.js)）：当前设备的最后一条连接断开时，Hub 把播放记为暂停在当时的位置；如果断开时正在播（`playing`、`buffering` 或 `loading`），就标上 `interruptedAt`。设备回来时，正在播或被打断时正在播的条目，不管车睡了多久，都在保存的位置接着播；用户本人离开前已经暂停的条目（没有 `interruptedAt`）保持暂停。用户之后的暂停或继续会清掉 `interruptedAt`。

**离开播放器。** 返回（播放器上的或浏览器的）停掉设备上的流，但留下条目：设备上报 `idle`，Hub 保存位置、停掉节点上的会话（转码随之结束），并把条目保持为该设备上的暂停状态，标上 `leftAt`。该设备的首页在正在播放栏里显示它，写作「Paused on This browser」（车里是「This screen」）（[`clients/tesla/src/remote.js`](../../../../clients/tesla/src/remote.js)）。点栏上的播放键、点栏本身，或别的设备遥控播放，都会在那个位置、用该条目保存的音轨请求新的流并打开播放器；设备选择器里的「Stop playing」结束它。页面回来时（刷新或醒来），标着 `leftAt` 的条目留在栏里，不会打开播放器；暂停保留这个标记，继续播放或新的流会清掉它。

**声音。** 播放先试着带声音开始，浏览器对媒体参与度高的网站可能允许这样做。浏览器的自动播放策略不让出声时，视频静音播放，页面上显示一个小的「Tap for sound」，点页面任何地方就会恢复声音。没有画面的流会等待点击。`autoplay_result` 和 `audio_unlocked` 事件记录每次的结果（[设备埋点](2026-10-11-device-telemetry.zh.md)）。

## 曾考虑的替代方案

**继续依赖 Plex 的片库和进度。** 进度会继续分散在 Plex 和 Yolo 两处，这正是要修的 bug，而且没有 Plex 的用户将没有进度可用。

**醒来后一律暂停续播。** 在车上，用户本人希望屏幕醒来后原来在播的内容接着播，就像 Spotify 那样；只有离开前主动暂停的状态才应该在醒来后保留。

## 后果

`play` 不带 `start_at` 时，在任何设备上都会从用户本人上次停下的地方继续，Yolo 还没播过的条目仍从 Plex 的进度续播。离开时还在播放的车，不管睡了多久，醒来后都会接着播放；浏览器不让出声时就静音播放。从播放器返回后，条目留在正在播放栏里，点一下就能接着看。
