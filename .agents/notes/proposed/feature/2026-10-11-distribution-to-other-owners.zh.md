# Agent Note: 把 Yolo 分发给其他用户

Status: proposed

[English](2026-10-11-distribution-to-other-owners.md) | 中文

## 问题

Yolo 是为一位用户本人手工部署的：控制面靠 wrangler 命令，节点靠克隆仓库和一个 launchd 服务，插件靠编辑 JSON 再重新部署来配置（[部署](../../implemented/architecture/2026-10-07-control-plane-on-cloudflare-media-node-at-home.zh.md)）。其他人不读代码就装不起来。

## 提案

从 0.7 到 1.0 的版本让其他用户也能安装 Yolo，每人用自己的 Cloudflare 账号和域名：

- **一条命令部署控制面。**
- **节点安装包：**面向 Synology、QNAP、Unraid 和 TrueNAS 的 Docker 镜像，以及一个让节点以 LaunchDaemon 运行的 macOS 安装包，局域网插件需要这样运行（Apple TN3179）。
- **首次设置向导**，最后用节点的配对码注册 passkey。
- **`yolo install`**：从 npm、git 或本地目录按固定版本安装插件；它更新配置、重新部署控制面（Worker 不能在运行时加载代码）并重启节点。
- **插件 API 文档和示例插件**；`useyolo.app` 宣传网站和文档上线。
- **备份恢复、用量护栏和安全审查。**

复杂度为中：工作面宽但不深，要在多个平台上打包和测试。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 验收标准

一位有 Cloudflare 账号和 NAS、电脑或 Mac 的新用户，按发布的说明——一条命令部署控制面、一个节点安装包和设置向导——装好 Yolo，用节点的配对码注册 passkey，配对一块屏幕，用 `yolo install` 安装一个插件，并能从备份恢复。

## 风险

每个 NAS 平台和 macOS 版本都需要单独打包和测试。把 Yolo 发布给他人，就绕不开 Cloudflare 对代理视频的条款问题（[待定问题](../process/2026-10-07-cloudflare-video-terms.zh.md)），不用 Cloudflare 的用户也仍然不受支持（[不依赖 Cloudflare 的自托管](../architecture/2026-10-07-self-hosting-without-cloudflare.zh.md)）。到 1.0 时，插件 API 必须稳定到可以写成文档。
