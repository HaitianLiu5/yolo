---
name: yolo-archive-agent-notes
description: Use when adding, auditing, pruning, archiving, restoring, or reviewing Agent Notes in Yolo; checks every new note for superseded active records, deletes small UI and purely mechanical records, classifies other implemented notes by future decision value, deletes rejected notes that no longer prevent a tempting fallacy, and applies the frozen archived/{kind} triplet and manifest rules.
---

# Archive Yolo Agent Notes

Reduce the active decision corpus without erasing history that can still guide work. Judge every note semantically; word count and age are discovery aids, never archive criteria.

## Read the contracts

Read [the Agent Note rules](../../notes/README.md), [the archive instructions](../../notes/archived/AGENTS.md), and the applicable active lifecycle instructions before classifying. Use current code, configuration, `.env.example`, newer Agent Notes, and inbound links to establish whether a rationale still owns or constrains anything.

## Check supersession when adding a note

Before drafting, apply the [creation criteria](../../notes/README.md#when-to-write-one). Every new Agent Note triggers a scoped audit of active notes covering the same decision, mechanism, or rejected alternative. Classify each full or partial supersession while writing the new note: archive qualifying implemented triplets in the same PR, retain and cross-link partial supersessions or independently useful rationale, reject obsolete proposals, and delete rejected notes that no longer prevent a plausible mistake. Apply the Agent Note consolidation rule when the new owner absorbs every unique proposition; do not defer a known match to a later corpus audit.

## Classify by future value

Apply these lifecycle-specific outcomes:

- **Implemented — delete:** delete complete triplets that only describe small UI adjustments or purely mechanical changes, and repair or remove inbound links. Local bug fixes, performance changes, new capabilities, and substantive behavior or ownership decisions do not qualify merely because they are implemented. Apply this criterion before keep/archive classification.
- **Implemented — keep active:** retain a note when its rationale, alternatives, negative guarantees, durable/wire semantics, ownership boundary, security rule, or reintroduction condition is likely to guide a future change. Classify the decision, not the mechanics of its implementation: a mechanical rename or type extraction can still record lasting naming, compatibility, or ownership rules. Length does not matter.
- **Implemented — archive:** archive a substantive historical decision when it is complete and unlikely to guide future work, but its historical rationale still warrants preservation. Do not archive records that meet the direct-deletion criterion.
- **Proposed — never archive:** keep a live proposal active; if it is no longer worth pursuing, reject it with an honest reason and satisfy the rejected lifecycle format.
- **Rejected — keep only as a guardrail:** retain a rejection only when the losing proposal remains a tempting, meaningful mistake and the note explains why it loses.
- **Rejected — delete:** delete the whole triplet when the rejected idea is obsolete, superseded, no longer plausible, or unlikely to prevent re-litigation. Repair or delete inbound links.

Do not archive toward a quota. Inspect every note in scope, classify analogous groups under one principle, use best judgment for close cases, and record genuinely borderline decisions for the handoff.

## Calibrated examples

These examples set the bar; the word counts demonstrate that size is not the test.

Delete implemented notes such as:

- the player chrome sized from shared design tokens, with neutral frosted menus: closed, minor UI behavior that the design-principles note already governs;
- a completed function relocation and import rewiring with unchanged behavior.

Keep implemented notes such as:

- [same-origin media passthrough](../../notes/implemented/architecture/2026-10-07-same-origin-media-passthrough.md) — 560 words: foundational security, cookie, and wire boundary;
- [Workers VPC node access](../../notes/implemented/architecture/2026-10-08-workers-vpc-node-access.md) — 584 words: single ownership of control-plane-to-node calls plus a documented fallback that must stay possible;
- [D1 data model](../../notes/implemented/architecture/2026-10-07-d1-data-model.md) — 600 words: durable storage policy (`user_id` everywhere, never edit an applied migration);
- [Plex session recovery](../../notes/implemented/bug-fix/2026-09-10-plex-session-recovery.md) — 639 words: a local bug fix, kept because its typed-expiration contract and retry budgets bind every transcoder-backed source.

Archive implemented notes such as:

- [the Drive-In repository review fixes](../../notes/archived/bug-fix/2026-09-06-drive-in-review-fixes.md) — 618 words: complete local fixes to a removed server whose few surviving rules now live in active notes, kept for their historical reasoning.

For rejected notes:

- keep [emulating a Plex Media Server](../../notes/rejected/architecture/2026-10-11-emulate-a-plex-media-server.md) — 234 words: Infuse and the Plex apps would work unchanged, so the temptation remains meaningful;
- delete a rejection once its premise is obsolete, for example a rejected alternative to a server that no longer exists.

## Archive one implemented triplet

1. Move the complete `foo.md`, `foo.zh.md`, and `foo.i18n.yaml` triplet from `implemented/<kind>/` to `archived/<kind>/`; `implemented` is deliberately absent from the archive path.
2. Make no body edits. Insert only `Archived: YYYY-MM-DD` immediately below `Status: implemented` in both language files, using the archival date and the same value on both sides.
3. Re-record the sidecar mechanically for the two metadata-only edits: an archived sidecar holds the Git blob hash of each side, not the section hashes of an active pair. Do not translate, reformat, update facts, or repair links inside the note. Existing title punctuation, blank-line layout, and language-switcher wording are preserved, not prerequisites for archival.

   ```sh
   dir=.agents/notes/archived/<kind>; base=<yyyy-mm-dd-topic>
   { echo "# Archived bilingual-pair record: the Git blob hash of each side as sealed."
     echo "$base.md: $(git hash-object --no-filters "$dir/$base.md")"
     echo "$base.zh.md: $(git hash-object --no-filters "$dir/$base.zh.md")"; } > "$dir/$base.i18n.yaml"
   ```

4. Search for inbound links from active prose. Redirect them to current authority, retarget them to the archived path only when the historical snapshot is intentionally cited, or delete them. Never verify or repair links out of the archived note.
5. Run `npm run verify-archived-agent-notes -- --write`. Its append-only mode first proves every existing seal still matches, then adds only the new triplet hashes. Run the normal verifier afterward.

After the triplet is sealed, never edit, move, translate, reformat, or delete it. Archived notes remain valid inbound-link targets but are historical snapshots, not authority for current behavior.

## Validate and report

Run the archive verifier's focused test (`node --test scripts/archived-agent-notes.test.js scripts/agent-note-gates.test.js`), `npm run verify-archived-agent-notes`, `npm run doc-sync`, and `git diff --check`.

Report active implemented notes kept, implemented notes deleted or archived, rejected notes kept/deleted, proposed notes rejected if any, and every genuinely borderline case with its word count and chosen outcome. Do not claim archived outbound links are valid: the archive verifier intentionally never checks them.
