# Agent Note: Confirm display sizes in the car and choose the default

Status: proposed

English | [中文](2026-10-11-in-car-display-size-check.zh.md)

## Problem

The [display size](../../implemented/feature/2026-10-11-display-size.md) sets `<meta name="viewport" content="width=N">` for scales between 1.53 and 1.0, but nobody has confirmed that Tesla's browser honours viewport widths other than 1183, the community's usual value. The default of 1.25 for recognized Teslas was chosen without trying it in the car.

## Proposal

In the car, try every display size from the home screen's **Display size** control and read the `display_scale` events in Workers Logs ([device telemetry](../../implemented/feature/2026-10-11-device-telemetry.md)): `honoured` (whether the layout width equals N), `innerWidth`/`innerHeight`, `clientWidth`, `devicePixelRatio`, and `visualViewport.scale` after each change. Then:

- remove any size the browser does not honour, and
- let the owner pick the default for a Tesla from the sizes that work, and update `TESLA_DEFAULT_SCALE` and the display-size note.

## Alternatives considered

**Keep 1.25 without checking.** If the browser ignores widths other than 1183, the setting silently does nothing in the car, and the owner's choice is a placebo.

**Offer only native and 1183.** It avoids the question but drops the in-between sizes that motivated the feature, since the owner finds native too big and 1183 too small.

## Acceptance criteria

Every size the home screen offers reports `honoured: true` in the car, or has been removed; the owner has chosen the Tesla default from the remaining sizes; and the display-size note states the confirmed sizes and default.

## Risks

A later Tesla software update can change how the browser treats the viewport meta, so a confirmed result can expire. The check needs the owner in the car with the screen awake.
