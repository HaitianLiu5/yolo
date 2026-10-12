# Agent Note: The owner's web pages share Yolo Web's visual system

Status: implemented

English | [中文](2026-10-12-owner-web-pages.zh.md)

## Problem

The control plane serves its own pages: passkey sign-in (`/login`), pairing a screen (`/device`, its confirmation, and the results), an agent's consent (`/oauth/authorize`), `/account`, and message pages. They were generic boxed forms in a style of their own: default blue buttons, a native select, walls of text. On the pairing confirmation the device's guess appeared twice (a card, then editable fields), Allow and Deny had equal weight, nothing said what happens after Allow, and the date read awkwardly. These pages decide who may play and which agent may act, usually on the owner's phone, so they have to be read at a glance and look like the rest of Yolo.

## Decision

The pages ([`service/control/src/auth/pages.js`](../../../../service/control/src/auth/pages.js)) use Yolo Web's visual system ([in-car design principles](2026-07-13-in-car-design-principles.md)):

- **Tokens.** The dark scheme is Yolo Web's palette exactly (`DARK_TOKENS`; a unit test keeps it equal to [`clients/tesla/src/style.css`](../../../../clients/tesla/src/style.css)). A light scheme with the same cool tint follows the system's `prefers-color-scheme`. Type scale, radii, and 48 px targets are shared (primary buttons are 52 px tall), as are the Yolo mark and the device types' names and icons from [`service/core/src/brand.js`](../../../../service/core/src/brand.js) and the favicon `/favicon.svg`.
- **Layout.** One column at most 440 px wide under the mark, no boxed card around it, one filled primary action, and secondary actions in quiet text.
- **Sign-in.** `/login` has one obvious **Sign in with passkey**. When `next` says what the sign-in is for, the page keeps it in view: a screen waiting to pair (its name, type, and code while the code is pending), an agent's consent, or settings. First-time setup is three numbered steps with a one-time-code field (numeric keyboard, `autocomplete="one-time-code"`, digits only when pasted). Errors are said in plain words, such as a closed passkey prompt.
- **Pairing.** The code entry formats `XXXX-XXXX` as it is typed. The confirmation answers at a glance: the code the screen should show; the device's name and type as one editable step (the name field carries the type's icon, the type is a segmented choice of five, both starting from the device's own guess); what it can and cannot do; **Allow** as the primary action and **Deny** quiet; and the code's single use and 10-minute life. After Allow the page says what happens next ("Model Y is paired. Go back to the car: it continues by itself"); not paired, an expired or used code (with **Enter another code**), and errors follow the same shape: an icon, a title, one sentence, a way on.
- **Consent.** The page names the agent, whether that name is verified, and where access goes, then lists each permission in plain words as a switch, all on by default because agents ask for all three. **Allow** is disabled while every switch is off, and the loopback warning stays.
- **Account.** `/account` says whether this browser is signed in, opens Yolo or its settings, and signs out.

Every route, form field (`code`, `name`, `kind`, `decision`, `handle`, `scope`), and security property stays as it was: the same-origin check on `/device`, the explicit Allow, 10-minute single-use codes, passkey-only sign-in, and the owner's choice of scopes.

## Alternatives considered

**Serving these pages from the client app.** The client is cross-origin isolated and needs a paired device; sign-in, consent, and approving a pairing must work on a phone that has never paired, and OAuth consent belongs on the authorization server's own page.

**One stylesheet served from the client's static assets.** It would be the literal single source, but the security pages would then depend on a second request and on the client build being deployed with the Worker. The pages inline their CSS, and the parity test keeps the shared tokens equal.

**Dark only, like the car.** These pages open on the owner's phone and computer, mostly in daylight; they follow the system setting.

**A native select for the device type.** It hides the five choices behind a tap and looks different on every platform; a segmented choice with icons shows them all.

## Consequences

From sign-in to the car, Yolo looks like one product, and the decisions on these pages (allow this screen, allow this agent) are visible without reading paragraphs. Each page response carries about 11 KB of inline CSS. A change to Yolo Web's dark tokens fails the parity test until the pages follow; the pages' copy and fields are pinned by unit tests of the rendered HTML ([`service/control/test/unit/auth.test.js`](../../../../service/control/test/unit/auth.test.js), [`pairing.test.js`](../../../../service/control/test/unit/pairing.test.js)).
