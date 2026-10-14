import { DANMAKU_AREAS, DANMAKU_DENSITIES, DANMAKU_FONT_SIZES, DEVICE_KINDS, formatTimestamp } from "@useyolo/core";
import { z } from "zod";

// MCP tools (Agent Note 2026-10-07-remote-mcp-server). Annotations follow the
// table exactly: read tools are readOnly, deletions are destructive, everything
// else is marked non-destructive explicitly because MCP defaults
// destructiveHint to true.

// OAuth scopes (Agent Note 2026-10-07-oauth-authorization-server). Each tool
// needs exactly one.
export const SCOPES = Object.freeze(["read", "control", "manage"]);

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });

const url = z.string().describe("Web address of a video page or file, such as a link the user shared");
const itemId = z.string().describe("Library item id exactly as search or browse returned it, in the form \"<source>:<id>\"");
const queuePosition = z.enum(["next", "end"]).describe("\"next\" plays it after the current item; \"end\" appends");
const playlistId = z.string().describe("Playlist id from playlist_list");
const device = z.string().describe("Device name or id from list_devices. Omit to use the active device");
const insightItem = z.string().describe("Library item id or URL. Omit for what is playing now");
const language = z.string().describe("Subtitle language, such as \"en\" or \"zh\". Omit for the selected or best text track");
const subtitleTrack = z.string().describe("Subtitle track id from list_tracks or get_item; overrides language");
const time = z.union([z.number().min(0), z.string()]).describe("Seconds, or \"mm:ss\" or \"hh:mm:ss\"");
// Tools whose items carry a cover say how to show it
// (Agent Note 2026-10-07-remote-mcp-server).
const COVERS = " Each item's thumbnail is its cover image URL, which loads without signing in: show it as it is, such as ![title](thumbnail), and never invent one.";

// What get_frame returns (Agent Note 2026-10-13-video-frames): an MCP image
// content block, and the facts an agent needs to talk about it.
function framePresentation(frame) {
  const of = frame.duration ? ` of ${formatTimestamp(frame.duration)}` : "";
  const lines = [
    `${frame.title ? `"${frame.title}"` : "The video"} at ${formatTimestamp(frame.time, { millis: true })} (${Number(frame.time.toFixed(3))} s${of}).`,
    `Source: ${frame.plugin}, read from its ${frame.input === "cache" ? "segment the screen already loaded" : `${frame.input} stream`}; ${frame.width}x${frame.height} JPEG.`,
    frame.playing ? "This is the item playing now." : "This item is not the one playing now.",
  ];
  return [
    { type: "image", data: frame.image, mimeType: frame.mimeType },
    { type: "text", text: lines.join("\n") },
  ];
}

// What get_storyboard returns: one image block and the tiles' times in
// reading order.
function storyboardPresentation(board) {
  const clock = (seconds) => formatTimestamp(seconds, { millis: board.step < 1 });
  const missing = new Set(board.missing);
  const lines = [
    `${board.title ? `"${board.title}"` : "The video"}: ${board.count} frames from ${clock(board.from)} to ${clock(board.to)}, one every ${clock(board.step)}.`,
    `${board.origin === "storyboard" ? "From the source's own storyboard images, so each time is the nearest it has" : `Read by the media node from the ${board.input} stream`}; ${board.width}x${board.height} JPEG, ${board.columns} columns by ${board.rows} rows, each tile labelled with its time.`,
    `Times, left to right and top to bottom: ${board.times.map((time) => (missing.has(time) ? `${clock(time)} (no picture)` : clock(time))).join(", ")}.`,
    board.playing ? "This is the item playing now." : "This item is not the one playing now.",
  ];
  return [
    { type: "image", data: board.image, mimeType: board.mimeType },
    { type: "text", text: lines.join("\n") },
  ];
}

