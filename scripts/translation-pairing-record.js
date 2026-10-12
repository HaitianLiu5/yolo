// Canonical paths, section computation, parsing, and rendering for bilingual
// pairing records. A record holds one entry per heading section with
// translated content, so independent edits to different sections change
// separate record lines and merge with Git's default text merge.

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { normalizeTranslationMarkdownLinks } from "./translation-links.js";
import { generatedRegions, parseTranslationMarkdown } from "./translation-pairing.js";

/**
 * The three repository-relative paths that form one bilingual pair: the
 * English document, the Simplified Chinese document, and the consistency record.
 * @typedef {{ source: string, zh: string, meta: string }} TranslationPairPaths
 */

/**
 * Section key (English heading-slug path) → content hashes of the section's
 * translated blocks on each side, in document order.
 * @typedef {ReadonlyMap<string, { en: string, zh: string }>} TranslationPairingRecord
 */

const KEY_LINE = /^(\/[^\s:#]*):$/;
const HASH_LINE = /^ {2}(en|zh): ([0-9a-f]{16})$/;

/**
 * Derive the counterpart and consistency-record paths from an English document.
 * @param {string} source Repository-relative English Markdown path.
 * @returns {TranslationPairPaths} The complete three-path pair.
 */
export function translationPairPaths(source) {
  if (!source.endsWith(".md") || source.endsWith(".zh.md")) {
    throw new Error(`expected an English Markdown path, received ${JSON.stringify(source)}`);
  }
  return {
    source,
    zh: source.replace(/\.md$/, ".zh.md"),
    meta: source.replace(/\.md$/, ".i18n.yaml"),
  };
}

function headingText(node) {
  if ("value" in node && (node.type === "text" || node.type === "inlineCode")) return node.value;
  return "children" in node ? node.children.map(headingText).join("") : "";
}

/**
 * Split normalized Markdown into the preamble plus one section per heading.
 * Fenced code blocks and generated regions, which the pairing gate requires to
 * be identical on both sides, are left out of each section's blocks.
 */
function sections(markdown, tree = parseTranslationMarkdown(markdown)) {
  const frontmatter = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(markdown)?.[0].length ?? 0;
  const result = [{ blocks: frontmatter > 0 ? [markdown.slice(0, frontmatter)] : [] }];
  const regionLines = generatedRegions(markdown).map((region) => [region.begin + 1, region.end + 1]);
  if (tree.type !== "root") throw new Error("Markdown parser returned a non-root tree");
  for (const node of tree.children) {
    if ((node.position?.start.offset ?? 0) < frontmatter) continue;
    if (node.type === "heading") result.push({ heading: node, blocks: [] });
    const line = node.position?.start.line ?? 0;
    if (node.type === "code" || regionLines.some(([begin, end]) => line >= begin && line <= end)) continue;
    result.at(-1)?.blocks.push(markdown.slice(node.position?.start.offset, node.position?.end.offset));
  }
  return result;
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
}

function sectionHash(blocks) {
  return createHash("sha256").update(blocks.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Compute the record for one pair's current contents.
 *
 * Both sides are split at every heading; section `i` of one side corresponds
 * to section `i` of the other. Each side's hash covers its top-level blocks
 * except fenced code blocks and generated regions, which the pairing gate
 * requires to be identical on both sides. A section with no remaining blocks
 * has no entry. Keys are the English heading-slug paths, with `~2`, `~3`, …
 * suffixes on repeats.
 * @param {TranslationPairPaths} paths Pair paths used to resolve each side's relative links.
 * @param {string} en English document text.
 * @param {string} zh Chinese document text.
 * @param {Omit<import("./translation-links.js").TranslationLinkContext, "sourcePath">} context Link-resolution inputs for both sides.
 * @param {{ readonly en: import("mdast").Nodes, readonly zh: import("mdast").Nodes }} [trees] Optional GFM parses of the exact English and Chinese inputs; normalized text is parsed separately when it changes.
 * @returns {TranslationPairingRecord} Entries in document order.
 * @throws {Error} When the two sides have different heading counts or malformed generated regions.
 */
export function computeTranslationPairingRecord(paths, en, zh, context, trees) {
  const normalizedEn = normalizeTranslationMarkdownLinks(en, { ...context, sourcePath: paths.source }, [], trees?.en);
  const normalizedZh = normalizeTranslationMarkdownLinks(zh, { ...context, sourcePath: paths.zh }, [], trees?.zh);
  const enSections = sections(normalizedEn, normalizedEn === en ? trees?.en : undefined);
  const zhSections = sections(normalizedZh, normalizedZh === zh ? trees?.zh : undefined);
  if (enSections.length !== zhSections.length) {
    throw new Error(`${paths.source} has ${enSections.length - 1} heading(s) but ${paths.zh} has ${zhSections.length - 1}`);
  }
  const record = new Map();
  const ancestors = [];
  const keys = new Set();
  for (const [index, enSection] of enSections.entries()) {
    const zhSection = zhSections[index];
    if (zhSection === undefined) throw new Error("section alignment lost its counterpart");
    let path = "/";
    if (enSection.heading !== undefined) {
      const depth = enSection.heading.depth;
      while ((ancestors.at(-1)?.depth ?? 0) >= depth) ancestors.pop();
      ancestors.push({ depth, slug: slug(headingText(enSection.heading)) });
      path = `/${ancestors.map((ancestor) => ancestor.slug).join("/")}`;
    }
    let key = path;
    for (let repeat = 2; keys.has(key); repeat++) key = `${path}~${repeat}`;
    keys.add(key);
    if (enSection.blocks.length === 0 && zhSection.blocks.length === 0) continue;
    record.set(key, { en: sectionHash(enSection.blocks), zh: sectionHash(zhSection.blocks) });
  }
  return record;
}

/**
 * Parse a consistency record.
 * @param {string} content Complete sidecar text.
 * @returns {TranslationPairingRecord | undefined} Entries in file order, or `undefined` for malformed or duplicate entries.
 */
export function parseTranslationPairingRecord(content) {
  const record = new Map();
  const lines = content.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
  for (let index = 0; index < lines.length; index += 3) {
    const key = KEY_LINE.exec(lines[index] ?? "")?.[1];
    const en = HASH_LINE.exec(lines[index + 1] ?? "");
    const zh = HASH_LINE.exec(lines[index + 2] ?? "");
    if (key === undefined || record.has(key) || en?.[1] !== "en" || zh?.[1] !== "zh" || !en[2] || !zh[2]) {
      return undefined;
    }
    record.set(key, { en: en[2], zh: zh[2] });
  }
  return record;
}

/**
 * Render the canonical consistency record for a pair.
 * @param {TranslationPairPaths} paths Pair paths written into the recovery command.
 * @param {TranslationPairingRecord} record Confirmed section hashes.
 * @returns {string} Canonical YAML text with exactly one trailing newline.
 */
export function renderTranslationPairingRecord(paths, record) {
  return [
    `# Bilingual-pair consistency record for ${basename(paths.source)} (.agents/notes/README.md): per heading`,
    "# section, a hash of its English and Chinese blocks outside code blocks and generated regions.",
    "# After editing either side, bring the other along and re-record with:",
    `#   npm run verify-translation-pairing -- --write ${paths.source}`,
    ...[...record].flatMap(([key, hashes]) => [`${key}:`, `  en: ${hashes.en}`, `  zh: ${hashes.zh}`]),
    "",
  ].join("\n");
}

/**
 * Describe how a current record differs from the confirmed one.
 * @param {TranslationPairingRecord} recorded Confirmed record.
 * @param {TranslationPairingRecord} current Record computed from current contents.
 * @returns {string[]} One message per changed, added, or removed section; empty when equal.
 */
export function translationPairingRecordDiff(recorded, current) {
  const out = [];
  for (const [key, hashes] of current) {
    const confirmed = recorded.get(key);
    if (confirmed === undefined) {
      out.push(`section ${key} has unconfirmed translated content`);
      continue;
    }
    const sides = ["en", "zh"].filter((side) => confirmed[side] !== hashes[side]);
    if (sides.length > 0) out.push(`section ${key} changed since confirmation (${sides.join(", ")})`);
  }
  for (const key of recorded.keys()) {
    if (!current.has(key)) out.push(`section ${key} is recorded but no longer has translated content`);
  }
  return out;
}
