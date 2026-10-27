# Agent Note: The useyolo.app website, with the privacy policy and support pages

Status: implemented

English | [中文](2026-10-23-useyolo-app-website.zh.md)

## Problem

An app on the App Store needs a privacy policy URL and a support URL, and each must describe what the app really does. Yolo has several clients, the browser player in its car and web profiles, Yolo TV for Apple TV, and later an iPhone app, and the privacy facts are the same for all of them: each talks only to the owner's own server and node. A policy kept apart from the code drifts as data flows change.

## Decision

- **`site/` in this repository is useyolo.app.** Static HTML, stylesheets, small scripts, and two short clips in [`site/public/`](../../../../site/public/), served by Workers Static Assets from [`site/wrangler.jsonc`](../../../../site/wrangler.jsonc) on `useyolo.app` and `www.useyolo.app`, with no Worker code, cookies, analytics, or third-party requests. Every page is black and white, the colour left to the pictures and to the red of a stopped packet. The pages show no scrollbars; soft blurs at the window's top and bottom edges show where more lies. The first screen of `/privacy` and `/support` is a canvas field that `site.js` draws by hand, with no library: on `/privacy` your data circulates between screen, server, and node inside your boundary and a packet that heads for the developer is stopped at it; on `/support` the path runs from your account to your screens. The field pauses off screen and stands still for reduced motion; everything to read is HTML over it. On the home page, `/` and `/zh`, `home.js` and `home.css` play four requests to the owner's agent on a phone, a laptop, a TV, and a car, the TV's film handed to the moving car at the same second, with real footage from Blender's *Tears of Steel* and *Big Buck Bunny* under CC BY 3.0, credited on the page; the clips in `site/public/media/` are cut short and small so the page stays light. It is Yolo's own site, not an owner's instance, so its config names its domain, unlike `service/control/wrangler.jsonc`. `npm run site:deploy` deploys it through `npm run wrangler` with the token of `npm run yolo -- auth`, from the account that holds the `useyolo.app` zone.
- **One privacy policy and one support page for every client.** `/privacy` and `/support` in English, `/zh/privacy` and `/zh/support` in Chinese, are the URLs App Store Connect takes. The policy says what each client sends to the owner's server and node, what the server stores and why, why Apple clients ask for local network access (the node's `_yolo._tcp` Bonjour advertisement, and LAN direct play), and how Ask's voice is handled: in the browser the recording passes to the owner's transcriber and is never stored ([voice input](../feature/2026-10-18-agent-from-the-screen.md#voice-input)); Yolo TV uses the system's dictation and records nothing itself. The developer collects nothing, which matches each Apple app's `PrivacyInfo.xcprivacy` (no collected data types, no tracking).
- **The pages follow the code.** A change that makes a client send, or the server keep, something new updates `/privacy` and `/zh/privacy` in the same change, with a new effective date. Both languages change together; the pages are HTML, so the Markdown pairing gate does not check them.
- **Support is GitHub Issues and `support@useyolo.app`**, an address the zone forwards with Cloudflare Email Routing; security reports go to GitHub Security Advisories as [`SECURITY.md`](../../../../SECURITY.md) says.

## Alternatives considered

**A separate repository for the website.** The privacy policy is a description of the code's data flows; in another repository a change to the code would not show the page beside it in review.

**A page served by each owner's instance.** App Store Connect needs one fixed URL for every owner, and the policy is about the app, not about one instance.

**Pages in Markdown under the Agent Notes.** They are for App Review and the public, not project knowledge, and they need a stable address and styled HTML.

## Consequences

The policy URLs stay fixed while the pages change, and their history is the repository's. Every new client, or new field a client sends, is a reason to read `/privacy`. Deploying the site needs the Cloudflare account that holds `useyolo.app`; the `useyolo.app` registration lapses on 2027-10-10 unless it is renewed, and the App Store listing's URLs go with it.
