import { api, authHeaders, thisDeviceId } from "./api.js";
import { artworkImage, hydrateArtwork, landscapeArtwork } from "./artwork.js";
import { dismissible, h, icons } from "./dom.js";
import { livePosition, transferTargets } from "./play-target.js";
import { state } from "./state.js";
import { nextAvailable, share, subscribe } from "./store.js";
import { createWelcomeWait, WAIT_TIMED_OUT, waitTimedOut } from "./welcome-wait.js";

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
// button, or a tap on the bar, shows the player this screen kept and plays
// on in place, or plays the item here again with a new stream.
//
// Its picture is the paused frame: this screen's kept player's own, drawn
// when it was left, with no request; another device's paused item (or this
// screen's after a reload) gets one from Yolo's /v1/frame at the Hub's
// position, small, and again only when that position moves; otherwise, and
// while it plays, the item's artwork.
//
// On a start, until Yolo's Hub welcomes the page, the bar shows the Hub's
// state as the page kept it (home-cache.js), still: its line does not move,
// its picture is the item's artwork, and the latest press waits for the
// welcome, then acts on what Yolo says (welcome-wait.js).

const ACTIVE = new Set(["playing", "paused", "loading", "buffering"]);
const SKIP_BACK_SECONDS = 10;
const FRAME_WIDTH = 320;
const FRAME_MOVED_SECONDS = 2;

/**
 * @param {object} options
 * @param {HTMLElement} options.bar  #now-playing
 * @param {HTMLDialogElement} options.picker  #device-picker
 * @param {object} options.profile  profile.js
 * @param {(message: string) => void} options.notify  a short notice
 * @param {(ref: object) => void} options.play  plays an item on this device (browse.js)
 * @param {() => ({ sessionId: string, position: number, frame: HTMLCanvasElement | null } | null)} [options.kept]
 *   the player this screen keeps behind the home screen (player.js)
 * @param {(sessionId: string) => boolean} [options.reopen]  shows that
 *   player again and plays on; false when none is kept for the session
 * @param {() => Promise<void>} [options.welcomed]  resolves once the Hub
 *   welcomed this page (main.js)
 */
