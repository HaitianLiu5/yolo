// Builds the Samsung TV app: copies the Tizen shell into dist/ with this
// instance's address filled in and signs it into dist/Yolo.wgt with the
// Tizen CLI's active security profile.
//
//   node clients/tizen/build.js --origin https://yolo.example.com
//
// The address is the instance's, never committed (yolo.instance.json holds it).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const app = join(dist, "app");

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const origin = argument("origin")?.replace(/\/+$/, "");
if (!origin || !/^https:\/\/[^/]+$/.test(origin)) {
  console.error("usage: node clients/tizen/build.js --origin https://<your Yolo>");
  process.exit(1);
}
const tizen = argument("tizen") ?? join(homedir(), "tizen-studio/tools/ide/bin/tizen");

rmSync(dist, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
for (const file of ["config.xml", "index.html", "main.js", "style.css"]) copyFileSync(join(here, file), join(app, file));
copyFileSync(resolve(here, "../player/public/icon-512.png"), join(app, "icon.png"));
writeFileSync(join(app, "origin.js"), `window.YOLO_ORIGIN = ${JSON.stringify(origin)};\n`);

execFileSync(tizen, ["package", "-t", "wgt", "-o", dist, "--", app], { stdio: "inherit" });
console.log(`built ${join(dist, "Yolo.wgt")}`);
