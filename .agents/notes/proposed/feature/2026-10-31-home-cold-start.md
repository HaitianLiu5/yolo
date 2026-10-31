# Agent Note: A new owner chooses where they watch, and plugins turn on from any screen

Status: proposed

English | [中文](2026-10-31-home-cold-start.zh.md)

## Problem

A new owner pairs a screen and finds an empty home. Nothing on it says what Yolo can show or how to get there, so the only thing left is to ask an agent to play a link. That is the floor of Yolo's experience, not what it is for: a screen that plays only what an agent hands it gives nobody a reason to open it. The goal is the next level, where the owner's own sources fill the home and the owner finds and picks things themselves, with the agent as a helper.

The plugins that would fill the home are chosen on the home machine. The node loads the list in `yolo.config.json`, or `plugins/official.json` when there is none ([`service/plugin-api/src/host.js`](../../../../service/plugin-api/src/host.js)), with options from that file or from environment variables. A change means editing JSON, restarting the node, and redeploying the Worker when a plugin has a `control` entry ([plugin architecture](../../implemented/architecture/2026-10-11-plugin-architecture.md)). No screen shows a plugin, and the only guided path is an agent following [`yolo-add-source-plugin`](../../../../skills/yolo-add-source-plugin/SKILL.md) in a terminal.

The defaults grew around one owner's setup: Plex, a mainland egress proxy, a Bilibili account, a Tesla. `official.json` loads Plex, yt-dlp, both agents, the model provider, and five metadata plugins on every new node, whether or not the owner uses them. Signing in to a site means putting a cookies file on the node (`YTDLP_COOKIES_FILE`), which no screen can do. A new owner who only uses YouTube, only has Plex, or only has a folder of files on a disk should reach a full home without touching the home machine. An owner without a Bilibili account must never be asked about Bilibili again after saying no.