export const TOOLS = [
  {
    name: "get_status",
    title: "Get playback status",
    description: `What is playing now, on which device, the position, whether the home media node is online, whether remote direct play and the media relay are on, and what is up next.${COVERS}`,
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({}),
    run: (services) => services.status(),
  },
  {
    name: "list_devices",
    title: "List devices",
    description: "Screens that can play, such as the Yolo player in the car, with online and active flags.",
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({}),
    run: (services) => services.devices(),
  },
  {
    name: "rename_device",
    title: "Rename a device",
    description: "Set a screen's name or type, such as naming the car's browser \"Model Y\" with type car. A device only guesses these about itself.",
    scope: "manage",
    annotations: WRITE,
    input: z.object({
      device: z.string().describe("Device id or current name from list_devices"),
      name: z.string().min(1).max(100).optional().describe("New name"),
      kind: z.enum(DEVICE_KINDS).optional().describe("Device type"),
    }),
    run: (services, args) => services.renameDevice(args.device, { name: args.name, kind: args.kind }),
  },
  {
    name: "remove_device",
    title: "Remove a device",
    description: "Remove a paired screen, such as the car, and revoke its access. It can only play again after it is paired again and the owner approves it.",
    scope: "manage",
    annotations: DESTRUCTIVE,
    input: z.object({ device: z.string().describe("Device id from list_devices") }),
    run: (services, args) => services.deleteDevice(args.device),
  },
  {
    name: "search",
    title: "Search the library",
    description: `Search the media library (movies, shows, episodes) by title. If the query is a URL, resolve its title, duration and thumbnail instead. Use the returned ids with play, queue_add, or playlist_add.${COVERS}`,
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({
      query: z.string().min(1).describe("Title to search for, or a URL to look up"),
      type: z.enum(["movie", "show", "episode"]).optional().describe("Only return this kind of item"),
    }),
    run: (services, args) => services.search(args),
  },
  {
    name: "browse",
    title: "Browse the library",
    description: `Without arguments, list libraries. With library_id, list that library's items (newest first). With item_id, list a show's episodes or another item's children.${COVERS}`,
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({
      library_id: z.string().optional().describe("Library id from browse"),
      item_id: itemId.optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    run: (services, args) => services.browse({ libraryId: args.library_id, itemId: args.item_id, offset: args.offset, limit: args.limit }),
  },
  {
    name: "play",
    title: "Play",
    description: "Start playing a URL, a library item, or a queue item, replacing what is playing. Plays on the active device unless device is given. Resumes from the last saved position unless start_at is given.",
    scope: "control",
    annotations: WRITE,
    input: z.object({
      url: url.optional(),
      item_id: itemId.optional(),
      queue_item_id: z.string().optional().describe("Queue item id from queue_list; it is removed from the queue"),
      device: device.optional(),
      start_at: z.number().min(0).optional().describe("Start position in seconds"),
    }),
    run: (services, args) => services.play({
      url: args.url, itemId: args.item_id, queueItemId: args.queue_item_id, device: args.device, startAt: args.start_at,
    }),
  },
  {
    name: "control",
    title: "Control playback",
    description: "Pause, resume, or stop playback, or skip to the next queue item or the previous history item.",
    scope: "control",
    annotations: WRITE,
    input: z.object({ action: z.enum(["pause", "resume", "stop", "next", "previous"]) }),
    run: (services, args) => services.control(args.action),
  },
  {
    name: "seek",
    title: "Seek",
    description: "Jump to a position in the current item.",
    scope: "control",
    annotations: WRITE,
    input: z.object({ position_seconds: z.number().min(0) }),
    run: (services, args) => services.seek(args.position_seconds),
  },
  {
    name: "transfer",
    title: "Transfer playback",
    description: "Move playback to another device and continue from the same position. The previous device stops.",
    scope: "control",
    annotations: WRITE,
    input: z.object({ device: z.string().describe("Device name or id from list_devices") }),
    run: (services, args) => services.transfer(args.device),
  },
  {
    name: "list_tracks",
    title: "List subtitle and audio tracks",
    description: "Subtitle and audio tracks for the current item, or for item_id (a library item id or URL).",
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({ item_id: z.string().optional().describe("Library item id or URL; omit for the current item") }),
    run: (services, args) => services.listTracks(args.item_id ? { itemId: args.item_id } : {}),
  },
  {
    name: "set_tracks",
    title: "Choose subtitles and audio",
    description: "Choose subtitle and audio tracks for the current item using ids from list_tracks. Pass subtitles: [] to turn subtitles off. The choice is remembered for similar videos.",
    scope: "control",
    annotations: WRITE,
    input: z.object({
      subtitles: z.array(z.string()).max(4).optional().describe("Subtitle track ids; [] turns subtitles off"),
      audio: z.string().optional().describe("Audio track id"),
    }),
    run: (services, args) => services.setTracks(args),
  },
  // Understanding what plays (Agent Note 2026-10-07-remote-mcp-server): read
  // tools give compact answers, because agents pay for every token.
  {
    name: "get_item",
    title: "Item details",
    description: `Details of what is playing, or of item_id: title, description, people (cast and crew, or the channel), date, duration, genres, tags, ratings, season and episode, its subtitle and audio tracks, and the user's progress. Use it for "who is in this", "what is this about", or "how much is left".${COVERS}`,
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({ item_id: insightItem.optional() }),
    run: (services, args) => services.item({ itemId: args.item_id }),
  },
  {
    name: "get_transcript",
    title: "Read the transcript",
    description: "What is said in the item, from its text subtitles or captions, as \"m:ss text\" lines. Without from/to on the playing item it covers about a minute either side of the position: use it for \"what did they just say\". from_seconds 0 reads the whole item a page at a time; when a page is cut, call again with from_seconds set to nextFrom. Image subtitles are pictures and have no transcript.",
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({
      item_id: insightItem.optional(),
      from_seconds: z.number().min(0).optional().describe("Start of the range in seconds"),
      to_seconds: z.number().min(0).optional().describe("End of the range in seconds; omit for the end of the item, or of the page"),
      language: language.optional(),
      track: subtitleTrack.optional(),
      max_chars: z.number().int().min(500).max(20000).optional().describe("Page size in characters, default 6000"),
    }),
    run: (services, args) => services.transcript({
      itemId: args.item_id, from: args.from_seconds, to: args.to_seconds, language: args.language, track: args.track, maxChars: args.max_chars,
    }),
  },
  {
    name: "search_transcript",
    title: "Search the transcript",
    description: "Find where words are said in the item, from its text subtitles or captions: matching moments with at (seconds) for seek, so use it for \"go to where they talk about X\". It ignores case and accents, matches the whole phrase first, then all its words close together. Search for words someone would say; for a topic said in other words, read get_transcript.",
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({
      query: z.string().min(1).max(200).describe("Words to find"),
      item_id: insightItem.optional(),
      language: language.optional(),
      track: subtitleTrack.optional(),
      limit: z.number().int().min(1).max(50).optional().describe("Most matches to return, default 10"),
    }),
    run: (services, args) => services.searchTranscript({
      query: args.query, itemId: args.item_id, language: args.language, track: args.track, limit: args.limit,
    }),
  },
  {
    name: "get_chapters",
    title: "Chapters and markers",
    description: "The item's chapters and its intro and credits markers, each with start and end in seconds and a kind (chapter, intro, or credits), and for the playing item the chapter playing now. Use it for \"what is in this video\" or to seek to a chapter.",
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({ item_id: insightItem.optional() }),
    run: (services, args) => services.chapters({ itemId: args.item_id }),
  },
  {
    name: "get_frame",
    title: "Get a video frame",
    description: "A picture of a video at one moment, read from the source, not from a screen: what is on screen now, or what happens at a given time. Without arguments, the item playing now at its current position. For another item, pass item_id and a time. Returns a JPEG with the title, the exact time used, and the source.",
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({
      time: time.optional().describe("Seconds, or \"mm:ss\" or \"hh:mm:ss\". Omit for the current position of the item playing now"),
      item_id: insightItem.optional(),
      width: z.number().int().min(160).max(1920).optional().describe("Largest picture width in pixels; default 1280"),
    }),
    run: (services, args) => services.frame({ time: args.time, itemId: args.item_id, width: args.width }),
    present: framePresentation,
  },
  {
    name: "get_storyboard",
    title: "Get a storyboard",
    description: "Skim a video in one call: one image of evenly spaced frames in a grid, each labelled with its time, over the whole item or from..to. Without item_id, the item playing now. Uses the source's own storyboard images when it has them, else frames read from the source. Follow up with get_frame for a closer look at a moment.",
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({
      item_id: insightItem.optional(),
      from: time.optional().describe("Start of the range; default the start of the item"),
      to: time.optional().describe("End of the range; default the end of the item"),
      count: z.number().int().min(2).max(30).optional().describe("Number of frames; default 12"),
      width: z.number().int().min(80).max(480).optional().describe("Width of each tile in pixels; default 320"),
    }),
    run: (services, args) => services.storyboard({ itemId: args.item_id, from: args.from, to: args.to, count: args.count, width: args.width }),
    present: storyboardPresentation,
  },
  {
    name: "skip",
    title: "Skip the intro or a chapter",
    description: "Seek past the intro that is playing (to: intro), or to the next or previous chapter, from the playing item's chapters and markers. Use it for \"skip the intro\". It fails with not_found when there is no such marker or chapter, and says where the intro is. To skip end credits, use control with next.",
    scope: "control",
    annotations: WRITE,
    input: z.object({ to: z.enum(["intro", "next_chapter", "previous_chapter"]) }),
    run: (services, args) => services.skip(args.to),
  },
  {
    name: "get_playback_health",
    title: "Playback health",
    description: "Why playback stutters or looks soft on the active device, or on device: the stream's resolution, bitrate, and codec, the quality cap, the media path (lan, wan for remote direct play, or relay) and why the others failed, the buffer, measured throughput, recent stalls and stream rebuilds, the playback engine (canvas, or native for <video>), and short hints. Use it for \"why is it buffering\".",
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({ device: device.optional() }),
    run: (services, args) => services.playbackHealth({ device: args.device }),
  },
  {
    name: "get_comments",
    title: "Read viewer comments",
    description: "What viewers wrote at a moment of what is playing, or of item_id: the timed comments (danmaku) around `at` seconds, by default the current position, within 30 seconds. The same text said several times is one entry with a count n. Use it for \"what are people saying here\". An item without timed comments answers available: false.",
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({
      item_id: insightItem.optional(),
      at: z.number().min(0).optional().describe("Seconds into the item; defaults to the current position, or the start of another item"),
      window: z.number().min(1).max(120).optional().describe("Seconds of comments around `at` (default 30)"),
      limit: z.number().int().min(1).max(200).optional().describe("Most entries to return (default 60)"),
    }),
    run: (services, args) => services.comments({ itemId: args.item_id, at: args.at, window: args.window, limit: args.limit }),
  },
  {
    name: "set_danmaku",
    title: "Show or hide danmaku",
    description: "Turn danmaku (viewer comments that scroll over the picture) on or off on a screen, or change how they look. The screen keeps the setting for every video.",
    scope: "control",
    annotations: WRITE,
    input: z.object({
      device: device.optional(),
      enabled: z.boolean().optional().describe("Show danmaku"),
      density: z.enum(DANMAKU_DENSITIES).optional().describe("\"low\" shows about a third; \"normal\" all that fit without overlapping; \"high\" also those that fit after waiting up to 2 seconds for a lane; none overlap"),
      opacity: z.number().min(0.2).max(1).optional().describe("0.2 to 1"),
      area: z.enum(DANMAKU_AREAS).optional().describe("The part of the picture they use, from the top: the full picture (above the subtitles), the top half, or the top quarter"),
      font_size: z.enum(DANMAKU_FONT_SIZES).optional(),
    }),
    run: (services, args) => services.setDanmaku({
      device: args.device, enabled: args.enabled, density: args.density, opacity: args.opacity, area: args.area, fontSize: args.font_size,
    }),
  },
  {
    name: "queue_list",
    title: "List the queue",
    description: `Items waiting to play after the current one, in order.${COVERS}`,
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({}),
    run: (services) => services.listQueue(),
  },
  {
    name: "queue_add",
    title: "Add to the queue",
    description: "Add a URL or library item to the queue, at the end or to play next.",
    scope: "manage",
    annotations: WRITE,
    input: z.object({ url: url.optional(), item_id: itemId.optional(), position: queuePosition.optional() }),
    run: (services, args) => services.addToQueue({ url: args.url, itemId: args.item_id, position: args.position }),
  },
  {
    name: "queue_remove",
    title: "Remove from the queue",
    description: "Remove one item from the queue.",
    scope: "manage",
    annotations: DESTRUCTIVE,
    input: z.object({ queue_item_id: z.string().describe("Queue item id from queue_list") }),
    run: (services, args) => services.removeFromQueue(args.queue_item_id),
  },
  {
    name: "queue_clear",
    title: "Clear the queue",
    description: "Remove every item from the queue. Does not stop what is playing.",
    scope: "manage",
    annotations: DESTRUCTIVE,
    input: z.object({}),
    run: (services) => services.clearQueue(),
  },
  {
    name: "playlist_list",
    title: "List playlists",
    description: "Saved playlists with item counts.",
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({}),
    run: (services) => services.listPlaylists(),
  },
  {
    name: "playlist_get",
    title: "Show a playlist",
    description: `A saved playlist and its items.${COVERS}`,
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({ playlist_id: playlistId }),
    run: (services, args) => services.getPlaylist(args.playlist_id),
  },
  {
    name: "playlist_create",
    title: "Create a playlist",
    description: "Create an empty saved playlist.",
    scope: "manage",
    annotations: WRITE,
    input: z.object({ name: z.string().min(1).max(200), description: z.string().max(2000).optional() }),
    run: (services, args) => services.createPlaylist(args),
  },
  {
    name: "playlist_add",
    title: "Add to a playlist",
    description: "Add a URL or library item to the end of a saved playlist.",
    scope: "manage",
    annotations: WRITE,
    input: z.object({ playlist_id: playlistId, url: url.optional(), item_id: itemId.optional() }),
    run: (services, args) => services.addToPlaylist(args.playlist_id, { url: args.url, itemId: args.item_id }),
  },
  {
    name: "playlist_import",
    title: "Import a playlist",
    description: "Save an external playlist (the URL of a playlist on a video site) as a new playlist, optionally adding it to the queue.",
    scope: "manage",
    annotations: WRITE,
    input: z.object({
      url: z.string().describe("External playlist URL"),
      name: z.string().max(200).optional().describe("Name for the saved playlist; defaults to the source title"),
      enqueue: z.boolean().optional().describe("Also add every item to the end of the queue"),
    }),
    run: (services, args) => services.importPlaylist(args),
  },
  {
    name: "playlist_enqueue",
    title: "Queue a playlist",
    description: "Add every item of a saved playlist to the queue.",
    scope: "manage",
    annotations: WRITE,
    input: z.object({ playlist_id: playlistId, position: queuePosition.optional() }),
    run: (services, args) => services.enqueuePlaylist(args.playlist_id, { position: args.position }),
  },
  {
    name: "playlist_delete",
    title: "Delete a playlist",
    description: "Delete a saved playlist and its items.",
    scope: "manage",
    annotations: DESTRUCTIVE,
    input: z.object({ playlist_id: playlistId }),
    run: (services, args) => services.deletePlaylist(args.playlist_id),
  },
  {
    name: "history",
    title: "Watch history",
    description: `Recently played items, newest first, with the saved position for resuming.${COVERS}`,
    scope: "read",
    annotations: READ_ONLY,
    input: z.object({ limit: z.number().int().min(1).max(500).optional() }),
    run: (services, args) => services.history({ limit: args.limit }),
  },
];
