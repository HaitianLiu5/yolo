# Agent Note: Folders on the node's machine as a source

Status: implemented

English | [中文](2026-10-26-folder-source.zh.md)

## Problem

Yolo's only sources were Plex and yt-dlp, so an owner whose films and shows sit on a disk or a NAS, without Plex, could not play them: a friend of the owner installed Plex only to try Yolo. The node could not read a local file at all, since an Input was always an http(s) URL ([media pipeline](../architecture/2026-10-11-node-media-pipeline.md)), and it had no remux of its own: Plex remuxes with its own direct stream ([LAN direct play](2026-10-12-lan-direct-play.md)). Most files in such a library are Matroska, which no browser's `<video>` element and not the car's canvas engine take as it is, often with AC-3 or DTS audio, and with subtitles in files beside the video, frequently in GB18030.

## Decision

`plugins/source-folder` lists and plays the video files under folders on the node's machine, and the node's core gains a `local` Input that serves a file from its own disk, as it is or as HLS that ffmpeg copies or transcodes on demand. It is in the default plugin list and does nothing until the owner names folders. WebDAV, a catalog in D1, a Docker image, and one history for the same title on several sources remain in the [own library proposal](../../proposed/feature/2026-10-11-own-library-and-nas.md).

### The plugin

The folders are the plugin's `roots` option, else `FOLDER_ROOTS`, absolute paths separated by `:` (`;` on Windows), documented in `.env.example`. A NAS reaches the node as a share mounted on its machine, as the own library proposal decided. The folders' movies form one library and their shows another, since the home screen shows a library of movies and libraries of shows. The plugin scans the roots when the node starts, in the background, and again every `rescanMinutes` (30); listings wait for the first scan. It skips hidden folders, a NAS's own (`@eaDir`, `#recycle`), extras and trailers, and samples under 300 MB.

A file is a movie or an episode by its name and the folders around it, read with the core's release-title parser, which the plugin API now exports as `parseReleaseTitle` ([metadata plugins](../architecture/2026-10-25-metadata-plugins.md)): it knows `S01E02`, `1x02`, `第1季第2集`, `EP02`, and a fansub's `- 02`. A file named only by a number is an episode of its folder's show; a season folder (`Season 1`, `S01`, `第一季`, `Specials`) gives the season and makes the folder above it the show; a file named only by tags (`movie.mkv`) takes its folder's name and year. Episodes with the same show name in a root form one show, which lists them in season and episode order and is their run for [what plays next](2026-10-23-up-next.md).

| Id | Names |
|---|---|
| `f-<root key>-<hash of the path below the root>` | A file: a movie or an episode. `<root key>` is 8 hex digits of a hash of the root's own path |
| `s-<root key>-<hash of the show's name>` | A show |

Library item ids are at most 128 letters, digits, and `._~-` ([`source.js`](../../../../service/core/src/source.js)), and a hash names no path, so an id cannot point outside the roots. It stays the same across scans and restarts; a file renamed or a share mounted elsewhere gets a new id, which the Hub's search by title and duration finds again ([moved library items](2026-10-21-moved-library-items.md)). An id the last scan does not know scans again, at most once a minute, so a file added since plays before the next scheduled scan. ffprobe reads each file once per path, size, and modification time, kept in the plugin's `cacheDir`, in the background after a scan so that listings carry durations.

Audio streams are the item's audio tracks when it has two or more. Subtitles are the files beside the video named after it (`Movie.chs.srt`), or every subtitle file in its folder and its `Subs` folder when it is the folder's only video, then the text streams inside it; image subtitles (PGS, VobSub) are not offered, since they would have to be burned in. A subtitle file is decoded by its byte order mark, else as UTF-8, else as GB18030 or Big5, whichever reads with fewer unknown characters; its name's tag (`chs`, `cht`, `chs&eng`, `eng`) or else its text gives its language. ffmpeg converts SRT and ASS to WebVTT; a stream inside the file is read out once into the cache, answering `{ pending }` meanwhile, since that reads the whole file. Artwork is a poster beside the file or in its show's folder, else a frame ffmpeg reads at a tenth of the file, kept in the cache.

