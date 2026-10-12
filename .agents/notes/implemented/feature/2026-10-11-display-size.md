# Agent Note: A display size for the Tesla browser

Status: implemented

English | [中文](2026-10-11-display-size.zh.md)

## Problem

From software 2026.26, Tesla's browser renders at a `devicePixelRatio` of 1.53: a CSS viewport of about 773×601 on about 1183 physical pixels across. The owner finds the player too big at that size, and the community's usual fix, `width=1183` (one CSS pixel per physical pixel), too small. A size change must not confuse Yolo about how big the screen really is, and must not stop Yolo from recognizing the car.

## Decision

The Tesla client offers display sizes ([`clients/tesla/src/display-scale.js`](../../../../clients/tesla/src/display-scale.js)): scales of 1.53 (native), 1.35, 1.25, 1.15, and 1.0 physical pixels per CSS pixel, set through `<meta name="viewport" content="width=N">` with N = round(physical width / scale).

- [`clients/tesla/public/display-scale-boot.js`](../../../../clients/tesla/public/display-scale-boot.js) runs in `<head>` before the first layout: it measures the physical size before anything changes it (`innerWidth × devicePixelRatio`), keeps it in `window.__yoloDisplayBoot`, and applies the saved scale.
- Only the car offers a size: the car's [profile](2026-10-11-yolo-web-client.md) (the owner's device type "car", or the [device fingerprint](2026-10-07-device-code-pairing.md) until Yolo has said the type) at a `devicePixelRatio` of at least 1.4. It defaults to 1.25. Every other browser keeps its own scale, its meta is left alone, and a size saved there earlier is ignored: the boot script applies a saved choice only where the app stored a numeric default (`yolo.displayScaleAuto`), and stores `native` elsewhere.
- In the car the owner picks a size in settings, under **This screen**: five steps from **Smallest** (1.0) through **Default** (1.25) to **Largest** (the browser's own 1.53), each shown with a letter of growing size, saved in this device's `localStorage`. `?scale=1.25` (or `native`) applies to one visit only, on any browser, for testing.
- The fingerprint uses the measurements taken before the change, so the device is still recognized as a Tesla at any size, and viewport reports to Yolo stay in physical pixels ([capability negotiation](../architecture/2026-10-07-capability-negotiation.md)).
- After a size takes effect, the `display_scale` event reports the scale, `width`, its origin (`default`, `owner`, or `query`), the physical size measured before the change, and afterwards `innerWidth`/`innerHeight`, `clientWidth`, `devicePixelRatio`, `visualViewport.scale`, and `honoured` (whether the layout width equals N); the `env` event is sent again ([device telemetry](2026-10-11-device-telemetry.md)).

## Alternatives considered

**Keep the native scale of 1.53.** The owner finds the player too big at that size.

**The community's `width=1183`, a scale of 1.0.** The owner finds it too small, and it remains one of the choices.

**Sizes in every browser, labelled as percentages of native.** On a computer or phone the steps are relative to the browser's own pixel ratio (a Mac at 2x showed 100%, 77%, 68%, 63%, 57%, and 50%), which says nothing to the owner; those browsers zoom by themselves, and a fixed viewport width would break their responsive layout. Named steps around the default say what changes.

## Consequences

The owner chooses how large the player looks, per device, without changing what Yolo knows about the screen. Whether the car's browser honours widths other than 1183, and which default suits the owner best, still have to be confirmed in the car ([proposal](../../proposed/feature/2026-10-11-in-car-display-size-check.md)); until then, 1.25 is the default for recognized Teslas.
