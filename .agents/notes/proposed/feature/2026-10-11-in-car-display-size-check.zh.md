# Agent Note: 在车上确认显示大小并选定默认值

Status: proposed

[English](2026-10-11-in-car-display-size-check.md) | 中文

## 问题

[显示大小](../../implemented/feature/2026-10-11-display-size.zh.md)为 1.53 到 1.0 之间的各档设置 `<meta name="viewport" content="width=N">`，但还没有人确认特斯拉浏览器是否接受 1183（社区常用的值）以外的视口宽度。被认出的特斯拉默认使用 1.25，这个值是在没有上车试过的情况下定的。

## 提案

在车上用首页的 **Display size** 逐档试一遍，并在 Workers Logs 里查看 `display_scale` 事件（[设备埋点](../../implemented/feature/2026-10-11-device-telemetry.zh.md)）：每次改动后的 `honoured`（布局宽度是否等于 N）、`innerWidth`/`innerHeight`、`clientWidth`、`devicePixelRatio` 和 `visualViewport.scale`。然后：

- 去掉浏览器不接受的档位；
- 让用户本人从可用的档位中选出特斯拉的默认值，并更新 `TESLA_DEFAULT_SCALE` 和显示大小记录。

## 曾考虑的替代方案

**不检查，保持 1.25。** 如果浏览器忽略 1183 以外的宽度，这个设置在车上就会悄无声息地不起作用，用户本人的选择只是安慰剂。

**只提供原生和 1183 两档。** 这样可以回避问题，但会丢掉促成这个功能的中间档位，因为用户本人觉得原生太大、1183 太小。

## 验收标准

首页提供的每一档在车上都报告 `honoured: true`，否则已被去掉；用户本人已从剩下的档位中选定特斯拉的默认值；显示大小记录写明了确认过的档位和默认值。

## 风险

特斯拉之后的软件更新可能改变浏览器处理视口 meta 的方式，所以确认过的结果也可能失效。这项检查需要用户本人在车上、屏幕处于唤醒状态。
