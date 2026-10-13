# Agent Note: Bilingual documentation pairs

Status: implemented

English | [中文](2026-10-12-bilingual-documentation.zh.md)

## Problem

Yolo's documentation is read by people and agents in English and in Chinese. The owner wrote the design documents in Chinese, while the code, commit messages, README, and most agent work are in English. A document kept in one language leaves the other audience to translate it privately, those translations drift, and nothing showed when two versions disagreed.

## Decision

Every document in scope is maintained in English and Simplified Chinese under the contract below. It is the [DeepSeek Harness i18n contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/i18n/README.md) with Yolo's scope, as part of [adopting Agent Notes](2026-10-12-agent-notes-hold-project-knowledge.md).

### The pairing contract

- **Both languages carry equal authority.** A document may be authored and reviewed in either language first, and the counterpart is translated from it. Neither file outranks the other; what binds them is that they must say the same thing.
- **A pair is three sibling files.** The English `foo.md`, the Chinese `foo.zh.md`, and a consistency record `foo.i18n.yaml`, all in the same directory. Pairs merge whole: a PR never lands one language without the other two files.
- **The consistency record.** `foo.i18n.yaml` holds one entry per heading section that contains language-specific content. The key is the section's English heading-slug path (`/` for text before the first heading; a repeated path gets `~2`, `~3`, …), and the entry holds a hash of the English and of the Chinese blocks of that section, outside fenced code blocks and generated regions. Edits to different sections change separate record lines, so Git's default text merge composes them; a record conflicts only when both branches changed the same section. An out-of-sync pair is updated by patching the counterpart against the edited side's diff, never by re-translating whole files; the gate names each changed section. After bringing the pair back in line, `npm run verify-translation-pairing -- --write <pair>` re-records it; that diff is the reviewable act of confirming consistency, which is why `--write` requires naming the confirmed pairs (`--write --all` is the explicit corpus-wide form).

  ```yaml
  /foo:
    en: 41d772192075e133
    zh: dda91c6c670cfd9d
  /foo/usage:
    en: 86940bea4a3c7ed6
    zh: de78429597783c7f
  ```

- **Language switcher.** The Chinese file links back immediately after its H1 with `[English](foo.md) | 中文`; the English file reciprocates there with `English | [中文](foo.zh.md)`. A page published outside GitHub may use the public `https://github.com/HaitianLiu5/yolo/blob/main/<path>` URL of the same counterpart.
- **Structure mirrors the counterpart.** Heading depths and order, list kinds, ordered-list starts, list item counts, table row and column counts, semantic link targets with exact query and fragment suffixes, and verbatim code blocks match one to one. A relative link to a document of the bilingual corpus uses `.md` on the English side and `.zh.md` on the Chinese side; a missing counterpart is a completeness error, not a fallback. A Chinese document carries an explicit `<a id="…">` for every English heading anchor that other documents link into, because its own headings slug differently.

### The gate: verify-translation-pairing

`npm run verify-translation-pairing` (part of `doc-sync`) enforces the contract:

1. Every document in scope has a complete pair.
2. Every pair that exists at all is complete and consistent: the record is canonical and equals the record computed from the current contents, both switchers are present, every relative document link uses its side's locale, and the structural signatures match.
3. A document listed as excluded has no `.zh.md` and no `.i18n.yaml`. Archived notes are outside this gate; `verify-archived-agent-notes` seals their triplets instead.

