# Agent Note: In-car design principles

Status: implemented

English | [中文](2026-07-13-in-car-design-principles.zh.md)

## Problem

The player is used first by occupants on a large in-car touchscreen (its car profile) and also in a computer's or phone's browser (its web profile), and the owner's web pages sit beside it. The main job is to start and control media with as little typing and precise tapping as possible, and the controls must also work from a phone-sized browser. Without a stated direction, each screen drifts toward a developer dashboard or a generic streaming-app clone.

## Decision

Every screen follows one design context:

- **Personality:** calm, direct, cinematic. It should feel dependable and purpose-built for a car, not like a developer dashboard or a generic streaming clone.
- **Aesthetic direction:** a restrained black interface with high contrast, large touch targets, and sparse typography. Functional state matters more than decoration. Avoid neon effects, busy cards, tiny controls, and modal-heavy settings.
- **Principles:**
  - Prefer one-tap choices over typed configuration.
  - Make the current state visible before the user acts.
  - Use touch targets of at least 48 px (`--touch`) for primary in-car controls.
  - Keep playback controls visually quiet until needed.
  - Preserve a stable layout across Tesla and phone viewports.

The palette, spacing, type sizes, radii, and touch sizes are CSS custom properties in [`clients/player/src/style.css`](../../../../clients/player/src/style.css) that every screen shares: a neutral `oklch` palette on pure black, a 4 px spacing scale up to 48 px, type from 13 to 40 px, and frosted menus. Every control uses the 48 px touch target (`--touch`) with 22 px icons; at the car's default display size that is about 60 physical pixels. Errors the person watching sees are a single sentence with **Try again** and **Back**, never technical detail ([device telemetry](../feature/2026-10-11-device-telemetry.md)).

The car's browser window ends above the car's app dock: the window is 601 CSS pixels (920 physical pixels) tall, and Tesla's status bar, the browser's toolbar, and the dock take the rest of the 1200-pixel panel. So the layout keeps no band for the dock, only the bottom edge's own safe-area inset (`--safe-bottom`, a phone's home indicator). The player centres the picture in the whole window, not in the space below the top bar, because the top bar hides with the controls and the picture would sit low while watching. Its progress bar and controls sit on the window's bottom edge, which puts them in the band below a 16:9 picture, and the top bar in the band above it; menus fit between the two.

The player's controls follow the YouTube app on a phone or tablet, because the car's screen is a touch screen ([`controls.js`](../../../../clients/player/src/controls.js)). A tap on the picture shows one overlay over a soft scrim, even across the picture with no darker bands at the top and bottom; another tap, 3 seconds of playing, or a mouse leaving the player hides it, and while paused it stays. A tap never pauses by itself, and on a car's screen every press counts as a touch, whatever pointer the browser reports. The overlay holds the top bar (Back, the title, and the danmaku, subtitle, audio, volume, and settings buttons, audio only when there is a track to choose), previous, play/pause, and next over the picture's centre (previous when Yolo's history has an earlier item, next when the queue has one), and the time, the progress bar, and fullscreen in one row on the bottom edge. A double tap on the left or right third seeks 10 seconds back or ahead, 10 more for each further tap, with YouTube's ripple and without showing the overlay; a press and hold plays at twice the speed while held, on the `<video>` engine only, because the canvas engine's frames follow its audio clock; and a swipe down is Back. Danmaku stays under the overlay, frozen while paused, and the overlay's scrim dims it; subtitles take YouTube's size and place, 16 pixels for every 360 of the picture's height (at least 16) and 2% of its height above its bottom edge, and stay just above the bottom row while it shows. The pointer hides with the controls; while a stream loads, a mouse's movement shows it alone. On a phone held upright, as in the YouTube app, the top bar and the bottom row lie on the picture itself, and while they show, subtitles move into the band below the picture. With a mouse, a click plays or pauses, and Space or K, J and L, the arrow keys, F, and M work as on YouTube.

The same tokens serve [Yolo Web](../feature/2026-10-11-yolo-web-client.md) in a computer's or phone's browser and the owner's web pages, which add a light scheme that follows the system setting ([owner web pages](2026-10-12-owner-web-pages.md)); the Yolo mark and the device types' icons come from one module. Lists, sheets, and pages carry their structure with spacing, grouping, and type rather than borders and divider lines, keep one left edge with actions on the right, and say only the essential sentence. Settings are one sheet whose destructive actions confirm in place, never a dialog over a dialog; every pressable control moves when pressed, and the sheet works with a keyboard as well as a touchscreen.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

Screens share one visual vocabulary through the tokens, so a new view inherits the palette, spacing, and touch sizes instead of inventing its own. A [display size](../feature/2026-10-11-display-size.md) other than native scales every CSS pixel, so touch targets shrink with the chosen size.
