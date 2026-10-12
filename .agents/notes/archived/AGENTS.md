# AGENTS.md — Archived Agent Notes

Archived Agent Note triplets under the kind directories are frozen historical snapshots, not current authority. Never edit, reformat, translate, repair, delete, or move a sealed artifact; use an active Agent Note or current documentation for new decisions and facts.

The archival change may only relocate a complete English/Chinese/sidecar triplet, insert the identical `Archived: YYYY-MM-DD` line below both `Status: implemented` lines, re-record the sidecar, and repair or delete inbound links. Do not inspect, verify, or repair links out of archived notes.

Run the [`yolo-archive-agent-notes`](../../skills/yolo-archive-agent-notes/SKILL.md) workflow and append new artifact hashes with `npm run verify-archived-agent-notes -- --write`. The normal verifier rejects changed or missing sealed artifacts, incomplete triplets, unknown kind folders, and invalid archive metadata.

No seal-transition exceptions exist. An owner-authorized exception is an exact old-to-new hash for one sealed path, listed in `AUTHORIZED_SEAL_TRANSITIONS` in `scripts/archived-agent-notes.js` and named here; it permits no other content change, reversal, or deletion.
