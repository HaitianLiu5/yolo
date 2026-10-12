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
  - Use touch targets of at least 44 px (`--touch`) for primary in-car controls.
  - Keep playback controls visually quiet until needed.
  - Preserve a stable layout across Tesla and phone viewports.

The palette, spacing, type sizes, radii, and touch sizes are CSS custom properties in [`clients/tesla/src/style.css`](../../../../clients/tesla/src/style.css) that every screen shares: a cool-undertone `oklch` palette, a 4 px spacing scale up to 48 px, type from 13 to 40 px, and frosted menus. Content stays clear of the car's app dock, which covers the bottom of the browser window (`--dock-clearance`). The player's chrome uses 44 px touch targets (`--touch`) with 22 px icons, which is about 67 physical pixels at the car's native scale. Errors the person watching sees are a single sentence with **Try again** and **Back**, never technical detail ([device telemetry](../feature/2026-10-11-device-telemetry.md)).

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

Screens share one visual vocabulary through the tokens, so a new view inherits the palette, spacing, and touch sizes instead of inventing its own. The owner set 44 px as the minimum on 2026-10-12, matching the shipped `--touch` token; an earlier 48 px figure was dropped. A [display size](../feature/2026-10-11-display-size.md) other than native scales every CSS pixel, so touch targets shrink with the chosen size.
