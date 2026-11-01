# Agent Note: 特斯拉浏览器的显示大小

Status: implemented

[English](2026-10-11-display-size.md) | 中文

## 问题

从软件 2026.26 起，特斯拉浏览器以 1.53 的 `devicePixelRatio` 渲染：CSS 视口约 773×601，对应约 1183×920 个物理像素。在这个像素比下播放器显得太大，而一个 CSS 像素对应一个物理像素（社区通常的 `width=1183`）时又显得太小。改变大小不能让 Yolo 搞错屏幕真正有多大，也不能让 Yolo 认不出这是车。

## 决策

播放器的车机模式提供几档显示大小（[`clients/player/src/display-scale.js`](../../../../clients/player/src/display-scale.js)）：每个 CSS 像素占 1.53（原生）、1.35、1.25、1.15 和 1.0 个物理像素，通过根元素上的 CSS `zoom` 实现，zoom = 档位 / 浏览器自己的 `devicePixelRatio`（1.53 下的 1.25 档为 0.817）。页面随之按 `innerWidth / zoom` 个 CSS 像素的宽度排版：在车上 773 像素宽的窗口里，默认档为 946，1.0 档为 1183。

- [`clients/player/public/display-scale-boot.js`](../../../../clients/player/public/display-scale-boot.js) 在 `<head>` 里、第一次布局之前运行，设置保存的档位对应的 zoom，并把应用的结果存在 `window.__yoloDisplayBoot` 里。
- 只有车提供显示大小：[车机模式](2026-10-11-yolo-web-client.zh.md)（用户本人为设备选的类型是「car」；Yolo 还没告诉页面类型时，看[设备指纹](2026-10-07-device-code-pairing.zh.md)），且 `devicePixelRatio` 不低于 1.4。默认 1.25。其他浏览器保持自己的缩放、不设 zoom，之前在那里保存的大小也被忽略：只有应用为这台设备存了数字默认值（`yolo.displayScaleAuto`）时，启动脚本才应用保存的选择；其他设备上应用存的是 `native`。
- 在车上，用户本人在设置的 **This screen** 下选择大小：从 **Smallest**（1.0）经 **Default**（1.25）到 **Largest**（浏览器自己的 1.53）共五档，每档用一个逐渐变大的字母表示，保存在这台设备的 `localStorage` 里。`?scale=1.25`（或 `native`）在任何浏览器上都只对这一次打开有效，用于测试。
- zoom 既不改变 `innerWidth`，也不改变 `devicePixelRatio`。指纹直接读取它们，所以无论选哪一档，设备都仍被认作特斯拉；上报给 Yolo 的视口也保持物理像素，即 `innerWidth × devicePixelRatio`（车上为 1183×920）（[能力协商](../architecture/2026-10-07-capability-negotiation.zh.md)）。canvas 的后备缓冲区是解码画面的尺寸，zoom 不会碰它；只有浏览器把画面缩放进去的那个框跟随布局变化。
- 在缩放后的根元素里，`getBoundingClientRect()` 和指针坐标用的都是窗口的 CSS 像素，所以进度条、双击的左右区域，以及比较这两者的命中判断都不需要修正；`clientWidth`、`scrollBy` 和 `ResizeObserver` 用的是元素自己缩放后的 CSS 像素。`vw`、`vh` 和媒体查询仍然按未缩放的窗口计算（默认档下 100vw 只有窗口的 82%），所以样式表改为以 `#app`（一个尺寸容器）为基准，使用 `cqw` 和 `cqh`；一个单元测试会拒绝客户端样式表里的视口单位。
- 某一档生效后，`display_scale` 事件上报 `method: "zoom"`、档位、来源（`default`、`owner` 或 `query`）、请求的 `zoom` 和实际生效的 `appliedZoom`（body 在屏幕上的宽度与其 CSS 宽度之比）、`width`（zoom 应得到的 CSS 宽度）、`layoutWidth`/`layoutHeight`（页面实际排版的尺寸）、`physicalWidth`/`physicalHeight`、`innerWidth`/`innerHeight`、`devicePixelRatio`、`visualViewport.scale`，以及 `honoured`（`layoutWidth` 是否等于 `width`）；之后 `env` 事件会再发一次（[设备埋点](2026-10-11-device-telemetry.zh.md)）。

## 曾考虑的替代方案

**保持原生的 1.53。** 播放器在这个大小下显得太大。

**一个 CSS 像素对应一个物理像素，即 1.0 档。** 播放器在这个大小下显得太小，它仍是可选的一档。

**`<meta name="viewport" content="width=N">`，社区的做法。** 软件 2026.26 上的车机浏览器是 Linux 上的桌面版 Chrome 148，而桌面版 Chrome 不应用视口 meta。2026-10-12 车上报告默认档 `honoured: false`：页面仍然是 773 个 CSS 像素宽，`visualViewport.scale` 为 1，所以显示大小在车上从未生效。zoom 从 Chromium 128 起成为标准，在桌面版和移动版 Chromium 上同样改变布局。两者都设置的话，在接受 meta 的浏览器上会叠加生效，所以 meta 保持 `width=device-width`。

**在所有浏览器上都提供显示大小，并按原生大小的百分比标注。** 在电脑或手机上，这些档位是相对浏览器自己的像素比算的（一台 2 倍屏的 Mac 显示 100%、77%、68%、63%、57% 和 50%），对用户本人毫无意义，而且这些浏览器自己就能缩放。围绕默认值命名的档位才说得清改变了什么。

## 后果

用户本人可以按设备选择播放器看起来有多大，而 Yolo 对屏幕的认识不受影响。每一档都会缩放每个 CSS 像素，所以触控目标保持 48 个 CSS 像素，在屏幕上随所选大小变小（默认档下约 60 个物理像素）。样式表不能用 `vw` 或 `vh` 表示跟随窗口的尺寸。zoom 在车上是否生效、哪一档最适合用户本人作为默认值，仍需要在车上由一条 `method: "zoom"` 且 `honoured: true` 的 `display_scale` 事件确认（[提案](../../proposed/feature/2026-10-11-in-car-display-size-check.zh.md)）；在那之前，被认出的特斯拉默认使用 1.25。

## 测试

[`test/e2e/car-playback.test.js`](../../../../test/e2e/car-playback.test.js) 在车机窗口（1.53 下的 773×601，桌面版 Chrome）里配对，并检查默认档下 946 像素的排版。zoom 的计算、选出的各档以及在各档下的点按没有单独的测试；由[车上检查](../testing/2026-07-21-test-layers.zh.md#in-car-checks)覆盖。
