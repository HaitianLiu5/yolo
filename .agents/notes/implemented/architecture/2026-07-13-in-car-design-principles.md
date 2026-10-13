# Agent Note: In-car design principles

Status: implemented

English | [中文](2026-07-13-in-car-design-principles.zh.md)

## Problem

The Tesla client is used by occupants on a large in-car touchscreen. The main job is to start and control canvas-rendered media with as little typing and precise tapping as possible, and the controls must also work from a phone-sized browser. Without a stated direction, each screen drifts toward a developer dashboard or a generic streaming-app clone.

## Decision

The client's interface follows one design context:

- **Personality:** calm, direct, cinematic. It should feel dependable and purpose-built for a car, not like a developer dashboard or a generic streaming clone.
- **Aesthetic direction:** a restrained, cool-tinted dark interface with high contrast, large touch targets, and sparse typography. Functional state matters more than decoration. Avoid neon effects, busy cards, tiny controls, and modal-heavy settings.
- **Principles:**
  - Prefer one-tap choices over typed configuration.
  - Make the current state visible before the user acts.
  - Use touch targets of at least 48 px (`--touch`) for primary in-car controls.
  - Keep playback controls visually quiet until needed.
  - Preserve a stable layout across Tesla and phone viewports.

The palette, spacing, type sizes, radii, and touch sizes are CSS custom properties in [`clients/tesla/src/style.css`](../../../../clients/tesla/src/style.css) that every screen shares: a cool-undertone `oklch` palette, a 4 px spacing scale up to 48 px, type from 13 to 40 px, and frosted menus. Every control uses the 48 px touch target (`--touch`) with 22 px icons; at the car's default display size that is about 60 physical pixels. Errors the person watching sees are a single sentence with **Try again** and **Back**, never technical detail ([device telemetry](../feature/2026-10-11-device-telemetry.md)).

The car's browser window ends above the car's app dock: the window is 601 CSS pixels (920 physical pixels) tall, and Tesla's status bar, the browser's toolbar, and the dock take the rest of the 1200-pixel panel. So the layout keeps no band for the dock, only the bottom edge's own safe-area inset (`--safe-bottom`, a phone's home indicator). The player centres the picture in the whole window, not in the space below the top bar, because the top bar hides with the controls and the picture would sit low while watching. Its progress bar and controls sit on the window's bottom edge, which puts them in the band below a 16:9 picture, and the top bar in the band above it; menus fit between the two.

The same tokens serve [Yolo Web](../feature/2026-10-11-yolo-web-client.md) in a computer's or phone's browser and the owner's web pages, which add a light scheme that follows the system setting ([owner web pages](2026-10-12-owner-web-pages.md)); the Yolo mark and the device types' icons come from one module. Lists, sheets, and pages carry their structure with spacing, grouping, and type rather than borders and divider lines, keep one left edge with actions on the right, and say only the essential sentence. Settings are one sheet whose destructive actions confirm in place, never a dialog over a dialog; every pressable control moves when pressed, and the sheet works with a keyboard as well as a touchscreen.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

Screens share one visual vocabulary through the tokens, so a new view inherits the palette, spacing, and touch sizes instead of inventing its own. A [display size](../feature/2026-10-11-display-size.md) other than native scales every CSS pixel, so touch targets shrink with the chosen size.
