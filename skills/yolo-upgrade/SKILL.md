---
name: yolo-upgrade
description: Upgrade an owner's Yolo instance to a newer release, or roll it back - reads the release notes, gets the owner's approval, backs up D1, migrates, restarts the node, deploys the Worker, and runs yolo doctor. Also covers moving an instance onto a separate deploy checkout and importing an instance deployed before v0.4.0.
---

# Upgrade or roll back Yolo

Upgrades move the instance's **deploy checkout** from one release tag (`vX.Y.Z`) to a newer one. Work in that checkout, at its root. Every command prints a result and takes `--json`; exit code 2 means **stop and get the owner's approval**, 3 means **a human must act**. The rules behind the order are in [versions and releases](../../.agents/notes/implemented/process/2026-10-13-versions-and-releases.md).

## Check first

```sh
npm run yolo -- doctor --json
```

Fix every failure before upgrading (`skills/yolo-deploy` has the table); an upgrade on a broken instance makes both problems harder to read. `doctor` also says when a newer release exists.

## 1. The plan (APPROVAL)

```sh
npm run yolo -- upgrade                 # newest release; or --to vX.Y.Z
```

Nothing changes yet. It fetches the tags, reads the `CHANGELOG.md` sections between the current and the target release, and exits 2 with:

- `upgrade.releases`: each release's notes;
- `upgrade.migrations`, `upgrade.newSecrets`, `upgrade.newSettings`, `upgrade.resources`;
- `upgrade.humanActions`: things only the owner can do;
- `upgrade.rollback`: `code` (rolling back later needs no database restore) or `restore`;
- `plan`: the steps it will run.

If it exits 3 instead, a release needs a setting or a secret first: ask the owner, add a setting to `.env`, and let the owner store a secret with `npm run wrangler -- secret put <NAME>`. Then run the plan again.

Show the owner the notes, the human actions, the rollback mode, and the plan, in plain words. Mention that playback stops for a minute while the node restarts. Wait for a clear yes.

## 2. Run it

```sh
npm run yolo -- upgrade --to vX.Y.Z --approve
```

It backs up D1 (an SQL export in `.yolo/backups/` and a Time Travel bookmark), checks out the tag, runs `npm ci`, then runs the new release's own commands: `migrate`, `service restart node` (and waits for the node to report the new version), `deploy`, and `doctor`. The order lets the old Worker run on the migrated database and the new node accept the old Worker, so nothing breaks between steps. Every step is recorded in `.yolo/deployments.jsonl`.

Afterwards, do the `next` items (the release's human actions) with the owner.

## 3. If it fails: roll back (APPROVAL)

```sh
npm run yolo -- rollback                # shows the plan; exits 2
npm run yolo -- rollback --approve      # after the owner agrees
```

It rolls the Worker back to the version recorded before the upgrade, checks out the previous release, runs `npm ci`, restarts the node, and runs `doctor`. It never restores D1 on its own: when the release said `rollback: restore`, the plan says so, and only `--restore-d1` (with the owner's explicit approval, because changes made since the upgrade are lost) restores the bookmark. A failure before `migrate` changed nothing on Cloudflare; the result's `fix` says how to return the checkout.

## The deploy checkout

The live node must not run from a checkout someone develops in: every `git pull` or branch switch there changes the code under a running node, and an upgrade moves the checkout between tags. An instance therefore runs from its own clone:

```
~/yolo/                          the deploy checkout, detached at a release tag
├── yolo.instance.json           the instance's identity (ignored by git)
├── .env                         NODE_SECRET and the node's settings (ignored)
├── .yolo/                       deployments.jsonl, backups/, tunnel-token (ignored)
├── service/control/wrangler.instance.jsonc   rendered for deploys (ignored)
└── .logs/, .segment-cache/, …   the node's runtime state (ignored), unless
                                 YOLO_RUNTIME_DIR in .env puts it elsewhere
```

The services run `service/node/src/main.js` from this directory. `upgrade` refuses to run in a checkout that is on a branch (`--allow-branch` overrides), so it never moves a development checkout by accident. A developer who also deploys between releases can point a development checkout at the same identity with `YOLO_INSTANCE=~/yolo/yolo.instance.json` and `YOLO_ENV_FILE=~/yolo/.env`, but the node keeps running from the deploy checkout.

### Moving an instance onto a deploy checkout

For an instance whose node runs from a development checkout (`~/dev/yolo` below), with the owner's approval and at a quiet time:

```sh
git clone ~/dev/yolo ~/yolo && cd ~/yolo
git remote set-url origin https://github.com/HaitianLiu5/yolo.git && git fetch --tags origin
git checkout --detach vX.Y.Z                     # the release the instance runs, or newer
npm ci
cp ~/dev/yolo/yolo.instance.json ~/dev/yolo/.env .
cp -R ~/dev/yolo/.lan .                          # the node's LAN and remote keys and certificates, if direct play is on
npm run yolo -- doctor --offline                 # the identity reads correctly here
npm run yolo -- service install node --restart   # rewrites the instance's node service to run from here
npm run yolo -- doctor
```

`service install` keeps the label in the instance file (`services.node`), so the old service is replaced in place, not duplicated. The caches (`.segment-cache/`, `.hls-cache/`, `.media-cache/`) refill by themselves; copy them too to keep them warm. When `doctor` is clean, the development checkout can stop carrying the instance's files.

## An instance deployed before v0.4.0

Before v0.4.0, the instance's values lived in the tracked `service/control/wrangler.jsonc`, and there is no `yolo upgrade` to read them. Once, by hand, in the checkout that deploys:

```sh
git show <the commit you deployed>:service/control/wrangler.jsonc > /tmp/old-wrangler.jsonc
git checkout --detach v0.4.0 && npm ci
npm run yolo -- init --import-wrangler /tmp/old-wrangler.jsonc --node-label <the node's launchd label>
npm run yolo -- config show                      # domain, D1, KV, and VPC ids as before
npm run yolo -- doctor
```

Then continue at "Run it" above with `npm run yolo -- migrate` (D1 already has every migration up to v0.4.0, so it changes nothing), `npm run yolo -- service restart node`, and `npm run yolo -- deploy`.
