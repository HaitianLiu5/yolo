import { api } from "./api.js";
import { physicalViewport } from "./display-scale.js";
import { hasNothingLeftToPlay } from "./playback-recovery.js";
import { playOnThisDevice, setShareStreams } from "./playback.js";
import { applyTracks, getPlaybackPosition, showStatus } from "./player.js";
import { state } from "./state.js";

// A share link's page, /s/<token> (Agent Note 2026-10-20-share-links): a
// friend the owner sent the link plays its one item here, without pairing.
// The page asks /v1/share/<token> for the item and the media paths a friend
// may try, and /v1/share/<token>/stream for each stream, which comes back
// in the answer as the `load` the realtime channel brings a paired screen,
// so the player plays, recovers, seeks, and changes quality as it does
// there. Nothing goes to the owner's Hub: no realtime channel, reports, or
// history. The friend's place is kept in this browser.

const POSITION_KEY = "yolo.share.";
const SAVE_EVERY_MS = 5_000;
const STREAM_TIMEOUT_MS = 90_000;

function savedPosition(token) {
  try {
    const saved = JSON.parse(localStorage.getItem(`${POSITION_KEY}${token}`) || "null");
    return Number(saved?.position) > 0 ? saved : null;
  } catch {
    return null;
  }
}

function savePosition(token, position, duration) {
  try {
    localStorage.setItem(`${POSITION_KEY}${token}`, JSON.stringify({ position, duration, at: Date.now() }));
  } catch {
    // Private mode: the place lives for this page only.
  }
}

/**
 * Plays the shared item. `profile` is this browser's (profile.js), `paths`
 * the media path controller (media-paths.js), and `onLoad(message)` plays a
 * stream as a `load` message would (main.js).
 */
export async function startShare({ token, profile, paths, onLoad }) {
  document.documentElement.dataset.share = "";
  showStatus("Loading…");
  let info;
  try {
    info = await api(`/v1/share/${encodeURIComponent(token)}`, { label: "Shared video", retries: 1 });
  } catch (error) {
    showStatus(error.status === 404 || error.status === 410 ? error.message : `This video could not be opened: ${error.message}`);
    return;
  }
  document.title = `${info.item.title} · Yolo`;
  void paths.setPaths({ media: info.media }, "share");

  setShareStreams({
    async stream(body, label) {
      const message = await api(`/v1/share/${encodeURIComponent(token)}/stream`, {
        method: "POST",
        body: { ...body, capabilities: profile.capabilities(), viewport: physicalViewport() },
        timeoutMs: STREAM_TIMEOUT_MS,
        retries: 0,
        label,
      });
      onLoad(message);
      return { state: { sessionId: message.stream?.sessionId ?? null } };
    },
    // Text subtitles change on this page; anything that needs another
    // stream is the owner's to choose.
    async tracks({ subtitles, audio }) {
      if (audio !== undefined) throw new Error("The audio track of a shared video cannot be changed");
      if (subtitles) applyTracks(null, { ...state.tracks.selected, subtitles });
    },
  });

  setInterval(() => {
    if (!state.player || !state.sessionId || state.isLive) return;
    savePosition(token, getPlaybackPosition(), state.duration || info.item.duration || null);
  }, SAVE_EVERY_MS);

  const saved = savedPosition(token);
  const startTime = saved && !hasNothingLeftToPlay(saved.position, saved.duration) ? saved.position : 0;
  try {
    await playOnThisDevice({}, { startTime });
  } catch (error) {
    showStatus(error.message || "This video could not be played");
  }
}
