// @useyolo/plugin-api: the plugin API
// (Agent Note 2026-10-11-source-plugin-api). Experimental until Yolo 1.0: it
// may change incompatibly in any release before that.
//
// A plugin is an npm package whose package.json names its entry points:
//
//   "yolo": { "node": "./src/node.js", "control": "./src/control.js" }
//
// Either entry may be absent. Each entry is an ES module whose default export
// is a factory. Yolo calls it once with the API for that side, and the factory
// registers what the plugin provides:
//
//   /** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
//   export default function (yolo) {
//     yolo.registerSource("example", { claim: (url) => …, describe: (source) => … });
//   }
//
// A DNS provider plugin may also name a "setup" entry: a module, not a
// factory, that the operator's command line imports on the owner's machine
// to set the provider up (Agent Note 2026-10-14-dns-provider-plugins).
//
// Plugins list this package under peerDependencies. The host provides it, so
// every plugin shares the host's copy and its YoloError class.

export { isHttpUrl, YoloError } from "@useyolo/core";

/**
 * Where an item comes from. `plugin` is the source id that a source plugin
 * registered, and `id` names the item within that source. Other fields belong
 * to the plugin; Yolo stores them unchanged and never reads them.
 *
 * `<plugin>:<id>` is the item's source key, which history, resume positions
 * and track preferences are stored under. A plugin must therefore return the
 * same `id` for the same content every time.
 * @typedef {{ plugin: string, id: string, [field: string]: unknown }} Source
 */

/**
 * A Source as a source method returns it. Yolo sets `plugin` to the source's
 * own id, and turns a numeric `id` into a string.
 * @typedef {{ id: string | number, [field: string]: unknown }} SourceInput
 */

/**
 * A subtitle or audio track.
 * @typedef {object} Track
 * @property {string} id  Stable for the same item: saved track choices match on it.
 * @property {"subtitle" | "audio"} kind
 * @property {string} language  Language code or name, such as "en" or "chi".
 * @property {string} name
 * @property {boolean} [auto]  An automatic caption.
 * @property {"text" | "image"} [format]
 * @property {boolean} [default]
 */

/** @typedef {{ subtitles: Track[], audio: Track[] }} TrackList */

/**
 * Title and artwork for one item. Give the artwork either as `thumbnail`, an
 * absolute http(s) URL on the public internet (screens get it through the
 * node, which refuses other addresses), or as `artwork`, a variant name such
 * as "poster" or "landscape" that the source's own `artwork()` serves; Yolo
 * turns a variant into a control plane URL.
 * @typedef {object} Metadata
 * @property {string | null} title
 * @property {string | null} [thumbnail]
 * @property {string} [artwork]
 * @property {number | null} [duration]  Seconds.
 * @property {boolean} [isLive]
 */

/**
 * A library entry: a movie, show, season, episode, or anything a source lists.
 * `id` is local to the source; Yolo prefixes it as `<source id>:<id>`, and
 * playing the entry plays the Source `{ plugin: <source id>, id }`. Fields
 * other than `id` and `artwork` are passed through as they are.
 * @typedef {object} LibraryItem
 * @property {string} id
 * @property {string} kind  "movie", "show", "season", "episode", …
 * @property {string} title
 * @property {number | null} [duration]  Seconds. With the title, how Yolo
 *   finds an item again in `search` when the source stops knowing its id
 *   (Agent Note 2026-10-21-moved-library-items).
 * @property {string | null} [thumbnail]
 * @property {string} [artwork]  See Metadata.
 * @property {string[]} [parents]  The local ids of the library items this one
 *   belongs to, outermost first, at most two: an episode's show, then its
 *   season; a season's show. Yolo counts a show's and a season's episodes
 *   watched in Yolo by them (Agent Note 2026-10-11-yolo-owns-progress-and-resume).
 */

/** @typedef {{ id: string, title: string, type?: string }} Library */

/**
 * The run an item belongs to: every item in playing order, and the asked
 * item's place among them. Items take a `title`, `thumbnail` or `artwork`,
 * and `duration` as a Collection's do; a `title` the source does not know
 * is left out, and Yolo asks `describe()` when it shows that item next. A
 * `label` is the item's short place in the run, such as "S1 · E3" or "P3".
 * @typedef {object} Sequence
 * @property {string | null} [title]  The run's name, such as the show's.
 * @property {Array<{ source: SourceInput, title?: string, label?: string, thumbnail?: string | null, artwork?: string, duration?: number | null }>} items
 * @property {number} index  Where the asked item is in `items`.
 */