The owner profiles proposal (#110, `feature/owner-profiles`) adds profile plugins that put the owner's follows on every home. It leaves two things to this note: how a plugin gets turned on, and the cold start.

## Proposal

The first time a paired screen opens an empty home, it asks **"Where do you usually watch?"** and offers places to choose: the owner's own folders, Plex, Bilibili, YouTube, Tencent Sports, and, last, "Just ask my agent". Choosing a place turns on the plugins behind it and connects it, by scanning a QR code with the site's phone app, entering a link code, or picking a folder. The home then shows that place's rows. The owner can skip at any step; every screen remembers the skip; and a quiet entry on the home and in Settings › Plugins brings the owner back whenever they like. Agents turn plugins on through MCP, and each request waits for the owner's passkey. An agent on the home machine can write a plugin of its own. Yolo checks it, the owner approves it with a passkey, and the node loads it, with automatic rollback when it fails.

Underneath, this is the plugin system that already exists, made visible and changeable at runtime. Nothing in the core names a site: the places, their titles, and their sign-ins come from plugin manifests and the official catalog under `plugins/`.

```
screen (web, car, TV, Apple TV, iOS)
  │ GET /v1/setup, choices          owner's phone or this screen (passkey)
  │                                   │ /v1/owner/plugins, /v1/owner/setup/…, /v1/owner/approvals
  ▼                                   ▼
control plane ──nodeFetch──▶ node: /internal/v1/plugins  ──▶ writes yolo.config.json, applies it in place
  ▲                                   ▲
  │ MCP list_plugins / change_plugin  │ Unix socket: npm run yolo -- plugins propose <dir>
agents (claude.ai, ChatGPT, …)        agents on the home machine (Ask's Claude Code or Codex, a terminal)
```

### What 1.0 delivers and what waits for 1.x

1.0 delivers choice: a new owner chooses what runs and what is connected, signing in is never required, every step can be skipped and done later, and agents can do the same with the owner's approval. 1.x delivers the ecosystem around it.

| | 1.0 | 1.x |
|---|---|---|
| Choosing | The cold start, Settings › Plugins, `npm run yolo -- plugins`, and MCP with per-request approval | Unchanged |
| Catalog | The official plugins in the checkout, the owner's local plugins, and any package the config lists | A community index and `yolo install` from npm or git at pinned versions ([distribution to other owners](2026-10-11-distribution-to-other-owners.md)) |
| Manifest | The `yolo` fields below, read by the host and used to render the catalog and the forms | Unchanged; the `api` range is enforced once the API is published |
| Plugin API | Experimental, in the repository, with these additions | `@useyolo/plugin-api` published to npm under semver |
| Applying a change | In place on the node, or a node restart where in-place loading cannot work | Unchanged |
| Control entries | Listed, applied by a redeploy from the home machine | Node plugins register MCP tools themselves, so only DNS providers keep control entries |
| Plugins an agent builds | Local plugins: checked, approved with a passkey, loaded, rolled back | Published like any other plugin |
| Isolation | None. A plugin runs in the node with the node's rights, and every approval page says so | Each plugin in its own process behind RPC, declared hosts enforced through the egress layer, only declared environment variables, never `NODE_SECRET` |

Agent-built local plugins belong in 1.0. They use the same catalog, approval, and loading as official plugins, and they keep "an agent can teach Yolo a new site" a one-request step. Isolation does not come first: the approval and the warnings carry the risk until isolation arrives ([plugins an agent builds](#plugins-an-agent-builds)).

1.0 must leave the way open for 1.x. Every field a community index would show is a manifest field now. `hosts` is declared now and enforced later. A plugin keeps state only in its own directories and in the node's site sign-ins, never in another plugin's directory, so a later process boundary can move it. An approval is tied to the hash of the code it approved, so an npm version can later be approved the same way. The core marks nothing as built in: `official.json` does.

### The cold start

The guide shows on a paired screen whose home has never been set up: `GET /v1/setup` answers `state: "new"`. It is a full-screen step in front of the home, with one heading, **"Where do you usually watch?"** ("你平时在哪里看？"), and a card for each place in the official catalog. Each card shows an icon, the place's name, and one line about what it adds. Cards can be picked together. Plugins the owner built on the home machine that declare a place appear after the official ones. **Skip for now** is on every step.

- **The places.** The owner's own files come first: **Folders on this computer** and **Plex**. Sites follow, with none picked in advance and the order following the screen's language (Bilibili and Tencent Sports first in Chinese, YouTube first in English). **Just ask my agent** comes last and looks secondary: it is the floor the guide moves owners away from, not the first suggestion.
- **Choosing one turns it on and connects it.** After the owner's passkey ([who may change plugins](#who-may-change-plugins)), each chosen place turns on its plugins on the node and walks through its connect step, one place at a time.
  - **Bilibili**: the Bilibili app scans a QR code. The sign-in feeds both the follows on the home and signed-in playback quality ([signing in is never required](#signing-in-is-never-required)).
  - **YouTube**: instructions for the home machine's browser cookies, or a Google Takeout file. Links play without either.
  - **Tencent Sports**: a WeChat QR code for paid games. Replays and free games play without it.
  - **Plex**: nothing to do when Plex runs beside the node, since the node reads its address and token. Otherwise, a server found on the home network and Plex's own link code.
  - **Folders**: a folder picker over the node's machine.
  - **Just ask my agent**: turns on the agent plugins whose CLI the node finds on its machine. With none, it shows how to connect an agent from the phone.
- **Every connect step is skippable too.** Skipping one leaves its plugin on and not connected. The plugin reads nothing, the place's card says "Connect to see what you follow", and links of that site still play.
- **Rows at once.** When a place connects, the home behind the guide fills: skeletons while a profile reads its lists or a folder is scanned (with a count of files found), then the rows. Finishing the guide lands on that home.
- **Remembered across screens.** Finishing, with at least one place or "Just ask my agent", sets `done`; Skip sets `skipped`. Both are kept per owner in D1, so no other screen shows the guide again. A skipped home stays on the floor (history, what agents played, the queue) and keeps one quiet card, **Add where you watch**: last among the home's rows, or alone when the home is empty. It never pops up or shows a badge. Settings › Plugins has the same entry and **Show the guide again**.
- **Places not chosen stay quiet.** No toast, badge, or row ever mentions a site the owner did not choose. A card asks to connect a place only when the owner chose that place and skipped its sign-in, and it goes away when they turn the place off.

#### On each kind of screen

- **Phone or computer, web profile.** The passkey prompt runs on the page, as signing in from Settings does today ([passkey owner sign-in](../../implemented/architecture/2026-10-08-passkey-owner-sign-in.md)). Fields such as a Plex address are typed here. A site's QR code shown on a phone cannot be scanned by that same phone. The page offers the site's "open in app" link where the site has one; otherwise it asks the owner to scan from another device. Whether Bilibili's code opens its app this way is check C3 below.
- **TV or car, with a remote or a touchscreen and no keyboard.** These screens never ask the owner to type, and they do not run the passkey ceremony, which neither Tesla's browser nor a TV app can be relied on to support. **Continue** shows a QR code instead: `POST /v1/setup/handoff` returns a short-lived link bound to this screen. The owner opens it on a phone, signs in with a passkey, and sees the same choices already picked. The phone authorizes, and the big screen keeps displaying. A site's QR code for its own app appears on the TV or the car, where the phone can scan it, and the screen follows each step by asking `GET /v1/setup` every 2 seconds while a step waits, as pairing polls. Every option that needs typing is filled in on the phone. The car's version keeps the [in-car design principles](../../implemented/architecture/2026-07-13-in-car-design-principles.md): big targets, one decision per step, and the QR code large enough to scan from the passenger seat.
- **Apple TV and Samsung TV.** The [Apple TV app](2026-10-19-apple-tv-client.md) draws the same `/v1/setup` choices and QR codes natively in YoloKit, moving focus with the Siri Remote. The [Samsung TV app](2026-10-26-tv-web-client.md) opens the player, so it gets the web version with `tv-remote.js`'s focus.
- **iOS.** The native app draws the guide and opens the handoff page in the system browser for the passkey, so no site sign-in ever happens in the app's own web view.

### Settings › Plugins

Settings gains **Plugins**, the place the owner comes back to. It is grouped the way the owner thinks about it:

1. **Waiting for you**: pending approvals, from an agent's MCP request or a local plugin an agent built ([agents turn plugins on](#agents-turn-plugins-on-with-the-owners-approval)).
2. **Where you watch**: the places, as in the guide, each with its state (off, on, connected, needs sign-in, failed, stale), Connect or Disconnect, and its rows' switches from #110.
3. **Built in**: web links. It has no switch ([built-in link playback](#built-in-link-playback-and-the-default-load-list)).
4. **More**: everything else, such as names and posters (the metadata plugins), AI subtitles, the model for plugins, agents, and proxies.
5. **Made on this computer**: local plugins, each marked "Not reviewed by Yolo", with its version and **Use previous version**.

A plugin's page shows its summary, what it reads, keeps, and sends (`privacy`), a note about the site's terms where the manifest has one, its options as a form built from the manifest (secret options show only whether they are set), its health from `/internal/v1/health`, its version and where it comes from (official, local, or a package), and its switch. A plugin with a `control` entry shows what a redeploy needs ([plugins with a control entry](#plugins-with-a-control-entry)). Only the owner can change anything here. A screen without an owner session shows the same page read-only, with **Sign in to change**, which is the handoff QR code on a TV or in the car.

This is how the choices are made, not a plugin console. The guide, the home's card, and Settings are three views of one catalog over the same routes.

### The catalog and the manifest

Every plugin describes itself in the `yolo` field of its `package.json`. The fields below are added to `node`, `control`, and `setup`; text fields take `{ "en", "zh" }` and fall back to English.

| Field | Meaning |
|---|---|
| `title`, `summary` | Its name and one line about what it adds, as screens show them |
| `kinds` | What it registers (`source`, `profile`, `metadata`, `agent`, `model`, `speech`, `proxy`, `dns`), so the catalog can group it before loading it |
| `place` | Optional: `{ id, title?, icon }` to offer it in the guide as a place; plugins that share an `id` are one place |
| `connect` | How a screen connects it: `qr` (the site's app scans a code), `code` (a code entered on the site's link page, shown with a QR code to that page), `folder`, `fields` (options typed on a phone or computer), `instructions`, or none |
| `options` | The options a form shows: `[{ key, type, title, secret?, env?, default? }]`, where `type` is `string`, `number`, `boolean`, `folder`, `folders`, or `url`, and `env` names the environment variable the plugin reads now |
| `privacy` | What it reads, keeps on the node, and sends, and to whom, in a sentence or two |
| `terms` | Optional: a short note about the site's terms, shown when it is turned on |
| `hosts` | The hosts it talks to, shown on its page and the approval page; enforced in 1.x |
| `reload` | `restart` when the plugin cannot be loaded in place ([how a change takes effect](#how-a-change-takes-effect-on-the-node)) |
| `api` | The plugin API range it was written for |
| `samples` | Optional: URLs or ids the checks use ([plugins an agent builds](#plugins-an-agent-builds)) |

The **catalog** is what the node can offer: every official plugin in the checkout's `plugins/` that `official.json` lists in `catalog`, every local plugin under the node's `.yolo/local-plugins/`, and any package the config already lists. `GET /internal/v1/plugins` answers it with each plugin's manifest fields, whether it is on, its load state and error, its connection, and its options with secret values left out. The node reads manifests without importing code, so the catalog is cheap and a broken plugin still shows up.

`plugins/official.json` keeps its role and gains the catalog:

```json
{
  "plugins": [{ "source": "./source-ytdlp", "builtIn": true }],
  "catalog": [
    "./source-folder", "./source-plex", "./profile-bilibili", "./profile-youtube", "./source-tencent-sports",
    "./agent-claude-code", "./agent-codex", "./model-subscriptions",
    "./metadata-local", "./metadata-wikimedia", "./metadata-tvmaze", "./metadata-bangumi", "./metadata-tmdb",
    "./subtitles-openai", "./proxy-url", "./dns-desec"
  ],
  "with": {
    "folders": ["./metadata-local", "./metadata-wikimedia", "./metadata-tvmaze", "./metadata-bangumi", "./model-subscriptions"],
    "plex": ["./metadata-wikimedia", "./metadata-tvmaze", "./metadata-bangumi", "./model-subscriptions"]
  }
}
```

`with` names the plugins a place brings along. Choosing Folders or Plex also turns on the metadata plugins that need no key and the model provider, so the owner's films get names and posters without a second question. The place's card lists them by name, with the one line each sends ("titles of your files to Wikidata, TVmaze, and Bangumi"), and a switch to leave any of them off. Each one is also its own row under **More**. `source-example` is not in the catalog.

### Built-in link playback and the default load list

**Playing a web link is built in.** The yt-dlp source is the precondition of the floor: an agent hands Yolo a URL, the node asks the source plugins in order, and one claims it. It is never a choice. It does not appear in the guide or the places, and Settings shows it under **Built in** with no switch. In code it stays a plugin in `plugins/`, so no file under `service/` names it and the provider-name check still holds. `official.json` loads it on every node that has no config of its own and marks it `builtIn`. An owner who does not want it can still set `"enabled": false` in their config by hand, as the [plugin architecture](../../implemented/architecture/2026-10-11-plugin-architecture.md) allows. No screen offers that switch.

Because it claims every http(s) URL, the node always inserts a plugin turned on from a screen before the first built-in source, so a site-specific source sees its URLs first.

**Everything else is chosen.** A new node loads only built-in link playback. Plex, folders, profiles, Tencent Sports, metadata, AI subtitles, proxies, models, and agents load only after the owner chooses them, in the guide, in Settings, from the terminal (`npm run yolo -- plugins on <name>`), or through an agent's approved request. This replaces the [1.0 roadmap](2026-10-11-yolo-1-0.md)'s row that took yt-dlp out of the default list and offered it at setup.

### Plugin granularity

Packages stay small and single-purpose: one package per site and plugin type, such as `profile-bilibili` apart from link playback. What the owner chooses is a **place**, which maps to one or more packages through `place` and `with`. The guide stays short however finely the code is split, and Settings still shows each package for the owner who wants control.

One rule decides what stays inside built-in link playback: site handling that needs no sign-in and offers no choice stays. That covers Bilibili's danmaku, seasons, part lists, and upos mirrors, Vimeo's embed fallback, YouTube's captions, and the yt-dlp extension that asks Tencent Video for H.264. Anything that needs a sign-in or that an owner would choose becomes its own plugin.

**Tencent Sports becomes `plugins/source-tencent-sports`.** It takes the game pages (`sports.qq.com/kbsweb/game.htm`), their replay lists, the live channels from Tencent's live API, and Yolo's Tencent sign-in (`tencent-account.js` and the setup entry's WeChat QR code), out of `source-ytdlp` ([Tencent Sports replays and live games](../../implemented/feature/2026-10-26-tencent-sports-replays.md)). A replay is a Tencent Video page, which link playback already plays. So the plugin API gains one generic answer: `prepare()` may return `{ delegate: url }`, and the node plays that URL through the next source after this one that claims it, keeping the game as the item's Source, so history and resume key on the game. The Tencent sign-in is saved as a site sign-in for Tencent's hosts, so link playback plays Tencent Video pages with it as it does now.

### Signing in is never required

Loading a plugin and connecting an account are separate, and connecting is always optional. A place without a sign-in still works as far as its site allows. Bilibili links play anonymously at the site's anonymous quality, and Tencent Sports replays and free games play.

- **`connect` is not just for profiles.** #110 gives profile plugins `connect: { start(), poll(attempt), forget() }`. Any plugin may now offer it, with `connect` in its manifest saying how. The node serves it at `/internal/v1/plugins/:name/connect`, and the owner routes replace #110's per-profile ones ([routes](#routes-data-and-protocol-versions)). A connect attempt can name the screen that displays it, so the site's QR code appears on the TV while the owner approves on a phone.
- **Site sign-ins are kept by the node.** A connect that ends with a site session hands its cookies to the node with `yolo.signIns.save(cookies)`, limited to the hosts in the plugin's manifest. The node keeps them in its ignored `.yolo/sign-ins/` (mode 600). A plugin that plays from that site reads them with `yolo.signIns.cookieFile(url)`: a Netscape cookie file for the URL's host, which yt-dlp takes as `--cookies`, or null. Built-in link playback reads every host. Any other plugin reads only the hosts it declares. So one Bilibili scan gives both the profile's follows and signed-in playback (subtitles, higher quality), and one WeChat scan gives Tencent's paid games and Tencent Video pages. Disconnect deletes the sign-in, and the site's own security settings end the session. Until isolation, this host limit only keeps plugins from misusing each other's sign-ins by accident; it cannot stop a hostile plugin.
- **An owner's own cookies file still wins.** `cookiesFile`, `cookiesFromBrowser`, and `YTDLP_COOKIES_FILE` keep working unchanged, and they take precedence over the node's sign-ins for the hosts they cover.
- **What a place gives without a sign-in.** A profile needs an account to read follows. This note asks #110 for one addition: a list marked `account: false` holds a site's public lists, such as Bilibili's popular videos, and is read once the place is chosen, so choosing Bilibili without signing in still gives the home a row. Without that addition, a place chosen without a sign-in adds link playback and its connect card, nothing more.

### How a change takes effect on the node

The node owns the plugin config. `PATCH /internal/v1/plugins/:name` `{ enabled?, options?, connect? }` writes the config and applies the change in place.

- **Which file.** The file the node loaded: `YOLO_CONFIG`, else `yolo.config.json`. A node running on the defaults creates `yolo.config.json` from `official.json` on its first change. The node writes atomically (a temporary file, then a rename) with 2-space JSON, changes only the entry it was asked to, keeps every other field (`egress` included) and the order, and puts a new entry before the first built-in source. An option marked `secret` never goes into the config: it goes to `.yolo/plugin-options/<plugin>.json` (mode 600) and is merged into `yolo.options` at load. A config file the node cannot write turns the switch into a message naming the file.
- **In place by default.** The node keeps the running set and diffs it against the new config:
  - A plugin turned on is imported, its factory is called, its `start` handlers run, and what it registered joins the registries at its config position, since claim order is load order ([source plugin API](../../implemented/architecture/2026-10-11-source-plugin-api.md#lifecycle)).
  - A plugin turned off leaves the claim order and stops taking new `prepare`s at once. The streams it is serving play on until their screens stop them, for at most 4 hours. Then its `stop()`s and `shutdown` handlers run and its registrations go.
  - Changed options are a stop and then a start with the new options. The factory is called again on the module already imported, so a plugin keeps no state at module scope, which the lifecycle already asks.
  - New code always comes from a new path. A local plugin's approved version lives in a directory named by its hash ([plugins an agent builds](#plugins-an-agent-builds)), so its files load fresh under new URLs, which Node's module cache would otherwise keep. Official plugins change code only on an upgrade, which restarts the node anyway.
- **A restart only where in-place loading cannot work.** That is a plugin whose manifest says `reload: "restart"` (for example, one that installs process-wide hooks), or an in-place step that failed and left a registry inconsistent. The node then restarts itself once no stream is playing, or at once if the owner presses **Restart now**, and the service manager that `npm run yolo -- service` installs starts it again. A node not running as a service says so and names the command. Screens playing through the node recover their streams as they do after any node restart.
- **Failures stay local.** A plugin that fails to load or start is `failed` with its error, and every other plugin keeps running, as at startup. Settings, `yolo doctor`, and `list_plugins` show the error.

### Plugins with a control entry

Workers cannot load code at runtime, so a plugin's `control` entry is bundled into the Worker when it is built ([plugin architecture](../../implemented/architecture/2026-10-11-plugin-architecture.md)). Today only `dns-desec` has one, and DNS providers are chosen when the instance is deployed, not in the guide.

- **1.0.** The node writes the config like any other change. The plugin's page says "Applies after a redeploy from the home machine", with `npm run yolo -- deploy` and **Ask my agent to redeploy**, which hands the request to the screen's agent on the home machine ([screens ask the owner's own agent](../../implemented/feature/2026-10-18-agent-from-the-screen.md)). The Worker's build info lists the control entries it bundled, so the page can say "Waiting for a redeploy" until the deployed Worker matches the config. Local plugins with a control entry are refused, since they would run in the Worker with every binding. The build skips paths under `.yolo/local-plugins/`, so a deploy from another checkout never fails on them.
- **1.x.** Node plugins register MCP tools themselves. The control plane lists them through `nodeFetch()` and forwards their calls, so a plugin that only adds tools needs no control entry. Only DNS providers keep one, because they run while the node is offline.

### Agents turn plugins on with the owner's approval

Two MCP tools, in [`service/control/src/mcp/tools.js`](../../../../service/control/src/mcp/tools.js), naming no site:

- **`list_plugins`** (`read`) answers the catalog: each plugin's title, summary, kinds, place, state, connection, and error, the places, and pending requests with their state. An agent asked "connect YouTube too" finds the place's plugins here.
- **`change_plugin`** (`manage`) `{ plugin | place, enabled, options?, connect? }`. Turning a plugin **off** applies at once and writes a `kind: "security"` log line: it removes code from the node and is undone with one switch. Turning a plugin **on**, or changing its options, creates a **request** and applies nothing. The answer is `{ request: { id, code, url, expiresAt } }`, and the tool's description tells the agent to give the owner the link and the short code.

A request names the change, the agent that asked (its OAuth client's name), and, for a place, the plugins it brings along. It lasts 10 minutes, works once, and the owner approves it in one of three ways: the link on any device, a banner on every screen signed in as the owner (a realtime `approval` message, optional under the [client protocol](../../implemented/architecture/2026-10-19-client-protocol.md), which a screen without an owner session ignores), or **Waiting for you** in Settings › Plugins. **Allow** runs a passkey ceremony at that moment, not just a session check, because it changes what code runs on the home machine. With `connect: true`, an approved request goes straight into the place's connect step on the device that approved it. A request that is denied or expires changes nothing and is never shown again.

The pending-request list and the banner are the same mechanism [connecting a home agent from a signed-in screen](2026-10-22-remote-agent-approval.md) proposes for agent grants. Whichever of the two is built first builds the mechanism.

#### Who may change plugins

| Who | Can |
|---|---|
| Any paired screen (device credential) | Read the catalog and the places (`GET /v1/setup`), skip the guide or show it again, start a handoff |
| The owner, signed in with a passkey | Everything in Settings › Plugins, choose places, connect and disconnect, approve requests |
| An agent over MCP | Read (`read`), turn off (`manage`), request anything else (`manage`), which waits for the owner |
| The home machine's terminal | `npm run yolo -- plugins` with `list`, `on`, `off`, `check`, `propose`, and `rollback`: anyone with a shell as the node's user can already edit the config, so these need no passkey, except `propose`, whose approval keeps a record |

### Plugins an agent builds

The owner can ask their agent for a plugin at any time: on a screen through Ask, which reaches Claude Code or Codex on the home machine, or in a terminal there. "Make Yolo play this site" becomes a plugin the owner approves, which then appears as a place in the guide and Settings.

- **Where it is written.** In a workspace outside the checkout, `~/yolo-plugins/<name>/` by default (the place [`yolo-add-source-plugin`](../../../../skills/yolo-add-source-plugin/SKILL.md) already uses), started as a copy of [`plugins/source-example`](../../../../plugins/source-example/) and importing only `@useyolo/plugin-api` from Yolo. Upgrades never touch it.
- **Checks.** `npm run yolo -- plugins check <dir>` runs, in a child process:
  1. The manifest: a `node` entry and no `control` entry, the fields above, an `api` range the host meets, and a name that is not an official plugin's or an installed package's.
  2. Imports: nothing from Yolo but `@useyolo/plugin-api`.
  3. The factory, called with a recording `yolo`, as `source-example`'s tests do: what it registers passes the node's own checks (`checkSourceImpl` and the others), and `start` and `shutdown` finish within the node's limits.
  4. The plugin conformance kit for each kind it registers: for a source, `claim` answers fast without the network, and `describe` and `prepare` on its `samples` return valid shapes. For a profile, `lists` and `entries` return valid shapes.
  5. Its own `npm test` when it has one.
- **A version is a snapshot.** `npm run yolo -- plugins propose <dir>` runs the checks, copies the directory with its `node_modules` (and without `.git`) into the node's ignored `.yolo/local-plugins/<name>/<hash>/`, where `<hash>` is a SHA-256 over every file's path and content, and hands the proposal to the node over its Unix socket, as the owner code is issued ([passkey owner sign-in](../../implemented/architecture/2026-10-08-passkey-owner-sign-in.md)). It prints the approval link and short code, as `npm run yolo -- auth` prints Cloudflare's. The agent relays them, and the request appears under **Waiting for you** and in the banner.
- **Approval.** The approval page shows:
  - the plugin's title and summary, what it registers, and the place it offers;
  - its `hosts` and `privacy`;
  - every check's result, its files and size, and its hash;
  - for a new version, which files changed since the version that runs now;
  - who asked: the machine, and the agent when Ask started it.

  At the top, the page says: "Yolo has not reviewed this code. It runs inside the media node with the node's full access to this computer, its files, your home network, and the sign-ins Yolo keeps." **Allow** takes a passkey ceremony. The node records `{ hash, approvedAt, passkey, requestedBy }`, adds the plugin to the config before built-in link playback, and loads it in place.
- **What runs is what was approved.** At every load the node hashes the snapshot again and refuses one that differs (`failed: changed after approval`). An edit is a new snapshot and a new approval.
- **Rollback.** The node keeps the last three approved snapshots of each local plugin.
  - **Automatic.** A version that fails to load or start goes back to the previous approved one, or off when there is none, and says so in Settings, `yolo doctor`, and `list_plugins`.
  - **Crash guard.** Before loading a new version the node writes a probation mark. If the node process ends within 5 minutes, the next start loads the previous version and marks the new one `failed: the node stopped while it ran`.
  - **By hand.** **Use previous version** in Settings and `npm run yolo -- plugins rollback <name>` go back at any time without a new approval, since that code was approved before.
- **The security boundary, stated plainly.** In 1.0 a local plugin is trusted code in the node process, as every plugin is ([plugin architecture](../../implemented/architecture/2026-10-11-plugin-architecture.md)). It can read `.env` and `NODE_SECRET`, sign the node's internal requests, issue an owner code through the node's socket (which lets someone holding that code reset the owner's passkeys), read every site sign-in and every plugin's state, and reach the home network. The passkey approval protects against requests from agents that reach Yolo only over MCP and against code loaded by mistake, and it keeps a record of who approved which hash. It cannot stop a process that already runs as the node's user on that machine: such a process can edit the node's files directly. Isolation, declared hosts enforced, and a filtered environment come after 1.0.
- **The skills.** `yolo-add-source-plugin` becomes the agent's path for writing a plugin: copy `source-example`, implement, test, `plugins check`, `plugins propose`, relay the link, then confirm with `list_plugins` or `yolo doctor`. Editing the config and restarting by hand stays only for npm packages until `yolo install` arrives in 1.x. [`yolo-add-official-plugin`](../../../skills/yolo-add-official-plugin/SKILL.md) adds the manifest fields, the catalog entry, the place and `with` where they apply, both languages, and `privacy`. A local plugin worth sharing becomes official through it.

### Existing instances on upgrade

An instance that upgrades keeps the plugins it runs and never sees the guide.

- **With its own config** (`YOLO_CONFIG` or `yolo.config.json`), the config stays as it is. Where it lists `source-ytdlp`, the upgrade inserts `source-tencent-sports` just before it and moves the Tencent sign-in from `source-ytdlp`'s state directory to the new plugin's, so Tencent Sports keeps working.
- **Without one,** the upgrade writes `yolo.config.json` with the previous release's default list before the node restarts, so the same plugins load. `yolo doctor` warns when a node with earlier runtime state runs on the new defaults, which covers an upgrade done without the command.
- **The guide.** A D1 migration marks the cold start `done` for every existing user, so no screen of an upgraded instance shows it. **Add where you watch** and **Show the guide again** are in Settings.
- `npm run yolo -- plugins migrate` does the config steps. The release's `CHANGELOG.md` `yolo-upgrade` block runs it and says that existing instances keep their plugins ([versions and releases](../../implemented/process/2026-10-13-versions-and-releases.md)).

### Routes, data, and protocol versions

The node:

| Method | Path | Purpose |
|---|---|---|
| GET | `/internal/v1/plugins` | The catalog, the places, each plugin's state, and pending local proposals |
| PATCH | `/internal/v1/plugins/:name` | `{ enabled?, options?, connect? }`: write the config and apply it |
| POST, GET, DELETE | `/internal/v1/plugins/:name/connect`, `…/connect/:attempt`, `…/connection` | A plugin's connect, as #110 defines it for profiles |
| GET | `/internal/v1/folders?path=` | Directories on the node's machine for the folder picker: home, mounted volumes, and their subdirectories, names only |
| GET, POST | `/internal/v1/plugins/proposals/:id`, `…/approve`, `…/deny` | A local proposal and its outcome |
| POST | `/internal/v1/plugins/:name/rollback` | Back to the previous approved version |
| POST | `/local/v1/plugins/proposals` | On the Unix socket only: a proposal from `plugins propose` |

The control plane, with the `read` scope or a device credential: `GET /v1/setup` returns `{ state, available, choices, step? }`, where `step` is the connect step a phone started for this screen. `PUT /v1/setup` takes `{ state: "skipped" | "new" }` and needs the `manage` scope. `POST /v1/setup/handoff` returns `{ url, code, expiresAt }`. The [owner routes](../../implemented/architecture/2026-10-07-v1-http-api.md#owner-routes), behind the passkey session:

- `GET /v1/owner/plugins` and `PATCH /v1/owner/plugins/:name`
- `POST /v1/owner/setup/places/:id` `{ without? }`, which turns a place on with its `with` plugins, minus the ones unticked
- the connect routes under `/v1/owner/plugins/:name/`, with `display: <deviceId>`
- `GET /v1/owner/folders`
- `GET /v1/owner/approvals` and `POST /v1/owner/approvals/:id` `{ allow }`, with a fresh passkey assertion
- `POST /v1/owner/plugins/:name/rollback`

The handoff page is one of the [owner web pages](../../implemented/architecture/2026-10-12-owner-web-pages.md), so it works on a phone that never paired.

D1 gains two tables in the next migration, each with `user_id` ([D1 data model](../../implemented/architecture/2026-10-07-d1-data-model.md)). `home_setup` holds `state` (`skipped` or `done`) and `updated_at`, one row per user; the migration inserts `done` for every existing user. `plugin_requests` holds MCP requests: `id`, `plugin` or `place`, the change, the client, the short code's hash, `expires_at`, and `status`. Local proposals stay on the node. The previous release's code reads neither table.

Every route and message is new, and older peers answer 404 or ignore it: an older node's 404 becomes `available: false` with "Upgrade the media node". So neither `NODE_PROTOCOL` nor `CLIENT_PROTOCOL` changes ([client protocol](../../implemented/architecture/2026-10-19-client-protocol.md)). The privacy pair at `site/public/privacy.html` and `site/public/zh/privacy.html` gains the setup state and the plugin requests kept in D1, and the site sign-ins kept on the node.

### Plan

1. The owner runs checks C1 to C3.
2. The host:
   - manifest fields, the catalog in `official.json`, and `GET /internal/v1/plugins`;
   - in-place apply with draining, restart as a fallback, and config writing with secret options;
   - `yolo.signIns`, generic `connect`, and the folder listing;
   - `npm run yolo -- plugins` with `list`, `on`, `off`, and `migrate`;
   - tests of ordering, draining, the restart fallback, and the config written.
3. The control plane: `/v1/setup`, the handoff page, the owner routes, the `home_setup` and `plugin_requests` migration, `list_plugins` and `change_plugin`, approvals with the realtime banner, and the build skipping local plugins.
4. The web player: the guide in the web and car profiles and on TVs, the home's **Add where you watch**, and Settings › Plugins. The Apple TV app and iOS draw the same routes in their own changes.
5. `source-tencent-sports` split out with `prepare`'s `delegate`. Manifests for every official plugin. `official.json` down to built-in link playback, with the catalog and `with`. The upgrade step.
6. Local plugins: `plugins check`, the plugin conformance kit, `plugins propose`, approval, hash checks at load, rollback, and the crash guard. The two skills rewritten.
7. The `CHANGELOG.md` entry with its `yolo-upgrade` block, and the privacy pair.

#110 lands its profile plugins against step 2's `connect`, and the home rows it proposes fill the guide's "rows at once". The folder source (#93) is the Folders place. The web player's home must show every library, not only the first movie library as it does today, before Folders and Plex fill a home well; the no-dead-ends work on the web player is fixing that.

### Owner checks

| Check | Steps | Decides |
|---|---|---|
| C1, Plex's link code | Without a token, request a PIN from plex.tv (`POST /api/v2/pins` with `strong=false`), enter its code at `plex.tv/link` on a phone, and poll the PIN for its token | Whether the Plex place connects a remote server with a code on the TV, with no typing |
| C2, a site's QR code on a TV | Show Bilibili's web sign-in QR code (#110's P5) on the Apple TV and in the car at the guide's size, and scan it with the Bilibili app from the couch and from the passenger seat | The QR code's size and contrast on those screens |
| C3, a site's QR code on the phone itself | Open Bilibili's sign-in URL from its QR code on the same phone, in Safari and Chrome | Whether the phone version offers "open in app" or must ask for another device |

## Alternatives considered

**A plugin console only, with no guide.** Settings › Plugins alone would make every plugin reachable, but a new owner who opens an empty home would not know to look there or what to pick. The guide asks one question in the owner's terms and uses the console's routes underneath.

**Load everything by default and let the owner turn things off.** This is today's `official.json`, and a full home on day one would be easy. But every new node would run code for sites its owner never uses: Plex probes, Bilibili requests, metadata lookups that send file titles to public databases. The home would also center on whichever sites the defaults favor. Which plugins run is the owner's choice, for every plugin.

**Make link playback a choice too.** A purer catalog, but an owner who skipped it would have a Yolo that cannot play the links agents hand it. That is below the floor.

**Put the Bilibili, Tencent, and YouTube handling into the core.** It would remove the plugin hop, but the core may not name a site, and per-site code changes on the sites' schedule.

**Keep Tencent Sports inside link playback.** Less work. But the built-in plugin would then carry a site's sign-in and a choice no owner made. The `delegate` answer keeps the split plugin small: it names the replay page, and link playback plays it.

**Metadata as its own guide step, or only in Settings.** A second question slows the guide for a choice most owners would accept. Leaving metadata only in Settings would show a folder of files as raw file names. Bringing the metadata plugins along with Folders and Plex, named on the card and each with its own switch, keeps it to one question and still lets the owner say no.

**Restart the node on every change.** Simpler than applying changes in place, and the service manager already restarts the node. But every switch would interrupt every screen's stream and drop the node's caches, and a restart takes seconds the guide would show as a hang. Plugins already have a load, start, and shutdown lifecycle that turns on and off cleanly. A restart stays the fallback.

**Re-import changed code in place under a query string.** Node's module cache keys on the URL, so `node.js?v=2` reloads the entry, but its relative imports resolve to the old URLs and keep the old code. A directory per approved hash gives every file a new URL and doubles as the rollback store.

**A new OAuth scope for plugins.** Granted once on the consent page, it would let an agent turn plugins on without asking again. But many agents hold Yolo tokens (claude.ai, ChatGPT, the CLIs), and turning a plugin on changes what code runs on the home machine. A passkey at each request keeps the owner in that decision, and turning a plugin off, which only removes code, needs none.

**Agent-built plugins after isolation.** Waiting would mean the risk of in-process code is never carried by an approval. But every plugin runs in-process before isolation anyway, official ones included, and an owner's agent can already write a plugin and edit the config by hand. A checked, hashed, approved, and reversible path with plain warnings is safer than that, and it keeps "teach Yolo a site" within one request.

**Let MCP agents upload a plugin.** A claude.ai agent cannot put files on the home machine, and code arriving over the internet into the node is a larger surface than code written on that machine. Proposals come only through the node's Unix socket.

**Keep the cold start's state on each screen.** No D1 change, but every new screen would ask again, and a skip on the TV would not count in the car.

**Keep site sign-ins inside each plugin.** #110 keeps a profile's session in its own `stateDir`. Then one Bilibili scan would read follows while playback stayed anonymous, or the owner would sign in twice. A sign-in store the node keeps, limited to declared hosts, serves both without one plugin reading another's directory, which isolation will need anyway.

**Move control entries to the node in 1.0.** It would remove the redeploy for tool-only plugins, but no official plugin needs it now (only `dns-desec` has a control entry, chosen at deploy time). It can wait for 1.x without blocking anything.

## Acceptance criteria

- A new instance loads only built-in link playback. Its first paired screen shows "Where do you usually watch?". Choosing Bilibili and scanning the code shows the follows' rows within seconds, and a Bilibili link then plays at signed-in quality without any cookies file on the node.
- Three new owners, each with only one source (YouTube only, Plex only, a folder only), finish the guide on a TV with the remote and a phone, without typing on the TV. Each reaches a home with their source's rows and plays from it.
- An owner without a Bilibili account skips Bilibili, or the whole guide. Yolo is fully usable, and no screen ever mentions Bilibili afterwards. Skipping on the TV means the car and the browser never show the guide; **Add where you watch** brings it back from any screen.
- Turning a plugin on or off from Settings, or with `npm run yolo -- plugins`, takes effect without a node restart. A stream playing from another plugin keeps playing, and a stream from the plugin turned off plays until its screen stops it.
- `change_plugin` from claude.ai turning on YouTube applies nothing until the owner approves with a passkey through the link or a screen's banner. Turning a plugin off applies at once with a security log line.
- An agent on the home machine writes a plugin for a new site from `source-example`. `plugins check` passes, the owner approves it on a phone, and the site appears as a place and plays. A broken next version rolls back to the previous one by itself, and a version that crashes the node is skipped at the next start. Editing the snapshot after approval makes it `failed`.
- After an upgrade, the owner's instance loads exactly the plugins it loaded before (Tencent Sports included), and no screen shows the guide.
- No file under `service/` or `clients/` names a site. The places, titles, and sign-ins come from manifests and `official.json`, and `scripts/provider-names.test.js` passes.

## Risks

- **Code the owner approves without reading.** An approval page cannot make the owner review code. The warning, the checks, the hash, the record, and rollback limit the damage of a mistake. They do not stop a hostile plugin, which has the node's full rights until isolation.
- **A plugin can hang the node.** A busy loop in a plugin blocks the node's event loop. The service manager does not restart a process that hangs, and the crash guard covers only exits. The owner restarts the node, and the probation mark then skips that version. Isolation fixes this.
- **The node writes the owner's config.** An owner who edits `yolo.config.json` by hand while the node writes it can lose an edit. The node rereads the file before each write and refuses when it changed since it was loaded, asking for a reload.
- **Sign-ins kept on the home machine.** A site sign-in made from a screen is a whole session of the owner's account in `.yolo/sign-ins/`. Anyone who can read that machine can use it.
- **Fewer things work out of the box.** A new owner who skips everything gets only link playback, with no metadata and no Ask. The guide, the home's card, and Settings are how they get more.
- **Site terms.** Turning on a site's plugin shows its `terms` note. The owner connects each account themselves, and Yolo reads and plays only what the owner's own account can.
- **Given up:** a community catalog, installing from npm, isolation, and node-registered MCP tools until 1.x; plugins with a control entry still need a redeploy from the home machine.
