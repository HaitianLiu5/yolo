# Agent Note: useyolo.app 网站，以及隐私政策和技术支持页

Status: implemented

[English](2026-10-23-useyolo-app-website.md) | 中文

## 问题

上架 App Store 的 app 需要一个隐私政策网址和一个技术支持网址，而且内容必须如实描述 app 的行为。Yolo 有好几个客户端：车机和网页两种模式的浏览器播放器、Apple TV 上的 Yolo TV，以后还有 iPhone app；它们的隐私事实是一样的：每个都只和主人自己的服务器和节点通信。和代码分开维护的政策，会随着数据流变化而走样。

## 决策

- **本仓库的 `site/` 就是 useyolo.app。**[`site/public/`](../../../../site/public/) 里是静态 HTML 和一个样式表，由 [`site/wrangler.jsonc`](../../../../site/wrangler.jsonc) 通过 Workers 静态资源部署在 `useyolo.app` 和 `www.useyolo.app` 上，没有 Worker 代码、Cookie、统计，也不请求任何第三方。它是 Yolo 自己的网站，不是某个主人的实例，所以和 `service/control/wrangler.jsonc` 不同，它的配置写明了自己的域名。`npm run site:deploy` 经 `npm run wrangler`、用 `npm run yolo -- auth` 的令牌，从持有 `useyolo.app` 区域的账号部署。
- **所有客户端共用一份隐私政策和一个技术支持页。**英文的 `/privacy` 和 `/support`、中文的 `/zh/privacy` 和 `/zh/support`，就是填进 App Store Connect 的网址。政策写明每个客户端向主人的服务器和节点发送什么、服务器存什么以及为什么、Apple 客户端为什么要本地网络权限（节点的 `_yolo._tcp` Bonjour 广播，以及局域网直连播放），以及 Ask 的语音怎么处理：浏览器里的录音交给主人的转写插件，从不保存（[语音输入](../feature/2026-10-18-agent-from-the-screen.zh.md#voice-input)）；Yolo TV 用系统听写，自己不录音。开发者什么都不收集，这和每个 Apple app 的 `PrivacyInfo.xcprivacy` 一致（没有收集的数据类型，不追踪）。
- **页面跟着代码走。**让客户端发送、或让服务器保存新东西的改动，要在同一个改动里更新 `/privacy` 和 `/zh/privacy`，并更新生效日期。两种语言一起改；页面是 HTML，Markdown 的配对检查管不到它们。
- **技术支持走 GitHub Issues 和 `support@useyolo.app`**，这个地址由该区域的 Cloudflare Email Routing 转发；安全问题按 [`SECURITY.md`](../../../../SECURITY.md) 提交到 GitHub Security Advisories。

## 考虑过的替代方案

**网站放在单独的仓库。**隐私政策描述的是代码的数据流；放在别的仓库，代码改动在评审时看不到旁边的页面。

**由每个主人的实例提供页面。**App Store Connect 需要一个对所有主人都固定的网址，而且政策讲的是 app，不是某一个实例。

**把页面写成 Agent Notes 下的 Markdown。**它们是给 App 审核和公众看的，不是项目知识，需要稳定的地址和带样式的 HTML。

## 后果

页面内容变了，政策网址不变，修改历史就是仓库的历史。每个新客户端、客户端新发送的每个字段，都是重读 `/privacy` 的理由。部署网站需要持有 `useyolo.app` 的 Cloudflare 账号；`useyolo.app` 的注册在 2027-10-10 到期，不续费的话，App Store 上架信息里的网址也会随之失效。
