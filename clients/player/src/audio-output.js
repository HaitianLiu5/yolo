// The audio output a page's first tap opens (Agent Note
// 2026-04-04-canvas-playback-engine). The canvas engine plays through
// an AudioContext, and the first one a page makes opens the system's audio
// device, which holds the page's main thread for up to two seconds (1.8 s
// in Chrome on macOS). The first tap opens it once the tap's own handlers
// have run: the play request they send goes first, the device opens while
// Yolo prepares the stream, and the engine's own AudioContext then starts at
// once. A <video> element needs no AudioContext; the tap itself lets it play
// with sound.
export function warmAudioOutput({
  engine,
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
  defer = (task) => setTimeout(task, 0),
} = {}) {
  if (engine !== "canvas" || typeof AudioContextClass !== "function") return false;
  defer(() => {
    try {
      const context = new AudioContextClass();
      context.resume().then(() => context.close()).catch(() => {});
    } catch {
      // No audio output here: the engine finds out when it plays.
    }
  });
  return true;
}
