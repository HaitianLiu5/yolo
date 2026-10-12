# Agent Note: Design Tesla detection from the car's env event

Status: proposed

English | [中文](2026-10-11-tesla-detection-from-car-telemetry.zh.md)

## Problem

Since software 2026.26, Tesla's browser sends a desktop Chrome user agent without "Tesla", so Yolo guesses the car from its screen: a 14-point fingerprint with thresholds taken from a community project ([device code pairing](../../implemented/feature/2026-10-07-device-code-pairing.md)). In full-screen mode the width and width ratio no longer match, and the score can fall below the threshold of 9. The guess sets the default name and type on the approval page and the default [display size](../../implemented/feature/2026-10-11-display-size.md), so a miss shows up in both.

## Proposal

The `env` event already reports what a better method needs ([device telemetry](../../implemented/feature/2026-10-11-device-telemetry.md)): the fingerprint's score breakdown (`tesla`) and a bounded probe of native bridges — global names beyond the standard ones, the type and keys of known bridge names such as `qt`, `cefQuery`, `chrome.webview`, `webkit.messageHandlers`, `tesla`, or `QtCarBrowser`, and non-standard `navigator` properties. Read the car's `env` events in normal and full-screen mode, then:

- if a bridge or global name exists only in the car's browser, recognize the car by it first, and keep the screen score as the fallback;
- otherwise retune the score's ranges and threshold from the measured values in both modes.

## Alternatives considered

**Keep the user agent check and the current score.** It works for the owner's car in normal mode but can miss it in full screen, and its thresholds come from someone else's measurements.

**Stop guessing.** The owner already chooses the name and type at approval, but the default display size depends on recognizing the car, and a good guess saves a correction on every pairing.

## Acceptance criteria

The owner's car is recognized as a Tesla in normal and full-screen mode, an ordinary desktop Chrome is not, and `device-fingerprint.js` and the pairing note describe the method with the data it was based on.

## Risks

Bridge names and globals can change with any software update, so a method based on them needs the score as a fallback. The probe must keep reading only names, types, and keys and never call what it finds, or it could trigger native behavior in the car.
