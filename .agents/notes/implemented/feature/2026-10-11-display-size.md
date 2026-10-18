# Agent Note: A display size for the Tesla browser

Status: implemented

English | [中文](2026-10-11-display-size.zh.md)

## Problem

From software 2026.26, Tesla's browser renders at a `devicePixelRatio` of 1.53: a CSS viewport of about 773×601 on about 1183×920 physical pixels. At that ratio the player looks too big, and at one CSS pixel per physical pixel (the community's usual `width=1183`) too small. A size change must not confuse Yolo about how big the screen really is, and must not stop Yolo from recognizing the car.

## Decision

The player's car profile offers display sizes ([`clients/player/src/display-scale.js`](../../../../clients/player/src/display-scale.js)): scales of 1.53 (native), 1.35, 1.25, 1.15, and 1.0 physical pixels per CSS pixel, applied with CSS `zoom` on the root element, zoom = scale / the browser's own `devicePixelRatio` (0.817 for 1.25 at 1.53). The page then lays out `innerWidth / zoom` CSS pixels wide: 946 at the default in the car's 773-pixel window, 1183 at 1.0.

- [`clients/player/public/display-scale-boot.js`](../../../../clients/player/public/display-scale-boot.js) runs in `<head>` before the first layout, sets the saved scale's zoom, and keeps what it applied in `window.__yoloDisplayBoot`.
- Only the car offers a size: the car's [profile](2026-10-11-yolo-web-client.md) (the owner's device type "car", or the [device fingerprint](2026-10-07-device-code-pairing.md) until Yolo has said the type) at a `devicePixelRatio` of at least 1.4. It defaults to 1.25. Every other browser keeps its own scale without a zoom, and a size saved there earlier is ignored: the boot script applies a saved choice only where the app stored a numeric default (`yolo.displayScaleAuto`), and stores `native` elsewhere.
- In the car the owner picks a size in settings, under **This screen**: five steps from **Smallest** (1.0) through **Default** (1.25) to **Largest** (the browser's own 1.53), each shown with a letter of growing size, saved in this device's `localStorage`. `?scale=1.25` (or `native`) applies to one visit only, on any browser, for testing.
- Zoom changes neither `innerWidth` nor `devicePixelRatio`. The fingerprint reads them as they are, so the device is still recognized as a Tesla at any size, and viewport reports to Yolo stay in physical pixels, `innerWidth × devicePixelRatio` (1183×920 in the car) ([capability negotiation](../architecture/2026-10-07-capability-negotiation.md)). The canvas's backing store is the decoded picture's size, which the zoom does not touch; only the box the browser scales it into follows the layout.
- Inside the zoomed root, `getBoundingClientRect()` and pointer coordinates share the window's CSS pixels, so the seek bar, the double-tap sides, and hit tests that compare them need no correction; `clientWidth`, `scrollBy`, and `ResizeObserver` work in the element's own zoomed CSS pixels. `vw`, `vh`, and media queries still measure the unzoomed window (100vw is 82% of the window at the default), so the stylesheet sizes against `#app`, a size container, with `cqw` and `cqh` instead, and a unit test rejects viewport units in the client's stylesheets.
- After a size takes effect, the `display_scale` event reports `method: "zoom"`, the scale, its origin (`default`, `owner`, or `query`), the requested `zoom` and the `appliedZoom` (the body's on-screen width over its CSS width), `width` (the CSS width the zoom should give), `layoutWidth`/`layoutHeight` (what the page lays out at), `physicalWidth`/`physicalHeight`, `innerWidth`/`innerHeight`, `devicePixelRatio`, `visualViewport.scale`, and `honoured` (whether `layoutWidth` equals `width`); the `env` event is sent again ([device telemetry](2026-10-11-device-telemetry.md)).

## Alternatives considered

**Keep the native scale of 1.53.** The player looks too big at that size.

**One CSS pixel per physical pixel, a scale of 1.0.** The player looks too small at that size, and it remains one of the choices.

**`<meta name="viewport" content="width=N">`, the community's mechanism.** The car's browser on software 2026.26 is desktop Chrome 148 on Linux, and desktop Chrome does not apply the viewport meta. On 2026-10-12 the car reported `honoured: false` at the default: the page stayed 773 CSS pixels wide with `visualViewport.scale` 1, so the size never took effect in the car. Zoom is standard in Chromium since version 128 and changes the layout in desktop and mobile Chromium alike. Setting both would apply both in a browser that honours the meta, so the meta is left at `width=device-width`.

**Sizes in every browser, labelled as percentages of native.** On a computer or phone the steps are relative to the browser's own pixel ratio (a Mac at 2x showed 100%, 77%, 68%, 63%, 57%, and 50%), which says nothing to the owner, and those browsers zoom by themselves. Named steps around the default say what changes.

## Consequences

The owner chooses how large the player looks, per device, without changing what Yolo knows about the screen. Every size scales every CSS pixel, so touch targets keep 48 CSS pixels and shrink on screen with the chosen size (about 60 physical pixels at the default). The stylesheet cannot use `vw` or `vh` for sizes that follow the window. Whether the zoom applies in the car, and which default suits the owner best, still have to be confirmed there by a `display_scale` event with `method: "zoom"` and `honoured: true` ([proposal](../../proposed/feature/2026-10-11-in-car-display-size-check.md)); until then, 1.25 is the default for recognized Teslas.

## Testing

[`test/e2e/car-playback.test.js`](../../../../test/e2e/car-playback.test.js) pairs in the car's window (773×601 at 1.53, desktop Chrome) and checks the 946-pixel layout at the default size. The zoom computation, the chosen sizes, and taps at them have no test of their own; the [in-car checks](../testing/2026-07-21-test-layers.md#in-car-checks) cover them.
