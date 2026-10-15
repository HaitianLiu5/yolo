# Agent Note: 在流的结尾重试，绝不会在结尾加载

Status: implemented

[English](2026-10-12-retry-at-stream-end.md) | 中文

## 问题

流已经播到结尾、播放器显示错误时，点 **Try again** 会一直停在「Loading」。[`clients/player/src/player.js`](../../../../clients/player/src/player.js) 里的 `retryPlayback()` 从 `getPlaybackRecoveryPosition()` 取起点（也就是结尾），并要求在那里重建失败的会话，而那里已经没有可播的内容。如果流已经播完，Yolo 也已经结束了那个会话（设备发了 `ended`，队列里没有下一项），于是重建请求得到 `superseded`，没有任何东西取代那个转圈。

同一个 bug 让一个 dash_split 跳转的端到端测试间歇性失败：它 60 秒长的 fixture（测试前置数据）可能在测试最后一次点 Try again 之前就播完。

## 决策

重试、恢复和续播都不会请求一个已经没有内容可播的流（[`clients/player/src/playback-recovery.js`](../../../../clients/player/src/playback-recovery.js)）。位置落在一个已知、非直播时长的最后一秒以内时，就算没有内容可播（`hasNothingLeftToPlay`、`NOTHING_LEFT_SECONDS`）。

- **Try again 重新播放这个条目**：从停下的位置播；那里没有内容可播时，从头播，和 Yolo 对待任何看完的条目一样（[进度和续播](../feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)）。`planRetry()` 决定怎么播：Hub 最新的 `PlaybackState` 还持有失败的会话时，Try again 重建它（`reason: "recovery"`，并带上被替换的会话）；Yolo 已经结束或停止了那个会话，或者以 `superseded` 拒绝重建而且已经没有会话时，Try again 在本机对这个条目发一个新的 `play`。`playback_retry_requested` 记录这个决定。
- **结尾处的自动恢复会让条目结束。**位置已经没有内容可播的恢复（`410`、跳转卡住、解码错误）会像自然播完一样发送 `ended`，然后 Yolo 播放队列的下一项，或者停止。`playback_recovery_finished` 记录这一步。
- **回到结尾的页面会让正在播放的条目结束。**页面重新加载或醒来时，如果发现本机的条目已经在结尾，而 Hub 记着它在播放，或者因为设备在播放时断了连接而暂停（`interruptedAt`；暂停加载的流永远不会被标上），`resumeDecision()` 给出 `finished`，页面发送 `ended`，而不是在结尾请求一个流。Hub 因别的原因记为暂停的条目永远不会被结束，因为 `ended` 会在没人要求的情况下开始队列的下一项：它保持暂停，在结尾之前 `PAUSED_AT_END_SECONDS`（3）秒处加载，那里的流还有画面可显示。所以 `ended` 随连接丢失、页面又在重连前重新加载时，条目会停在结尾暂停，而不会接着往下播；只有仍留着播放器的那个页面才会重发 `ended`（[Hub 和实时通道](../architecture/2026-10-07-hub-and-realtime-channel.zh.md)）。

流中途的恢复行为不变。

### 测试

`planRetry` 的单元测试锁定这条约定：条目播完、Yolo 结束了它的会话之后，Try again 从头播放这个条目。单元测试还覆盖 `hasNothingLeftToPlay` 和 `resumeDecision().finished`；[`test/e2e/car-playback.test.js`](../../../../test/e2e/car-playback.test.js) 里车机的端到端流程从错误面板点 Try again 接着播放。

## 曾考虑的替代方案

**队列里有下一项时，前进到下一项。** Try again 指的是屏幕上的这个条目；前进会让同一个按钮因为一个用户本人可能根本没在看的队列而做两件不同的事，还会跳过一个用户本人没看到结尾的条目。自然播完和结尾处的自动恢复仍然会前进，因为那时条目确实已经结束了。

**只加长 fixture。** 测试会通过，但任何人在视频结尾点 Try again 时仍然会卡住。

**禁用这个不稳定的测试。** 这样也会失去它对跳转、重建和恢复之后格式与画面尺寸的覆盖，而这正是这个测试存在的意义。

## 后果

Try again 总会播放点什么，自动恢复也绝不会自己把看完的条目重播一遍。电影最后一秒出错时，用户本人点 Try again 会从头开始；想离开就点 Back。一秒的阈值有意定得很窄：还有片尾字幕没播完时，会从原来的位置继续。