`--list` prints every in-scope document as `ok`, `out-of-sync`, or `missing` and never fails. Naming pairs (any of a pair's three files, or its bare stem) checks only those pairs; the corpus-wide form is what `doc-sync` and CI run. `--cached <pairs>` checks the staged bytes and is what the pre-commit hook runs.

The practical rule: **a change to either side of a pair updates the counterpart in the same change and re-records it with `--write <pair>`.** A green gate means the pair was confirmed consistent at these exact contents, not that the confirmation was sound: it checks hashes and Markdown structure, never meaning, terminology, or tone. Review owns those.

### Scope and exclusions

In scope: every README (matched case-insensitively on the basename) outside dependency, build, and runtime folders; the root `CONTRIBUTING.md`; and every active document under `.agents/notes/`. [scripts/translation-pairing.manifest.json](../../../../scripts/translation-pairing.manifest.json) lists only exclusions:

- `.agents/notes/AGENTS.md`, `.agents/notes/implemented/AGENTS.md`, and its `CLAUDE.md` symlink — agent instructions, kept in English like the root `AGENTS.md`.

The frozen `.agents/notes/archived/` tree is outside the evolving gate. Documents outside the corpus — `AGENTS.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, skills, GitHub templates, and code comments — are English only.

### Translation rules

- **Faithfulness.** The counterpart says what the authored side says: no added behavior, prerequisites, warnings, or examples, and none dropped. If the two disagree on substance, fix the side that is wrong and bring the other along in the same change. Translate meaning, not words, and keep the author's register: terse stays terse.
- **Voice.** Write as a native technical author restating the content. Give Chinese sentences an explicit actor instead of vague passives, and prefer established engineering idiom to calques.
- **Structure.** Keep the heading hierarchy, list shape, tables (header cells translated), byte-identical code blocks, inline code spans, and link targets. Translate heading text and link text.
- **Chinese typography.** Put a half-width space between Chinese and Latin words or numerals; use full-width punctuation in Chinese prose and 顿号（、）for parallel items; prefer commas, colons, or parentheses to em dashes; write 你, not 您; keep proper nouns in their canonical casing.
- **Terminology.** Follow the table below in both directions. A Chinese counterpart uses the 中文 column and writes the 首次出现 form at a term's first mention. A new term without established usage stays in English and is added to the table in the same change.

### Terminology

| English | 中文 | 首次出现 | Note |
|---|---|---|---|
| agent | agent | agent（智能体） | An AI agent such as ChatGPT, Claude, or Codex |
| Agent Note | Agent Note | | The H1 prefix `# Agent Note: ` stays in English |
| MCP | MCP | | |
| control plane | 控制面 | | The Cloudflare Worker |
| media node | 媒体节点 | | Short form 节点 |
| Hub | Hub | | The per-user Durable Object |
| owner | 用户本人 | | Yolo's single user |
| device | 设备 | | |
| active device | 当前设备 | | |
| capabilities | 能力描述 | | |
| source plugin | 片源插件 | | |
| Source, sourceKey, Input | Source、sourceKey、Input | | Protocol shapes keep their English names |
| session | 会话 | | A playback session |
| stream | 流 | | |
| segment | 分片 | | |
| delivery | 交付方式 | | |
| transcode | 转码 | | |
| burn in | 烧录 | | Image subtitles drawn into the picture |
| queue, playlist | 队列、播放列表 | | |
| passkey | passkey | | |
| owner pairing code | 配对码 | | The node's 6-digit code |
| device code flow | 设备码流程 | | RFC 8628 |
| device credential | 设备凭据 | | `ydt_…` |
| media token | 媒体 token | | |
| realtime channel | 实时通道 | | |
| node renderer | 节点渲染器 | | |
| the player | 播放器 | | Yolo's one browser app (`clients/tesla`), served at the site root |
| car profile, web profile | 车机 profile、web profile | | The player's two profiles (`car`, `web`) |
| canvas engine, `<video>` engine | canvas 引擎、`<video>` 引擎 | | The player's two playback engines |
| Tesla | 特斯拉 | | The vehicle and its browser only, never the app |
| doc-sync | doc-sync | doc-sync（文档同步门禁） | |
| gate | 门禁 | | |
| fixture | fixture | fixture（测试前置数据） | |
| manifest | manifest | manifest（元数据清单） | |
| PR | PR | PR（Pull Request） | |

### Division of labor

The working agent updates a routine counterpart directly, in one pass after reading the terminology table; it does not generate a translation brief, run a separate translation pass, or delegate. The gate checks pair completeness, recorded hashes, switchers, link locale, and the structural signature. Review owns translation quality, terminology, and the structure the signature does not encode.

## Alternatives considered

**Locale directories, a separate translation repository, or interleaved bilingual files.** Sibling files keep a pair in one directory, so it moves, links, and merges as a unit, and each file stays readable on its own.

**Chinese only, as Yolo's design documents were.** It leaves the English side of the project — the README, code comments, commits, and agents working in English — without the rationale.

**English only.** It drops the language the owner wrote the design in.

**Whole-file blob hashes as the record.** Any edit changes both lines of such a record, so two branches that edit different sections of one pair always conflict. Archived notes still use that format for their seals, because they never change.

**The harness's translation brief and prompt tooling.** It serves an extended translation workflow that runs only when explicitly invoked, and the pairing gate does not depend on it; Yolo does not port it.

## Consequences

Both audiences read the same, confirmed content, and a pair cannot drift unnoticed: an edit to one side turns the gate red until the other side follows and the pair is re-recorded. Each documentation change costs a second-language edit and a record update, and a green gate still needs a reviewer to judge the translation itself.
