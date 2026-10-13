import { readInstance, validateInstance, withDefaults } from "../lib/instance.js";
import { InstanceConfigError, readTemplate, renderInstanceConfig, writeGenerated } from "../lib/wrangler-config.js";

export const summary = "Render wrangler.instance.jsonc from the template and the instance file, or show the instance";
export const usage = "config render | config show";
export const options = {};

export async function run({ positionals, p }) {
  const action = positionals[0] ?? "show";
  const { exists, raw, error } = readInstance(p.instance);
  if (error) return { command: `config ${action}`, status: "failed", summary: error };
  if (!exists) {
    return {
      command: `config ${action}`,
      status: "failed",
      summary: `No instance file at ${p.instance}`,
      next: ["npm run yolo -- init --domain <your-domain>"],
    };
  }
  if (action === "show") {
    const problems = validateInstance(raw, { deploy: true });
    return {
      command: "config show",
      status: "ok",
      summary: `Instance file ${p.instance}`,
      instance: withDefaults(raw),
      files: { instance: p.instance, env: p.envFile, generated: p.generated, state: p.state },
      steps: problems.map((problem) => ({ id: problem.field, status: "warn", message: problem.message, fix: problem.fix })),
    };
  }
  if (action !== "render") return { command: `config ${action}`, status: "failed", summary: `Unknown action "${action}"; use render or show` };
  try {
    const wrote = writeGenerated(p.generated, renderInstanceConfig(readTemplate(p.template), raw));
    return {
      command: "config render",
      status: "ok",
      summary: wrote ? `Wrote ${p.generated}` : `${p.generated} is current`,
      generated: p.generated,
    };
  } catch (renderError) {
    if (!(renderError instanceof InstanceConfigError)) throw renderError;
    return {
      command: "config render",
      status: "failed",
      summary: "The instance file is not complete",
      steps: renderError.problems.map((problem) => ({ id: problem.field, status: "fail", message: problem.message, fix: problem.fix })),
    };
  }
}
