import { state } from "./state.js";
import { h } from "./dom.js";
import { setTracks } from "./playback.js";
import { showStatus } from "./player.js";

// The player's subtitle and audio menus: their choices, drawn from the
// tracks Yolo sent (state.tracks), with the chosen ones checked. controls.js
// opens and closes them; a choice goes to Yolo, which saves it for the item
// and sends the tracks again.

const btnSubs = document.getElementById("btn-subs");
const subsPanel = document.getElementById("subs-panel");
const subsList = document.getElementById("subs-list");
const btnAudio = document.getElementById("btn-audio");
const audioPanel = document.getElementById("audio-panel");
const audioList = document.getElementById("audio-list");

// A language's name in that language ("中文", "English", "日本語"), or "".
function nativeLanguageName(tag) {
  if (!tag || /^und\b/i.test(tag)) return "";
  try {
    const name = new Intl.DisplayNames([tag], { type: "language" }).of(tag);
    return name && name !== tag ? name.charAt(0).toLocaleUpperCase(tag) + name.slice(1) : "";
  } catch {
    return "";
  }
}

// One choice in a menu: pressed while it is chosen, which the check mark
// shows (style.css).
function choice({ label, detail = null, chosen, onChoose }) {
  return h("button", {
    type: "button",
    "aria-pressed": String(chosen),
    onclick: (event) => {
      event.stopPropagation();
      onChoose();
    },
  }, label, detail ? h("small", {}, detail) : null);
}

// The source's name for the track, else its language's own name; a
// machine-made track carries an AI badge rather than words in its name.
function subtitleLabel(track) {
  const name = track.name || nativeLanguageName(track.language) || track.language || "Unknown";
  return h("span", {}, name, track.auto ? h("span", { class: "track-ai", "aria-label": "automatic" }, "AI") : null);
}

export function updateSubsUI() {
  const subtitles = state.tracks.subtitles || [];
  if (!subtitles.length) {
    btnSubs.classList.add("hidden");
    subsPanel.classList.add("hidden");
    return;
  }
  btnSubs.classList.remove("hidden");
  const selected = new Set(state.tracks.selected?.subtitles || []);
  btnSubs.classList.toggle("active", selected.size > 0);
  // Text tracks can be shown together (two languages at once); a burned-in
  // track replaces whatever else is shown.
  const toggle = (track) => {
    if (track.delivery !== "vtt" || [...selected].some((id) => subtitles.find((t) => t.id === id)?.delivery !== "vtt")) {
      chooseSubtitles(selected.has(track.id) ? [] : [track.id]);
      return;
    }
    const next = new Set(selected);
    if (next.has(track.id)) next.delete(track.id);
    else next.add(track.id);
    chooseSubtitles([...next]);
  };
  subsList.replaceChildren(
    h("div", { class: "track-heading" }, "Subtitles"),
    choice({ label: h("span", {}, "Off"), chosen: !selected.size, onChoose: () => chooseSubtitles([]) }),
    ...subtitles.map((track) => choice({ label: subtitleLabel(track), chosen: selected.has(track.id), onChoose: () => toggle(track) })),
  );
}

let trackRequest = 0;

// The choice is Yolo's: it saves it for this item (and as the default for
// the next), then sends `tracks` (or a new stream when the picture changes).
async function chooseSubtitles(ids) {
  subsPanel.classList.add("hidden");
  const request = ++trackRequest;
  try {
    await setTracks({ subtitles: ids });
  } catch (error) {
    if (request !== trackRequest) return;
    showStatus(`Could not change subtitles: ${error.message}`);
  }
}

// Audio renditions inside the stream itself (an HLS playlist's), which the
// <video> engine switches without a new stream; only when the source lists
// no audio tracks of its own (Agent Note 2026-10-12-two-playback-engines).
function updateRenditionUI(renditions) {
  btnAudio.classList.remove("hidden");
  audioList.replaceChildren(...renditions.map((rendition) => choice({
    label: h("span", {}, rendition.name || rendition.language || "Unknown"),
    chosen: Boolean(rendition.active),
    onChoose: () => {
      audioPanel.classList.add("hidden");
      state.player?.selectAudioRendition?.(rendition.id);
      updateAudioUI();
    },
  })));
}

export function updateAudioUI() {
  const tracks = state.tracks.audio || [];
  const hasTrackSelection = tracks.length > 1;
  const renditions = !tracks.length ? state.player?.audioRenditions?.() || [] : [];
  if (renditions.length > 1) {
    updateRenditionUI(renditions);
    return;
  }

  // The button opens a list to choose from: with one track there is nothing
  // to choose, so it stays hidden.
  if (!hasTrackSelection) {
    btnAudio.classList.add("hidden");
    audioPanel.classList.add("hidden");
    return;
  }
  btnAudio.classList.remove("hidden");

  const active = state.tracks.selected?.audio ?? tracks.find((track) => track.default)?.id ?? null;
  audioList.replaceChildren(...tracks.map((track) => choice({
    label: h("span", {}, track.name || track.language || "Unknown"),
    detail: track.detail,
    chosen: String(active) === String(track.id),
    onChoose: () => {
      audioPanel.classList.add("hidden");
      setTracks({ audio: track.id }).catch((error) => showStatus(`Could not change audio: ${error.message}`));
    },
  })));
}
