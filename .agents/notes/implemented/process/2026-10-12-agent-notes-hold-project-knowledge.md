# Agent Note: Agent Notes hold all project knowledge

Status: implemented

English | [中文](2026-10-12-agent-notes-hold-project-knowledge.zh.md)

## Problem

Yolo's knowledge was spread over unrelated places with no rules about which fact lived where. `docs/` held a numbered table of 25 decisions, a 500-line protocol draft that mixed wire contracts with implementation status, deployment steps, and an incident write-up, a roadmap, a plugin guide, and three records from the original Tesla-only player. A test architecture README, an experiment README, and a design-context file sat elsewhere, and `AGENTS.md` told agents to read four documents before proposing a change. Status lines rotted, the same rule (for example, why the player needs COOP/COEP) was stated in three files, and about a hundred code comments cited "decision 15" or "yolo-v1.md §7", which break whenever a table is renumbered or a section moves. Nothing checked any of it, and the design documents were written only in Chinese while the code, commits, and README are in English.

## Decision

Yolo copies the Agent Notes mechanism of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) unchanged, including its bilingual system, and makes it the only home of project knowledge:

- The [Agent Note rules](../../README.md) govern layout, the closed class set, the header and body format, lifecycles, the supersession check, the frozen archive with its content-seal manifest, and the ban on a central index. Every note is a triplet: an English file, a `.zh.md` counterpart, and an `.i18n.yaml` consistency record, under the [bilingual contract](2026-10-12-bilingual-documentation.md).
- There is no `docs/` folder and there are no scattered records: the classification gate rejects a `docs/` folder. Reference material that is really a shipped decision about structure — the `/v1` protocol, the plugin API, the media pipeline's Input contract, telemetry, the test layers, the design principles — lives in the implemented note that owns that decision, one decision per note. Future work and open questions live in `proposed/`.
- Root files outside the notes are limited to what GitHub expects: `README.md` (a project landing page, bilingual like the harness's README), `CONTRIBUTING.md` (bilingual like the harness's), `SECURITY.md` and `CODE_OF_CONDUCT.md` (English only; the harness has neither), `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `CHANGELOG.md` (English only: each release's changes and the upgrade facts the upgrade command reads, [versions and releases](2026-10-13-versions-and-releases.md)). `AGENTS.md`, with `CLAUDE.md` as a symlink to it, holds standing orders, each linking the note that owns its rationale. `skills/` holds shipped product skills for agents that deploy, operate, and use an instance, not project documentation.
- Documents link a note by its relative path, and code comments cite it as `Agent Note <file stem>`; nothing cites a decision number or another document's section number.
- The [documentation standard and slop checklist](../../AGENTS.md#the-documentation-standard) live in the notes' own `AGENTS.md`.

### Gates

`npm run doc-sync` runs six gates concurrently through `scripts/run-gates.js`, and `npm run check` runs it before the build and tests:

| Script | Checks |
|---|---|
| `verify-agent-note-classification` | lifecycle and class folders, dated filenames, no `INDEX.md`, no `docs/` |
| `verify-agent-note-format` | header block, status grammar per lifecycle, required and banned sections, alternatives |
| `verify-archived-agent-notes` | archive triplets, archive metadata, sidecar blob hashes, the append-only manifest |
| `verify-translation-pairing` | complete pairs, section records, link locale, switchers, structural signature |
| `verify-md-links` | relative link targets and heading anchors |
| `verify-md-wrap` | one physical line per prose paragraph |

CI runs `doc-sync` with the pull request's base commit as `YOLO_ARCHIVE_BASE_REF` and full history, so a reused shallow checkout cannot hide a changed seal. `lefthook.yml` checks staged pairing records and archive changes before a commit or merge and runs `doc-sync` before a push. The gates have no tests of their own: a gate that broke would show on the next change it should catch.

### What differs from the harness

The mechanism is the harness's; these differences adapt it to Yolo and are kept current when either side changes:

- Every script is plain JavaScript with Node's test runner, because Yolo allows no TypeScript or transpiler. The ported section-record code reproduces the harness's recorded fixture hashes exactly.
- Harness-specific names become Yolo names: the `yolo-archive-agent-notes` skill, `YOLO_ARCHIVE_BASE_REF`, the `yolo-translation-target:` link sentinel, and the `HaitianLiu5/yolo` public URL. npm forwards script arguments only after `--`, so commands read `npm run verify-translation-pairing -- --write <pair>`.
- The format took effect in Yolo on 2026-10-12, so the grandfather comment is valid for notes dated before that day.
- The pairing corpus is every README, the root `CONTRIBUTING.md`, and `.agents/notes/`; the harness's `docs/` and `python/` roots do not exist here.
- An archive kind folder may be absent, because Git keeps no empty directory; the gate rejects unknown kinds among the folders that exist. No seal-transition exceptions exist.
- The pairing gate prunes dependency and runtime folders with a name callback, because Node 22.12 (Yolo's engine floor) accepts no glob patterns in `globSync`'s `exclude`.
- `doc-sync` is a small runner over these six gates, not the harness's general gate scheduler.
- Not ported: the harness's translation brief and prompt tooling, which the pairing gate does not import (it serves an extended, explicitly invoked translation workflow); its word-budget, generated-catalog, and package gates, which govern documents Yolo does not have; and its worktree-local hook installer (see Consequences).

## Alternatives considered

**Keep `docs/` beside the notes.** Two homes bring back the question of where a fact belongs and the duplication that followed from it.

**Adapt the mechanism to Yolo's size**, for example by dropping the archive or the Chinese counterparts. Not done: the mechanism is copied unchanged, so its rules and gates match the harness and later upstream fixes port cleanly. The harness records the rationale for the format, the archive, and the section-keyed pairing records in its own notes: [one gated in-file format](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/archived/process/2026-07-05-uniform-agent-note-format.md), [the frozen archive](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/process/2026-07-26-frozen-agent-note-archive.md), and [section-keyed records](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/archived/process/2026-09-23-section-keyed-translation-pairing-records.md).

**Port the notes but keep numbered decisions in one table.** A number says nothing about where its rationale lives once tables are split or renumbered, and nothing can check it; a relative link can be checked and survives a move between lifecycle folders.

**Port the worktree-local hook installer as well.** The harness installs its hooks per worktree because shared hooks let one worktree's install rewrite every other's. Under npm, the lefthook package's own install script runs before any root script and installs into the shared hooks folder, so a root installer cannot deliver that isolation; it would also migrate the shared repository configuration on the first install.

## Consequences

Every fact has one home that a gate checks: links resolve, notes stay in the format, archived notes cannot change, and both languages stay confirmed against each other. Agents and readers find a decision by browsing a lifecycle and class folder instead of reading four long documents.

The cost is that every documentation change touches two languages and a record, and `npm run check` fails on a broken link or an unconfirmed translation as it does on a failing test. Git hooks installed by lefthook's npm package are shared by all worktrees of the checkout; a worktree without a `lefthook.yml` only prints a notice and commits normally.
