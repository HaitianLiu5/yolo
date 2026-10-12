import { isHttpUrl } from "@useyolo/core";

// Drive-In's saved data in Yolo's terms, for the one-time export
// (export.js). Drive-In knew two kinds of items: Plex library items by
// ratingKey, and web videos by URL. They become the official Plex plugin's
// Sources ({ plugin: "plex", id }) and unclaimed { url }s that the node's
// source plugins claim. Each function returns a Source, an unclaimed { url },
// or null to skip.

// The source id of the official Plex plugin (plugins/source-plex).
const PLEX_SOURCE = "plex";

const plexSource = (ratingKey) => ({ plugin: PLEX_SOURCE, id: String(ratingKey) });

// A row of the Drive-In queue_items or playlist_items table.
export function sourceFromDriveInRow(row) {
  if (row.source_type === "plex" || row.rating_key) return row.rating_key ? plexSource(row.rating_key) : null;
  return isHttpUrl(row.url) ? { url: row.url.trim() } : null;
}

// An entry of .play-history.json.
export function sourceFromDriveInHistory(entry) {
  if (entry.plex?.ratingKey) return plexSource(entry.plex.ratingKey);
  return isHttpUrl(entry.url) ? { url: entry.url.trim() } : null;
}

// Drive-In thumbnails point at the old server's proxy routes. Library items
// get the control plane's artwork route; web thumbnails keep their original
// URL.
export function thumbnailFromDriveIn(thumbnail, source) {
  if (!thumbnail) return null;
  if (source?.plugin === PLEX_SOURCE) return `/v1/library/items/${encodeURIComponent(`${PLEX_SOURCE}:${source.id}`)}/artwork?variant=landscape`;
  if (thumbnail.startsWith("/api/thumb?")) return new URLSearchParams(thumbnail.split("?")[1]).get("url");
  return isHttpUrl(thumbnail) ? thumbnail : null;
}

// A row of Drive-In's subtitle_preferences: { source, selection }, where
// source is "default", "plex:<ratingKey>" or a page URL. Returns { ref,
// selection } with ref "default", a Source or { url }, or null to skip.
export function preferenceFromDriveIn(row) {
  let tracks;
  try {
    tracks = JSON.parse(row.selection);
  } catch {
    return null;
  }
  if (!Array.isArray(tracks)) return null;
  const key = String(row.source ?? "");
  const ref = key === "default" ? "default"
    : key.startsWith("plex:") ? plexSource(key.slice(5))
      : isHttpUrl(key) ? { url: key } : null;
  if (!ref) return null;
  const plex = ref !== "default" && ref.plugin === PLEX_SOURCE;
  return {
    ref,
    selection: {
      subtitles: tracks.map((track) => ({
        id: plex ? `plex:${track.id}` : `s_${track.id}`,
        language: track.language || "",
        name: track.title || "",
        format: track.delivery === "external" ? "text" : "image",
      })),
      audio: null,
    },
  };
}
