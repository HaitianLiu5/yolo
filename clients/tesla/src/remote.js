import { api } from "./api.js";
import { artworkImage, hydrateArtwork, landscapeArtwork } from "./artwork.js";
import { h, icons } from "./dom.js";
import { livePosition, transferTargets } from "./play-target.js";
import { state } from "./state.js";

// Yolo as a remote (Agent Note 2026-10-11-yolo-web-client), as Spotify
// Connect does it: while another device plays, the home screen shows a
// now-playing bar with what plays and where, its transport controls, and a
// device picker that moves playback, to this browser too when it can play.
// Every command goes to Yolo over /v1 with this device's credential; the bar
// only reads the Hub's broadcasts (`state`, `devices`, `queue`) and never
// answers them.
//
// The bar shows this device's own item too after the owner went Back from
// the player: Yolo keeps it paused at its position
// (Agent Note 2026-10-11-yolo-owns-progress-and-resume), and its play
// button, or a tap on the bar, plays it here again.

const ACTIVE = new Set(["playing", "paused", "loading", "buffering"]);
const SKIP_BACK_SECONDS = 10;

/**
 * @param {object} options
 * @param {HTMLElement} options.bar  #now-playing
 * @param {HTMLDialogElement} options.picker  #device-picker
 * @param {object} options.profile  profile.js
 * @param {(message: string) => void} options.notify  a short notice
 * @param {(ref: object) => void} options.play  plays an item on this device (browse.js)
 */
