// Every `yolo` command returns one result object and prints it as text or,
// with --json, as JSON on stdout. The exit code follows `status`, so an agent
// can branch on either.
//
// { command, status, summary, steps|checks: [{ id, status, message,
//   instructions?: [string], fix? }], next?: [string], ...command-specific fields }

export const EXIT_CODES = Object.freeze({
  ok: 0,
  failed: 1,
  needs_approval: 2,
  needs_human: 3,
});

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip", info: "info", needs_human: "HUMAN", needs_approval: "APPROVE", done: "done", unchanged: "same" };

// A step's `instructions` (what a person does, in order) print numbered,
// one per line, before its fix.
function line(entry) {
  const tag = MARK[entry.status] ?? entry.status;
  const lines = [`  [${tag}] ${entry.message}`];
  for (const [index, text] of (entry.instructions ?? []).entries()) lines.push(`         ${index + 1}. ${text}`);
  if (entry.fix && entry.status !== "ok" && entry.status !== "done" && entry.status !== "unchanged") lines.push(`         fix: ${entry.fix}`);
  return lines.join("\n");
}

function renderText(result) {
  const out = [];
  if (result.summary) out.push(result.summary);
  const groups = new Map();
  for (const entry of result.checks ?? result.steps ?? []) {
    const group = entry.group ?? "";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }
  for (const [group, entries] of groups) {
    if (group) out.push(`\n${group}`);
    out.push(...entries.map(line));
  }
  if (result.plan?.length) out.push("\nPlan:", ...result.plan.map((step, index) => `  ${index + 1}. ${step}`));
  if (result.next?.length) out.push("\nNext:", ...result.next.map((step) => `  - ${step}`));
  if (result.status === "needs_approval" && result.approve) out.push(`\nNothing was changed. After the owner approves, run: ${result.approve}`);
  return `${out.join("\n")}\n`;
}

export function finish(result, { json = false } = {}) {
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result));
  process.exitCode = EXIT_CODES[result.status] ?? 1;
}

// The worst status of a list of checks or steps.
export function overall(entries) {
  const statuses = new Set(entries.map((entry) => entry.status));
  if (statuses.has("fail")) return "failed";
  if (statuses.has("needs_human")) return "needs_human";
  if (statuses.has("needs_approval")) return "needs_approval";
  return "ok";
}