A file is a `video` item, a copy whose work the metadata plugins name ([metadata plugins](../architecture/2026-10-25-metadata-plugins.md)): `file()` names it, so `metadata-local` reads the NFO files and pictures beside it, and its title is its reading in a release name's form, `Show S01E08` or `Film (2010)`, which `details()` gives with the year and an episode's series. Such a title carries what the folders said and reads clearly to the node's title parser, so the database plugins confirm it without a model call. Once a match is cached, listings show the file as its work, with the work's title, kind, series, and poster, and the work's still or poster in place of the file's own picture; a file not matched yet is listed by its own title and picture and queued. Shows are the plugin's own grouping and keep the kind `show`.

`prepare` returns `{ type: "local", path, audio }`, with `audio` the file's stream index of the chosen audio track, or null for its default. The plugin never decides how the file reaches a screen.

### The `local` Input

A source that may read local files implements `roots()`, the folders its `local` Inputs may come from. The source registry resolves the Input's path and the roots with their links and refuses with `forbidden` a file outside them, or any `local` Input from a source without `roots()`, so a link inside a root that points out of it does not play. `input.js` accepts only an absolute, normalized path.

The pipeline probes the file ([`local-file.js`](../../../../service/node/src/media/local-file.js)) and asks `playable()` with the device's capabilities and the path's limit:

| `playable()` and the file | Delivery |
|---|---|
| `direct`, with the file's first audio track | `mp4` from `/m/{token}/f/{n}`: the file by byte range from the disk |
| `direct` with another audio track, `remux`, or `audio`, and H.264 video | HLS of MPEG-TS segments from `/m/{token}/r/`, the video copied; AAC copied, other audio transcoded to stereo AAC |
| `transcode`, or video other than H.264 | The same HLS, the video transcoded to H.264 at the device's `maxHeight` and `limits.maxVideoKbps` |

MPEG-TS carries H.264 to hls.js, Safari's native HLS, and the canvas engine alike, which is why other codecs are transcoded even where the device decodes them.

### On-demand HLS

[`local-stream.js`](../../../../service/node/src/media/local-stream.js) gives a screen a VOD playlist of the whole file at once, so both engines seek anywhere in it as in any VOD stream, and ffmpeg makes the segments when a screen asks for them. Segment bounds are fixed by a plan before any job runs: for copied video, keyframes at least 6 seconds apart, read from the file's own index (an MP4's sample tables, a Matroska file's cues) in a few small reads, else from an ffprobe scan of every packet, kept on disk; for transcoded video, every 6 seconds, where the job forces keyframes. A job started at segment n seeks to its first keyframe, keeps the file's timestamps (`-copyts`), and gives the segment muxer the plan's later bounds counted from there, so any job writes the same segments with the same timestamps: a screen that seeks past what ffmpeg has made gets a new job and a seamless stream. Every timestamp is moved by 0.2 seconds so that no job writes a negative one, which MPEG-TS cannot carry and ffmpeg would otherwise shift by a different amount in each job; both engines read an offset that small as none.

A segment a running job will reach within 6 segments is waited for, up to 10 seconds; one behind the job's start or further ahead starts a new job there. A job runs at most 40 segments ahead of the screen, paused with `SIGSTOP` beyond that, and segments more than 8 behind are removed; a segment counts as made once the muxer's list names it, so a killed job's unfinished segment is never served. The session's directory is under `.hls-cache/` and goes with the session.

## Alternatives considered

**A playlist that grows as ffmpeg writes it**, as the split-file transcode does. hls.js treats a playlist without an end as live and starts at its edge, a native player shows no duration, and a seek past what is made has nowhere to go but a new stream from Yolo; a VOD playlist of fixed segments lets both engines seek as in any VOD stream.

