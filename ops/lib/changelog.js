// CHANGELOG.md: one "## vX.Y.Z (YYYY-MM-DD)" section per release, each with
// a fenced ```yolo-upgrade block of JSON that `yolo upgrade` reads
// (Agent Note 2026-10-13-versions-and-releases):
//
//   protocol    the internal protocol number of the release
//   migrations  D1 migrations the release adds
//   secrets     new Worker secrets: [{ name, required, how }]
//   settings    new node .env settings: [{ name, required, how }]
//   resources   new Cloudflare resources or bindings, in words
//   node        "restart" when the node changed, else "none"
//   rollback    "code": the previous release runs on this release's data;
//               "restore": rolling back also restores D1 from the backup
//   human       actions only a person can take, in words

export const UPGRADE_FIELDS = Object.freeze({ protocol: 0, migrations: [], secrets: [], settings: [], resources: [], node: "restart", rollback: "code", human: [] });

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

export function parseChangelog(text) {
  const releases = [];
  const headings = [...text.matchAll(/^## v(\d+\.\d+\.\d+)(?: \((\d{4}-\d{2}-\d{2})\))?\s*$/gm)];
  headings.forEach((heading, index) => {
    const body = text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length);
    const block = /^```yolo-upgrade\n([\s\S]*?)^```/m.exec(body);
    let upgrade = null;
    let error = null;
    if (block) {
      try {
        upgrade = { ...UPGRADE_FIELDS, ...JSON.parse(block[1]) };
      } catch (parseError) {
        error = `v${heading[1]}: the yolo-upgrade block is not JSON (${parseError.message})`;
      }
    } else {
      error = `v${heading[1]}: no yolo-upgrade block`;
    }
    releases.push({ version: heading[1], date: heading[2] ?? null, notes: body.replace(/^```yolo-upgrade\n[\s\S]*?^```\n?/m, "").trim(), upgrade, error });
  });
  return releases;
}

// What an upgrade from `from` (exclusive) to `to` (inclusive) involves.
export function upgradePath(releases, from, to) {
  const steps = releases.filter((release) => compareVersions(release.version, from) > 0 && compareVersions(release.version, to) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version));
  const blocks = steps.map((release) => release.upgrade).filter(Boolean);
  return {
    releases: steps.map(({ version, date, notes }) => ({ version, date, notes })),
    errors: steps.map((release) => release.error).filter(Boolean),
    protocol: blocks.at(-1)?.protocol ?? null,
    migrations: blocks.flatMap((block) => block.migrations),
    secrets: blocks.flatMap((block) => block.secrets),
    settings: blocks.flatMap((block) => block.settings),
    resources: blocks.flatMap((block) => block.resources),
    human: blocks.flatMap((block) => block.human),
    nodeRestart: blocks.some((block) => block.node !== "none"),
    rollback: blocks.some((block) => block.rollback === "restore") ? "restore" : "code",
  };
}
