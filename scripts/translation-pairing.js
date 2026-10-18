// Pure parsing and structural helpers for the bilingual-document pairing
// gate. Kept separate from the CLI so corpus discovery and signature behavior
// can be regression-tested without reading or mutating the repository tree.
// Also the one home of the generated-region grammar, shared by the pairing
// gate and any region-injecting generator.

import { basename } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import {
  languageSwitcherLinkOffset,
  semanticTranslationLinkNodeTarget,
} from "./translation-links.js";

/** Complete opening marker line: `<!-- BEGIN GENERATED <slug> … -->` (slug captured). */
const GENERATED_REGION_BEGIN_LINE = /^<!-- BEGIN GENERATED (\S+)(?: [^>]*)? -->$/;
/** Complete closing marker line: `<!-- END GENERATED <slug> -->` (slug captured). */
const GENERATED_REGION_END_LINE = /^<!-- END GENERATED (\S+) -->$/;
/** Loose marker detector: any line that LOOKS like a region marker must parse as one. */
const GENERATED_REGION_MARKER_HINT = /^<!-- (?:BEGIN|END) GENERATED /;

/**
 * One generated region: its slug, zero-based marker line indices, and text (markers included).
 * @typedef {{ slug: string, begin: number, end: number, text: string }} GeneratedRegion
 */

/**
 * Locate every generated region. Regions are line-delimited: a marker occupies
 * its whole line, must be a complete well-formed marker, and the closing slug
 * must match the opener.
 * @param {string} content Full Markdown document text.
 * @returns {GeneratedRegion[]} The regions in document order.
 * @throws {Error} On an unopened END, unclosed BEGIN, nested BEGIN, malformed
 *   marker line, or a closing slug that does not match its opener.
 */
export function generatedRegions(content) {
  const lines = content.split("\n");
  const regions = [];
  let open = null;
  for (const [index, line] of lines.entries()) {
    const begin = GENERATED_REGION_BEGIN_LINE.exec(line);
    if (begin?.[1]) {
      if (open) throw new Error("generated region BEGIN marker nested inside an open region");
      open = { slug: begin[1], begin: index };
      continue;
    }
    const end = GENERATED_REGION_END_LINE.exec(line);
    if (end?.[1]) {
      if (!open) throw new Error("generated region END marker without a BEGIN");
      if (end[1] !== open.slug) throw new Error(`generated region END slug '${end[1]}' does not match its BEGIN slug '${open.slug}'`);
      regions.push({ ...open, end: index, text: lines.slice(open.begin, index + 1).join("\n") });
      open = null;
      continue;
    }
    if (GENERATED_REGION_MARKER_HINT.test(line)) {
      throw new Error(`malformed generated region marker line: ${JSON.stringify(line)}`);
    }
  }
  if (open) throw new Error("generated region BEGIN marker without an END");
  return regions;
}

/**
 * Wrap generated Markdown in the marker lines of one region.
 * @param {string} slug Region slug, unique within its page.
 * @param {string} body Region content without markers.
 * @returns {string} The marker-delimited region text.
 */
/**
 * Validated fields of `scripts/translation-pairing.manifest.json`: source
 * documents exempt from pairing because they are generated, instructional, or
 * bilingual by construction.
 * @typedef {{ excluded: string[] }} TranslationPairingManifest
 */

const README_ARTIFACT = /(?:^|\/)readme(?:\.md|\.zh\.md|\.i18n\.yaml)$/i;
const ROOT_PAIRED_DOCUMENT_ARTIFACT = /^(?:contributing)(?:\.md|\.zh\.md|\.i18n\.yaml)$/i;
const NON_SOURCE_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".cache",
  "tmp",
  ".wrangler",
  ".hls-cache",
  ".media-cache",
  ".segment-cache",
  ".logs",
]);

/**
 * Glob traversal exclusion: prune dependency, runtime, and generated
 * directories by name. Node 22.12 passes the callback only an entry name (later
 * releases sometimes pass a relative path), so it matches the last segment;
 * {@link isTranslationScopeFile} still filters every discovered path, including
 * the frozen archive, so pruning only saves traversal.
 * @param {string | import("node:fs").Dirent} entry
 * @returns {boolean}
 */
export function isTranslationScopeGlobExcluded(entry) {
  const name = String(typeof entry === "string" ? entry : entry.name).split(/[\\/]/).at(-1);
  return NON_SOURCE_DIRECTORIES.has(name);
}

/** Whether a repository-relative path belongs to a dependency, runtime, or generated tree. */
function isTranslationSourceExcluded(file) {
  return file.split("/").some((segment) => NON_SOURCE_DIRECTORIES.has(segment));
}

/**
 * Whether one discovered Markdown or sidecar path belongs to the bilingual source corpus.
 * @param {string} file Repository-relative slash path.
 * @returns {boolean}
 */
