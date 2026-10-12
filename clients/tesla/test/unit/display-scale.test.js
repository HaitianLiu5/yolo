import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  AUTO_KEY, CHOICE_KEY, createDisplayScale, defaultScale, isNativeScale, physicalViewport, scaleLabel, TESLA_DEFAULT_SCALE, viewportWidthFor,
} from "../../src/display-scale.js";

const bootScript = readFileSync(new URL("../../public/display-scale-boot.js", import.meta.url), "utf8");
const TESLA_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// A window as the Tesla browser on 2026.26 presents it, or another one.
function fakeWindow({ dpr = 1.53, width = 773, height = 601, screen = { width: 1254, height: 784 }, search = "", stored = {} } = {}) {
  const items = new Map(Object.entries(stored));
  const meta = { content: "width=device-width, initial-scale=1.0", setAttribute(name, value) { this[name] = value; } };
  return {
    devicePixelRatio: dpr,
    innerWidth: width,
    innerHeight: height,
    screen,
    navigator: { userAgent: TESLA_UA },
    visualViewport: { scale: 1 },
    location: { search },
    localStorage: { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) },
    document: { querySelector: () => meta, documentElement: { clientWidth: width } },
    meta,
    items,
  };
}

// The boot script, as the page runs it before its first layout.
function boot(win) {
  runInNewContext(bootScript, { window: win, document: win.document, URLSearchParams });
  return win.__yoloDisplayBoot;
}

test("the viewport width shows the physical width at the chosen scale", () => {
  // 773 CSS px at 1.53 is 1183 physical pixels: the community's width=1183.
  assert.equal(viewportWidthFor(Math.round(773 * 1.53), 1.0), 1183);
  assert.equal(viewportWidthFor(1183, 1.25), 946);
  assert.equal(viewportWidthFor(1183, 1.35), 876);
  assert.equal(viewportWidthFor(1183, 1.15), 1029);
  assert.equal(viewportWidthFor(1183, 1.53), 773);
  assert.equal(isNativeScale(1.53, 1.53), true);
  assert.equal(isNativeScale(null, 1.53), true);
  assert.equal(isNativeScale(1.25, 1.53), false);
  assert.deepEqual([scaleLabel(null, 1.53), scaleLabel(1.25, 1.53), scaleLabel(1.0, 1.53), scaleLabel(1.25, 1)], ["100%", "82%", "65%", "125%"]);
});

test("a Tesla on 2026.26 starts at 1.25; older software and other browsers stay native", () => {
  assert.equal(defaultScale({ tesla: true }, 1.53), TESLA_DEFAULT_SCALE);
  assert.equal(defaultScale({ tesla: true }, 1.0), null, "older software renders at 1.0");
  assert.equal(defaultScale({ tesla: false }, 1.53), null);

  const car = fakeWindow();
  boot(car);
  const carScale = createDisplayScale({ win: car });
  carScale.init();
  assert.deepEqual(carScale.state, { scale: 1.25, width: 946, source: "default", nativeScale: 1.53 });
  assert.equal(car.meta.content, "width=946");
  assert.equal(car.items.get(AUTO_KEY), "1.25", "the boot script applies it first thing next time");

  const laptop = fakeWindow({ dpr: 2, width: 1440, height: 900, screen: { width: 1440, height: 900 } });
  boot(laptop);
  const laptopScale = createDisplayScale({ win: laptop });
  laptopScale.init();
  assert.equal(laptopScale.state.scale, null);
  assert.equal(laptop.meta.content, "width=device-width, initial-scale=1.0", "no change elsewhere");
  assert.equal(laptop.items.get(AUTO_KEY), "native");
});

test("the boot script applies the saved size before the first layout, from what it measured first", () => {
  const car = fakeWindow({ stored: { [AUTO_KEY]: "1.25" } });
  const measured = boot(car);
  assert.deepEqual([measured.physicalWidth, measured.physicalHeight, measured.scale, measured.width, measured.source], [1183, 920, 1.25, 946, "default"]);
  assert.equal(car.meta.content, `width=${viewportWidthFor(1183, 1.25)}`);
  // The owner's choice wins over the default; ?scale= over both, unsaved.
  assert.equal(boot(fakeWindow({ stored: { [AUTO_KEY]: "1.25", [CHOICE_KEY]: "1.15" } })).width, 1029);
  assert.equal(boot(fakeWindow({ stored: { [CHOICE_KEY]: "native" } })).width, null);
  const queried = fakeWindow({ search: "?scale=1.0", stored: { [CHOICE_KEY]: "1.15" } });
  assert.deepEqual([boot(queried).width, boot(queried).source], [1183, "query"]);
  assert.equal(boot(fakeWindow({ search: "?scale=nonsense" })).width, null);
});

test("the owner's choice is saved, re-lays out the page, and is reported with what the browser did", async () => {
  const car = fakeWindow();
  boot(car);
  const events = [];
  const display = createDisplayScale({ win: car, record: (type, fields) => events.push({ type, ...fields }) });
  display.init();
  assert.deepEqual(display.options().map((option) => [option.value, option.label, option.active]), [
    ["native", "100%", false], [1.35, "88%", false], [1.25, "82%", true], [1.15, "75%", false], [1, "65%", false],
  ]);
  // The browser applies width=1029 (the page lays out 1029 CSS px wide).
  display.choose(1.15);
  car.innerWidth = 1029;
  car.innerHeight = 800;
  car.document.documentElement.clientWidth = 1029;
  assert.equal(car.meta.content, "width=1029");
  assert.equal(car.items.get(CHOICE_KEY), "1.15");
  await new Promise((done) => setTimeout(done, 500));
  const reported = events.at(-1);
  assert.deepEqual(
    [reported.type, reported.reason, reported.scale, reported.width, reported.innerWidth, reported.clientWidth, reported.honoured, reported.physicalWidth],
    ["display_scale", "owner", 1.15, 1029, 1029, 1029, true, 1183],
  );
  // Yolo still hears of the screen's real size, not a 1029-wide one at 1.53.
  assert.deepEqual(physicalViewport(car), { width: 1183, height: 920 });
  display.choose("native");
  assert.equal(car.meta.content, "width=device-width, initial-scale=1.0");
  assert.equal(car.items.get(CHOICE_KEY), "native");
});

test("without a scale the physical viewport is measured live", () => {
  const laptop = fakeWindow({ dpr: 2, width: 1000, height: 700 });
  assert.deepEqual(physicalViewport(laptop), { width: 2000, height: 1400 });
});
