# Agent Note: The player speaks the screen's language

Status: implemented

English | [中文](2026-10-26-player-language.zh.md)

## Problem

The player was written in English only. Its owner speaks Chinese, and the screens that matter most are a car and a phone whose browsers may be set to English: the Mac whose Chrome answers `en-US` heard Chinese voice requests without a Chinese hint, and the speech model, left to detect the language, wrote some of them in traditional characters. Following the browser alone could not say what the person in front of the screen reads and speaks.

## Decision

The player shows English or Simplified Chinese, and each screen chooses ([`clients/player/src/i18n.js`](../../../../clients/player/src/i18n.js)).

- **The choice.** **Settings › This screen › Language** offers Automatic, English, and 简体中文, each named in its own language, and keeps the choice in `localStorage` (`yolo.language`), as with the agent the screen asks. Automatic follows the browser's languages in order: the first that is Chinese, in any script or region, means Simplified Chinese, the first that is English means English, and none of either means English. A choice made on the screen wins over the browser. Changing it reloads the page, so everything is drawn again in it; the language is read once, when the page loads.
- **The text.** The English text is the key: `t(text, values)` returns the text in the screen's language, from [`clients/player/src/locales/zh-Hans.js`](../../../../clients/player/src/locales/zh-Hans.js) for Chinese, and the English itself where the catalog has no entry. A value goes in by name (`{agent}`), so a translation can place it anywhere in its sentence. The page's own text in `index.html`, its text nodes and `aria-label`, `placeholder`, `title`, and `alt` values, is looked up the same way when the page starts, before anything draws, and `<html lang>` says the language. Dates take the language as their locale.
- **What is translated.** Everything the player itself shows: the home screen, search, episodes, the player's controls and menus, the loading and error screens, Ask and its voice input, pairing, and Settings. Device events, logs, error codes, and what the screen sends to Yolo stay as they are. Words Yolo's server writes, such as an API error's message, show as the server wrote them, as do titles, agents' names, and agents' answers.
- **What it says to Yolo.** A screen with a choice sends that language with a voice request (`POST /v1/agent/transcriptions?language=`) and a question to its agent; without one it sends the browser's, as before. A screen set to Chinese is therefore heard as Chinese by the transcriber, in simplified characters, whatever its browser says ([voice input](2026-10-18-agent-from-the-screen.md#voice-input)), and its agent is told the screen is set to `zh-Hans`.
- **The gate.** [`clients/player/test/unit/i18n.test.js`](../../../../clients/player/test/unit/i18n.test.js) reads every `t()` of a literal under `clients/player/src` and the page's own text, and fails when one has no Chinese, when the catalog holds an entry nothing shows, or when a value is named differently in the two languages. Text therefore goes through `t()` as a literal where it is written, never as a variable.

The Apple TV app is not covered; it keeps its own strings.

## Alternatives considered

**Following the browser's language only.** It needs no setting, but the car's and the owner's own browsers are set to English while the owner reads and speaks Chinese, which is how voice requests came back in traditional characters. The browser stays the default; a choice on the screen overrides it.

**One language for the whole account.** Owner settings sit behind the passkey session, which the car rarely has, and two people watching on different screens may read different languages. A per-screen choice is made where it is seen, without signing in, like the agent the screen asks.

**Symbolic keys (`ask.listening`) or a library such as i18next.** Keys would need an English catalog beside the code and a lookup to read any screen's text, and a library adds a dependency and a format to a client that has none. The English text as key keeps the code readable as it was, falls back to English by itself, and the gate keeps the catalog complete.

**Switching the language in place, without a reload.** Every screen would have to draw itself again on a change, and text made when a module loads would stay in the old language. A language changes rarely, from Settings, so a reload is the simpler whole.

**Converting the transcriber's traditional characters to simplified on the node.** It would fix only the voice input's script, for every owner, including those who read traditional characters, and not the language the player shows. The screen's choice settles both, and an automatic screen still follows its browser.

## Consequences

A screen set to Chinese reads Chinese throughout and is heard as Chinese, in simplified characters, whatever its browser says. Every new text in the player needs its Chinese in the same change, which the gate enforces, and a sentence is written whole with named values rather than built from pieces. Text from Yolo's server and from agents is not translated, so a Chinese screen can still show an English error from the server. Only English and Simplified Chinese exist; another language is a catalog and a line in `LANGUAGES`. Changing the language reloads the page, which stops what the screen plays until it resumes.
