// Fullscreen and AirPlay buttons for the web profile's <video> engine (Agent
// Note 2026-10-12-two-playback-engines). Each shows only where the browser
// offers it; the car's canvas engine has none of them. Picture-in-Picture has
// no button: the browser's own menu and the system's player offer it.
//
// Fullscreen takes the whole player (#app), not the <video> element, so
// Yolo's controls, subtitles, and danmaku stay on screen. A browser without
// element fullscreen that can put the <video> element itself in fullscreen
// (every browser on iPhone) opens the system's own player instead, as
// YouTube's mobile site does: the engine shows Yolo's subtitles there as the
// element's text tracks, danmaku waits for the return, and the engine
// follows what the system's player did meanwhile (native-video-player.js).

/**
 * How this page goes fullscreen: "element" (the whole player), "video" (the
 * <video> element in the system's player, on iPhone), or null. iOS says a
 * <video> element can go fullscreen only once its stream has begun to load.
 */
function fullscreenPathFor(doc, video) {
  if (doc?.fullscreenEnabled === true || doc?.webkitFullscreenEnabled === true) return "element";
  if (typeof video?.webkitEnterFullscreen === "function" && video.webkitSupportsFullscreen === true) return "video";
  return null;
}

/** The buttons of one page (`doc`); the page's own are below. */
function createPictureControls(doc, win = globalThis) {
  const app = doc.getElementById("app");
  const buttons = {
    fullscreen: doc.getElementById("btn-fullscreen"),
    airplay: doc.getElementById("btn-airplay"),
  };

  let current = null; // { video, cleanup }

  const fullscreenElement = () => doc.fullscreenElement || doc.webkitFullscreenElement || null;

  function show(button, visible) {
    button?.classList.toggle("hidden", !visible);
  }

  function syncState() {
    buttons.fullscreen?.classList.toggle("active", Boolean(fullscreenElement()));
  }

  function showFullscreen() {
    show(buttons.fullscreen, Boolean(current && fullscreenPathFor(doc, current.video)));
  }

  async function toggleFullscreen() {
    const video = current?.video;
    try {
      if (fullscreenElement()) {
        await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      } else if (fullscreenPathFor(doc, video) === "video") {
        // Still inside the tap: iOS opens its player only for a gesture.
        video.webkitEnterFullscreen();
      } else {
        await (app.requestFullscreen?.({ navigationUI: "hide" }) ?? app.webkitRequestFullscreen?.());
      }
    } catch (error) {
      console.warn("[player] Fullscreen:", error);
    }
    syncState();
  }

  buttons.fullscreen?.addEventListener("click", (event) => {
    event.stopPropagation();
    void toggleFullscreen();
  });
  buttons.airplay?.addEventListener("click", (event) => {
    event.stopPropagation();
    current?.video?.webkitShowPlaybackTargetPicker?.();
  });
  doc.addEventListener("fullscreenchange", syncState);
  doc.addEventListener("webkitfullscreenchange", syncState);

  /** The player went away: no buttons, and the system's player ends with it. */
  function detach() {
    if (!current) return;
    const { video, cleanup } = current;
    cleanup();
    current = null;
    if (video.webkitDisplayingFullscreen === true) video.webkitExitFullscreen?.();
    for (const button of Object.values(buttons)) show(button, false);
  }

  return {
    /** Offer what the browser can do with this player's <video> element. */
    attach(player) {
      detach();
      const video = player?.video;
      if (!video) return;
      const listeners = [];
      const on = (type, handler) => {
        video.addEventListener(type, handler);
        listeners.push([type, handler]);
      };
      // Whether the element itself can go fullscreen is known once its
      // stream loads.
      on("loadstart", showFullscreen);
      on("loadedmetadata", showFullscreen);
      // AirPlay works with the browser's own HLS, not with Media Source.
      if (typeof win.WebKitPlaybackTargetAvailabilityEvent === "function" && player.mode !== "hls.js") {
        on("webkitplaybacktargetavailabilitychanged", (event) => show(buttons.airplay, event.availability === "available"));
      }
      current = {
        video,
        cleanup: () => {
          for (const [type, handler] of listeners) video.removeEventListener(type, handler);
        },
      };
      showFullscreen();
      show(buttons.airplay, false);
      syncState();
    },

    detach,

    /** Leaving playback leaves the player's fullscreen too. */
    exitPictureModes() {
      if (fullscreenElement() === app) void (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())?.catch?.(() => {});
    },
  };
}

const page = globalThis.document ? createPictureControls(globalThis.document) : null;

/** Offer what the browser can do with this player's <video> element. */
export function attachPictureControls(player) {
  page?.attach(player);
}

/** The player went away: no buttons, and fullscreen ends with it. */
export function detachPictureControls() {
  page?.detach();
}

/** Leaving playback leaves the player's fullscreen too. */
export function exitPictureModes() {
  page?.exitPictureModes();
}
