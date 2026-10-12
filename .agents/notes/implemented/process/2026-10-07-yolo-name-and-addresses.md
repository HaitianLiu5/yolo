# Agent Note: The name Yolo and its addresses

Status: implemented

English | [中文](2026-10-07-yolo-name-and-addresses.zh.md)

## Problem

Once Drive-In became one client of a larger service, the service needed its own name, an npm scope, an MCP server name, and an address for the owner's instance. The owner talks to agents by voice in mixed Chinese and English, so the name has to survive speech recognition, and the address is not cosmetic: passkeys and the OAuth issuer are bound to it.

## Decision

The service is **Yolo**. Its website is `useyolo.app`, used only for promotion; npm packages use the `@useyolo/*` scope; the MCP server and the plugin namespace are both named `yolo`. Because agent tools such as Claude Code call an auto-approve setting "YOLO mode", tool and server descriptions state that Yolo is a media service.

The owner's control plane is served at **`yolo.haitian.site`** (MCP at `https://yolo.haitian.site/mcp`), a personal domain, like Drive-In's `drivein.haitian.site` before it. Anyone else who runs Yolo deploys it to their own domain. `PUBLIC_ORIGIN` in `service/control/wrangler.jsonc` is the OAuth issuer, the token audience, and the passkey relying party; changing it invalidates every passkey.

`useyolo.app` is registered in the owner's Cloudflare account until 2027-10-10, with automatic renewal off.

### Naming criteria

The name had to be shorter than "drivein", read as a technology product, and be recognized reliably in mixed Chinese and English speech. For the last point: no common homophone (as "Claude" is heard as "cloud"), at least two syllables ending in a vowel, no dependence on the n/l distinction that many southern Chinese accents merge, and not a word the owner says when giving commands. Yolo meets all of them: every speech recognizer's vocabulary has it, and "you only live once" suits an entertainment service. Trademarks were not considered, because this is a private service.

## Alternatives considered

**Homecue or Cue.** "Cue" sounds like "queue", and the queue is a core concept.

**Nod.** It sounds almost like "not".

**Kudo, Remo, Beamo, Nemo, Dobby.** All met the criteria; the name is Yolo.

**Other domains.** A Cloudflare Registrar query on 2026-10-08 found `heyyolo.app`, `yoloplay.app`, and `yolotv.app` available, while `yolo.app`, `yolo.ai`, and `useyolo.com` were taken; the npm scope `@yolo` was taken and `@useyolo` free.

**Serving the control plane on `useyolo.app`, `app.useyolo.app`, or `api.useyolo.app`.** The owner keeps the root for the promotional site and keeps this private instance on a personal domain, so that every Yolo deployment sits on its owner's domain.

## Consequences

The name works by voice, but it collides with "YOLO mode" in agent tools, which every tool description has to counter, and with a well-known object-detection model that outranks the website in search. Moving the owner's instance to another address means registering every passkey again and re-authorizing every agent. The `useyolo.app` registration lapses on 2027-10-10 unless the owner renews it.
