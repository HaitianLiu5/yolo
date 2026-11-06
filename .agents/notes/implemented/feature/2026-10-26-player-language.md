# Agent Note: The player speaks the screen's language

Status: implemented

English | [中文](2026-10-26-player-language.zh.md)

## Problem

The player was written in English only. Its owner speaks Chinese, and the screens that matter most are a car and a phone whose browsers may be set to English: the Mac whose Chrome answers `en-US` heard Chinese voice requests without a Chinese hint, and the speech model, left to detect the language, wrote some of them in traditional characters. Following the browser alone could not say what the person in front of the screen reads and speaks. The pages Yolo's server renders for signing in, pairing, and approving were English too, so a screen set to Chinese sent its owner to an English page.

## Decision

The player shows English or Simplified Chinese, and each screen chooses ([`clients/player/src/i18n.js`](../../../../clients/player/src/i18n.js)).

- **The choice.** **Settings › This screen › Language** offers Automatic, English, and 简体中文, each named in its own language, and keeps the choice in `localStorage` (`yolo.language`), as with the agent the screen asks. Automatic follows the browser's languages in order: the first that is Chinese, in any script or region, means Simplified Chinese, the first that is English means English, and none of either means English. A choice made on the screen wins over the browser. Changing it reloads the page, so everything is drawn again in it; the language is read once, when the page loads.
- **The text.** The English text is the key: `t(text, values)` returns the text in the screen's language, from [`clients/player/src/locales/zh-Hans.js`](../../../../clients/player/src/locales/zh-Hans.js) for Chinese, and the English itself where the catalog has no entry. A value goes in by name (`{agent}`), so a translation can place it anywhere in its sentence. The page's own text in `index.html`, its text nodes and `aria-label`, `placeholder`, `title`, and `alt` values, is looked up the same way when the page starts, before anything draws, and `<html lang>` says the language. Dates take the language as their locale.
- **What is translated.** Everything the player itself shows: the home screen, search, episodes, the player's controls and menus, the loading and error screens, Ask and its voice input, pairing, and Settings. Device events, logs, error codes, and what the screen sends to Yolo stay as they are. An API error's message shows as the server wrote it, on the owner's pages too, as do titles, agents' names, and agents' answers.
- **What it says to Yolo.** A screen with a choice sends that language with a voice request (`POST /v1/agent/transcriptions?language=`) and a question to its agent; without one it sends the browser's, as before. A screen set to Chinese is therefore heard as Chinese by the transcriber, in simplified characters, whatever its browser says ([voice input](2026-10-18-agent-from-the-screen.md#voice-input)), and its agent is told the screen is set to `zh-Hans`.
- **The owner's pages.** The sign-in, pairing, consent, account, and plugin-request pages the control plane renders show the same two languages ([`service/control/src/auth/i18n.js`](../../../../service/control/src/auth/i18n.js)). The server writes them before any script runs, often for a phone that just scanned a QR code, and it cannot read `localStorage`, so the request says the language: the `Accept-Language` header in its order of preference, by the same rule as Automatic (`languageFromTags()` in [`service/core/src/language.js`](../../../../service/core/src/language.js)), and over it a `yolo-language` cookie. The player writes that cookie from its choice each time it loads and clears it on Automatic, so a browser whose player has a choice sees these pages in it. Each request gets its own `t` (`pageWords(request)`), because the Worker answers many at once and a language kept in the module would cross between them. The English text is the key here too ([`service/control/src/auth/locales/zh-Hans.js`](../../../../service/control/src/auth/locales/zh-Hans.js)); the pages' inline scripts take their words from the same `t`, `<html lang>` says the language, and a plugin's title, summary, and privacy line use its `zh` text.
- **The gate.** [`clients/player/test/unit/i18n.test.js`](../../../../clients/player/test/unit/i18n.test.js) reads every `t()` of a literal under `clients/player/src` and the page's own text, and fails when one has no Chinese, when the catalog holds an entry nothing shows, or when a value is named differently in the two languages. Text therefore goes through `t()` as a literal where it is written, never as a variable. [`service/control/test/unit/i18n.test.js`](../../../../service/control/test/unit/i18n.test.js) does the same for `service/control/src/auth`, and renders every page in both languages, failing on English left in a Chinese page's text or script.

The Apple TV app is not covered; it keeps its own strings.

## Alternatives considered

**Following the browser's language only.** It needs no setting, but the car's and the owner's own browsers are set to English while the owner reads and speaks Chinese, which is how voice requests came back in traditional characters. The browser stays the default; a choice on the screen overrides it.

**One language for the whole account.** Owner settings sit behind the passkey session, which the car rarely has, and two people watching on different screens may read different languages. A per-screen choice is made where it is seen, without signing in, like the agent the screen asks.

**Symbolic keys (`ask.listening`) or a library such as i18next.** Keys would need an English catalog beside the code and a lookup to read any screen's text, and a library adds a dependency and a format to a client that has none. The English text as key keeps the code readable as it was, falls back to English by itself, and the gate keeps the catalog complete.

**Switching the language in place, without a reload.** Every screen would have to draw itself again on a change, and text made when a module loads would stay in the old language. A language changes rarely, from Settings, so a reload is the simpler whole.

**A script on the owner's pages that reads `localStorage` and redraws them.** It needs no cookie, but each page would first show in the browser's language, and the answer to a form would have to be drawn again the same way. The cookie tells the server before it writes anything, a form's answer included.

**The language in the pairing link.** A screen set to Chinese could put its language in its QR code, and the sign-in page would have to carry it through `next`. The page is read on the phone by whoever holds it, so that phone's own language or choice decides.

**Converting the transcriber's traditional characters to simplified on the node.** It would fix only the voice input's script, for every owner, including those who read traditional characters, and not the language the player shows. The screen's choice settles both, and an automatic screen still follows its browser.

## Consequences

A screen set to Chinese reads Chinese throughout and is heard as Chinese, in simplified characters, whatever its browser says. Every new text in the player or on the owner's pages needs its Chinese in the same change, which the gates enforce, and a sentence is written whole with named values rather than built from pieces. Text from Yolo's server and from agents is not translated, so a Chinese screen or owner's page can still show an English error from the server. A browser with a chosen language sends one short cookie with each request to Yolo's origin, which the server reads for these pages and does not keep. A phone that never opened the player follows its own languages, even when the car beside it is set to Chinese. Only English and Simplified Chinese exist; another language is a catalog and a line in `LANGUAGES`. Changing the language reloads the page, which stops what the screen plays until it resumes.