/**
 * A playlist or collection behind one URL.
 * @typedef {object} Collection
 * @property {string | null} [title]
 * @property {Array<{ source: SourceInput, title?: string, thumbnail?: string | null, duration?: number | null }>} items
 */

/**
 * A chapter of an item, or a marker a player may skip. Seconds from the start.
 * Yolo sorts them, drops entries without a usable start, with an end at or
 * before the start, or with another kind, and runs a chapter without an end
 * to the next chapter (or the item's end).
 * @typedef {object} Chapter
 * @property {number} start
 * @property {number | null} [end]
 * @property {"chapter" | "intro" | "credits"} [kind]  Default "chapter".
 * @property {string} [title]
 */

/**
 * What an agent may want to know about an item, in provider-neutral terms.
 * Every field is optional; fill what the provider knows. Yolo trims strings,
 * caps lists (20 people, 10 genres, 15 tags) and the description (1,500
 * characters), and drops fields it does not know.
 * @typedef {object} Details
 * @property {string} [title]
 * @property {string} [kind]  "movie", "episode", "show", "video", "live", …
 * @property {string} [description]  Summary or description, plain text.
 * @property {string} [date]  Release or upload date: "YYYY-MM-DD", "YYYYMMDD", or an ISO date-time.
 * @property {number} [year]
 * @property {number} [duration]  Seconds.
 * @property {Array<{ name: string, role?: string, character?: string }>} [people]
 *   Cast and crew, or who published it: role "cast" (the default), "director", "writer", "producer",
 *   "channel", "uploader", "artist", … The most important first.
 * @property {string[]} [genres]
 * @property {string[]} [tags]
 * @property {Array<{ value: number, max?: number, source?: string }>} [ratings]  Such as { value: 8.1, max: 10, source: "audience" }.
 * @property {string} [contentRating]  Such as "PG-13" or "TV-MA".
 * @property {{ title?: string, season?: number, episode?: number, episodeTitle?: string }} [series]  For an episode.
 * @property {string} [studio]
 * @property {string} [language]
 * @property {string} [url]  The item's public web page (http or https).
 * @property {Record<string, number>} [stats]  Counts such as { views, likes, comments }.
 * @property {{ position?: number, watched?: boolean }} [progress]  The source's own watch record, if it keeps one.
 */

/**
 * A timed comment (danmaku). Yolo drops comments without a time or text,
 * cuts text to 100 characters, and keeps at most 20,000 per answer.
 * @typedef {object} Comment
 * @property {number} t  Seconds from the start of the item.
 * @property {string} text  Plain text.
 * @property {"scroll" | "top" | "bottom"} [mode]  Scrolls right to left (the default), or stays at the top or bottom.
 * @property {string} [color]  "#rrggbb"; white by default.
 * @property {number} [size]  Relative to the normal size, 0.5 to 2; 1 by default.
 * @property {number} [weight]  The provider's rank of the comment, 0 to 10, higher for those its viewers
 *   want to see, such as Bilibili's; screens hide those below 3 at normal density.
 */

/**
 * The comments a source gives for one span. `start` and `end` (seconds, or
 * null for the item's end) say which span holds all its comments; they
 * default to the span asked for.
 * @typedef {{ comments: Comment[], start?: number, end?: number | null }} CommentWindow
 */