export function createRemote({ bar, picker, profile, notify, play, kept = () => null, reopen = () => false, welcomed = () => Promise.resolve() }) {
  const open = bar.querySelector("#np-open");
  const art = bar.querySelector(".np-art");
  const artwork = bar.querySelector(".np-artwork");
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
  // Yolo's frame of a paused item: the one shown, the one asked for, and
  // the position where asking failed, for one session.
  const frame = { sessionId: null, position: null, element: null, url: null, asked: null, failed: null };

  const selfName = () => (profile.car ? "This screen" : "This browser");
  const selfId = thisDeviceId;
  const deviceName = (id) => (id === selfId() ? selfName() : (state.devices || []).find((device) => device.id === id)?.name ?? "another device");
  // A press before the welcome acts once the Hub has said what plays now:
  // the latest one, once, its button marked meanwhile.
  const pressWait = createWelcomeWait(welcomed);
  const live = (action) => (event) => {
    if (state.welcomed) {
      action(event);
      return;
    }
    const button = event.currentTarget;
    button.classList.add("waiting");
    void pressWait.later(() => (state.welcomed ? action(event) : undefined), {
      onEnd: () => button.classList.remove("waiting"),
      onFail: (error) => {
        if (waitTimedOut(error)) notify(WAIT_TIMED_OUT);
      },
    });
  };

  // What the bar shows: another device's item while it plays or is paused,
  // or this device's own item that the owner left with Back.
  function remoteState() {
    const hub = state.welcomed ? state.hub : state.cachedHub;
    if (!hub?.item || !hub.deviceId || !ACTIVE.has(hub.status)) return null;
    if (hub.deviceId !== selfId()) return hub;
    const left = hub.status === "paused" && hub.leftAt && hub.sessionId !== resuming && !state.player;
    return left ? hub : null;
  }

  const ownState = () => {
    const hub = remoteState();
    return hub?.deviceId === selfId() ? hub : null;
  };

  // This device's own item, where it was left: the kept player plays on, or
  // a new stream plays it here (Yolo applies its tracks). The bar steps
  // aside meanwhile, so a second tap cannot ask twice.
  function resumeHere() {
    const hub = ownState();
    if (!hub) return false;
    if (reopen(hub.sessionId)) return true;
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

  // --- The picture ---------------------------------------------------------

  function forgetFrame() {
    if (frame.url) URL.revokeObjectURL(frame.url);
    Object.assign(frame, { sessionId: null, position: null, element: null, url: null, asked: null, failed: null });
  }

  async function fetchFrame(sessionId, position) {
    frame.asked = position;
    try {
      const response = await fetch(`${location.origin}/v1/frame?time=${position.toFixed(1)}&width=${FRAME_WIDTH}`, {
        headers: authHeaders(), cache: "no-store",
      });
      if (!response.ok) throw new Error(`/v1/frame answered ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const image = new Image();
      image.className = "np-frame";
      image.alt = "";
      image.dataset.source = "yolo";
      image.src = url;
      await image.decode().catch(() => {});
      if (frame.sessionId !== sessionId) {
        URL.revokeObjectURL(url);
        return;
      }
      if (frame.url) URL.revokeObjectURL(frame.url);
      Object.assign(frame, { position, element: image, url });
    } catch {
      // The artwork stays; this position is not asked for again.
      if (frame.sessionId === sessionId) frame.failed = position;
    } finally {
      if (frame.sessionId === sessionId) frame.asked = null;
      update();
    }
  }

  // Yolo's frame at a paused item's position: asked once per position that
  // moved meaningfully, one request at a time. Until it comes, the last one
  // of the same session shows.
  function yoloFrame(hub, position) {
    if (frame.sessionId !== hub.sessionId) {
      forgetFrame();
      frame.sessionId = hub.sessionId;
    }
    const near = (at) => at != null && Math.abs(at - position) < FRAME_MOVED_SECONDS;
    if (frame.asked == null && !near(frame.position) && !near(frame.failed)) void fetchFrame(hub.sessionId, position);
    return frame.element;
  }

  function paintPicture(hub) {
    const position = livePosition(hub);
    const own = kept();
    let picture = null;
    if (own?.frame && own.sessionId === hub.sessionId && hub.deviceId === selfId() && Math.abs(own.position - position) < FRAME_MOVED_SECONDS) {
      picture = own.frame;
    } else if (hub.status === "paused" && !hub.item.isLive && state.welcomed) {
      picture = yoloFrame(hub, position);
    }
    const shown = art.querySelector(".np-frame");
    if (shown !== picture) {
      shown?.remove();
      if (picture) art.insertBefore(picture, artwork.nextSibling);
    }
    art.classList.toggle("has-frame", Boolean(picture));
  }

  function update() {
    const hub = remoteState();
    const resumable = hub?.deviceId === selfId();
    document.getElementById("app")?.classList.toggle("has-now-playing", Boolean(hub));
    bar.classList.toggle("hidden", !hub);
    bar.classList.toggle("resumable", resumable);
    open.disabled = !resumable;
    open.setAttribute("aria-label", resumable ? `Play ${hub.item.title || "this"} here` : hub?.item?.title || "Now playing");
    if (!hub) {
      clearInterval(ticker);
      ticker = null;
      art.querySelector(".np-frame")?.remove();
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
      artwork.innerHTML = artworkImage(thumbnail, { eager: true });
      hydrateArtwork(artwork);
    }
    paintPicture(hub);
    const paused = hub.status === "paused";
    toggle.innerHTML = paused ? icons.play : icons.pause;
    toggle.setAttribute("aria-label", paused ? "Play" : "Pause");
    next.disabled = !nextAvailable({ hub });
    back.disabled = Boolean(hub.item.isLive);
    paint();
    if (!ticker) ticker = setInterval(paint, 1000);
    if (picker.open && !pendingPlay) renderPicker();
  }

  toggle.addEventListener("click", live(() => {
    const hub = remoteState();
    if (!hub || resumeHere()) return;
    // Show the change at once; Yolo's `state` broadcast confirms it.
    const pausing = hub.status !== "paused";
    share({ hub: { ...hub, status: pausing ? "paused" : "playing", position: livePosition(hub), positionAt: Date.now() } });
    void command(`/v1/playback/${pausing ? "pause" : "resume"}`, { label: pausing ? "Pause" : "Play" });
  }));
  back.addEventListener("click", live(() => {
    const hub = remoteState();
    if (hub) void command("/v1/playback/seek", { body: { position: Math.max(0, livePosition(hub) - SKIP_BACK_SECONDS) }, label: "Skip back" });
  }));
  next.addEventListener("click", live(() => void command("/v1/playback/next", { label: "Next" })));
  devices.addEventListener("click", live((event) => openPicker({ instant: event.detail === 0 })));
  open.addEventListener("click", live(() => resumeHere()));

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

  dismissible(picker, closePicker);
  picker.querySelector("#device-picker-close").addEventListener("click", closePicker);

  // The Hub's state and the queue redraw the bar (store.js).
  subscribe(["hub", "queue"], update);

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
    // The press that waits for the welcome goes (the screen pairs again).
    dropWaitingPress: () => pressWait.drop(),
  };
}
