import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPluginConfig } from "@useyolo/plugin-api/host";

// Plugins' setup entries (`yolo.setup` in package.json): modules the
// operator's command line imports on the owner's machine to set a provider
// up, such as a DNS provider (Agent Note 2026-10-14-dns-provider-plugins) or
// a model provider's sign-in (Agent Note 2026-10-25-models-for-plugins).

// A plugin directory's setup entry: the module, null when it has none, or
// an Error when it cannot be loaded.
export async function setupEntry(dir) {
  let entry;
  try {
    entry = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))?.yolo?.setup;
  } catch {
    return null;
  }
  if (typeof entry !== "string") return null;
  try {
    return await import(pathToFileURL(resolve(dir, entry)).href);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * The enabled plugin of the plugin config whose setup entry sets up
 * `provider`: { plugin: { name, source }, setup, configPath, skipped }, or
 * plugin: null when none does; `plugin.options` are the plugin's options
 * from the config. A setup entry that cannot be loaded is skipped and named
 * in `skipped`, so one broken plugin stops no command. `env` gives YOLO_CONFIG, as for the build.
 */
export async function findSetupPlugin({ root, env = process.env, provider }) {
  let config;
  try {
    config = loadPluginConfig({ root, env });
  } catch (error) {
    return { plugin: null, setup: null, configPath: null, error: error.message, skipped: [] };
  }
  const skipped = [];
  for (const plugin of config.plugins) {
    if (!plugin.enabled || plugin.error || !plugin.root) continue;
    const setup = await setupEntry(plugin.root);
    if (setup instanceof Error) {
      skipped.push(`${plugin.name}: its setup entry cannot be loaded: ${setup.message}`);
      continue;
    }
    if (setup?.provider === provider) return { plugin: { name: plugin.name, source: plugin.source, options: plugin.options ?? {} }, setup, configPath: config.path, skipped };
  }
  return { plugin: null, setup: null, configPath: config.path, skipped };
}