/**
 * What a source can do. Every method is optional; Yolo calls only what the
 * source implements, and only after the node has started the plugin.
 *
 * URLs go through the sources in registration order: `claim` and `expand`
 * return `undefined` to pass the URL to the next source, and the first
 * other answer wins. Keep `claim` cheap and offline (no network, no
 * subprocess): the control plane calls it before every play of a URL.
 * @typedef {object} SourceImpl
 * @property {() => object | Promise<object>} [health]  Free-form status for /internal/v1/health.
 * @property {(url: string) => SourceInput | undefined | Promise<SourceInput | undefined>} [claim]
 * @property {(url: string) => Promise<Collection | undefined>} [expand]
 * @property {(source: Source) => Promise<Metadata>} [describe]
 * @property {(source: Source) => Promise<TrackList>} [tracks]
 * @property {() => Promise<Library[]>} [libraries]  Library ids are local, like item ids.
 * @property {(libraryId: string, page: { offset: number, limit: number }) => Promise<{ total?: number | null, offset?: number, items: LibraryItem[] }>} [items]
 * @property {(itemId: string) => Promise<{ parent?: LibraryItem, items: LibraryItem[] }>} [children]
 * @property {(query: string, options: { type: string | null, limit: number }) => Promise<LibraryItem[]>} [search]
 * @property {(itemId: string, variant: string) => Promise<Response>} [artwork]  An image response.
 * @property {(source: Source, context: PrepareContext) => Promise<StreamDescriptor>} [prepare]
 *   Resolve an item into something the node's media pipeline can serve. Called
 *   for every playback, seek-restart and recovery; may take tens of seconds.
 * @property {(source: Source, context: { capabilities: object, viewport: object | null, limits: { maxVideoKbps: number }, network: "lan" | "tunnel" }) => Promise<void>} [warm]
 *   Resolve ahead for a device whose home screen offers this item first, with what its `prepare`
 *   context would hold, so that a `prepare` soon after needs less time. Start no session and nothing
 *   the source must stop; Yolo runs one at a time, in the background, and ignores failures.
 * @property {(source: Source) => Promise<Sequence | null>} [sequence]
 *   The run the item belongs to, in playing order: a show's episodes across its seasons, a
 *   multi-part video's parts, the playlist its URL names. Yolo plays the next one when the item
 *   ends and the queue is empty, and shows it before then (Agent Note 2026-10-23-up-next). Null
 *   when the item belongs to none. Called once for each item that starts, in the background; keep
 *   it to one request where the provider allows. Without it, nothing follows an item but the queue.
 *
 * What agents read about an item (optional; each has a fallback):
 * @property {(source: Source, trackId: string) => Promise<string | { pending: true, retryAfter?: number }>} [subtitle]
 *   WebVTT text of one of `tracks()`' text subtitles when the item is not playing, for transcripts.
 *   While the item plays, Yolo reads the stream descriptor's `subtitle(trackId)` instead, except for
 *   a growing track, whose whole text comes from here. Without it, a transcript of an item that is
 *   not playing, or of a growing track, says the source offers none. While the site limits the
 *   subtitle, it throws a YoloError `rate_limited` with `details.retryAfter` (seconds).
 * @property {(source: Source) => Promise<Chapter[] | { chapters: Chapter[], duration?: number }>} [chapters]
 *   Chapters and intro and credits markers. Without it, an item has none.
 * @property {(source: Source) => Promise<Details>} [details]
 *   Description, people, dates, genres, ratings, and the like. Without it, Yolo gives what
 *   `describe()` returns.
 * @property {(source: Source) => Promise<Storyboard | null>} [storyboard]
 *   Storyboard images the source already has, such as a site's thumbnail sprites, for an agent's
 *   contact sheet; null when it has none. Offer it only when it is cheaper than reading frames of the
 *   video. Without it, or when it fails or is slow, Yolo reads frames of the video itself
 *   (Agent Note 2026-10-13-video-frames).
 *
 * What screens draw over the picture (optional):
 * @property {(source: Source, range: { start: number, end: number }) => Promise<CommentWindow | null>} [comments]
 *   Timed comments (danmaku) from `start` seconds: null when the item has none, else the comments of
 *   the span the answer covers completely, at least the part from `start`, such as one segment the
 *   provider serves or the whole item. The node keeps answers per item, so a source never caches
 *   them itself. Without it, an item has no comments (Agent Note 2026-10-13-danmaku).
 */

/**
 * A source's own storyboard: sprite sheets of thumbnails in time order. Each sheet is one image of
 * `columns` × `rows` tiles of `tileWidth` × `tileHeight` pixels, read left to right and top to
 * bottom, covering `duration` seconds from `start`, one tile every `interval` seconds (default
 * duration / tiles). `headers` go with the image request.
 * @typedef {{ title?: string, duration?: number, sheets: Array<{ url: string, headers?: Record<string, string>,
 *   start: number, duration: number, columns: number, rows: number, tileWidth: number, tileHeight: number,
 *   interval?: number }> }} Storyboard
 */

