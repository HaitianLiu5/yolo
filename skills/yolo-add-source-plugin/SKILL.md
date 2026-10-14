---
name: yolo-add-source-plugin
description: Add a source to an owner's Yolo instance - install an existing Yolo source plugin, or write a new one from plugins/source-example - then load it on the media node, redeploy when it has a control entry, and check it with yolo doctor.
---

# Add a source plugin to Yolo

Sources (Plex, web video links, a folder, a website) are plugins: npm packages with a `yolo` field in their `package.json`. The node loads their `node` entries at start; a `control` entry, which adds MCP tools, is bundled into the Worker when it deploys. Which plugins load, in what order, and with which options is the plugin config, `yolo.config.json`. The contract is the [source plugin API](../../.agents/notes/implemented/architecture/2026-10-11-source-plugin-api.md), and its plugin-authoring guide is the reference for writing one; [the plugin architecture](../../.agents/notes/implemented/architecture/2026-10-11-plugin-architecture.md) explains loading and trust.

Work in the instance's deploy checkout, at its root.

## APPROVAL: plugins run with the node's full access

A plugin is code that runs inside the media node, with the same access to this machine, its network, and its files as the node itself. Before installing one the owner did not write, tell the owner where it comes from and what it can reach, and wait for a yes.

## 1. Keep the plugins outside the checkout

Upgrades check out new release tags, so the owner's plugins and their config live next to it, not in it:

```sh
mkdir -p ~/yolo-plugins && cd ~/yolo-plugins
[ -f package.json ] || npm init -y >/dev/null
```

Create `~/yolo-plugins/yolo.config.json` from the official list once, with absolute paths to the checkout's official plugins (a plugin config lists every plugin; one that is missing does not load):

```json
{
  "plugins": [
    { "source": "/Users/<owner>/yolo/plugins/source-plex" },
    { "source": "/Users/<owner>/yolo/plugins/source-ytdlp" }
  ]
}
```

and point the node and the Worker's build at it with one line in the instance's `.env`:

```sh
YOLO_CONFIG=/Users/<owner>/yolo-plugins/yolo.config.json
```

## 2a. Install an existing plugin

```sh
cd ~/yolo-plugins
npm install --legacy-peer-deps <package>          # or a git URL, or a local directory
```

`--legacy-peer-deps` is needed because `@useyolo/plugin-api` is not on npm: the node gives every plugin its own copy. Add `{ "source": "<package>", "options": { … } }` to the config; an npm package name resolves from `~/yolo-plugins/node_modules`. Pin the version the owner approved (`npm install <package>@<version>`).

## 2b. Write a new plugin

Start from [`plugins/source-example`](../../plugins/source-example/): a library of video links from its options, with `claim`, `libraries`, `items`, `search`, `describe`, `tracks`, and `prepare`, the optional `details`, `chapters`, and `subtitle` that let the owner's agent read an item, the optional `comments` that screens draw over the picture, and tests that need no node.

```sh
cp -R <checkout>/plugins/source-example ~/yolo-plugins/source-<name>
```

Then, in the copy:

1. Rename the package (`@<owner>/yolo-source-<name>`) and the source id (`SOURCE_ID`: lowercase letters, digits, and dashes, unique on the node). Keep `"peerDependencies": { "@useyolo/plugin-api": "*" }` and import nothing else from Yolo.
2. Implement only the methods the source can serve; Yolo never calls a missing one. Return the same `id` for the same item every time: history and resume are keyed by it. Keep `claim()` fast and offline. Play by returning an Input from `prepare()` (`file`, `hls`, or `split`); never serve HTTP or cache segments yourself.
3. Read settings from `yolo.options` (the config) or `yolo.env` (the node's `.env`) with a prefix of the plugin's own, and keep secrets out of a `control` entry's options, which are bundled into the Worker.
4. Start processes, sockets, and timers in `yolo.on("start")` and release them in `yolo.on("shutdown")`.
5. To let the owner's agent understand what plays, add what the provider knows, each optional: `details(source)` (description, people with their roles, date, genres, tags, ratings, series), `chapters(source)` (`[{ start, end?, kind?, title? }]` in seconds, `kind` `chapter`, `intro`, or `credits`), and `subtitle(source, trackId)` (WebVTT text of a text subtitle from `tracks()`, for transcripts of an item that is not playing; while it plays, the stream descriptor's `subtitle(trackId)` serves). Without them, agents get what `describe()` returns, no chapters, and transcripts only during playback. The types are in `@useyolo/plugin-api`. If the provider has timed viewer comments (danmaku), add `comments(source, { start, end })`: `{ comments: [{ t, text, mode?, color?, size? }], start?, end? }` for the span the answer covers from `start` (`end: null` for the whole item), or `null` for an item without any; the node keeps them, so cache nothing yourself.
6. Run its tests from the copy: `node --test test/*.test.js`. Outside the node, `@useyolo/plugin-api` must resolve to the checkout's copy, once: `mkdir -p ~/yolo-plugins/node_modules/@useyolo && ln -sfn <checkout>/service/plugin-api ~/yolo-plugins/node_modules/@useyolo/plugin-api`.

Add `{ "source": "./source-<name>", "options": { … } }` to the config (the path is relative to the config file).

## 3. Order

URLs go to plugins in config order, and the first claim wins. `source-ytdlp` claims every http(s) URL, so a plugin that claims URLs goes before it. Library search and browsing span every source, in any order.

## 4. Load it

```sh
cd <checkout>
npm run yolo -- service restart node
npm run yolo -- deploy             # only when the plugin has a "control" entry
npm run yolo -- doctor
```

`doctor` lists each plugin as `started` or `failed` with its error; a failing plugin never stops the node or the other plugins. Over MCP, `browse` shows the new library and `search` finds its items.

## Remove it

Delete its entry from the config (or set `"enabled": false`), then restart the node and, for a `control` entry, deploy again.

Contributing a plugin to this repository as an official one follows the same API plus the repository's own rules in [AGENTS.md](../../AGENTS.md).
