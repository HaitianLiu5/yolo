import assert from "node:assert/strict";
import test from "node:test";
import { createPictureControls, fullscreenPathFor } from "../../src/picture-controls.js";

class FakeElement extends EventTarget {
  constructor(id) {
    super();
    this.id = id;
    this.classes = new Set(["hidden"]);
    this.classList = {
      toggle: (name, force) => {
        const on = force ?? !this.classes.has(name);
        if (on) this.classes.add(name);
        else this.classes.delete(name);
        return on;
      },
      contains: (name) => this.classes.has(name),
    };
    this.requested = 0;
  }

  get hidden() {
    return this.classes.has("hidden");
  }

  async requestFullscreen() {
    this.requested += 1;
  }
}

// The page as picture-controls.js reads it; `fullscreenEnabled` is the
// element Fullscreen API (false on iPhone).
function fakeDocument({ fullscreenEnabled }) {
  const doc = new EventTarget();
  const elements = new Map(["app", "btn-fullscreen", "btn-airplay"].map((id) => [id, new FakeElement(id)]));
  doc.getElementById = (id) => elements.get(id) ?? null;
  doc.fullscreenEnabled = fullscreenEnabled;
  doc.fullscreenElement = null;
  return { doc, app: elements.get("app"), fullscreen: elements.get("btn-fullscreen") };
}

// A <video> element of WebKit on iPhone: it can go fullscreen in the
// system's player once its stream begins to load.
class PhoneVideo extends EventTarget {
  constructor() {
    super();
    this.webkitSupportsFullscreen = false;
    this.webkitDisplayingFullscreen = false;
    this.entered = 0;
    this.exited = 0;
  }

  webkitEnterFullscreen() {
    this.entered += 1;
    this.webkitDisplayingFullscreen = true;
  }

  webkitExitFullscreen() {
    this.exited += 1;
    this.webkitDisplayingFullscreen = false;
  }
}

test("without element fullscreen (iPhone), the button opens the system's player for the <video> element", () => {
  const { doc, app, fullscreen } = fakeDocument({ fullscreenEnabled: false });
  const controls = createPictureControls(doc, {});
  const video = new PhoneVideo();
  controls.attach({ video, mode: "native-hls" });
  assert.equal(fullscreen.hidden, true, "not before the stream loads");

  video.webkitSupportsFullscreen = true;
  video.dispatchEvent(new Event("loadedmetadata"));
  assert.equal(fullscreen.hidden, false, "the button shows");

  fullscreen.dispatchEvent(new Event("click"));
  assert.equal(video.entered, 1, "within the tap");
  assert.equal(app.requested, 0);

  // Leaving playback closes the system's player with it.
  controls.detach();
  assert.deepEqual([video.exited, fullscreen.hidden], [1, true]);
});

test("element fullscreen, where the browser has it (iPad, computers), takes the whole player; without either, no button", () => {
  const ipad = fakeDocument({ fullscreenEnabled: true });
  const video = new PhoneVideo();
  video.webkitSupportsFullscreen = true;
  createPictureControls(ipad.doc, {}).attach({ video, mode: "native-hls" });
  assert.equal(ipad.fullscreen.hidden, false);
  ipad.fullscreen.dispatchEvent(new Event("click"));
  assert.deepEqual([ipad.app.requested, video.entered], [1, 0]);

  const none = fakeDocument({ fullscreenEnabled: false });
  createPictureControls(none.doc, {}).attach({ video: new EventTarget(), mode: "hls.js" });
  assert.equal(none.fullscreen.hidden, true);

  assert.equal(fullscreenPathFor({ webkitFullscreenEnabled: true }, null), "element");
  assert.equal(fullscreenPathFor({ fullscreenEnabled: false }, video), "video");
  assert.equal(fullscreenPathFor({ fullscreenEnabled: false }, { webkitSupportsFullscreen: true }), null);
});