/**
 * What the device that will play can do
 * (Agent Note 2026-10-07-capability-negotiation). The Tesla canvas player is
 * one such profile. @typedef {object} Capabilities @property {string} renderer
 * "canvas-webcodecs", "html5-video", "native" or "external". @property
 * {string[]} delivery  Stream types the device reads: "hls", "mp4". @property
 * {string[]} containers  Progressive file containers it plays as they are,
 * such as "mp4". @property {string[]} video  Preferred video codecs first,
 * such as "avc1", "hvc1". @property {string[]} audio  Preferred audio codecs
 * first, such as "mp4a", "ac-3". @property {number} maxHeight  Largest useful
 * picture height. @property {"client-vtt" | "native-vtt" | "burn-in"}
 * subtitles  How text subtitles reach the screen. @property {boolean}
 * audioOnly
 */

/**
 * A source's original file in provider-neutral terms, for
 * PrepareContext.playable. Codec ids are the capabilities' ("avc1", "hvc1",
 * "vp09", "av01"; "mp4a", "mp3", "ac-3", "ec-3", "flac", "opus", "dts").
 * @typedef {object} MediaDescription
 * @property {string} [container]  "mp4", "webm", "mkv", …
 * @property {{ codec?: string, profile?: string, bitDepth?: number, hdr?: boolean, width?: number, height?: number } | null} [video]
 * @property {Array<{ codec?: string, channels?: number }>} [audio]  The audio the device would hear.
 * @property {number} [kbps]  The file's overall bitrate.
 */

/**
 * The second argument of prepare().
 * @typedef {object} PrepareContext
 * @property {Capabilities} capabilities
 * @property {{ width?: number, height?: number } | null} viewport  The device's last reported viewport.
 * @property {number | null} startTime  Seconds to start at, or null: Yolo has no saved position, so
 *   start where the source itself would resume (or at 0).
 * @property {"play" | "recovery" | "seek" | "quality" | "transfer" | "tracks" | "frame"} reason  "frame": no device
 *   plays; the node reads one picture at `startTime` itself (Agent Note 2026-10-13-video-frames), so the
 *   original file suits best, no subtitle is chosen, and stop() runs right after. A source should leave
 *   its own state alone (track selection, watch position) and start no work it does not need.
 * @property {{ maxVideoKbps: number }} limits  The video bitrate to stay under: the node's ceiling for
 *   the media path (LAN_MAX_VIDEO_KBPS on the LAN, WAN_MAX_VIDEO_KBPS on remote direct play,
 *   STREAM_MAX_VIDEO_BITRATE_KBPS on the relay), or the device's adaptive-quality cap when that is
 *   lower. When no format fits, pick the smallest one, not the best.
 * @property {"tunnel" | "lan"} network  How the device reaches the node: "lan" when it plays from the
 *   node's LAN listener on the home network, where the original file may play as it is
 *   (Agent Note 2026-10-12-lan-direct-play).
 * @property {(media: MediaDescription) => { decision: "direct" | "remux" | "audio" | "transcode", reasons: string[] }} playable
 *   Whether this device plays a file as it is ("direct", a `file` Input), needs only a new container
 *   ("remux") or new audio ("audio"), or a transcode, within `limits`.
 * @property {(available: { subtitles: Track[], audio: Track[] }) => { subtitles: string[], audio: string | null }} chooseTracks
 *   Applies the user's explicit choice or saved preferences to the item's tracks and returns the
 *   chosen track ids. `audio: null` means the source's default audio.
 */

