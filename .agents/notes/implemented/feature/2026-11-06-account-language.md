# Agent Note: The account keeps a language for its screens

Status: implemented

English | [中文](2026-11-06-account-language.zh.md)

## Problem

[Each screen chooses its language](2026-10-26-player-language.md), and a screen that has not chosen follows its browser. The owner reads Chinese on several screens whose browsers answer English, so the choice had to be found and made again on each one, and every new screen started in English.

## Decision

The account keeps one language, which every screen on Automatic shows. A screen's own choice still wins.

- **The order.** A screen's choice, then the account's language, then the browser's languages ([`clients/player/src/i18n.js`](../../../../clients/player/src/i18n.js)).
- **Setting it.** **Settings › Your Yolo › Every screen › Language** offers Automatic, English, and 简体中文. `PUT /v1/owner/language` keeps the choice in `language_settings`, one row per user, behind the owner's passkey session like every owner setting; Automatic removes the row ([`service/control/src/store/language-settings.js`](../../../../service/control/src/store/language-settings.js)).
- **Reaching a screen.** A welcome carries `language`, a tag or null, and a change goes to every connected screen as a `language` message. Both are optional under the [client protocol](../architecture/2026-10-19-client-protocol.md), so a client that ignores them keeps its own language and no protocol number moves. A welcome from a Hub that could not read the language, or from one older than this, leaves the field out, and the screen keeps what it knows rather than fall back to its browser.
- **What a screen does.** It keeps the last language it heard in `localStorage` (`yolo.accountLanguage`), so a page draws in it as it loads, before any connection. When that changes what the page shows, the page loads again, as a screen's own choice does. A page with a player on screen, or one kept behind home, goes on as it is and changes at a later welcome or load. So does a window that another window of the same screen replaced, until it takes the screen back: its load would say hello and stop what the other window plays. The screen where the owner made the change loads at once, whatever it plays, since the change was made on it. A page whose storage does not keep the language never loads again for it: the next load would only ask again, without end.
- **What it says to Yolo.** The language that goes with a voice request and a question to an agent is the screen's choice, then the account's, then the browser's.
- **Other languages.** The server takes any language tag, so a client that shows more languages needs no change there. A release that does not show the tag treats it as none.

## Alternatives considered

**One language with no choice on a screen.** It is the simplest model, and the owner would never meet a screen that disagrees. But two people on different screens may read different languages, and the car rarely has the owner's session to change anything. [The reasons a screen chooses](2026-10-26-player-language.md) still hold; only the default moved.

**Any paired screen sets the account's language from This screen's row.** One row would be simpler, and the car could set it without a passkey. But a device credential never reaches an owner setting, and someone choosing a language for the screen in front of them should not change everyone else's.

**The first choice on any screen becomes the account's.** New screens would follow without the owner finding a second setting. It has the same problem as the row above, and it would change other screens as a side effect that nothing on the row explains.

**Asking for the language over HTTP before the first draw.** A page would never show the wrong language, but it would wait on the network before drawing anything, which the car's connection makes the worst place to wait. Keeping the last language draws at once and corrects at most once.

**Loading a playing screen again at once.** Every screen would agree immediately, but a change made in one room would stop what someone is watching in another.

## Consequences

One setting changes every screen on Automatic, in the moment for those that are idle and later for those playing. A screen with its own choice stays as it is until it is set back to Automatic. A screen that pairs after the change draws its pairing code in its browser's language and loads once after its first welcome. Yolo keeps one more small row, which the [privacy policy](../../../../site/public/privacy.html) names. The Apple apps ignore both messages until they take them up, and pages the Worker draws itself, such as sign-in, do not read this language.
