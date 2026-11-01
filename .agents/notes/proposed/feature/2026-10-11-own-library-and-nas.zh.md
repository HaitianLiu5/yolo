# Agent Note: Yolo 自己的片库和 NAS 片源

Status: proposed

[English](2026-10-11-own-library-and-nas.md) | 中文

## 问题

Yolo 的片库模型已经有了，但只有 Plex 插件在填充它，所以片子放在 NAS 上、又没有 Plex 的用户根本没有片库。片库也只在家里的节点在线时才能访问，除了 Plex 提供的以外，没有任何元数据（海报、简介、演职员）。Yolo 已经管理进度（[进度和续播](../../implemented/feature/2026-10-11-yolo-owns-progress-and-resume.zh.md)）；同一个决策也让 Plex 在片库方面变成可选。

## 提案

0.5 版让 Yolo 拥有自己的片库：

- **文件夹片源插件**：扫描目录、解析文件名，并用 ffprobe 读取音轨和字幕；以及**节点自己的重新封装**：对设备不接受其容器、但能解码其编码的文件做 ffmpeg 流复制，在关键帧处跳转。两者都在[文件夹片源](../../implemented/feature/2026-10-26-folder-source.zh.md)里定下，即节点磁盘上文件的 `local` Input。
- **WebDAV 片源插件**：按地址配置。它的文件要通过 HTTP 读取，`local` Input 不涵盖这种情况：节点按需生成的 HLS 也要能读 http(s) 的 file Input，并用字节范围读取关键帧索引。
- **海报、简介和演职员**来自元数据插件，其接口以及官方插件（用户自己的文件、不需要 key 的数据库，以及可选的 TMDB 插件）在[元数据插件](../../implemented/architecture/2026-10-25-metadata-plugins.zh.md)里说明；文件夹和 WebDAV 片源实现它的 `file(source)`，让本地的 NFO 文件和图片也能用上。
- **同步到 D1 的片库目录**：节点离线时也能浏览和搜索。
- **节点的 Docker 镜像**：支持硬件加速转码，让节点以容器形式运行在 NAS 主机上。

NAS 上的文件通过**让节点靠近文件**来访问：节点用 Docker 跑在 NAS 上，或者把 NAS 的共享目录挂载到节点所在的机器。节点本身只额外支持 WebDAV。

**TMDB key** 的问题在[元数据插件](../../implemented/architecture/2026-10-25-metadata-plugins.zh.md#the-tmdb-key)里有了答案：大多数剧集不需要 key，而 TMDB 的许可不能转让，所以想用 TMDB 的用户自己免费申请一个 key。

## 曾考虑的替代方案

**在节点里实现 SMB 或 NFS 客户端。** Node 生态里的 SMB 库不成熟，而且 Plex 和 Jellyfin 也是靠运行在文件旁边或挂载共享目录来访问的。

**把 DLNA 作为片源。** DLNA 服务提供的元数据太少，撑不起片库。

## 验收标准

没有 Plex 的用户把 Yolo 指向一个 NAS 文件夹和一个 WebDAV 共享，然后浏览、搜索并播放带海报和简介的电影和剧集；节点离线时仍能浏览和搜索；节点的 Docker 镜像能在 NAS 上运行，并在 NAS 支持时用硬件加速转码；条目显示[元数据插件](../../implemented/architecture/2026-10-25-metadata-plugins.zh.md)为它们找到的详情。

## 风险

NAS 环境差别很大，文件名的边界情况很多，低端 NAS 的转码性能可能撑不住 720p 的流。把片库目录同步到 D1 会复制一份片库数据，需要一条与节点视角冲突时的处理规则。每个用户自己的 TMDB key 给每次安装多了一个可选步骤。