/**
 * Where the media pipeline reads a stream from. Headers go with every
 * upstream request for this Input (and, for HLS, its playlists and segments).
 * `cacheKey(url)` may name what the bytes behind an upstream URL are, so
 * re-signed URLs of the same content share the node's disk cache; return null
 * when unsure. Byte ranges are added to it by Yolo.
 * @typedef {(
 *   { type: "file", url: string, headers?: Record<string, string>, cacheKey?: (url: string) => string | null, cache?: boolean,
 *     alternates?: string[] } |
 *   { type: "hls", url: string, headers?: Record<string, string>, cacheKey?: (url: string) => string | null, cache?: boolean,
 *     manifest?: string, maxBandwidth?: number, trimToStart?: boolean, transcoder?: boolean, live?: { parse: (body: string) => LiveIndex | null } } |
 *   { type: "split", video: SplitTrack, audio: SplitTrack, transcode?: boolean }
 * )} Input
 *
 * - `file`: one progressive file (MP4, WebM), read with byte ranges.
 * - `hls`: an HLS playlist. `manifest` is the master playlist's body when the source already fetched it
 *   (fetching it again could start a second transcode). `maxBandwidth` drops larger variants (bits/s).
 *   `trimToStart` drops placeholder segments before EXT-X-START. `transcoder` marks an upstream that
 *   answers 404 for segments it has not written yet: Yolo retries briefly and asks `health()`.
 *   `cache: false` keeps segments out of the disk cache. `live.parse` turns a DVR playlist into a
 *   LiveIndex so Yolo serves a bounded live window.
 * - `split`: separate video and audio MP4 files, joined into fMP4 HLS; `transcode` asks for ffmpeg.
 *
 * `alternates` (on `file` and on each split track) are other URLs of the same bytes, such as the
 * same signed path on a CDN's mirror hosts, in the order to try them when the node knows nothing
 * better. The node ranks them by how each host has served it lately, across sessions; reads a split
 * segment with hedged requests across them, resuming at the byte offset; and moves a `file` request
 * to the next one when it stalls, times out or fails. refresh() is only tried once all of them
 * refused the request.
 */

/**
 * @typedef {{ url: string, headers?: Record<string, string>, cacheKey?: (url: string) => string | null,
 *   codec?: string, width?: number, height?: number, fps?: number, kbps?: number, alternates?: string[] }} SplitTrack
 */

/**
 * A sequence-addressed live DVR playlist.
 * @typedef {object} LiveIndex
 * @property {number} mediaSequence
 * @property {number} latestSequence
 * @property {number} segmentDuration  Seconds.
 * @property {number} startedAt  Unix seconds of sequence 0.
 * @property {number} liveEdge  Unix seconds of the newest media.
 * @property {number} targetDuration
 * @property {(sequence: number) => string | null} segmentUrl
 */

/**
 * A subtitle or audio track of a prepared stream. `delivery` says how a subtitle reaches the
 * screen: "vtt" (Yolo serves `subtitle(id)` to the device) or "burn" (the source draws it into
 * the picture, so choosing it needs a new prepare). A `growing` "vtt" subtitle is one the source
 * is still making: a screen reads it again every few seconds for a window around its position,
 * which Yolo passes to `subtitle(id, window)`.
 * @typedef {Track & { delivery?: "vtt" | "burn", growing?: boolean }} StreamTrack
 */

/**
 * What prepare() resolves to. Only `input` is required.
 * @typedef {object} StreamDescriptor
 * @property {Input} input
 * @property {string | null} [title]
 * @property {number | null} [duration]  Seconds.
 * @property {boolean} [isLive]
 * @property {string | null} [thumbnail]
 * @property {string} [artwork]  As in Metadata.
 * @property {string[]} [parents]  As in LibraryItem: the show and season the item belongs to.
 * @property {number} [startTime]  Seconds the device should start at; defaults to 0.
 * @property {{ width?: number, height?: number, fps?: number, videoKbps?: number, audioKbps?: number, split?: boolean } | null} [profile]
 * @property {number} [maxVideoKbps]  A lower video bitrate cap than `limits.maxVideoKbps` that the
 *   source chose its formats under (for example because its upstream measured slow); the stream
 *   reports itself capped at it, so the device's adaptive quality can step up from there.
 * @property {{ subtitles: StreamTrack[], audio: StreamTrack[], selected: { subtitles: string[], audio: string | null } }} [tracks]
 * @property {(trackId: string, window: { start: number, end: number } | null) => Promise<string | { pending: true, retryAfter?: number }>} [subtitle]
 *   WebVTT text of a "vtt" subtitle, or `{ pending: true }` while it is still being prepared (Yolo
 *   answers 425 with Retry-After). For a `growing` track, `window` is the screen's window (seconds):
 *   answer the cues made so far in it and work on it next; with `null`, answer every cue made so
 *   far. Yolo never caches a growing track's answer. While the site limits the subtitle, it throws a
 *   YoloError `rate_limited` with `details.retryAfter` (seconds), which Yolo answers 429 with
 *   Retry-After.
 * @property {() => Promise<Input>} [refresh]  Fresh upstream URLs when the old ones expire or are denied.
 * @property {() => Promise<"alive" | "expired" | "unknown">} [health]  Is the upstream session still there?
 * @property {(report: { position: number, duration: number | null, status: string }) => Promise<void>} [progress]
 *   Playback progress, about every 30 seconds while playing (write it back to the source if it keeps one).
 * @property {() => Promise<void>} [stop]  Release upstream resources (a transcode). May run more than once.
 */

