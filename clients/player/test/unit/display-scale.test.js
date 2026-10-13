import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { AUTO_KEY, CHOICE_KEY, createDisplayScale, isEligible, physicalViewport } from "../../src/display-scale.js";

const bootScript = readFileSync(new URL("../../public/display-scale-boot.js", import.meta.url), "utf8");
const TESLA_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

// A window as the Tesla browser on 2026.26 presents it (Chrome 148, which
// ignores the viewport meta), or another one. Its layout follows the root's
// zoom as Chromium's standardized zoom does: innerWidth and the pixel ratio
// stay, the body lays out innerWidth / zoom CSS px wide, and its on-screen
// box stays the window's.
function fakeWindow({ dpr = 1.53, width = 773, height = 601, screen = { width: 1254, height: 784 }, search = "", stored = {}, honoursZoom = true } = {}) {
  const items = new Map(Object.entries(stored));
  const styles = new Map();
  const win = {
    devicePixelRatio: dpr,
    innerWidth: width,
    innerHeight: height,
    screen,
    navigator: { userAgent: TESLA_UA },
    visualViewport: { scale: 1 },
    location: { search },
    localStorage: { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) },
    items,
    styles,
  };
  const zoom = () => (honoursZoom ? Number(styles.get("zoom") ?? 1) : 1);
  win.document = {
    documentElement: {
      style: {
        setProperty: (name, value) => styles.set(name, String(value)),
        removeProperty: (name) => styles.delete(name),
        getPropertyValue: (name) => styles.get(name) ?? "",
      },
    },
    body: {
      get clientWidth() {
        return Math.round(win.innerWidth / zoom());
      },
      get clientHeight() {
        return Math.round(win.innerHeight / zoom());
      },
      getBoundingClientRect: () => ({ width: win.innerWidth, height: win.innerHeight }),
    },
  };
  return win;
}

// The boot script, as the page runs it before its first layout.
function boot(win) {
  runInNewContext(bootScript, { window: win, document: win.document, URLSearchParams });
  return win.__yoloDisplayBoot;
}

const settle = () => new Promise((done) => setTimeout(done, 500));

test("the car starts at the default size; other browsers keep their own scale", () => {
  assert.equal(isEligible({ car: true, devicePixelRatio: 1.53 }), true);
  assert.equal(isEligible({ car: true, devicePixelRatio: 1.0 }), false, "older software renders at 1.0");
  // A Mac at 2x is not a car: its browser zooms by itself.
  assert.equal(isEligible({ car: false, devicePixelRatio: 2 }), false);
  const car = fakeWindow();
  boot(car);
  const carScale = createDisplayScale({ win: car, eligible: true });
  carScale.init();
  assert.deepEqual(carScale.state, { scale: 1.25, zoom: 0.817, width: 946, source: "default", nativeScale: 1.53, eligible: true });
  assert.equal(car.styles.get("zoom"), "0.817");
  assert.equal(car.items.get(AUTO_KEY), "1.25", "the boot script applies it first thing next time");

  const laptop = fakeWindow({ dpr: 2, width: 1440, height: 900, screen: { width: 1440, height: 900 } });
  boot(laptop);
  const laptopScale = createDisplayScale({ win: laptop, eligible: false });
  laptopScale.init();
  assert.deepEqual([laptopScale.state.scale, laptopScale.state.zoom], [null, 1]);
  assert.equal(laptop.styles.has("zoom"), false, "no change elsewhere");
  assert.equal(laptop.items.get(AUTO_KEY), "native");
  laptopScale.choose(1.15);
  assert.equal(laptop.styles.has("zoom"), false, "nothing to choose off the car");
});

test("a size saved on a browser that is not the car is ignored", () => {
  // The chips used to show on a Mac too (100%, 77%, 68%, …): a choice saved
  // then must not shrink the page any more.
  const mac = fakeWindow({ dpr: 2, width: 1440, height: 900, screen: { width: 1440, height: 900 }, stored: { [AUTO_KEY]: "native", [CHOICE_KEY]: "1.35" } });
  assert.equal(boot(mac).zoom, 1);
  const display = createDisplayScale({ win: mac, eligible: false });
  display.init();
  assert.equal(mac.styles.has("zoom"), false);
  // ?scale= still works anywhere, for testing.
  const queried = fakeWindow({ dpr: 2, width: 1440, height: 900, search: "?scale=1.0", stored: { [AUTO_KEY]: "native" } });
  assert.deepEqual([boot(queried).source, queried.__yoloDisplayBoot.zoom, queried.styles.get("zoom")], ["query", 0.5, "0.5"]);
});

