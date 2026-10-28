import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { YoloError } from "@useyolo/plugin-api";
import { createPlayback, normalizeVideoBitrate } from "./playback.js";
import { createPlex } from "./plex.js";

// Official source plugin: a Plex Media Server library
// (Agent Note 2026-10-11-yolo-owns-progress-and-resume: Plex is an optional
// source; Yolo keeps its own history and progress).
//
// Options (yolo.config.json), each falling back to the environment:
//   url    PLEX_URL, else http://localhost:32400
//   token  PLEX_TOKEN, else on macOS the token Plex Media Server keeps in its
//          own preferences
//   videoBitrateKbps  PLEX_VIDEO_BITRATE_KBPS, 4000–4800, default 4800: the
//          car's fixed 720p transcode, which a <video> device also gets
//          under a limit below 8 Mbps (playback.js)
//
// Sources: { plugin: "plex", id: <ratingKey> }. Plex does not claim URLs.

export const SOURCE_ID = "plex";
const DEFAULT_URL = "http://localhost:32400";

function tokenFromPlexPreferences() {
  try {
    return execFileSync("defaults", ["read", "com.plexapp.plexmediaserver", "PlexOnlineToken"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch {
    return "";
  }
}

function readable(path) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// The source's methods over a client; `client()` throws until "start".
// `playback()` plays items (playback.js).
export function createPlexSource(client, playback = () => {
  throw new YoloError("resolve_failed", "Plex playback is not available");
}) {
  return {
    prepare: async (source, context) => playback().prepare(source, context),
    health: async () => client().health(),
    describe: async (source) => client().describe(source.id),
    tracks: async (source) => client().tracks(source.id),
    // What agents read (Agent Note 2026-10-07-remote-mcp-server).
    details: async (source) => client().details(source.id),
    // The file beside which metadata plugins read NFOs and pictures, only
    // when this machine has it (Agent Note 2026-10-25-metadata-plugins).
    file: async (source) => {
      const file = await client().file(source.id);
      return file && readable(file.path) ? file : null;
    },
    chapters: async (source) => client().chapters(source.id),
    // What plays after an episode (Agent Note 2026-10-23-up-next).
    sequence: async (source) => client().sequence(source.id),
    subtitle: async (source, trackId) => playback().subtitle(source.id, trackId),
    libraries: async () => client().libraries(),
    items: async (sectionKey, page) => client().libraryItems(sectionKey, page),
    children: async (ratingKey) => client().children(ratingKey),
    search: async (query, options) => client().search(query, options),
    artwork: async (ratingKey, variant) => client().artwork(ratingKey, variant),
  };
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function plexPlugin(yolo, { readToken = tokenFromPlexPreferences } = {}) {
  let plex = null;
  let playback = null;

  // Reading the token may run `defaults`, so it waits for "start".
  yolo.on("start", () => {
    const url = String(yolo.options.url || yolo.env.PLEX_URL || DEFAULT_URL);
    const token = String(yolo.options.token || yolo.env.PLEX_TOKEN || readToken() || "");
    plex = createPlex({ url, token });
    playback = createPlayback({
      plex,
      cacheDir: yolo.cacheDir ?? null,
      videoBitrate: normalizeVideoBitrate(yolo.options.videoBitrateKbps ?? yolo.env.PLEX_VIDEO_BITRATE_KBPS),
      logger: yolo.log,
    });
    if (!plex.configured) yolo.log.warn("No Plex token: set PLEX_TOKEN or the plugin's token option");
  });
  yolo.on("shutdown", () => {
    plex = null;
    playback = null;
  });

  const started = (value) => {
    if (!value) throw new YoloError("internal", "The Plex source has not started");
    return value;
  };
  yolo.registerSource(SOURCE_ID, createPlexSource(() => started(plex), () => started(playback)));
}
