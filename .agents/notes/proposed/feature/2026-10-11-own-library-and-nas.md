# Agent Note: Yolo's own library and NAS sources

Status: proposed

English | [中文](2026-10-11-own-library-and-nas.zh.md)

## Problem

Yolo's library model exists, but only the Plex plugin fills it, so an owner whose films sit on a NAS without Plex has no library at all. The library is also reachable only while the home node is online, and there is no metadata (posters, synopses, credits) apart from what Plex supplies. Yolo already owns progress ([progress and resume](../../implemented/feature/2026-10-11-yolo-owns-progress-and-resume.md)); the same decision makes Plex optional for the library too.

## Proposal

Version 0.5 gives Yolo its own library:

- **A folder source plugin** that scans directories, parses file names, and reads audio and subtitle tracks with ffprobe, and **the node's own remux**: an ffmpeg stream copy of a file whose container the device does not take but whose codecs it decodes, with seeking at keyframes. Both are decided in [folder source](../../implemented/feature/2026-10-26-folder-source.md), as the `local` Input of a file on the node's disk.
- **A WebDAV source plugin**, configured by address. Its files are read over HTTP, which the `local` Input does not cover: the node's on-demand HLS would also read an http(s) file Input, with byte ranges for the keyframe index.
- **Posters, synopses, and credits** from metadata plugins, whose interface and official plugins (the owner's files, keyless databases, and an optional TMDB one) are described in [metadata plugins](../../implemented/architecture/2026-10-25-metadata-plugins.md); the folder and WebDAV sources answer its `file(source)`, so local NFO files and pictures reach them.
- **A library catalog synced to D1**, so browsing and search keep working while the node is offline.
- **A Docker image of the node** with hardware-accelerated transcoding, so the node runs as a container on NAS hosts.

NAS files are reached by **keeping the node close to the files**: the node runs in Docker on the NAS, or the NAS shares are mounted on the machine where the node runs. The node itself adds only WebDAV.

**The TMDB key** is answered in [metadata plugins](../../implemented/architecture/2026-10-25-metadata-plugins.md#the-tmdb-key): most TV needs no key, and TMDB's licence cannot be shared, so an owner who wants TMDB registers a free key.

## Alternatives considered

**An SMB or NFS client inside the node.** Node's SMB libraries are immature, and Plex and Jellyfin also rely on running next to the files or on mounted shares.

**DLNA as a source.** DLNA servers provide too little metadata for a library.

## Acceptance criteria

An owner without Plex points Yolo at a NAS folder and a WebDAV share, then browses, searches, and plays films and series with posters and synopses; browsing and search still work while the node is offline; the node's Docker image runs on a NAS and transcodes with hardware acceleration where the NAS supports it; and items show the details that [metadata plugins](../../implemented/architecture/2026-10-25-metadata-plugins.md) find for them.

## Risks

NAS environments differ widely, file names have many edge cases, and transcoding performance on low-end NAS hardware may not hold a 720p stream. Syncing the catalog into D1 duplicates library data and needs a rule for conflicts with the node's view. Each owner's own TMDB key adds an optional step to every install.
