#!/usr/bin/env node
// `npm run wrangler -- <arguments>`: wrangler in service/control with this
// instance's configuration. With an instance file it renders
// wrangler.instance.jsonc first and passes it as --config; without one it
// uses the template wrangler.jsonc, as a fresh clone and CI do. An explicit
// --config is passed through untouched.
//
// --fallback-template (first argument) uses the template while the instance
// file is incomplete, for builds during setup; otherwise an incomplete
// instance stops here with the fields to fill in.
import { spawn } from "node:child_process";
import { readInstance } from "./lib/instance.js";
import { paths } from "./lib/paths.js";
import { InstanceConfigError, readTemplate, renderInstanceConfig, writeGenerated } from "./lib/wrangler-config.js";

const p = paths();
let args = process.argv.slice(2);
const fallback = args[0] === "--fallback-template";
if (fallback) args = args.slice(1);

function stop(lines) {
  console.error(lines.join("\n"));
  process.exit(1);
}

const explicit = args.some((arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config="));
let config = [];
if (!explicit) {
  const { exists, raw, error } = readInstance(p.instance);
  if (error) stop([error]);
  if (exists) {
    try {
      writeGenerated(p.generated, renderInstanceConfig(readTemplate(p.template), raw));
      config = ["--config", p.generated];
    } catch (renderError) {
      if (!(renderError instanceof InstanceConfigError)) throw renderError;
      if (!fallback) {
        stop([
          `The instance file ${p.instance} is not ready to deploy:`,
          ...renderError.problems.map((problem) => `  ${problem.field}: ${problem.message} (fix: ${problem.fix})`),
        ]);
      }
      console.error(`Using the template wrangler.jsonc: the instance file is not complete yet (${renderError.message}).`);
    }
  }
}

// Global flags go before a bare `--`, which ends wrangler's own options.
const dashdash = args.indexOf("--");
const argv = dashdash === -1 ? [...args, ...config] : [...args.slice(0, dashdash), ...config, ...args.slice(dashdash)];
const child = spawn(process.execPath, [p.wrangler, ...argv], { cwd: p.control, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
