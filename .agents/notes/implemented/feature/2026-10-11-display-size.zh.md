# Agent Note: 特斯拉浏览器的显示大小

Status: implemented

[English](2026-10-11-display-size.md) | 中文

## 问题

从软件 2026.26 起，特斯拉浏览器以 1.53 的 `devicePixelRatio` 渲染：CSS 视口约 773×601，横向约 1183 个物理像素。用户本人觉得播放器在这个大小下太大，而社区通常的做法 `width=1183`（一个 CSS 像素对应一个物理像素）又太小。改变大小不能让 Yolo 搞错屏幕真正有多大，也不能让 Yolo 认不出这是车。

## 决策

特斯拉客户端提供几档显示大小（[`clients/tesla/src/display-scale.js`](../../../../clients/tesla/src/display-scale.js)）：每个 CSS 像素占 1.53（原生）、1.35、1.25、1.15 和 1.0 个物理像素，用 `<meta name="viewport" content="width=N">` 实现，N = round(物理宽度 / 档位)。

- [`clients/tesla/public/display-scale-boot.js`](../../../../clients/tesla/public/display-scale-boot.js) 在 `<head>` 里、第一次布局之前运行：它在任何改动之前测量物理尺寸（`innerWidth × devicePixelRatio`），存在 `window.__yoloDisplayBoot` 里，并应用保存的档位。
- 只有车提供显示大小：车的[设备形态](2026-10-11-yolo-web-client.zh.md)（用户本人为设备选的类型是「car」；Yolo 还没告诉页面类型时，看[设备指纹](2026-10-07-device-code-pairing.zh.md)），且 `devicePixelRatio` 不低于 1.4。默认 1.25。其他浏览器保持自己的缩放、不改 meta，之前在那里保存的大小也被忽略：只有应用为这台设备存了数字默认值（`yolo.displayScaleAuto`）时，启动脚本才应用保存的选择；其他设备上应用存的是 `native`。
- 在车上，用户本人在设置的 **This screen** 下选择大小：从 **Smallest**（1.0）经 **Default**（1.25）到 **Largest**（浏览器自己的 1.53）共五档，每档用一个逐渐变大的字母表示，保存在这台设备的 `localStorage` 里。`?scale=1.25`（或 `native`）在任何浏览器上都只对这一次打开有效，用于测试。
- 指纹使用改动之前测得的尺寸，所以无论选哪一档，设备都仍被认作特斯拉；上报给 Yolo 的视口也保持物理像素（[能力协商](../architecture/2026-10-07-capability-negotiation.zh.md)）。
- 某一档生效后，`display_scale` 事件上报档位、`width`、来源（`default`、`owner` 或 `query`）、改动前测得的物理尺寸，以及生效后的 `innerWidth`/`innerHeight`、`clientWidth`、`devicePixelRatio`、`visualViewport.scale` 和 `honoured`（布局宽度是否等于 N）；之后 `env` 事件会再发一次（[设备埋点](2026-10-11-device-telemetry.zh.md)）。

## 曾考虑的替代方案

**保持原生的 1.53。** 用户本人觉得播放器在这个大小下太大。

**社区的 `width=1183`，即 1.0 档。** 用户本人觉得太小，它仍是可选的一档。

**在所有浏览器上都提供显示大小，并按原生大小的百分比标注。** 在电脑或手机上，这些档位是相对浏览器自己的像素比算的（一台 2 倍屏的 Mac 显示 100%、77%、68%、63%、57% 和 50%），对用户本人毫无意义；这些浏览器自己就能缩放，固定的视口宽度还会破坏它们的响应式布局。围绕默认值命名的档位才说得清改变了什么。

## 后果

用户本人可以按设备选择播放器看起来有多大，而 Yolo 对屏幕的认识不受影响。车机浏览器是否接受 1183 以外的宽度，以及哪一档最适合用户本人作为默认值，仍需要在车上确认（[提案](../../proposed/feature/2026-10-11-in-car-display-size-check.zh.md)）；在那之前，被认出的特斯拉默认使用 1.25。
