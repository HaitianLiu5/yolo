---
name: yolo-release
description: Use when cutting a Yolo release (vX.Y.Z) - sets the one version on every package, writes the CHANGELOG entry and its yolo-upgrade block, raises NODE_PROTOCOL when the node's internal API changed incompatibly and CLIENT_PROTOCOL when /v1 or the realtime channel did, verifies, and tags only after the maintainer approves.
---

# Release Yolo

A release is an annotated tag `vX.Y.Z` on `main`, a `CHANGELOG.md` section, and a GitHub Release. Owners' agents upgrade from one tag to the next with `npm run yolo -- upgrade`, which reads the section's `yolo-upgrade` block, so the block must be exact. The rules are in [versions and releases](../../notes/implemented/process/2026-10-13-versions-and-releases.md).

## 1. Gather what changed

```sh
prev=$(git tag -l 'v*' --sort=-v:refname | head -1)
git log --oneline "$prev"..main
git diff --name-only "$prev"..main -- service/control/migrations   # new migrations
git diff "$prev"..main -- service/node/src/app.js service/control/src/node-client.js service/core/src   # the internal API
git diff "$prev"..main -- service/control/src/api/v1.js service/control/src/hub service/control/src/realtime.js service/core/src/protocol.js   # /v1 and the realtime channel, which screens speak
git diff "$prev"..main -- .env.example service/control/wrangler.jsonc   # new settings, secrets, bindings
git diff "$prev"..main -- tools.json   # the pinned yt-dlp and Deno
```

Pin the newest yt-dlp in every release, and Deno when it has a newer release: `npm run yolo -- tools bump yt-dlp`, then `npm run yolo -- tools install` and the checks in step 4. A release that only bumps a tool, when yt-dlp fixes a site, is a patch release ([pinned tools](../../notes/implemented/process/2026-10-25-pinned-node-tools.md)); its CHANGELOG entry names the new version.

## 2. Decide the version and the protocol

- Before 1.0: a minor version for new features, migrations, or a protocol change; a patch version for fixes only. A name kept "for one release" during a rename is kept in this minor version and removed in the next one.
- Raise `NODE_PROTOCOL` in `service/core/src/protocol.js` by one when the previous release's node could not serve this release's control plane, or the reverse: a changed request or response shape, a Source the other side rejects, a removed endpoint. The node keeps accepting the previous number by itself (`acceptsProtocol`); if this release's node cannot serve the previous control plane, change the code until it can.
- Raise `CLIENT_PROTOCOL` in the same file by one when the previous release's clients (a browser tab loaded before the upgrade, an installed Apple or TV app) could not follow a change to `/v1` or the realtime channel: a changed or removed message or response shape, a field a client must now send. An added field or route that old clients ignore does not raise it. The Hub serves the current number and the one before, so keep the previous shape beside the new one for this release ([client protocol](../../notes/implemented/architecture/2026-10-19-client-protocol.md)), and state the raise in the block as `"clientProtocol": N`; leave the field out of a release that does not raise it.
- Check every new migration against the [D1 rule](../../notes/implemented/architecture/2026-10-07-d1-data-model.md#migrations-across-releases): it must work with the previous release's code. If one cannot, the block says `"rollback": "restore"`.

## 3. Prepare

```sh
npm run yolo -- release prepare X.Y.Z    # every package.json and @useyolo pin, the Apple clients' version, and the lockfile
```

It exits 0 and lists the missing CHANGELOG section as an `info` step and as the first `next` item: the section is written now, after the version is set. Once the section exists, running `prepare` is no longer needed; `release check` in step 4 compares the section with the code.

Add the section at the top of `CHANGELOG.md`: a few sentences for the owner, then the block. List new Worker secrets and `.env` settings with `required` and a `how` the owner's agent can follow; list Cloudflare resources the instance must provision; list every action only a person can take (a new permission prompt, a dashboard step, a paid plan).

````markdown
## vX.Y.Z (YYYY-MM-DD)

What changed for an owner, in plain sentences.

```yolo-upgrade
{
  "protocol": 1,
  "migrations": ["0006_example"],
  "secrets": [{ "name": "EXAMPLE_TOKEN", "required": false, "how": "Only for …: npm run wrangler -- secret put EXAMPLE_TOKEN" }],
  "settings": [],
  "resources": [],
  "node": "restart",
  "rollback": "code",
  "human": []
}
```
````

## 4. Verify

```sh
npm run yolo -- release check   # the entry matches NODE_PROTOCOL, states a raised CLIENT_PROTOCOL, and lists the migrations since the last tag
npm run check
clients/apple/archive.sh tvos --no-upload   # macOS only: the Apple apps in Release, as TestFlight gets them
clients/apple/archive.sh ios --no-upload
```

`npm run check` does not build the Apple apps, and a Debug build compiles code that `#if DEBUG` hides from Release, so only a Release archive proves the build TestFlight will get. Without a Mac, say so to the maintainer: the release then ships no Apple build.

Commit as `Release vX.Y.Z`.

## 5. Tag and publish: stop for the maintainer

Show the maintainer the CHANGELOG section and `npm run yolo -- release check`. Only after they approve:

```sh
git tag -a vX.Y.Z -m "Yolo X.Y.Z"
git push origin main vX.Y.Z
gh release create vX.Y.Z --title "Yolo X.Y.Z" --notes "<the section's prose>"
```

On a Mac, upload both Apple apps from the tag for TestFlight, and report each build number and the state the script ends with: `processed` once App Store Connect has an API key in `Local.xcconfig`, otherwise only `uploaded`, which the maintainer confirms in TestFlight:

```sh
clients/apple/archive.sh tvos
clients/apple/archive.sh ios
```

Then upgrade the maintainer's own instance with [`skills/yolo-upgrade`](../../../skills/yolo-upgrade/SKILL.md), so every release is exercised on the path owners take.
