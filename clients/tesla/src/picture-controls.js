// Picture-in-Picture, fullscreen, and AirPlay buttons for the web profile's
// <video> engine (Agent Note 2026-10-12-two-playback-engines). Each shows only
// where the browser offers it; the car's canvas engine has none of them.
//
// Fullscreen takes the whole player (#app), not the <video> element, so
// Yolo's controls and subtitles stay on screen. A browser that can only put
// the <video> element itself in fullscreen (Safari on iPhone) gets no
// button: its own player would hide Yolo's subtitles.

const app = document.getElementById("app");
const buttons = {
  pip: document.getElementById("btn-pip"),
  fullscreen: document.getElementById("btn-fullscreen"),
  airplay: document.getElementById("btn-airplay"),
};

let current = null; // { video, cleanup }

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const fullscreenEnabled = () => document.fullscreenEnabled === true || document.webkitFullscreenEnabled === true;

function pipSupported(video) {
  if (video.disablePictureInPicture) return false;
  if (document.pictureInPictureEnabled === true && typeof video.requestPictureInPicture === "function") return true;
  return typeof video.webkitSupportsPresentationMode === "function" && video.webkitSupportsPresentationMode("picture-in-picture");
}

const inPictureInPicture = (video) => document.pictureInPictureElement === video || video.webkitPresentationMode === "picture-in-picture";

function show(button, visible) {
  button?.classList.toggle("hidden", !visible);
}

function syncState() {
  const video = current?.video;
  buttons.pip?.classList.toggle("active", Boolean(video && inPictureInPicture(video)));
  buttons.fullscreen?.classList.toggle("active", Boolean(fullscreenElement()));
}

async function togglePictureInPicture() {
  const video = current?.video;
  if (!video) return;
  try {
    if (inPictureInPicture(video)) {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
      else video.webkitSetPresentationMode?.("inline");
    } else if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function") {
      await video.requestPictureInPicture();
    } else {
      video.webkitSetPresentationMode?.("picture-in-picture");
    }
  } catch (error) {
    console.warn("[player] Picture-in-Picture:", error);
  }
  syncState();
}

async function toggleFullscreen() {
  try {
    if (fullscreenElement()) {
      await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
    } else {
      await (app.requestFullscreen?.({ navigationUI: "hide" }) ?? app.webkitRequestFullscreen?.());
    }
  } catch (error) {
    console.warn("[player] Fullscreen:", error);
  }
  syncState();
}

buttons.pip?.addEventListener("click", (event) => {
  event.stopPropagation();
  void togglePictureInPicture();
});
buttons.fullscreen?.addEventListener("click", (event) => {
  event.stopPropagation();
  void toggleFullscreen();
});
buttons.airplay?.addEventListener("click", (event) => {
  event.stopPropagation();
  current?.video?.webkitShowPlaybackTargetPicker?.();
});
document.addEventListener("fullscreenchange", syncState);
document.addEventListener("webkitfullscreenchange", syncState);

/** Offer what the browser can do with this player's <video> element. */
export function attachPictureControls(player) {
  detachPictureControls();
  const video = player?.video;
  if (!video) return;
  const listeners = [];
  const on = (type, handler) => {
    video.addEventListener(type, handler);
    listeners.push([type, handler]);
  };
  on("enterpictureinpicture", syncState);
  on("leavepictureinpicture", syncState);
  on("webkitpresentationmodechanged", syncState);
  // AirPlay works with the browser's own HLS, not with Media Source.
  if (typeof globalThis.WebKitPlaybackTargetAvailabilityEvent === "function" && player.mode !== "hls.js") {
    on("webkitplaybacktargetavailabilitychanged", (event) => show(buttons.airplay, event.availability === "available"));
  }
  current = {
    video,
    cleanup: () => {
      for (const [type, handler] of listeners) video.removeEventListener(type, handler);
    },
  };
  show(buttons.pip, pipSupported(video));
  show(buttons.fullscreen, fullscreenEnabled());
  show(buttons.airplay, false);
  syncState();
}

/** The player went away: no buttons, and fullscreen ends with it. */
export function detachPictureControls() {
  if (!current) return;
  current.cleanup();
  current = null;
  for (const button of Object.values(buttons)) show(button, false);
}

/** Leaving playback leaves the player's fullscreen too. */
export function exitPictureModes() {
  if (fullscreenElement() === app) void (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.())?.catch?.(() => {});
}