**Segments of a fixed length cut by ffmpeg's HLS muxer, each job from where it starts.** Without the keyframes, a copied stream's cuts move with each job's first packet: segment n of a job started at 0 and of one started at n differ, a seek joins mismatched segments, and a keyframe interval longer than the segment leaves segments empty. Cutting at the file's own keyframes, from its index, costs a few small reads for MP4 and Matroska.

**Always transcode.** Simple and exact, but a 4K remux would cost a whole CPU on the owner's machine to play a file whose video the screen decodes; copying costs nothing.

**fMP4 segments.** They carry HEVC to Safari, but each job's init segment would have to be byte-identical across restarts, which ffmpeg does not promise; MPEG-TS segments stand alone.

**The plugin chooses direct, remux, or transcode itself**, as Plex does. Every local source would repeat the probe, the keyframe index, and the segmenter, and a plugin cannot serve HTTP or keep segments ([media pipeline](../architecture/2026-10-11-node-media-pipeline.md)); the core decides once for every source that names a file.

**A node-wide list of allowed folders.** The owner would name each folder twice, for the plugin and for the node; the source's own `roots()` keeps one list, and the node still checks every file against it with links resolved.

**The path below the root as the id.** It would be readable and need no index to play, but library item ids cannot carry slashes, spaces, or Chinese, and a path in an id is one more place to guard against `..`.

**The file name as the title.** The parser reads a release name, but `Show/Season 1/08.mkv` says only `08`; the folders' show and season would be lost and the file would cost a model call. The model still sees the file's own name beside the title.

**The file's own kind, `movie` or `episode`.** The node treats a source whose items are works as knowing them: it keeps the source's title and fields, only fills gaps, and never identifies its items for a listing, so a folder's grids would keep file-derived names and frames.

**One library for each folder**, holding its movies and shows. The home screen shows only libraries of movies and of shows, so a mixed one would never appear there.

**Watching the folders for changes.** File watchers on a mounted share are unreliable and costly on a large library; a rescan every 30 minutes, and one when an unknown id is asked for, cover new files.

## Consequences

An owner without Plex names folders and plays their films and episodes on every screen: an MP4 a browser plays goes as it is, on the LAN at the file's own bitrate, and a Matroska file plays through the stream copy at almost no CPU, with seeking anywhere. Subtitle files beside the video show in either engine, in GB18030 or Big5 too, and NFO files and posters reach the details through `metadata-local`.

It gives up some: an HEVC or VP9 file is transcoded even for a screen that decodes it; HDR video is transcoded without tone mapping and looks pale; image subtitles are not offered; a non-MP4, non-Matroska file's first copied play waits for ffprobe to read the whole file, and is transcoded instead if that fails; a seek far ahead waits for a new ffmpeg job, which on a slow NAS share may take a few seconds; a new file appears in listings only after the next scan. `FFMPEG_PATH` and `FFPROBE_PATH` name the tools, and other core uses of ffmpeg still run the one on `PATH`. Files are listed per folder, so the same film on Plex and on a folder has two histories until the catalog of the own library proposal joins them.

## Testing

[`local-media.test.js`](../../../../service/node/test/local-media.test.js) checks the `local` Input, the roots with links resolved, the segment plan and ffmpeg's arguments, and with ffmpeg real files: keyframes from an MP4's and a Matroska file's index against an ffprobe scan, an MP4 by byte range, a Matroska file as HLS whose segment from a job started in the middle equals the one from a job started at the beginning, and AC-3 audio transcoded. [`folder.test.js`](../../../../plugins/source-folder/test/folder.test.js) checks names, ids, titles the parser reads clearly, the scan, subtitle files and their encodings, listings, tracks, and the Input against a fake ffprobe; `local-media.test.js` also lists a folder's file through `metadata-local` as the work its NFO names, with the poster beside it as its picture. The end-to-end tests play a folder's MP4 and Matroska episode in the `<video>` engine with the subtitle file over the picture and a seek ([`web-playback.test.js`](../../../../test/e2e/web-playback.test.js)), and in the car's canvas engine ([`car-playback.test.js`](../../../../test/e2e/car-playback.test.js)).
