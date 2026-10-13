# Agent Note: Design Tesla detection from the car's env event

Status: proposed

English | [中文](2026-10-11-tesla-detection-from-car-telemetry.zh.md)

## Problem

Since software 2026.26, Tesla's browser sends a desktop Chrome user agent without "Tesla", so Yolo guesses the car from its screen: a 14-point fingerprint with thresholds taken from a community project ([device code pairing](../../implemented/feature/2026-10-07-device-code-pairing.md)). In full-screen mode the width and width ratio no longer match, and the score can fall below the threshold of 9. The guess sets the default name and type on the approval page and the default [display size](../../implemented/feature/2026-10-11-display-size.md), so a miss shows up in both.

The guess also decides the playback engine, where the owner's type cannot correct a false match. A page the fingerprint recognizes always plays with the canvas engine and announces the Tesla's canvas capabilities (720p H.264 and AAC), whatever type the owner gave the device, because Tesla can freeze a `<video>` element while the car moves ([two engines](../../implemented/architecture/2026-10-12-two-playback-engines.md)). A desktop browser that the score mistakes for a Tesla therefore plays with the canvas engine and loses what the `<video>` engine brings.

The car's `env` event on 2026-10-12, in normal mode, settled part of the question ([device telemetry](../../implemented/feature/2026-10-11-device-telemetry.md)):

- The user agent is plain Chrome 148 on Linux, and the fingerprint scores 14 of 14.
- The screen is 1254×784 CSS pixels (available 1254×784), the window 773×601, `visualViewport` 773×601 at scale 1, and `devicePixelRatio` 1.53.
- `maxTouchPoints` is 16, while `(pointer: coarse)` and `(hover: none)` are both false.
- The bridge probe found no native bridge: the only non-standard globals were Chrome's own `chrome.loadTimes`, `chrome.csi`, `chrome.app`, and `external.AddSearchProvider`.

## Proposal

Recognizing the car by a bridge or a global name only its browser has is ruled out: this software exposes none. The screen score stays the method. Read the car's `env` event in full-screen mode as well, then retune the score's ranges and threshold from the values measured in both modes. Sixteen touch points on desktop Chrome for Linux with a fine pointer is a candidate signal to weigh, if ordinary desktops do not report it.

## Alternatives considered

**Keep the user agent check and the current score.** It recognizes the owner's car in normal mode (14 of 14) but can miss it in full screen, and its thresholds come from someone else's measurements.

**Recognize the car by a native bridge first.** The probe found no bridge or global name that only the car's browser has, so there is nothing to recognize it by.

**Stop guessing.** The owner already chooses the name and type at approval, but the default display size depends on recognizing the car, and a good guess saves a correction on every pairing.

## Acceptance criteria

The owner's car is recognized as a Tesla in normal and full-screen mode, no desktop browser is recognized as a Tesla (no false positive), and `device-fingerprint.js` and the pairing note describe the method with the data it was based on.

## Risks

Screen measurements can change with any software update or a different model's screen, so the ranges need the car's own reports to stay right. A score loosened to recognize the car in full screen can also match a desktop browser, which would then play with the canvas engine whatever its type. The probe must keep reading only names, types, and keys and never call what it finds, or it could trigger native behavior in the car.
