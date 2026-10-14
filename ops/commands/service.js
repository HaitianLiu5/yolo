import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile } from "../lib/env-file.js";
import { INIT_FIX, readInstance } from "../lib/instance.js";
import { overall } from "../lib/output.js";
import { which } from "../lib/run.js";
import { cloudflaredSpec, installService, manager, nodeSpec, restartService, serviceFile, serviceStatus, uninstallService } from "../lib/service.js";

export const summary = "Run the node and cloudflared as login services (launchd on macOS, systemd --user on Linux)";
export const usage = "service install|restart|status|logs|uninstall [node|cloudflared] [--dry-run] [--restart] [--daemon] [--lines <n>]";
export const options = {
  "dry-run": { type: "boolean" },
  restart: { type: "boolean" },
  daemon: { type: "boolean" },
  lines: { type: "string" },
};

export function specs({ p, instance }) {
  const envValues = readEnvFile(p.envFile) ?? {};
  return {
    node: nodeSpec({ p, instance, envValues, envFileIsDefault: p.envFile === join(p.root, ".env") }),
    cloudflared: cloudflaredSpec({ p, instance }),
  };
}

export async function run({ values, positionals, p }) {
  const [action = "status", only = null] = positionals;
  const command = `service ${action}`;
  const { exists, instance, error } = readInstance(p.instance);
  if (error || !exists) return { command, status: "failed", summary: error ?? `No instance file at ${p.instance}`, next: [INIT_FIX] };
  if (!manager()) return { command, status: "failed", summary: `No supported service manager on ${process.platform}; run the node with npm run dev:node` };
  const all = specs({ p, instance });
  const roles = only ? [only] : ["node", "cloudflared"];
  for (const role of roles) if (!all[role]) return { command, status: "failed", summary: `Unknown service "${role}"; use node or cloudflared` };
  const steps = [];

  for (const role of roles) {
    const spec = all[role];
    if (action === "status") {
      const status = await serviceStatus(spec.label);
      steps.push({ id: role, status: status.running ? "ok" : "warn", message: `${spec.label}: ${status.detail}${status.pid ? `, pid ${status.pid}` : ""}`, fix: status.running ? null : `npm run yolo -- service install ${role}` });
    } else if (action === "install") {
      if (role === "node" && !readEnvFile(p.envFile)?.NODE_SECRET) {
        steps.push({ id: role, status: "fail", message: `${p.envFile} has no NODE_SECRET`, fix: INIT_FIX });
        continue;
      }
      if (role === "cloudflared") {
        if (!which("cloudflared")) {
          steps.push({ id: role, status: "fail", message: "cloudflared is not installed", fix: "brew install cloudflared" });
          continue;
        }
        if (!existsSync(p.tunnelToken)) {
          steps.push({ id: role, status: "needs_human", message: `No tunnel token at ${p.tunnelToken}`, fix: "npm run yolo -- provision tunnel (it says how to get the token)" });
          continue;
        }
      }
      const result = await installService(spec, { daemon: Boolean(values.daemon), dryRun: Boolean(values["dry-run"]), restart: Boolean(values.restart), stage: join(p.state, "services") });
      steps.push({ id: role, ...result, ...(values["dry-run"] ? { content: result.content } : {}) });
    } else if (action === "restart") {
      steps.push({ id: role, ...(await restartService(spec.label)) });
    } else if (action === "uninstall") {
      steps.push({ id: role, ...(await uninstallService(spec)) });
    } else if (action === "logs") {
      const lines = Number(values.lines || 40);
      const text = existsSync(spec.log) ? readFileSync(spec.log, "utf8").split("\n").slice(-lines - 1).join("\n") : null;
      steps.push({ id: role, status: text == null ? "warn" : "info", message: text == null ? `No log at ${spec.log}` : `${spec.log}:\n${text}`, log: spec.log });
    } else {
      return { command, status: "failed", summary: `Unknown action "${action}"` };
    }
  }

  return {
    command,
    status: overall(steps),
    summary: action === "install" && values["dry-run"] ? `Service files (${manager()}, not written):` : `Services (${manager()})`,
    files: Object.fromEntries(roles.map((role) => [role, serviceFile(all[role], { daemon: Boolean(values.daemon) })])),
    steps,
  };
}