export function isTranslationScopeFile(file) {
  return !file.startsWith(".agents/notes/archived/")
    && !isTranslationSourceExcluded(file) && (README_ARTIFACT.test(file)
    || ROOT_PAIRED_DOCUMENT_ARTIFACT.test(file)
    || file.startsWith(".agents/notes/"));
}

/** Read the manifest exclusion list or fail before enforcement starts. */
function excludedField(record) {
  const value = record.excluded;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("translation-pairing.manifest.json: excluded must be an array of strings");
  }
  return value;
}

/**
 * Parse and validate the checked-in bilingual manifest.
 * @param {string} content
 * @returns {TranslationPairingManifest}
 */
export function parseTranslationPairingManifest(content) {
  const value = JSON.parse(content);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("translation-pairing.manifest.json: expected an object");
  }
  const unsupported = Object.keys(value).filter((field) => field !== "excluded");
  if (unsupported.length > 0) {
    throw new Error(`translation-pairing.manifest.json: unsupported field(s): ${unsupported.join(", ")}; every in-scope document is required`);
  }
  return { excluded: excludedField(value) };
}

/**
 * Whether a manifest entry excludes one exact file or a directory subtree.
 * @param {string} file
 * @param {TranslationPairingManifest} manifest
 * @returns {boolean}
 */
