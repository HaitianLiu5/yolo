import { api, authHeaders, thisDeviceId } from "./api.js";
import { artworkImage, hydrateArtwork, landscapeArtwork } from "./artwork.js";
import { dismissible, h, icons } from "./dom.js";
import { t } from "./i18n.js";
import { livePosition, transferTargets } from "./play-target.js";
import { state } from "./state.js";
import { inUse, nextAvailable, share, subscribe } from "./store.js";
import { createWelcomeWait, WAIT_TIMED_OUT, waitTimedOut } from "./welcome-wait.js";

// Yolo as a remote (Agent Note 2026-10-11-yolo-web-client): every screen
// plays on its own (Agent Note 2026-10-31-screen-sessions), and the home
// screen's now-playing bar controls one session at a time, by default this
// screen's own one left with Back, else the newest other screen's in use.
// Its sheet lists every session in use, this screen's first, each with its
// screen and whose profile it is: a tap on one controls it, "Continue
// here" takes it over on this screen in one tap, and "Move to" sends the
// controlled one to another screen, asking first when someone is watching
// there (screen_busy). Every command goes to Yolo over /v1 with this
// device's credential and names the session's screen; the bar only reads
// the Hub's broadcasts (`state`, `devices`, `queue`) and never answers them.
//
// The bar shows this device's own item too after the owner went Back from
// the player: Yolo keeps it paused at its position
// (Agent Note 2026-10-11-yolo-owns-progress-and-resume), and its play
// button, or a tap on the bar, shows the player this screen kept and plays
// on in place, or plays the item here again with a new stream. One another
// screen continued shows "Continued on …", and its play button takes it
// back from there.
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
 * @param {object} options.mode  mode.js
 * @param {(message: string) => void} options.notify  a short notice
 * @param {(ref: object) => void} options.play  plays an item on this device (browse.js)
 * @param {() => ({ sessionId: string, position: number, frame: HTMLCanvasElement | null } | null)} [options.kept]
 *   the player this screen keeps behind the home screen (player.js)
 * @param {(sessionId: string) => boolean} [options.reopen]  shows that
 *   player again and plays on; false when none is kept for the session
 * @param {() => Promise<void>} [options.welcomed]  resolves once the Hub
 *   welcomed this page (main.js)
 * @param {(session: object) => void} [options.continueHere]  continues
 *   another screen's session on this one (browse.js)
 */
