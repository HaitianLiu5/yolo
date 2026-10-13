import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Where an instance's files live. Every path has a default inside the
// checkout and an environment variable that moves it, like YOLO_CONFIG for
// the plugin config (Agent Note 2026-10-13-agent-deployment).

export const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const INSTANCE_FILE = "yolo.instance.json";

export function paths({ root = ROOT, env = process.env } = {}) {
  const instance = env.YOLO_INSTANCE ? resolve(root, env.YOLO_INSTANCE) : join(root, INSTANCE_FILE);
  // The node's own rule (envFilePath in @useyolo/plugin-api/host): YOLO_ENV_FILE,
  // or DRIVEIN_ENV_FILE until the release after the rename, else .env
  // (Agent Note 2026-10-13-versions-and-releases).
  const named = env.YOLO_ENV_FILE ?? env.DRIVEIN_ENV_FILE;
  const envFile = named ? resolve(root, named) : join(root, ".env");
  // Deployment records, D1 backups, and the tunnel token sit next to the
  // instance file, so every checkout that uses the instance shares them.
  const state = join(dirname(instance), ".yolo");
  return {
    root,
    instance,
    envFile,
    state,
    deployments: join(state, "deployments.jsonl"),
    backups: join(state, "backups"),
    tunnelToken: join(state, "tunnel-token"),
    control: join(root, "service/control"),
    template: join(root, "service/control/wrangler.jsonc"),
    generated: join(root, "service/control/wrangler.instance.jsonc"),
    migrations: join(root, "service/control/migrations"),
    changelog: join(root, "CHANGELOG.md"),
    wrangler: join(root, "node_modules/wrangler/bin/wrangler.js"),
  };
}
