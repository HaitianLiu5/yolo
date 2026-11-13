# Agent Note: One version, tagged releases, and a protocol number

Status: implemented

English | [中文](2026-10-13-versions-and-releases.zh.md)

## Problem

Yolo was released continuously from `main` with no tags, no changelog, and four version numbers that disagreed: the packages said 0.1.0 or 0.2.0, the node reported a hard-coded 0.3.0, and the README said 0.4. Nothing told an owner, or the agent working for one, what an upgrade involves: which D1 migrations it applies, which secrets or settings it needs, whether the node must restart, or whether going back needs the database restored. The control plane and the node had to be deployed together, but no number said whether two deployed halves could talk to each other, so every upgrade had a mismatch window between `wrangler deploy` and the node's restart.

## Decision

### One version

Yolo has one version, the root `package.json`'s. Every workspace package carries it, every dependency on an `@useyolo/*` package pins it, and the Apple clients carry it as `MARKETING_VERSION` in `clients/apple/Config/Base.xcconfig`; `ops/test/versions.test.js` fails otherwise. The node reports it at `/internal/v1/health`, the Worker at `/.well-known/yolo`, and Settings shows it for the player and the node. `npm run yolo -- release prepare X.Y.Z` sets it everywhere and refreshes the lockfile; the release's CHANGELOG section is written after it, so `prepare` names a missing section as the next step instead of failing.

### Tagged releases and the changelog

A release is an annotated tag `vX.Y.Z` on `main` with a GitHub Release. [`CHANGELOG.md`](../../../../CHANGELOG.md) has one section per release, newest first, headed `## vX.Y.Z (YYYY-MM-DD)`; a heading without the date is not read as a release's. Its prose tells an owner what changed; its fenced `yolo-upgrade` block is JSON that `npm run yolo -- upgrade` reads ([`ops/lib/changelog.js`](../../../../ops/lib/changelog.js)):

| Field | Meaning |
|---|---|
| `protocol` | The release's internal protocol number |
| `clientProtocol` | The client protocol number, in the release that raises it; left out otherwise |
| `migrations` | The D1 migrations the release adds, by name |
| `secrets`, `settings` | New Worker secrets and node `.env` settings: `[{ name, required, how }]`; a required one stops the upgrade until the owner provides it |
| `resources` | New Cloudflare resources or bindings, in words |
| `node` | `restart` when the node changed, else `none` |
| `rollback` | `code`: the previous release runs on this release's database; `restore`: rolling back also restores D1 from the upgrade's backup |
| `human` | Actions only a person can take, in words |

`npm run yolo -- release check` compares the current version's entry with the code: the protocol matches `NODE_PROTOCOL`, a `CLIENT_PROTOCOL` raised since the previous tag is raised by one and stated as `clientProtocol`, and the migrations listed are exactly those added since the previous tag. The maintainer workflow is [`.agents/skills/yolo-release`](../../../skills/yolo-release/SKILL.md).

### The internal protocol

`NODE_PROTOCOL` in [`service/core/src/protocol.js`](../../../../service/core/src/protocol.js) numbers the contract of the [node's internal API](../architecture/2026-10-07-node-internal-api.md). The control plane sends it in `x-yolo-protocol` on every node request; a control plane without the header speaks protocol 0. The node accepts its own number and the one before, and answers anything else with `node_offline`, naming both sides and which one to upgrade. A release raises the number only when the previous release's other side could not follow the change, and the node keeps accepting the previous number for that one release.

`CLIENT_PROTOCOL` in the same file numbers what screens speak to `/v1` and the realtime channel, by the same rule: a release raises it only when the previous release's clients could not follow the change, and the Hub serves the current and the previous number ([client protocol](../architecture/2026-10-19-client-protocol.md)).

### Renamed names

A name that crosses a boundary between parts that upgrade separately (a request header, a playlist tag, an environment variable that an installed service sets) is renamed across two releases. The release that renames it sends or writes the new name and still accepts, or also sends, the old one, because a car tab can keep an old player loaded for days and an installed service keeps its environment; the next release removes the old name. Code that keeps an old name says so where it does, and each release's CHANGELOG entry lists the names it renames and the old names it removes.

### Pinned tools

A release also pins the node's yt-dlp and Deno in `tools.json`, and the `npm ci` that upgrades and rollbacks run installs the set the target release names ([pinned tools](2026-10-25-pinned-node-tools.md)). A release that only bumps a tool, as when yt-dlp fixes a site, is a patch release, and its CHANGELOG entry names the tool's new version.

### The upgrade order

Because the node accepts the previous protocol and every migration works with the previous release's code (the rule in the [D1 data model](../architecture/2026-10-07-d1-data-model.md)), an upgrade runs: back up D1, apply the migrations (the old Worker keeps working), restart the node (it accepts the old Worker), deploy the Worker, run `doctor`. A rollback runs the other way: the Worker first, then the node; D1 is restored only when a release says `rollback: restore`, and only with the owner's approval. `npm run yolo -- upgrade` and `npm run yolo -- rollback` run these steps and stop for the owner's approval first.

Both keep their facts in `.yolo/deployments.jsonl`. An upgrade writes an `upgrade-start` record once the checkout moved, an `upgrade-migrate` record before it runs the migrations, and an `upgrade` record when it ends, so one that was cut off can still be rolled back, and a rollback advises restoring D1 only when the upgrade got as far as its migrations: before them the database is still the old release's. Run again on a checkout that a cut-off or failed upgrade left on the target, `upgrade` fails and names the two ways on, a rollback or the remaining steps by hand, instead of reporting the target as reached; a later successful deploy of the target ends that. After restarting the node, both ask for its health in the protocol of the release now checked out, read from its `protocol.js`, not in the number of the release the command started on, which a node across a protocol change would refuse.

## Alternatives considered

**A version per package.** Plugins, the client, and the services are released together from one repository and deployed as one instance; separate numbers only multiplied what an owner had to compare, which is how four of them came to disagree.

**Comparing versions instead of a protocol number.** Most releases do not change the internal API, so requiring equal versions would forbid the one-sided window that every upgrade has; a protocol number changes only when compatibility does.

**Accepting every older protocol.** The node would carry compatibility code for every past release. One release of overlap covers the upgrade window, and an owner several releases behind upgrades through each, as the changelog lists them.

**Machine-readable upgrade facts in a separate file.** Keeping the block inside the release's changelog section puts the prose and the facts an agent acts on in one reviewed place.

## Consequences

An owner's agent can tell from the changelog what an upgrade will do and ask for approval with the facts in hand, and `doctor` can say which side is behind. The two halves can be upgraded one after the other without a window where they reject each other. The cost is discipline: every release needs its changelog entry, a protocol bump whenever the internal API changes incompatibly, and migrations written to work with the previous release's code.
