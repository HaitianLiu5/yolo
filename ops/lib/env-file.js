import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

// The node's .env: read it the way the node does, and set keys in place so
// comments and the owner's other settings survive.

export function readEnvFile(path) {
  if (!existsSync(path)) return null;
  return parseEnv(readFileSync(path, "utf8"));
}

const escapeKey = (key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `values` is { KEY: value }. A key already set to a non-empty value is kept
// unless `overwrite` lists it; a commented `# KEY=` line is replaced in place;
// otherwise the key is appended. A missing file starts from `template`.
// Returns the keys whose stored value changed.
export function setEnvValues(path, values, { template = null, overwrite = [] } = {}) {
  let text = existsSync(path) ? readFileSync(path, "utf8") : template && existsSync(template) ? readFileSync(template, "utf8") : "";
  const current = parseEnv(text);
  const changed = [];
  for (const [key, value] of Object.entries(values)) {
    if (value == null) continue;
    const has = typeof current[key] === "string" && current[key] !== "";
    if (has && (current[key] === String(value) || !overwrite.includes(key))) continue;
    const line = `${key}=${value}`;
    const active = new RegExp(`^${escapeKey(key)}=.*$`, "m");
    const commented = new RegExp(`^#\\s*${escapeKey(key)}=.*$`, "m");
    if (active.test(text)) text = text.replace(active, () => line);
    else if (commented.test(text)) text = text.replace(commented, () => line);
    else text = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
    changed.push(key);
  }
  if (changed.length || !existsSync(path)) writeFileSync(path, text, { mode: 0o600 });
  return changed;
}