/**
 * @typedef {object} PluginInfo
 * @property {string} name  The package name.
 * @property {string | null} version
 */

/**
 * Prefixes every line with the plugin's name.
 * @typedef {{ debug: Function, info: Function, warn: Function, error: Function }} Logger
 */

/**
 * The API a node entry's factory receives. Register everything while the
 * factory runs. Do not start processes, sockets, timers or watchers in the
 * factory: start them in a "start" handler and release them in a "shutdown"
 * handler, which may run more than once and must not fail when nothing was
 * started.
 * @typedef {object} YoloNodeAPI
 * @property {PluginInfo} plugin
 * @property {Readonly<Record<string, unknown>>} options  The plugin's `options` from yolo.config.json, or {}.
 * @property {Readonly<Record<string, string | undefined>>} env  The node's environment, including the repository .env.
 * @property {Logger} log
 * @property {string | null} cacheDir  A directory of this plugin's own for caches (created by the
 *   plugin when needed; Yolo may delete it). Null in tests that do not set one.
 * @property {typeof fetch} fetch  fetch() by the owner's egress rules
 *   (Agent Note 2026-10-13-node-egress-proxy): a host a rule matches goes through the proxies
 *   it lists, every other host direct. Use it for the plugin's own requests to a source.
 * @property {() => string | null} egressProxy  The node's HTTP proxy on 127.0.0.1, which applies
 *   the same rules to each connection, for a child process that makes its own requests (such
 *   as an extractor's proxy option); null when the owner has no egress rules. Ask on each run: it is set
 *   once the node has started.
 * @property {(id: string, impl: SourceImpl) => void} registerSource
 *   `id` is lowercase letters, digits and dashes, starts with a letter, and is
 *   unique on the node. It becomes the `plugin` field of this source's Sources.
 * @property {(id: string, impl: AgentImpl) => void} registerAgent
 *   `id` follows the source id rules. Screens ask the first agent registered on the node.
 * @property {(id: string, impl: TranscriberImpl) => void} registerTranscriber
 *   `id` follows the source id rules. AI subtitles use the first transcriber registered on the node.
 * @property {(id: string, impl: TranslatorImpl) => void} registerTranslator
 *   `id` follows the source id rules. AI subtitles use the first translator registered on the node.
 * @property {(id: string, impl: ProxyProviderImpl) => void} registerProxyProvider
 *   `id` follows the source id rules and is what yolo.config.json's egress.proxies name as `provider`.
 * @property {(event: "start" | "shutdown", handler: () => void | Promise<void>) => () => void} on
 *   Handlers run in plugin load order, then registration order. Returns a
 *   function that removes the handler.
 */

/**
 * What a person said or typed on one of the owner's screens
 * (Agent Note 2026-10-18-agent-from-the-screen). `device` is the screen that
 * asked, which plays by default; null when the request came from elsewhere.
 * `playing` is what plays now: the item (a library id or URL, as Yolo's tools take it), its
 * position and duration in seconds (duration null for a live stream), its status, and the
 * screen it plays on, which may not be the one that asked; null when nothing plays.
 * `session`, present when the request belongs to one of Yolo's conversations, is the agent's
 * session to continue, as an earlier `ask` resolved it, or null to start one; without it the
 * agent may keep its own memory.
 * @typedef {{ itemId: string, title: string | null, position: number, duration: number | null, status: string | null, device: { id: string, name: string } | null }} AgentPlaying
 * @typedef {{ text: string, device: { id: string, name: string } | null, playing?: AgentPlaying | null, language: string | null, session?: string | null }} AgentRequest
 */

/**
 * What an agent reports while it works, shown on the screen as it happens: a
 * tool it calls (Yolo's MCP tools by their own names, such as "search"), or
 * words it writes on the way.
 * @typedef {{ type: "tool", name: string } | { type: "text", text: string }} AgentEvent
 */

