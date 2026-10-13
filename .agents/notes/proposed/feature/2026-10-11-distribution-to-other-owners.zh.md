# Agent Note: 把 Yolo 分发给其他用户

Status: proposed

[English](2026-10-11-distribution-to-other-owners.md) | 中文

## 问题

用户本人的 agent（智能体）现在已经能在仓库的克隆里部署、检查、升级和回退一个实例，只在必须由用户本人完成的步骤停下（[agent 部署](../../implemented/feature/2026-10-13-agent-deployment.zh.md)）。没有 agent 的人仍然得在 Mac 或 Linux 机器的终端里运行这些命令，NAS 根本没有安装包，插件还要靠编辑 JSON 再重新部署来添加。

## 提案

从 0.7 到 1.0 的版本在这些命令之上继续构建，让任何人都能安装 Yolo，每位用户本人用自己的 Cloudflare 账号和域名：

- **节点安装包：**面向 Synology、QNAP、Unraid 和 TrueNAS 的 Docker 镜像，以及一个让节点以 LaunchDaemon 运行的 macOS 安装包，局域网插件需要这样运行（Apple TN3179）；目前 `npm run yolo -- service install --daemon` 只是为管理员准备好一个。
- **首次设置向导**，依次运行 `init`、`provision`、`migrate`、`deploy` 和 `service install`，最后用节点的配对码注册 passkey。
- **`yolo install`**：从 npm、git 或本地目录按固定版本安装插件；它更新配置、重新部署控制面（Worker 不能在运行时加载代码）并重启节点，也就是 [`skills/yolo-add-source-plugin`](../../../../skills/yolo-add-source-plugin/SKILL.md) 现在手工执行的那些步骤。
- **插件 API 文档**，在[示例插件](../../../../plugins/source-example/)之外；`useyolo.app` 宣传网站和文档上线。
- **整个实例的备份恢复**（D1、KV、实例文件和 `.env`），超出每次迁移前的 D1 导出；**用量护栏**；以及**安全审查**。

复杂度为中：工作面宽但不深，要在多个平台上打包和测试。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 验收标准

一位有 Cloudflare 账号和 NAS、电脑或 Mac 的新用户，按发布的说明——一条命令部署控制面、一个节点安装包和设置向导——装好 Yolo，用节点的配对码注册 passkey，配对一块屏幕，用 `yolo install` 安装一个插件，并能从备份恢复。

## 风险

每个 NAS 平台和 macOS 版本都需要单独打包和测试。把 Yolo 发布给他人，就绕不开 Cloudflare 对代理视频的条款问题（[待定问题](../process/2026-10-07-cloudflare-video-terms.zh.md)），不用 Cloudflare 的用户也仍然不受支持（[不依赖 Cloudflare 的自托管](../architecture/2026-10-07-self-hosting-without-cloudflare.zh.md)）。到 1.0 时，插件 API 必须稳定到可以写成文档。

宣传网站的地址 `useyolo.app` 注册在用户本人的 Cloudflare 账号下，到期日 2027-10-10，没开自动续费，所以除非用户本人续费，这个注册会在那天过期。