test("the boot script zooms the page to the saved size before the first layout", () => {
  const car = fakeWindow({ stored: { [AUTO_KEY]: "1.25" } });
  const applied = boot(car);
  assert.deepEqual([applied.scale, applied.zoom, applied.width, applied.source], [1.25, 0.817, 946, "default"]);
  assert.equal(car.styles.get("zoom"), "0.817");
  // The owner's choice wins over the default; ?scale= over both, unsaved.
  assert.equal(boot(fakeWindow({ stored: { [AUTO_KEY]: "1.25", [CHOICE_KEY]: "1.15" } })).width, 1028);
  const largest = fakeWindow({ stored: { [AUTO_KEY]: "1.25", [CHOICE_KEY]: "native" } });
  assert.deepEqual([boot(largest).width, largest.styles.has("zoom")], [null, false]);
  // The first visit has no default yet: the app sets it once it knows.
  assert.equal(boot(fakeWindow({ stored: { [CHOICE_KEY]: "1.15" } })).width, null);
  const queried = fakeWindow({ search: "?scale=1.0", stored: { [CHOICE_KEY]: "1.15" } });
  assert.deepEqual([boot(queried).width, boot(queried).source], [1183, "query"]);
  assert.equal(boot(fakeWindow({ search: "?scale=nonsense" })).width, null);
  // The zoom touches neither the window's size nor its pixel ratio.
  assert.deepEqual([car.innerWidth, car.devicePixelRatio], [773, 1.53]);
});

test("the owner's choice is saved, zooms the page, and is reported with what the browser did", async () => {
  const car = fakeWindow();
  boot(car);
  const events = [];
  const display = createDisplayScale({ win: car, eligible: true, record: (type, fields) => events.push({ type, ...fields }) });
  display.init();
  assert.deepEqual(display.options().map((option) => [option.value, option.label, option.isDefault, option.active]), [
    [1, "Smallest", false, false], [1.15, "Smaller", false, false], [1.25, "Default", true, true], [1.35, "Larger", false, false], ["native", "Largest", false, false],
  ]);
  display.choose(1.15);
  assert.equal(car.styles.get("zoom"), "0.7516");
  assert.equal(car.items.get(CHOICE_KEY), "1.15");
  await settle();
  const reported = events.at(-1);
  assert.deepEqual(
    [reported.type, reported.reason, reported.method, reported.scale, reported.zoom, reported.appliedZoom, reported.width, reported.layoutWidth, reported.innerWidth, reported.honoured],
    ["display_scale", "owner", "zoom", 1.15, 0.7516, 0.752, 1028, 1028, 773, true],
  );
  // Yolo still hears of the screen's real size: the window in physical pixels.
  assert.deepEqual([reported.physicalWidth, reported.physicalHeight], [1183, 920]);
  assert.deepEqual(physicalViewport(car), { width: 1183, height: 920 });
  assert.equal(display.options().find((option) => option.active).label, "Smaller");
  display.choose(1);
  assert.equal(display.state.width, 1183, "Smallest: one CSS pixel per physical pixel");
  display.choose("native");
  assert.equal(car.styles.has("zoom"), false);
  assert.equal(car.items.get(CHOICE_KEY), "native");
  assert.equal(display.options().find((option) => option.active).label, "Largest");
  // Full screen: the physical viewport is measured live.
  car.innerHeight = 784;
  assert.deepEqual(physicalViewport(car), { width: 1183, height: 1200 });
});

test("a browser that ignores the zoom is reported as not honouring it", async () => {
  const car = fakeWindow({ honoursZoom: false, stored: { [AUTO_KEY]: "1.25" } });
  boot(car);
  const events = [];
  createDisplayScale({ win: car, eligible: true, record: (type, fields) => events.push({ type, ...fields }) }).init();
  await settle();
  const reported = events.at(-1);
  assert.deepEqual([reported.reason, reported.zoom, reported.appliedZoom, reported.width, reported.layoutWidth, reported.honoured], ["boot", 0.817, 1, 946, 773, false]);
});

test("a device that turns out to be the car gets its size, and one that is not loses it", () => {
  const car = fakeWindow({ stored: { [CHOICE_KEY]: "1.15" } });
  boot(car);
  const display = createDisplayScale({ win: car, eligible: false });
  display.init();
  assert.equal(display.state.scale, null);
  // Yolo says the owner chose "car" for this screen: the saved choice applies.
  display.setEligible(true);
  assert.deepEqual([display.state.scale, display.state.source, car.styles.get("zoom")], [1.15, "owner", "0.7516"]);
  assert.equal(car.items.get(AUTO_KEY), "1.25");
  display.setEligible(false);
  assert.deepEqual([display.state.scale, car.styles.has("zoom"), car.items.get(AUTO_KEY)], [null, false, "native"]);
});
