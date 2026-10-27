import { showPlaybackNotice } from "./controls.js";
import { state } from "./state.js";
import { loadSubtitleTrack, onGrowingSubtitleFailure, subtitleCues } from "./subtitles.js";
import { loadSubtitleTracks, subtitleFailureNotice } from "./subtitle-loading.js";

// The stream's subtitle and audio tracks (state.tracks): the text subtitles
// Yolo selected load in the browser and draw over the picture (subtitles.js;
// a burned-in track is in the picture already, Agent Note
// 2026-10-07-capability-negotiation), and the system's fullscreen player
// gets them too. The menus that change them are track-menus.js's.

export const NO_TRACKS = Object.freeze({ subtitles: [], audio: [], selected: { subtitles: [], audio: null } });

let subtitlesShown = () => {};

/** `subtitlesShown(shown)` hears whether subtitles draw over the picture (the danmaku layer keeps clear of them). */
export function initTracks(deps) {
  ({ subtitlesShown } = deps);
}

/** Tracks after Yolo's `tracks` message: a new list with its selection, or a new selection of the same list. */
export function withTracks(current, tracks, selected) {
  if (tracks) return { ...tracks, selected: selected || tracks.selected || NO_TRACKS.selected };
  return selected ? { ...current, selected } : current;
}

// An AI track that stops reading says why once per stream, not on every poll.
const growingFailures = new Set();
onGrowingSubtitleFailure((trackId, message) => {
  const key = `${state.sessionId}:${trackId}`;
  if (growingFailures.has(key)) return;
  growingFailures.add(key);
  showPlaybackNotice(message);
});

// Each load supersedes the previous one's second round and notice.
let subtitleLoads = 0;

/**
 * The selected text subtitles of the stream on screen. The stream waits for
 * the first round only; a track the node asked to try again later loads in
 * the background, and the notice names the tracks that never loaded
 * (subtitle-loading.js).
 */
export async function loadSelectedSubtitles() {
  const selected = new Set(state.tracks.selected?.subtitles || []);
  const tracks = state.tracks.subtitles.filter((track) => selected.has(track.id) && track.url);
  const origin = state.mediaOrigin || location.origin;
  subtitlesShown(tracks.length > 0);
  const load = subtitleLoads += 1;
  const { player, sessionId } = state;
  const current = () => load === subtitleLoads && state.sessionId === sessionId && (!player || state.player === player);
  // The same subtitles for the system's fullscreen player (the <video>
  // engine on iPhone), where Yolo's overlay cannot show. A burned-in track is
  // in the picture already.
  const setCaptions = () => state.player?.setCaptions?.(state.tracks.subtitles
    .filter((track) => selected.has(track.id) && track.delivery !== "burn")
    .map((track) => ({ id: track.id, label: track.name || track.language || "", language: track.language || "", cues: subtitleCues(track.id) })));
  const { later } = await loadSubtitleTracks(tracks, {
    load: (track) => loadSubtitleTrack(track.id, new URL(track.url, origin).href, { growing: track.growing === true }),
    wait: (ms) => new Promise((done) => setTimeout(done, ms)),
    current,
    loadedLater: setCaptions,
  });
  setCaptions();
  void later.then((never) => {
    const notice = current() ? subtitleFailureNotice(never) : null;
    if (notice) showPlaybackNotice(notice);
  });
}
