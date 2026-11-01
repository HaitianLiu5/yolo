import { physicalViewport } from "../display-scale.js";

// The screen's shape for the runtime log: the window, the display size
// (display-scale.js), and the picture each engine draws into.

export function describeViewport() {
  const dpr = Number(globalThis.devicePixelRatio) || 1;
  const innerWidth = Number(globalThis.innerWidth) || 0;
  const innerHeight = Number(globalThis.innerHeight) || 0;
  const visualViewport = globalThis.visualViewport;
  const physical = physicalViewport();
  return {
    innerWidth,
    innerHeight,
    devicePixelRatio: dpr,
    devicePixelWidth: Math.round(innerWidth * dpr),
    devicePixelHeight: Math.round(innerHeight * dpr),
    physicalWidth: physical.width,
    physicalHeight: physical.height,
    displayScale: globalThis.__yoloDisplayBoot?.scale ?? null,
    displayZoom: globalThis.__yoloDisplayBoot?.zoom ?? 1,
    visualViewport: visualViewport ? {
      width: Math.round(visualViewport.width * 100) / 100,
      height: Math.round(visualViewport.height * 100) / 100,
      scale: visualViewport.scale,
      offsetLeft: visualViewport.offsetLeft,
      offsetTop: visualViewport.offsetTop,
    } : null,
    screen: globalThis.screen ? {
      width: globalThis.screen.width,
      height: globalThis.screen.height,
      availWidth: globalThis.screen.availWidth,
      availHeight: globalThis.screen.availHeight,
    } : null,
  };
}

/** The canvas engine's canvas in `container`: its size and the box it fills. */
export function describeCanvas(container) {
  const canvas = container?.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return null;
  return { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight };
}

/** The <video> engine's picture in `container`: the decoded size and the box it fills. */
export function describeVideo(container) {
  const video = container?.querySelector('video[data-engine="native"]');
  if (!(video instanceof HTMLVideoElement)) return null;
  return { width: video.videoWidth, height: video.videoHeight, clientWidth: video.clientWidth, clientHeight: video.clientHeight };
}