/**
 * An agent that acts on a screen's request, such as one the owner already
 * runs on the node's machine with its own MCP connection to Yolo. Yolo runs
 * one request at a time and aborts `signal` when a newer request replaces it
 * or the screen goes away; stop all work then.
 * @typedef {object} AgentImpl
 * @property {string} [title]  How screens name it.
 * @property {() => { available: boolean, reason?: string } | Promise<{ available: boolean, reason?: string }>} [health]
 *   Whether it can take a request now; `reason` says why not, for the owner.
 * @property {(request: AgentRequest, context: { signal: AbortSignal, emit: (event: AgentEvent) => void }) => Promise<{ text: string, session?: string | null }>} ask
 *   Does what was asked and resolves with one short sentence for the screen and the session a
 *   follow-up continues, such as the CLI's session id. Throws a YoloError
 *   whose message tells the owner what to fix, such as connecting the agent to Yolo.
 */

/**
 * A speech-to-text service for AI subtitles (Agent Note 2026-10-18-ai-subtitles),
 * such as a speech model the owner runs on a machine at home. Yolo sends one
 * stretch of an item's sound at a time, up to 30 seconds, and aborts `signal`
 * when it gives up waiting. Ask's voice input (Agent Note
 * 2026-10-18-agent-from-the-screen) sends a screen's recording the same way,
 * while someone waits for the words.
 * @typedef {object} TranscriberImpl
 * @property {string} [title]  How the owner sees it named.
 * @property {(request: { audio: Uint8Array, format: "wav", language: string | null, prompt: string | null, signal: AbortSignal }) =>
 *   Promise<{ language?: string | null, segments: Array<{ start: number, end: number, text: string }> }>} transcribe
 *   `audio` is 16 kHz mono 16-bit WAV. `language` is the spoken language when Yolo knows it, else null
 *   (detect it); `prompt` is the item's title and the words just before, to spell names. Resolves with
 *   the text in segments of a sentence or so, `start` and `end` in seconds from the start of `audio`,
 *   and the language heard as a BCP 47 tag when the service says. Leave out silence and noise
 *   rather than returning made-up words.
 */

/**
 * A text translator for AI subtitles (Agent Note 2026-10-18-ai-subtitles),
 * such as a language model the owner runs.
 * @typedef {object} TranslatorImpl
 * @property {string} language  The BCP 47 tag it translates into, such as "zh-Hans".
 * @property {string} [title]  How the owner sees it named.
 * @property {(request: { lines: string[], from: string | null, to: string, title: string | null, previous: string[], signal: AbortSignal }) => Promise<string[]>} translate
 *   Translates subtitle `lines` (spoken in `from`, null when unknown) into `to`, one output line per
 *   input line, in order. `title` and `previous`, the lines just before, are context, not to translate.
 */

/**
 * Where a proxy is now (Agent Note 2026-10-13-node-egress-proxy). `url` is an http:// or https://
 * proxy; credentials may be given apart or in the URL. The node asks for a new one shortly
 * before `expiresAt` (milliseconds since the epoch), and never logs the endpoint.
 * @typedef {object} ProxyEndpoint
 * @property {string} url
 * @property {string} [username]
 * @property {string} [password]
 * @property {number} [expiresAt]
 */

/**
 * A proxy provider for the node's egress rules: it only hands out endpoints, handles its own
 * sign-in and refresh, and never learns which requests use them.
 * @typedef {object} ProxyProviderImpl
 * @property {(options: Readonly<Record<string, unknown>>, context: { refused: boolean, failed: boolean }) => ProxyEndpoint | Promise<ProxyEndpoint>} endpoint
 *   `options` are the proxy's `options` in egress.proxies. `refused` is true when the proxy just
 *   refused the last endpoint's credentials; `failed` is true when the last endpoint's proxy
 *   could not be reached or could not open a tunnel (a 502, 503, or 504 to CONNECT), so a
 *   provider with more than one server can check it and hand out another. The node asks with
 *   `failed` at most once every 10 seconds per proxy. Throw (a YoloError) when there is none
 *   to give.
 */

