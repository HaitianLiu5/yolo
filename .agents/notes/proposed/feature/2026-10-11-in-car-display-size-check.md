# Agent Note: Confirm display sizes in the car and choose the default

Status: proposed

English | [中文](2026-10-11-in-car-display-size-check.zh.md)

## Problem

The [display size](../../implemented/feature/2026-10-11-display-size.md) first set `<meta name="viewport" content="width=N">`. The car's `display_scale` event on 2026-10-12 (software 2026.26, desktop Chrome 148 on Linux) answered whether the browser honours it: `honoured: false` at the default 1.25, with the page still 773 CSS pixels wide and `visualViewport.scale` 1, so no size ever took effect in the car. The display size now zooms the root element instead, which Chromium applies since version 128, but no `display_scale` event from the car has confirmed it yet. The default of 1.25 for recognized Teslas was chosen without seeing it in the car.

## Proposal

In the car, try every display size from **Display size** in settings and read the `display_scale` events in Workers Logs ([device telemetry](../../implemented/feature/2026-10-11-device-telemetry.md)): `method` (`zoom`), `honoured` (whether `layoutWidth` equals `width`, 946 at the default), `zoom` and `appliedZoom`, `innerWidth`/`innerHeight`, `devicePixelRatio`, and `visualViewport.scale` after each change. Then:

- remove any size the browser does not honour, and
- let the owner pick the default for a Tesla from the sizes that work, and update `TESLA_DEFAULT_SCALE` and the display-size note.

## Alternatives considered

**Keep 1.25 without checking.** The viewport meta already did nothing in the car without anyone noticing; if the zoom failed there too, the owner's choice would again be a placebo.

**Offer only the native size and 1.0.** It avoids the question but drops the in-between sizes that motivated the feature, since the owner finds native too big and 1.0 too small.

## Acceptance criteria

Every size settings offer reports `method: "zoom"` and `honoured: true` in the car, or has been removed; the owner has chosen the Tesla default from the remaining sizes; and the display-size note states the confirmed sizes and default.

## Risks

A later Tesla software update can change the browser, so a confirmed result can expire. The check needs the owner in the car with the screen awake.