export function createRemote({
  bar, picker, mode, notify, play, kept = () => null, reopen = () => false, welcomed = () => Promise.resolve(), continueHere = () => {},
}) {
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
  // The screen whose session the bar controls, as the owner picked it; null
  // for the default (sessionsShown()).
  let selected = null;
  // While the sheet asks whether to play where someone is watching: the
  // question, and how it is answered.
  let asking = null;
  // Yolo's frame of a paused item: the one shown, the one asked for, and
  // the position where asking failed, for one session.
  const frame = { sessionId: null, position: null, element: null, url: null, asked: null, failed: null };

  const selfName = () => (mode.car ? t("This screen") : t("This browser"));
  const selfId = thisDeviceId;
  const deviceName = (id) => (id === selfId() ? selfName() : (state.devices || []).find((device) => device.id === id)?.name ?? t("another device"));
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

  // This screen's own session when the bar shows it: left with Back, or
  // continued on another screen, and not on screen here.
  function ownShown() {
    const hub = state.welcomed ? state.hub : state.cachedHub;
    if (!hub?.item || !hub.deviceId || hub.deviceId !== selfId() || !ACTIVE.has(hub.status)) return null;
    const left = hub.status === "paused" && (hub.leftAt || hub.handedTo) && hub.sessionId !== resuming && !state.player;
    return left ? hub : null;
  }

  // Every session the bar can control: this screen's own first, then the
  // other screens' in use, newest first. Before the first welcome, the
  // state the page kept (another screen's included, as it was then).
  function sessionsShown() {
    const own = ownShown();
    if (!state.welcomed) {
      const cached = state.cachedHub;
      return [own, cached?.item && cached.deviceId !== selfId() && ACTIVE.has(cached.status) ? cached : null].filter(Boolean);
    }
    const others = Object.values(state.sessions || {})
      .filter((session) => session.deviceId !== selfId() && inUse(session))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    return [own, ...others].filter(Boolean);
  }

  // What the bar shows: the session the owner picked, else the first.
  function remoteState() {
    const shown = sessionsShown();
    return shown.find((session) => session.deviceId === selected) ?? shown[0] ?? null;
  }

  const ownState = () => {
    const hub = remoteState();
    return hub?.deviceId === selfId() ? hub : null;
  };

  // This device's own item, where it was left: the kept player plays on, or
  // a new stream plays it here (Yolo applies its tracks). One another
  // screen continued is taken back from there while it plays it. The bar
  // steps aside meanwhile, so a second tap cannot ask twice.
  function resumeHere() {
    const hub = ownState();
    if (!hub) return false;
    const continuing = hub.handedTo ? state.sessions?.[hub.handedTo.deviceId] : null;
    if (continuing?.item && continuing.item.source?.id === hub.item.source?.id) {
      continueHere(continuing);
      return true;
    }
    if (reopen(hub.sessionId)) return true;
    resuming = hub.sessionId;
    update();
    void Promise.resolve(play({ source: hub.item.source, startTime: livePosition(hub) })).finally(() => {
      resuming = null;
      update();
    });
    return true;
  }

  // `body.deviceId` names the screen whose session the command is for.
  async function command(path, { method = "POST", body, label } = {}) {
    try {
      await api(path, { method, body, label, retries: 0 });
      return true;
    } catch (error) {
      if (error.code === "screen_busy" && body && !body.replace) {
        if (await confirmBusy(error.details)) return command(path, { method, body: { ...body, replace: true }, label });
        return false;
      }
      notify(error.message || `${label} failed`);
      return false;
    }
  }

  // Asks in the sheet whether to play where someone is watching, from a
  // screen_busy refusal's details: true to play there instead.
  function confirmBusy(details = {}) {
    return new Promise((resolve) => {
      asking?.answer(false);
      asking = {
        details,
        answer: (yes) => {
          if (asking?.answer !== answer) return;
          asking = null;
          closePicker();
          resolve(yes);
        },
      };
      const { answer } = asking;
      openPicker({});
    });
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
    open.setAttribute("aria-label", resumable ? (hub.item.title ? t("Play {title} here", { title: hub.item.title }) : t("Play this here")) : hub?.item?.title || t("Now playing"));
    if (!hub) {
      clearInterval(ticker);
      ticker = null;
      art.querySelector(".np-frame")?.remove();
      if (picker.open && !pendingPlay) renderPicker();
      return;
    }
    title.textContent = hub.item.title || t("Playing");
    const handed = hub.deviceId === selfId() && hub.handedTo ? hub.handedTo.deviceId : null;
    const shownOn = handed ?? hub.deviceId;
    const device = (state.devices || []).find((candidate) => candidate.id === shownOn);
    // The device's name sits where the language puts it in the sentence.
    const sentence = handed ? t("Continued on {device}") : hub.status === "paused" ? t("Paused on {device}") : t("Playing on {device}");
    const [before, after] = sentence.split("{device}");
    const profile = profileTag(hub);
    const count = sessionsShown().length;
    where.replaceChildren(...[
      h("span", { class: "np-device-icon", html: icons.kind(device?.kind ?? "other", 16) }),
      before ? h("span", { class: "np-verb" }, before) : null,
      h("strong", {}, deviceName(shownOn)),
      after ? h("span", { class: "np-verb" }, after) : null,
      profile ? h("span", { class: "np-profile" }, profile) : null,
    ].filter(Boolean));
    devices.dataset.count = count > 1 ? String(count) : "";
    devices.setAttribute("aria-label", count > 1 ? t("{count} screens playing: choose one", { count }) : t("Choose where to play"));
    const thumbnail = landscapeArtwork(hub.item.thumbnail);
    if (thumbnail !== artworkUrl) {
      artworkUrl = thumbnail;
      artwork.innerHTML = artworkImage(thumbnail, { eager: true });
      hydrateArtwork(artwork);
    }
    paintPicture(hub);
    const paused = hub.status === "paused";
    toggle.innerHTML = paused ? icons.play : icons.pause;
    toggle.setAttribute("aria-label", paused ? t("Play") : t("Pause"));
    // Another screen's queue is its own: only what its state names as next.
    next.disabled = !nextAvailable({ hub, ...(hub.deviceId === selfId() ? {} : { queue: [] }) });
    back.disabled = Boolean(hub.item.isLive);
    paint();
    if (!ticker) ticker = setInterval(paint, 1000);
    if (picker.open && !pendingPlay) renderPicker();
  }

  toggle.addEventListener("click", live(() => {
    const hub = remoteState();
    if (!hub || (hub.deviceId === selfId() && resumeHere())) return;
    // Show the change at once; Yolo's `state` broadcast confirms it.
    const pausing = hub.status !== "paused";
    const shown = { ...hub, status: pausing ? "paused" : "playing", position: livePosition(hub), positionAt: Date.now() };
    if (hub.deviceId === selfId()) share({ hub: shown });
    else share({ sessions: { ...state.sessions, [hub.deviceId]: shown } });
    void command(`/v1/playback/${pausing ? "pause" : "resume"}`, { body: { deviceId: hub.deviceId }, label: pausing ? "Pause" : "Play" });
  }));
  back.addEventListener("click", live(() => {
    const hub = remoteState();
    if (hub) void command("/v1/playback/seek", { body: { deviceId: hub.deviceId, position: Math.max(0, livePosition(hub) - SKIP_BACK_SECONDS) }, label: "Skip back" });
  }));
  next.addEventListener("click", live(() => {
    const hub = remoteState();
    if (hub) void command("/v1/playback/next", { body: { deviceId: hub.deviceId }, label: "Next" });
  }));
  devices.addEventListener("click", live((event) => openPicker({ instant: event.detail === 0 })));
  open.addEventListener("click", live(() => resumeHere()));

  // --- The sheet: every session, and where to play -------------------------

  // The profile's name when it is not whose this screen is by default
  // (Agent Note 2026-10-31-screen-sessions), so the owner sees the family TV
  // writing their history, and the family the owner's session.
  function profileTag(session) {
    const profile = session?.profile;
    if (!profile?.id) return null;
    const mine = state.profile?.id ?? "owner";
    if (profile.id === mine) return null;
    return profile.id === "owner" ? t("Mine") : profile.name;
  }

  function deviceRow(device, { current = false, onclick }) {
    const self = device.id === state.deviceId;
    return h("li", {},
      h("button", {
        type: "button",
        class: `picker-row${current ? " current" : ""}`,
        "aria-current": current ? "true" : null,
        onclick,
      },
      h("span", { class: "picker-icon", html: icons.kind(device.kind) }),
      h("span", { class: "row-title" }, self ? selfName() : device.name),
      current ? h("span", { class: "picker-check", html: icons.check }) : null));
  }

  // One session: tapping it controls it in the bar; another screen's has
  // "Continue here" when this screen can play.
  function sessionRow(session, { current }) {
    const device = (state.devices || []).find((candidate) => candidate.id === session.deviceId) ?? { id: session.deviceId, kind: "other", name: deviceName(session.deviceId) };
    const own = session.deviceId === selfId();
    const profile = profileTag(session);
    const status = own && session.handedTo ? t("Continued on {device}", { device: deviceName(session.handedTo.deviceId) })
      : session.status === "paused" ? t("Paused") : t("Playing");
    return h("li", { class: "picker-session" },
      h("button", {
        type: "button",
        class: `picker-row${current ? " current" : ""}`,
        "aria-current": current ? "true" : null,
        onclick: () => {
          selected = session.deviceId;
          update();
          renderPicker();
        },
      },
      h("span", { class: "picker-icon", html: icons.kind(device.kind) }),
      h("span", { class: "picker-text" },
        h("span", { class: "row-title" }, own ? selfName() : device.name),
        h("span", { class: "row-meta" }, [session.item.title || t("Playing"), profile, status].filter(Boolean).join(" · "))),
      current ? h("span", { class: "picker-check", html: icons.check }) : null),
      !own && mode.canPlay ? h("button", {
        type: "button",
        class: "pill picker-continue",
        onclick: () => {
          closePicker();
          continueHere(session);
        },
      }, t("Continue here")) : null);
  }

  function renderBusy() {
    const { details } = asking;
    const profile = details?.profile?.id && details.profile.id !== "owner" ? details.profile.name : t("Someone");
    pickerTitle.textContent = t("Play there instead?");
    list.replaceChildren(h("li", { class: "picker-empty" }, t("{profile} is watching {title} on {device}.", {
      profile, title: details?.item?.title ?? t("something"), device: details?.name ?? t("that screen"),
    })));
    picker.querySelector(".picker-footer").replaceChildren(
      h("button", { type: "button", class: "picker-row", onclick: () => asking?.answer(true) },
        h("span", { class: "picker-icon", html: icons.play ?? "" }), h("span", { class: "row-title" }, t("Play there instead"))),
      h("button", { type: "button", class: "picker-row", onclick: () => asking?.answer(false) },
        h("span", { class: "picker-icon", html: icons.stop ?? "" }), h("span", { class: "row-title" }, t("Cancel"))),
    );
  }

  function renderPicker() {
    if (asking) {
      renderBusy();
      return;
    }
    const hub = remoteState();
    if (pendingPlay) {
      pickerTitle.textContent = t("Play on");
      const rows = pendingPlay.choices.map((device) => deviceRow(device, { onclick: () => choose(device) }));
      if (!rows.length) rows.push(h("li", { class: "picker-empty" }, t("No screen that can play is online. Open Yolo in the car or on a computer.")));
      list.replaceChildren(...rows);
      picker.querySelector(".picker-footer").replaceChildren();
      return;
    }
    const sessions = sessionsShown();
    pickerTitle.textContent = sessions.length ? t("Now playing") : t("Playing on");
    const rows = sessions.map((session) => sessionRow(session, { current: session.deviceId === hub?.deviceId }));
    // Where the session the bar controls can go: every other screen that
    // plays, this one first.
    const targets = transferTargets({ devices: state.devices || [], self: state.deviceId, canPlay: mode.canPlay })
      .filter((device) => device.id !== hub?.deviceId);
    if (hub && targets.length) {
      rows.push(h("li", { class: "picker-heading" }, t("Move to")));
      rows.push(...targets.map((device) => deviceRow(device, { onclick: () => choose(device) })));
    }
    if (!rows.length) {
      rows.push(h("li", { class: "picker-empty" }, t("No screen that can play is online. Open Yolo in the car or on a computer.")));
    }
    const footer = [];
    if (hub) {
      footer.push(h("button", {
        type: "button",
        class: "picker-row",
        onclick: () => {
          closePicker();
          void command("/v1/playback/stop", { body: { deviceId: hub.deviceId }, label: "Stop" });
        },
      }, h("span", { class: "picker-icon", html: icons.stop }), h("span", { class: "row-title" }, t("Stop playing"))));
    }
    list.replaceChildren(...rows);
    picker.querySelector(".picker-footer").replaceChildren(...footer);
  }

  // A tapped item plays on `device`; or the controlled session moves there,
  // and its screen pauses. Moving it here is "Continue here".
  async function choose(device) {
    const play = pendingPlay;
    closePicker();
    if (play) {
      await play.run(device.id);
      return;
    }
    const hub = remoteState();
    if (!hub) return;
    if (device.id === state.deviceId && mode.canPlay) {
      if (hub.deviceId === selfId()) resumeHere();
      else continueHere(hub);
      return;
    }
    await command("/v1/playback/device", { method: "PUT", body: { deviceId: device.id, from: hub.deviceId }, label: "Move playback" });
  }

  function openPicker({ instant = false, play = null } = {}) {
    pendingPlay = play;
    picker.classList.toggle("instant", instant);
    renderPicker();
    if (!picker.open) picker.showModal();
  }

  function closePicker() {
    pendingPlay = null;
    if (asking) {
      const { answer } = asking;
      answer(false);
      return;
    }
    if (picker.open) picker.close();
  }

  dismissible(picker, closePicker);
  picker.querySelector("#device-picker-close").addEventListener("click", closePicker);

  // Any screen's session and the queue redraw the bar (store.js).
  subscribe(["hub", "sessions", "queue"], update);

  return {
    update,
    // Ask where a tapped item should play (a remote with several screens
    // online); `run(deviceId)` plays it there.
    pickForPlay(choices, run) {
      openPicker({ play: { choices, run } });
    },
    closePicker,
    // Whether to play where someone else is watching (a screen_busy refusal's details).
    confirmBusy,
    // A remote's play for this device's own paused item: play it here.
    resumeHere,
    // The press that waits for the welcome goes (the screen pairs again).
    dropWaitingPress: () => pressWait.drop(),
  };
}