export function createRemote({ bar, picker, profile, notify, play }) {
  const art = bar.querySelector(".np-art");
  const title = bar.querySelector(".np-title");
  const where = bar.querySelector(".np-device");
  const fill = bar.querySelector(".np-progress-fill");
  const toggle = bar.querySelector("#np-toggle");
  const back = bar.querySelector("#np-back");
  const next = bar.querySelector("#np-next");
  const devices = bar.querySelector("#np-devices");
  const list = picker.querySelector("#device-picker-list");
  const pickerTitle = picker.querySelector("#device-picker-title");
  let artworkUrl = null;
  let ticker = null;
  // While picking where a tapped item should play: the function that plays it.
  let pendingPlay = null;
  // While this device asks Yolo for its own item again: that item's session.
  let resuming = null;

  const selfName = () => (profile.car ? "This screen" : "This browser");
  const deviceName = (id) => (id === state.deviceId ? selfName() : (state.devices || []).find((device) => device.id === id)?.name ?? "another device");

  // What the bar shows: another device's item while it plays or is paused,
  // or this device's own item that the owner left with Back.
  function remoteState() {
    const hub = state.hub;
    if (!hub?.item || !hub.deviceId || !ACTIVE.has(hub.status)) return null;
    if (hub.deviceId !== state.deviceId) return hub;
    const left = hub.status === "paused" && hub.leftAt && hub.sessionId !== resuming && !state.player;
    return left ? hub : null;
  }

  const ownState = () => {
    const hub = remoteState();
    return hub?.deviceId === state.deviceId ? hub : null;
  };

  // This device's own item, where it was left; Yolo applies its tracks. The
  // bar steps aside meanwhile, so a second tap cannot ask twice.
  function resumeHere() {
    const hub = ownState();
    if (!hub) return false;
    resuming = hub.sessionId;
    update();
    void Promise.resolve(play({ source: hub.item.source, startTime: livePosition(hub) })).finally(() => {
      resuming = null;
      update();
    });
    return true;
  }

  async function command(path, { method = "POST", body, label } = {}) {
    try {
      await api(path, { method, body, label, retries: 0 });
    } catch (error) {
      notify(error.message || `${label} failed`);
    }
  }

  function paint() {
    const hub = remoteState();
    if (!hub) return;
    const position = livePosition(hub);
    const duration = Number(hub.item.duration) || 0;
    fill.style.transform = `scaleX(${duration > 0 && !hub.item.isLive ? Math.min(1, position / duration) : 0})`;
  }

  function update() {
    const hub = remoteState();
    document.getElementById("app")?.classList.toggle("has-now-playing", Boolean(hub));
    bar.classList.toggle("hidden", !hub);
    bar.classList.toggle("resumable", hub?.deviceId === state.deviceId);
    if (!hub) {
      clearInterval(ticker);
      ticker = null;
      if (picker.open && !pendingPlay) renderPicker();
      return;
    }
    title.textContent = hub.item.title || "Playing";
    const device = (state.devices || []).find((candidate) => candidate.id === hub.deviceId);
    where.replaceChildren(
      h("span", { class: "np-device-icon", html: icons.kind(device?.kind ?? "other", 16) }),
      h("span", { class: "np-verb" }, hub.status === "paused" ? "Paused on " : "Playing on "),
      h("strong", {}, deviceName(hub.deviceId)),
    );
    const thumbnail = landscapeArtwork(hub.item.thumbnail);
    if (thumbnail !== artworkUrl) {
      artworkUrl = thumbnail;
      art.innerHTML = artworkImage(thumbnail, { emptyClass: "np-art-empty", eager: true });
      hydrateArtwork(art);
    }
    const paused = hub.status === "paused";
    toggle.innerHTML = paused ? icons.play : icons.pause;
    toggle.setAttribute("aria-label", paused ? "Play" : "Pause");
    next.disabled = !(state.queue || []).length;
    back.disabled = Boolean(hub.item.isLive);
    paint();
    if (!ticker) ticker = setInterval(paint, 1000);
    if (picker.open && !pendingPlay) renderPicker();
  }

  toggle.addEventListener("click", () => {
    const hub = remoteState();
    if (!hub || resumeHere()) return;
    // Show the change at once; Yolo's `state` broadcast confirms it.
    const pausing = hub.status !== "paused";
    state.hub = { ...hub, status: pausing ? "paused" : "playing", position: livePosition(hub), positionAt: Date.now() };
    update();
    void command(`/v1/playback/${pausing ? "pause" : "resume"}`, { label: pausing ? "Pause" : "Play" });
  });
  back.addEventListener("click", () => {
    const hub = remoteState();
    if (hub) void command("/v1/playback/seek", { body: { position: Math.max(0, livePosition(hub) - SKIP_BACK_SECONDS) }, label: "Skip back" });
  });
  next.addEventListener("click", () => void command("/v1/playback/next", { label: "Next" }));
  devices.addEventListener("click", (event) => openPicker({ instant: event.detail === 0 }));
  bar.addEventListener("click", (event) => {
    if (!event.target.closest("button")) resumeHere();
  });

  // --- The device picker ----------------------------------------------------

  function renderPicker() {
    const hub = state.hub;
    const targets = pendingPlay?.choices ?? transferTargets({ devices: state.devices || [], self: state.deviceId, canPlay: profile.canPlay });
    pickerTitle.textContent = pendingPlay ? "Play on" : "Playing on";
    const rows = targets.map((device) => {
      const current = !pendingPlay && hub?.deviceId === device.id && ACTIVE.has(hub?.status);
      const self = device.id === state.deviceId;
      return h("li", {},
        h("button", {
          type: "button",
          class: `picker-row${current ? " current" : ""}`,
          "aria-current": current ? "true" : null,
          onclick: () => choose(device),
        },
        h("span", { class: "picker-icon", html: icons.kind(device.kind) }),
        h("span", { class: "row-title" }, self ? selfName() : device.name),
        current ? h("span", { class: "picker-check", html: icons.check }) : null));
    });
    if (!rows.length) {
      rows.push(h("li", { class: "picker-empty" }, "No screen that can play is online. Open Yolo in the car or on a computer."));
    }
    const footer = [];
    if (!pendingPlay && remoteState()) {
      footer.push(h("button", {
        type: "button",
        class: "picker-row",
        onclick: () => {
          closePicker();
          void command("/v1/playback/stop", { label: "Stop" });
        },
      }, h("span", { class: "picker-icon", html: icons.stop }), h("span", { class: "row-title" }, "Stop playing")));
    }
    list.replaceChildren(...rows);
    picker.querySelector(".picker-footer").replaceChildren(...footer);
  }

  async function choose(device) {
    const play = pendingPlay;
    closePicker();
    if (play) {
      await play.run(device.id);
      return;
    }
    if (state.hub?.deviceId === device.id) {
      // It is here already; left paused by Back, it plays again.
      resumeHere();
      return;
    }
    await command("/v1/playback/device", { method: "PUT", body: { deviceId: device.id }, label: "Move playback" });
  }

  function openPicker({ instant = false, play = null } = {}) {
    pendingPlay = play;
    picker.classList.toggle("instant", instant);
    renderPicker();
    if (!picker.open) picker.showModal();
  }

  function closePicker() {
    pendingPlay = null;
    if (picker.open) picker.close();
  }

  picker.addEventListener("cancel", (event) => {
    event.preventDefault();
    closePicker();
  });
  picker.addEventListener("click", (event) => {
    if (event.target === picker) closePicker();
  });
  picker.querySelector("#device-picker-close").addEventListener("click", closePicker);

  return {
    update,
    // Ask where a tapped item should play (a remote with several screens
    // online); `run(deviceId)` plays it there.
    pickForPlay(choices, run) {
      openPicker({ play: { choices, run } });
    },
    closePicker,
    // A remote's play for this device's own paused item: play it here.
    resumeHere,
  };
}
