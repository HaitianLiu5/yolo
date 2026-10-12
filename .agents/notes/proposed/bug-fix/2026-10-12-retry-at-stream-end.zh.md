# Agent Note: 在流的结尾点 Try again 会一直停在 Loading

Status: proposed

[English](2026-10-12-retry-at-stream-end.md) | 中文

## 问题

流已经播到结尾、播放器显示错误时，点 **Try again** 会在播放停下的位置——也就是结尾——请求一个新的流，然后播放器一直停在「Loading」。[`clients/tesla/src/player.js`](../../../../clients/tesla/src/player.js) 里的 `retryPlayback()` 从 `getPlaybackRecoveryPosition()` 取起点，并在那里请求新的会话，而那里已经没有可播的内容。

它表现为端到端测试「seeking a dash_split stream keeps its format and picture size」（[`test/e2e/playback-experience.test.js`](../../../../test/e2e/playback-experience.test.js)）的间歇性失败：大约三次里有一次，在未修改的分支上也一样。这个测试的 fixture（测试前置数据）只有 60 秒长；等测试触发最后一个错误并点 Try again 时，播放可能已经到了结尾，负载较高时尤其如此。

## 提案

- 位置在条目结尾或之后的重试或恢复，不在结尾加载：而是从头重新播放这个条目；队列里有下一项时，则前进到下一项。用哪一种，遵循现有的「看完的条目从头开始」规则（Yolo 从头开始播放它，[进度和续播](../../implemented/feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)），除非用户本人决定 Try again 应该前进到下一项。
- 加长这个测试的 fixture，让测试在最后一步之前不可能播到结尾；并增加一个测试：在结尾之后点 Try again，期望播放重新开始（或前进），而不是卡住。

## 曾考虑的替代方案

**只加长 fixture。** 测试会通过，但任何人在视频结尾点 Try again 时，产品里仍然会卡住。

**禁用这个不稳定的测试。** 这样也会失去它对跳转、重建和恢复之后格式与画面尺寸的覆盖，而这正是这个测试存在的意义。

## 验收标准

流结束后点 Try again，播放器绝不会停在「Loading」：它会重新开始或前进。端到端测试在多次重复运行中都能通过，包括负载较高时；并有一个新测试覆盖结尾之后的 Try again。

## 风险

重新开始还是前进，会改变用户本人在条目结尾出错后看到的结果；选错可能会重播一个用户本人本想离开的视频。修复涉及多个触发方式（`410`、醒来、跳转重建）共用的恢复代码，所以不能改变流中途的恢复行为。
