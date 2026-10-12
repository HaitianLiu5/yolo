# Agent Note: 特斯拉浏览器的显示大小

Status: implemented

[English](2026-10-11-display-size.md) | 中文

## 问题

从软件 2026.26 起，特斯拉浏览器以 1.53 的 `devicePixelRatio` 渲染：CSS 视口约 773×601，横向约 1183 个物理像素。用户本人觉得播放器在这个大小下太大，而社区通常的做法 `width=1183`（一个 CSS 像素对应一个物理像素）又太小。改变大小不能让 Yolo 搞错屏幕真正有多大，也不能让 Yolo 认不出这是车。

## 决策

特斯拉客户端提供几档显示大小（[`clients/tesla/src/display-scale.js`](../../../../clients/tesla/src/display-scale.js)）：每个 CSS 像素占 1.53（原生）、1.35、1.25、1.15 和 1.0 个物理像素，用 `<meta name="viewport" content="width=N">` 实现，N = round(物理宽度 / 档位)。

- [`clients/tesla/public/display-scale-boot.js`](../../../../clients/tesla/public/display-scale-boot.js) 在 `<head>` 里、第一次布局之前运行：它在任何改动之前测量物理尺寸（`innerWidth × devicePixelRatio`），存在 `window.__yoloDisplayBoot` 里，并应用保存的档位。
- [设备指纹](2026-10-07-device-code-pairing.zh.md)认出的 2026.26 及以后的特斯拉（且 `devicePixelRatio` 不低于 1.4）默认 1.25；其他浏览器默认原生大小，不改 meta。
- 用户本人在首页最下面的 **Display size** 里选择大小，按原生大小的百分比显示（100%、88%、82%、75%、65%），保存在这台设备的 `localStorage` 里。`?scale=1.25`（或 `native`）只对这一次打开有效，用于测试。
- 指纹使用改动之前测得的尺寸，所以无论选哪一档，设备都仍被认作特斯拉；上报给 Yolo 的视口也保持物理像素（[能力协商](../architecture/2026-10-07-capability-negotiation.zh.md)）。
- 某一档生效后，`display_scale` 事件上报档位、`width`、来源（`default`、`owner` 或 `query`）、改动前测得的物理尺寸，以及生效后的 `innerWidth`/`innerHeight`、`clientWidth`、`devicePixelRatio`、`visualViewport.scale` 和 `honoured`（布局宽度是否等于 N）；之后 `env` 事件会再发一次（[设备埋点](2026-10-11-device-telemetry.zh.md)）。

## 曾考虑的替代方案

**保持原生的 1.53。** 用户本人觉得播放器在这个大小下太大。

**社区的 `width=1183`，即 1.0 档。** 用户本人觉得太小，它仍是可选的一档。

## 后果

用户本人可以按设备选择播放器看起来有多大，而 Yolo 对屏幕的认识不受影响。车机浏览器是否接受 1183 以外的宽度，以及哪一档最适合用户本人作为默认值，仍需要在车上确认（[提案](../../proposed/feature/2026-10-11-in-car-display-size-check.zh.md)）；在那之前，被认出的特斯拉默认使用 1.25。