/**
 * An MCP tool added by a control entry. It is served next to Yolo's own tools
 * under the same OAuth scopes.
 * @typedef {object} ToolDefinition
 * @property {string} name  lower_snake_case; must not clash with another tool.
 * @property {string} title
 * @property {string} description
 * @property {"read" | "control" | "manage"} scope  The one scope a token needs to call it.
 * @property {{ readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }} [annotations]
 *   Defaults to a write that is not destructive.
 * @property {object} input  A Standard Schema object schema, such as yolo.z.object({ … }).
 * @property {(args: object, context: { services: object }) => unknown | Promise<unknown>} run
 *   `context.services` is the service layer behind Yolo's own tools and the
 *   /v1 API. The return value is sent to the agent as JSON; a thrown YoloError
 *   becomes a tool error with its code.
 */

/**
 * The zone a DNS provider's names go under, as its `zone()` returns it. The
 * control plane keeps it in the media state and passes it back to every
 * other method; fields other than `id` and `name` belong to the provider,
 * which may update them (the state keeps the new values).
 * @typedef {{ id: string, name: string, [field: string]: unknown }} DnsZone
 */

/**
 * A DNS provider: the records the control plane keeps for the node's LAN and
 * remote names, `<label>.<zone>` (Agent Note 2026-10-14-dns-provider-plugins).
 * Every method throws a YoloError when it fails; never put the credential in
 * an error or a log line.
 * @typedef {object} DnsProvider
 * @property {(pageHost: string) => Promise<DnsZone>} zone  The zone the names go under, called once
 *   and kept. `pageHost` is the control plane's host, for a provider that finds its zone from it.
 * @property {(zone: DnsZone, name: string, type: "A" | "AAAA", address: string, options: { comment?: string }) => Promise<unknown>} setAddress
 *   Creates or moves the name's one record of that type: DNS-only, with a short TTL. A LAN name
 *   points at a private (RFC 1918) address.
 * @property {(zone: DnsZone, name: string, type: "A" | "AAAA") => Promise<unknown>} clearAddress
 *   Deletes it; succeeds when there is none.
 * @property {(zone: DnsZone, name: string, value: string) => Promise<unknown>} setTxt
 *   Sets the DNS-01 value at `name` (`_acme-challenge.<media name>`) and returns a handle for
 *   clearTxt. The control plane runs one certificate order at a time, under a lease, so a provider
 *   may replace any value already there, which also clears one an earlier removal left behind.
 * @property {(zone: DnsZone, name: string, value: string, handle: unknown) => Promise<void>} clearTxt
 *   Removes that value, or the name's TXT values with it.
 * @property {number} [settleMs]  How long the CA should wait after public DNS answers a new TXT
 *   value, for a provider whose authoritative servers catch up later; 0 by default, at most 5
 *   minutes. With a wait, the control plane asks a public resolver at most 4 times, 15 seconds
 *   apart, and names the node and orders its certificates only in its cron run, never while the
 *   owner waits on a check in settings, at most one certificate a run.
 */

/**
 * @typedef {object} DnsProviderDefinition
 * @property {string} [title]
 * @property {string} secret  The Worker secret that holds the provider's credential: in
 *   UPPER_SNAKE_CASE, starting with the provider's id (`my-dns` → `MY_DNS_TOKEN`), none of Yolo's own
 *   secrets, vars, or bindings, and no other provider's. Its value must be a string.
 * @property {(context: { token: string, zone: string | null, fetch: typeof fetch, sleep: (ms: number) => Promise<void> }) => DnsProvider | Promise<DnsProvider>} create
 *   Called on each run of the media names with the secret's value and the instance's
 *   media.dns.zone (null when unset). Make every request with `fetch` and wait with `sleep`.
 */

/**
 * The API a control entry's factory receives. Control entries are bundled
 * into the Worker when it is built, so they cannot be added at runtime.
 * @typedef {object} YoloControlAPI
 * @property {PluginInfo} plugin
 * @property {Readonly<Record<string, unknown>>} options
 * @property {Logger} log
 * @property {typeof import("zod").z} z  The host's zod, for tool input schemas.
 * @property {(tool: ToolDefinition) => void} registerTool
 * @property {(id: string, definition: DnsProviderDefinition) => void} registerDnsProvider
 *   `id` is lowercase letters, digits and dashes, not "cloudflare", which is built in; the
 *   instance's media.dns.provider chooses it.
 */

/**
 * @typedef {(yolo: YoloNodeAPI) => void | Promise<void>} NodePluginFactory
 * @typedef {(yolo: YoloControlAPI) => void | Promise<void>} ControlPluginFactory
 */
