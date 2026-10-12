# Agent Note: A display size for the Tesla browser

Status: implemented

English | [中文](2026-10-11-display-size.zh.md)

## Problem

From software 2026.26, Tesla's browser renders at a `devicePixelRatio` of 1.53: a CSS viewport of about 773×601 on about 1183 physical pixels across. The owner finds the player too big at that size, and the community's usual fix, `width=1183` (one CSS pixel per physical pixel), too small. A size change must not confuse Yolo about how big the screen really is, and must not stop Yolo from recognizing the car.

## Decision

The Tesla client offers display sizes ([`clients/tesla/src/display-scale.js`](../../../../clients/tesla/src/display-scale.js)): scales of 1.53 (native), 1.35, 1.25, 1.15, and 1.0 physical pixels per CSS pixel, set through `<meta name="viewport" content="width=N">` with N = round(physical width / scale).

- [`clients/tesla/public/display-scale-boot.js`](../../../../clients/tesla/public/display-scale-boot.js) runs in `<head>` before the first layout: it measures the physical size before anything changes it (`innerWidth × devicePixelRatio`), keeps it in `window.__yoloDisplayBoot`, and applies the saved scale.
- A Tesla on 2026.26 or later, recognized by the [device fingerprint](2026-10-07-device-code-pairing.md) with a `devicePixelRatio` of at least 1.4, defaults to 1.25; every other browser defaults to native and its meta is left alone.
- The owner picks a size under **Display size** at the bottom of the home screen, shown as a percentage of native size (100%, 88%, 82%, 75%, 65%) and saved in this device's `localStorage`. `?scale=1.25` (or `native`) applies to one visit only, for testing.
- The fingerprint uses the measurements taken before the change, so the device is still recognized as a Tesla at any size, and viewport reports to Yolo stay in physical pixels ([capability negotiation](../architecture/2026-10-07-capability-negotiation.md)).
- After a size takes effect, the `display_scale` event reports the scale, `width`, its origin (`default`, `owner`, or `query`), the physical size measured before the change, and afterwards `innerWidth`/`innerHeight`, `clientWidth`, `devicePixelRatio`, `visualViewport.scale`, and `honoured` (whether the layout width equals N); the `env` event is sent again ([device telemetry](2026-10-11-device-telemetry.md)).

## Alternatives considered

**Keep the native scale of 1.53.** The owner finds the player too big at that size.

**The community's `width=1183`, a scale of 1.0.** The owner finds it too small, and it remains one of the choices.

## Consequences

The owner chooses how large the player looks, per device, without changing what Yolo knows about the screen. Whether the car's browser honours widths other than 1183, and which default suits the owner best, still have to be confirmed in the car ([proposal](../../proposed/feature/2026-10-11-in-car-display-size-check.md)); until then, 1.25 is the default for recognized Teslas.
