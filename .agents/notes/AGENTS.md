# AGENTS.md — Agent Notes

Agent Notes are effectively RFCs written by agents: durable proposals and decision records that preserve rationale, alternatives, consequences, and required verification. Follow the [documentation standard](#the-documentation-standard) below and the [Agent Note rules](README.md).

**Every new Agent Note triggers a supersession check.** Search the active tree for older notes covering the same decision or mechanism, classify any full or partial supersession with [`yolo-archive-agent-notes`](../skills/yolo-archive-agent-notes/SKILL.md), and archive every qualifying implemented triplet in the same PR. Keep partial supersessions active and cross-linked.

Files under [`archived/`](archived/AGENTS.md) are frozen historical snapshots: never edit them or treat them as current authority.

## The documentation standard

This standard decides where each fact about Yolo lives and how it is written. Yolo keeps no `docs/` folder and no scattered records: project knowledge lives in Agent Notes, and the classification gate rejects a `docs/` folder ([rationale](implemented/process/2026-10-12-agent-notes-hold-project-knowledge.md)).

### Document structure

The README pair and the root community files are human-facing documents; Agent Notes follow the [Agent Note rules](README.md). A document's subject and tree position fix its scope: describe its own subject at appropriate detail and link to the owning note for lower-level detail.

Classify every human-facing section as a tutorial or reference. Tutorials follow an ordered path to an outcome and introduce only what each step needs. References define a lookup scope and current behavior without a teaching sequence. Label a section when either part is small.

### The tier taxonomy: one home per fact

Each fact has one home: the tier whose job it is; elsewhere, link there.

| Tier | Job | Does NOT belong there |
|---|---|---|
| Root `AGENTS.md` (`CLAUDE.md` symlinks it) | Standing orders: the project summary, code map, commands, and rules an agent needs in every session, one to three lines each, linking the note that owns the rationale | Stories, worked examples, situational procedures, anything restated from a linked note |
| Subtree `AGENTS.md` (`.agents/notes/`) | Orders specific to that subtree, including this standard | Repo-wide rules the root file already carries |
| [Agent Notes](README.md) | All durable project knowledge: decisions with their rationale and alternatives, the shipped contracts each decision owns (protocol, plugin API, data model, telemetry, test layers, design principles), and in `proposed/` the future work and open questions; `implemented/` notes describe shipped reality in present tense | Migration plans, acceptance-task checklists, fixture walkthroughs, and spec-speak ("should…") once the decision has shipped; archived notes are frozen history, never current authority |
| README pair (`README.md`, `README.zh.md`) | The GitHub landing page: what Yolo is, how it works, status, a high-level quick start, and links into the notes | Rationale, protocol detail, and full procedures (→ the owning note) |
| Root community files: the `CONTRIBUTING.md` pair, `SECURITY.md`, `CODE_OF_CONDUCT.md` | GitHub's contributor, vulnerability-reporting, and conduct entry points, kept to what is true now | Architecture or security design detail (→ the owning note) |
| Skills | `.agents/skills/`: repository workflows for agents working on Yolo; `skills/`: shipped product skills for agents that use Yolo's MCP server | Product and runtime contracts (→ the owning note) |
| Code comments | The local contract of the code they sit on | Rationale (→ the owning note, linked by path) |
| `.env.example`, `yolo.config.example.json` | Every configuration variable and plugin option with its default | Why a default was chosen (→ the owning note) |

Placement: rationale and contracts → Agent Notes; future work and open questions → `proposed/` notes; standing orders → root `AGENTS.md` with a rationale link; configuration → `.env.example`.

### Writing rules

- **Document current state.** Keep history in commits, PRs, and Agent Notes. Other prose names live mechanisms, not changes or version stages.
- **Record outcomes, not the discussion.** A note states the decision and the reason it holds; it never narrates who chose it, who asked for it, or how the conversation went (no "the owner chose", "at the owner's request", "after discussion"). An alternative states why it lost, not who rejected it.
- **Apply the Agent Note creation criteria.** Mechanical/local edits are exempt, including local UI changes; keep existing owning notes accurate ([scope](README.md#when-to-write-one)).
- **One physical line per paragraph** (`verify-md-wrap`): use editor soft-wrap. Code blocks, tables, and list structure keep their formatting.
- **Pairs update together**: an edit to either side of a bilingual pair updates the counterpart in the same change and re-records the pair ([contract](implemented/process/2026-10-12-bilingual-documentation.md)).
- **Cite notes by path or file stem, never by number.** A document links the owning note's relative path; a code comment cites it as `Agent Note <file stem>` (for example `Agent Note 2026-10-07-v1-http-api`), which is unique and survives a move between lifecycle folders. Decision numbers and other documents' section numbers do not survive edits.
- **Comments state complete contracts, not reasoning transcripts.** Preserve behavior, failure, timing, ownership, exceptions, consequences, and non-obvious orientation; delete narration, test walkthroughs, review analysis, and code restatement. Keep the local contract and link its rationale.
- Write directly: name actors and facts. Name the exact check, type, API, operation, or behavior instead of a metaphor.

### The slop checklist

Hunt these in any doc:

- Duplicated rules: search a distinctive phrase; keep one home and link the rest.
- History outside its permitted tier: state current facts and link the historical owner.
- Implementation-status annotations in prose or diagrams ("implemented!", "future: …"). Status rots; the lifecycle folder of the owning note and the code carry it.
- Hand-restated catalogs or inventories of tests, packages, and status when source is authoritative.
- Reasoning transcripts: step-by-step implementation narration, proof of obvious branches, test walkthroughs, or rejected local alternatives. Keep the resulting contract or durable rationale; delete the path used to derive it.
- Rationale repeated beside sibling functions instead of once at the owning capability or helper.
- Paragraph walls: one paragraph carrying several rules and parenthetical asides. Split it or demote the detail to its home.
- Emphasis inflation: bold, CAPS, or "critically" everywhere means nothing stands out. Reserve emphasis for the clause that changes behavior.
- Spec-speak in `implemented/` Agent Notes: "should", migration plans, acceptance checklists. An implemented Agent Note describes what is, per the [implemented-note instructions](implemented/AGENTS.md).

### Repository references

Use relative Markdown links for current files and PR numbers for historical references. `verify-md-links` checks local targets and heading anchors; a Chinese document links a `.zh.md` sibling and carries an explicit `<a id>` for every English anchor other documents link into.
