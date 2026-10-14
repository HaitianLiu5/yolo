import { RESET_ALL_IMAGE_LINKS_SQL } from "../../service/control/src/store/image-links.js";
import { deployContext } from "../lib/context.js";
import { overall } from "../lib/output.js";
import { wrangler, wranglerError } from "../lib/run.js";

// The operator's reset of agents' image links
// (Agent Note 2026-10-07-remote-mcp-server), as the owner's Reset image links
// in settings does: every user's key version in D1 goes up by one, so every
// cover link agents were given stops working, and their next call gets new
// ones.

export const summary = "Reset image links: every cover link agents were given stops working (Settings > Connected agents does the same)";
export const usage = "image-links reset";
export const options = {};

// One step: the reset on the instance's remote D1.
export async function resetImageLinks(p, ctx, { exec = wrangler } = {}) {
  const result = await exec(p, ["d1", "execute", ctx.instance.d1.name, "--remote", "--json", "--command", RESET_ALL_IMAGE_LINKS_SQL], { env: ctx.env, timeoutMs: 60_000 });
  if (result.code !== 0) {
    const missing = /no such table: image_links/i.test(`${result.stdout}${result.stderr}`);
    return {
      id: "image-links",
      status: "fail",
      message: `D1 did not reset image links: ${wranglerError(result)}`,
      fix: missing ? "D1 lacks migration 0007_image_links: npm run yolo -- migrate" : "npm run yolo -- doctor",
    };
  }
  return { id: "image-links", status: "done", message: "Every image link agents were given stops working within 30 seconds; their next call gets new links" };
}

export async function run({ positionals, p }) {
  if (positionals.length !== 1 || positionals[0] !== "reset") {
    return { command: "image-links", status: "failed", summary: `Usage: npm run yolo -- ${usage}` };
  }
  const ctx = await deployContext(p);
  if (!ctx.ok) return { command: "image-links", status: overall(ctx.steps), summary: "Not ready to reset image links", steps: ctx.steps };
  const steps = [...ctx.steps, await resetImageLinks(p, ctx)];
  return { command: "image-links", status: overall(steps), summary: overall(steps) === "ok" ? "Image links reset" : "Image links were not reset", steps };
}