export function isTranslationPairingManifestExcluded(file, manifest) {
  return manifest.excluded.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

/**
 * Build the active bilingual-source predicate shared by every link consumer.
 * @param {TranslationPairingManifest} manifest
 * @returns {(sourcePath: string) => boolean}
 */
export function translationPairSourcePredicate(manifest) {
  return (sourcePath) => isTranslationScopeFile(sourcePath)
    && !isTranslationPairingManifestExcluded(sourcePath, manifest);
}

/**
 * Normalize one CLI pair argument to its English anchor path: any of the
 * pair's three files (`foo.md`, `foo.zh.md`, `foo.i18n.yaml`) or the bare
 * `foo` stem names the same pair, and platform separators are accepted.
 * @param {string} argument Repo-relative path as passed on a command line.
 * @returns {string} The pair's `foo.md` anchor path with `/` separators.
 */
export function pairAnchorOfArgument(argument) {
  const normalized = argument.split("\\").join("/").replace(/^\.\//, "");
  if (normalized.endsWith(".zh.md")) return `${normalized.slice(0, -".zh.md".length)}.md`;
  if (normalized.endsWith(".i18n.yaml")) return `${normalized.slice(0, -".i18n.yaml".length)}.md`;
  if (normalized.endsWith(".md")) return normalized;
  return `${normalized}.md`;
}

/**
 * A parsed `verify-translation-pairing` invocation. `input` is the content
 * plane read by the check (writes and corpus checks use the working tree);
 * `scope` is `corpus` for discovery over the whole tree or `pairs` for only
 * the named anchors (English anchor paths, empty for corpus scope).
 * @typedef {{ input: "worktree" | "index", mode: "check" | "list" | "write", scope: "corpus" | "pairs", anchors: string[] }} TranslationPairingCliRequest
 */

/**
 * Parse and validate `verify-translation-pairing` CLI arguments.
 *
 * Check accepts optional pair paths; `--write` requires either pair paths or
 * `--all` so a bulk re-record is always an explicit choice — a bare
 * `--write` would silently bless every drifted pair in the tree, including
 * ones the caller never confirmed. `--list` is corpus-only.
 * @param {string[]} argv Arguments after the script name.
 * @returns {TranslationPairingCliRequest} The validated request.
 * @throws {Error} When flags or their combination are invalid.
 */
export function parseTranslationPairingCliArgs(argv) {
  const flags = argv.filter((argument) => argument.startsWith("--"));
  const anchors = [...new Set(argv.filter((argument) => !argument.startsWith("--")).map(pairAnchorOfArgument))].sort();
  const unknown = flags.filter((flag) => !["--list", "--write", "--all", "--cached"].includes(flag));
  if (unknown.length > 0) throw new Error(`unknown flag(s): ${unknown.join(", ")}`);
  const listMode = flags.includes("--list");
  const writeMode = flags.includes("--write");
  const allMode = flags.includes("--all");
  const cachedMode = flags.includes("--cached");
  if (listMode && (writeMode || allMode || cachedMode || anchors.length > 0)) {
    throw new Error("--list reports the whole corpus and takes no other flags or paths");
  }
  if (allMode && !writeMode) throw new Error("--all only applies to --write");
  if (cachedMode && writeMode) throw new Error("--cached is a read-only index check and cannot be combined with --write");
  if (cachedMode && anchors.length === 0) throw new Error("--cached requires the staged pair paths to check");
  if (writeMode) {
    if (anchors.length > 0 && allMode) throw new Error("--write takes either pair paths or --all, not both");
    if (anchors.length === 0 && !allMode) {
      throw new Error("--write requires the pair(s) you confirmed (any file of a pair), or --all to re-record every complete pair; recording pairs you did not review blesses unconfirmed content");
    }
    return { input: "worktree", mode: "write", scope: allMode ? "corpus" : "pairs", anchors };
  }
  if (listMode) return { input: "worktree", mode: "list", scope: "corpus", anchors: [] };
  return {
    input: cachedMode ? "index" : "worktree",
    mode: "check",
    scope: anchors.length > 0 ? "pairs" : "corpus",
    anchors,
  };
}

/**
 * The structural signature compared between the two sides of a pair:
 * heading depths, verbatim fenced code blocks (info string plus content),
 * table row and column counts, list kinds/starts/direct item counts, and
 * every link target in order with the language switcher excluded.
 * @typedef {{ headings: number[], code: string[], tables: string[], lists: string[], links: string[] }} TranslationStructureSignature
 */

/**
 * Parse Markdown with the same GFM extensions used by the pairing gate.
 * @param {string} content
 * @returns {import("mdast").Nodes}
 */
export function parseTranslationMarkdown(content) {
  return fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

const PUBLIC_REPOSITORY_BLOB_ROOT = "https://github.com/HaitianLiu5/yolo/blob/main/";

/**
 * Return the accepted relative and public-repository links to one counterpart.
 * @param {string} counterpart Repository-relative path of the other side.
 * @returns {string[]}
 */
export function languageSwitcherTargets(counterpart) {
  return [basename(counterpart), `${PUBLIC_REPOSITORY_BLOB_ROOT}${counterpart}`];
}

/**
 * Generated English sources cannot carry a switcher without making their
 * generator stale. Yolo has no generated paired sources yet.
 */
const GENERATED_ENGLISH_SOURCES = new Set();

/**
 * Whether an English source must carry the reciprocal language switcher.
 * @param {string} source
 * @returns {boolean}
 */
export function requiresSourceLanguageSwitcher(source) {
  return !GENERATED_ENGLISH_SOURCES.has(source);
}

/**
 * Collect the ordered structural signature, skipping accepted switcher targets.
 * @param {import("mdast").Nodes} tree
 * @param {string | readonly string[]} switcherTargets
 * @param {import("./translation-links.js").TranslationLinkContext & { markdown: string }} linkContext
 * @returns {TranslationStructureSignature}
 */
export function translationStructureSignature(tree, switcherTargets, linkContext) {
  const switcherOffset = languageSwitcherLinkOffset(tree, linkContext.markdown, switcherTargets);
  const sig = { headings: [], code: [], tables: [], lists: [], links: [] };
  const definitions = new Map();
  const collectDefinitions = (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
    if ("children" in node) for (const child of node.children) collectDefinitions(child);
  };
  collectDefinitions(tree);
  const linkTarget = (node) => semanticTranslationLinkNodeTarget(node, linkContext.markdown, linkContext);
  const visit = (node) => {
    switch (node.type) {
      case "heading":
        sig.headings.push(node.depth);
        break;
      case "code":
        sig.code.push(`\`\`\`${node.lang ?? ""}${node.meta ? ` ${node.meta}` : ""}\n${node.value}`);
        break;
      case "table":
        sig.tables.push(`${node.children.length}x${node.children[0]?.children.length ?? 0}`);
        break;
      case "list":
        sig.lists.push(node.ordered
          ? `ordered:start=${node.start ?? 1}:items=${node.children.length}`
          : `bullet:items=${node.children.length}`);
        break;
      case "link":
        if (node.position?.start.offset !== switcherOffset) {
          sig.links.push(linkTarget(node));
        }
        break;
      case "linkReference": {
        const definition = definitions.get(node.identifier);
        if (definition !== undefined) {
          sig.links.push(linkTarget(definition));
        }
        break;
      }
      default:
        // Every other node kind is prose or a container, not part of the signature.
        break;
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return sig;
}

/** Render a signature element for an error message, truncated for readability. */
function show(value) {
  if (value === undefined) return "nothing";
  const text = JSON.stringify(value);
  return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}

/**
 * Return the first divergence for each structural field; empty means equal.
 * @param {TranslationStructureSignature} source
 * @param {TranslationStructureSignature} zh
 * @returns {string[]}
 */
export function translationStructureDiff(source, zh) {
  const out = [];
  const fields = [
    ["heading (depth)", source.headings, zh.headings],
    ["code block", source.code, zh.code],
    ["table (row x column count)", source.tables, zh.tables],
    ["list (kind, start, item count)", source.lists, zh.lists],
    ["link target", source.links, zh.links],
  ];
  for (const [field, sourceValues, zhValues] of fields) {
    const length = Math.max(sourceValues.length, zhValues.length);
    for (let index = 0; index < length; index++) {
      if (sourceValues[index] !== zhValues[index]) {
        out.push(`${field} #${index + 1} diverges between the pair: ${show(sourceValues[index])} vs ${show(zhValues[index])}`);
        break;
      }
    }
  }
  return out;
}
