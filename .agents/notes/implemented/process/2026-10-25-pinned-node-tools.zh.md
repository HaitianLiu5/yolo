# Agent Note: 检出目录固定节点用的 yt-dlp 和 Deno

Status: implemented

[English](2026-10-25-pinned-node-tools.md) | 中文

## 问题

节点播放每个网页都要运行 yt-dlp，而 yt-dlp 为 YouTube 运行 Deno。以前用户本人用 Homebrew 或发行版的包管理器安装这两个程序，所以运行的是哪个版本取决于是哪台机器、哪天装的；Homebrew 按自己的节奏升级它们；回滚能恢复 Yolo 的代码，却恢复不了测试时用的工具。某个网站一改版、新版 yt-dlp 修好了它，每个用户都得自己发现并手动升级。`doctor` 只能说 PATH 上有某个 yt-dlp。

## 决策

### 清单

仓库根目录的 [`tools.json`](../../../../tools.json) 为每个工具固定一个发布版本：它的 GitHub 仓库、发布标签，以及 macOS 和 Linux 在 arm64 和 x64 上的压缩包名、它的 SHA-256 和包里的可执行文件。它固定 yt-dlp（用解压成目录的构建：`yt-dlp_macos.zip`、`yt-dlp_linux.zip`、`yt-dlp_linux_aarch64.zip`）和 Deno。这个文件提交进仓库、随代码一起变化，所以一个 Yolo 版本恰好对应一套工具。

### 安装

根目录的 `postinstall` 脚本运行 `npm run yolo -- tools install --postinstall`，所以每次 `npm install` 和 `npm ci` 都会安装固定的那套工具（[`ops/lib/tools.js`](../../../../ops/lib/tools.js)）：

- 缓存里没有的构建从它的 GitHub 发布下载，在解压任何内容之前先核对 SHA-256，再用 `unzip` 解压到一个临时名字下，完整之后才改成最终的名字。
- 缓存由这台机器上的所有检出目录共用：macOS 上是 `~/Library/Caches/yolo/tools`，Linux 上是 `$XDG_CACHE_HOME/yolo/tools`（没有则是 `~/.cache/yolo/tools`），也可以用 `YOLO_TOOLS_CACHE` 指定。除了固定的版本，每个工具还保留两个其他版本，供回滚和其他检出目录使用。
- 检出目录里被 git 忽略的 `.tools/bin/<tool>` 链接到固定的可执行文件，每个工具运行一次 `--version`：这证明它能在这台机器上启动，也让 yt-dlp 的 macOS 构建在播放之前就付掉第一次启动的开销（约 10 秒）。
- 下载失败或哈希不符会让 `npm install` 失败。`YOLO_TOOLS=skip` 跳过这一步；CI 用它，因为没有任何任务运行真正的节点，端到端测试也用假的 yt-dlp。在 `tools.json` 没有构建的平台上，这一步什么都不做，节点像以前一样从 PATH 找这些工具。

### 运行

节点启动时把 `.tools/bin` 放在它的 PATH 最前面（[`service/node/src/main.js`](../../../../service/node/src/main.js)），所以每个插件的子进程，以及 yt-dlp 自己查找 Deno 时，即使机器上还装着别的 yt-dlp，运行的也都是固定的构建。插件里指定可执行文件的选项（例如 yt-dlp 插件的 `binary`）仍然优先。`service/` 下的代码不提任何工具的名字。

### 升级、回滚和检查

`npm run yolo -- upgrade` 和 `rollback` 在重启节点之前会在检出目录里运行 `npm ci`，所以节点重启后用的是目标版本固定的工具；回滚时旧的构建还在缓存里。固定的工具缺失、或 `.tools/bin` 链接的是别的版本时，`doctor` 报失败，修复方法是 `npm run yolo -- tools install`；`npm run yolo -- tools status` 单独做同样的检查。

### 升级某个工具

`npm run yolo -- tools bump <tool>` 把某个工具固定到它的最新发布，每个压缩包用 GitHub 给出的 SHA-256。yt-dlp 对某个网站的修复，通过一个更新 `tools.json` 的 Yolo 版本送到用户手里，通常是一个补丁版本（[版本与发布](2026-10-13-versions-and-releases.zh.md)）；两次发布之间没有任何东西会自己更新。

### 仍由用户本人安装的程序

ffmpeg 和 cloudflared 仍是系统程序，用 Homebrew 或发行版安装，`doctor` 在 PATH 上检查它们。FFmpeg 官方不发布自己的构建，能找到的静态构建都是第三方对它开发分支的快照；而且 ffmpeg 命令行的变化远比 yt-dlp 跟随的那些网站慢。

## 曾考虑的替代方案

**用户本人自己安装所有工具。** 这是以前的状态，也是上面版本漂移的来源。

**让 yt-dlp 自己更新。** 每天运行 `yt-dlp -U` 修复网站最快，但这样一来实例运行什么取决于它上次何时更新，没有测试跑过这个组合，回滚也恢复不了它。

**把二进制文件提交进仓库。** 每个工具每个平台约 40 MB，四个平台再加上 yt-dlp 频繁的发布，每次升级都会让仓库变大；ffmpeg 的构建还带有 GPL 的再分发条款。

**一个依赖这些工具的 Homebrew 公式。** Homebrew 会装好它们，但版本跟随 Homebrew 而不是 Yolo，回滚恢复不了它们，Linux 也得另想办法。

**容器镜像。** 它能固定一切，但在 macOS 上容器里没有 VideoToolbox、家庭网络的地址和 Bonjour，而节点需要这些。

**yt-dlp 的单文件构建。** macOS 的单文件构建每次运行都要先把自己解压一遍，每次启动打印版本号都要约 10.6 秒；目录构建在第一次之后只要 0.26 秒。

**也固定 ffmpeg。** macOS 的静态构建是一位维护者发布的开发快照，Intel 版本在 2026 年 1 月就停了，不如 yt-dlp 和 Deno 发布在 GitHub 上的官方版本可靠。

**每个检出目录各有一个工具目录。** 每个工作树和部署检出目录都会把同样的 80 MB 再下载一遍；共用缓存加上每个检出目录自己的链接，每台机器每个版本只下载一次。

## 后果

一个 Yolo 版本在每台机器上运行的都是测试过的 yt-dlp 和 Deno，升级或回滚会让它们随代码一起变化，`doctor` 检查的是确切的构建。用户本人少装两个程序，PATH 上残留的 Homebrew yt-dlp 也不再有影响。

代价是 `npm install` 需要访问 GitHub，并在一台机器上第一次安装时下载约 80 MB；网站的修复要等一个 Yolo 版本，而不是随 yt-dlp 的发布立刻到来；Yolo 信任 yt-dlp 和 Deno 在 GitHub 上的发布，并用 SHA-256 固定它们。
