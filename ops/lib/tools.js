import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./run.js";

// The external programs this checkout pins (Agent Note 2026-10-25-pinned-node-tools).
// tools.json names one release of each, with every platform's archive and
// its SHA-256; `npm install` downloads them into a cache shared by every
// checkout and links this checkout's .tools/bin to the pinned ones, which the
// node puts first on its PATH. A checkout of another version links its own,
// so upgrades and rollbacks change the tools with the code.

export const MANIFEST = "tools.json";
export const BIN = join(".tools", "bin");
const VERIFIED = ".yolo-verified";
// Releases of each tool kept in the cache besides the pinned one, for
// rollbacks and other checkouts.
const KEEP = 2;

export function platformKey(platform = process.platform, arch = process.arch) {
  const os = { darwin: "darwin", linux: "linux" }[platform];
  const cpu = { arm64: "arm64", x64: "x64" }[arch];
  return os && cpu ? `${os}-${cpu}` : null;
}

export const readManifest = (root) => JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));

export function cacheDir(env = process.env, platform = process.platform) {
  if (env.YOLO_TOOLS_CACHE) return env.YOLO_TOOLS_CACHE;
  if (platform === "darwin") return join(homedir(), "Library", "Caches", "yolo", "tools");
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "yolo", "tools");
}

// The builds this checkout pins for this machine, or null on a platform
// tools.json has no builds for.
export function pinnedTools({ root, env = process.env, platform = process.platform, arch = process.arch }) {
  const key = platformKey(platform, arch);
  if (!key) return null;
  return Object.entries(readManifest(root).tools).map(([name, tool]) => {
    const build = tool.platforms[key];
    if (!build) throw new Error(`${MANIFEST} has no ${key} build of ${name}`);
    const dir = join(cacheDir(env, platform), name, `${tool.release}-${key}`);
    return {
      name,
      release: tool.release,
      url: `https://github.com/${tool.repository}/releases/download/${tool.release}/${build.asset}`,
      sha256: build.sha256,
      dir,
      executable: join(dir, build.executable),
      link: join(root, BIN, name),
    };
  });
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function verified(tool) {
  try {
    return readFileSync(join(tool.dir, VERIFIED), "utf8").trim() === tool.sha256 && existsSync(tool.executable);
  } catch {
    return false;
  }
}

function linkTarget(path) {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

export async function unzip(archive, dir) {
  const result = await run("unzip", ["-q", "-o", archive, "-d", dir], { timeoutMs: 5 * 60_000 });
  if (result.error?.code === "ENOENT") throw new Error("unzip is not installed (macOS has it; on Linux install the unzip package)");
  if (result.code !== 0) throw new Error(`unzip failed: ${(result.stderr || result.error?.message || "").trim()}`);
}

// Download, verify, and unpack one build into the cache. The archive is
// checked before anything is unpacked, and a build appears under its final
// name only once complete.
async function fetchBuild(tool, { fetchImpl, extract, log }) {
  log(`Downloading ${tool.name} ${tool.release}`);
  const response = await fetchImpl(tool.url);
  if (!response.ok) throw new Error(`${tool.name} ${tool.release}: ${tool.url} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== tool.sha256) throw new Error(`${tool.name} ${tool.release}: the download's SHA-256 is ${digest}, not the pinned ${tool.sha256}`);
  const staging = `${tool.dir}.partial-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, ".archive.zip");
  writeFileSync(archive, bytes);
  await extract(archive, staging);
  rmSync(archive);
  const executable = join(staging, tool.executable.slice(tool.dir.length + 1));
  if (!existsSync(executable)) throw new Error(`${tool.name} ${tool.release}: the archive has no ${tool.executable.slice(tool.dir.length + 1)}`);
  chmodSync(executable, 0o755);
  writeFileSync(join(staging, VERIFIED), `${tool.sha256}\n`);
  rmSync(tool.dir, { recursive: true, force: true });
  renameSync(staging, tool.dir);
}

function link(tool) {
  if (linkTarget(tool.link) === tool.executable) return;
  const temporary = `${tool.link}.${process.pid}`;
  rmSync(temporary, { force: true });
  symlinkSync(tool.executable, temporary);
  renameSync(temporary, tool.link);
}

function prune(tools, env, platform) {
  const cache = cacheDir(env, platform);
  for (const tool of tools) {
    const parent = join(cache, tool.name);
    const others = readdirSync(parent)
      .map((name) => join(parent, name))
      .filter((dir) => dir !== tool.dir && !dir.includes(".partial-"))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const dir of others.slice(KEEP)) rmSync(dir, { recursive: true, force: true });
  }
}

// Make .tools/bin hold exactly the pinned builds, downloading what the cache
// lacks, and run each once: it proves the build starts here, and the first
// start of yt-dlp's macOS build takes seconds that a play should not wait.
export async function installTools({ root, env = process.env, platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch, extract = unzip, check = true, log = () => {} }) {
  const tools = pinnedTools({ root, env, platform, arch });
  if (!tools) return { skipped: `${MANIFEST} has no builds for ${platform}-${arch}` };
  const bin = join(root, BIN);
  mkdirSync(bin, { recursive: true });
  const names = new Set(tools.map((tool) => tool.name));
  for (const entry of readdirSync(bin)) if (!names.has(entry)) rmSync(join(bin, entry), { force: true });
  const results = [];
  for (const tool of tools) {
    const downloaded = !verified(tool);
    if (downloaded) await fetchBuild(tool, { fetchImpl, extract, log });
    link(tool);
    if (check) {
      const started = await run(tool.link, ["--version"], { env, timeoutMs: 2 * 60_000 });
      if (started.code !== 0) throw new Error(`${tool.name} ${tool.release} did not start: ${(started.stderr || started.error?.message || `exit code ${started.code}`).trim()}`);
    }
    results.push({ name: tool.name, release: tool.release, downloaded, path: tool.link });
  }
  prune(tools, env, platform);
  return { tools: results };
}

// Whether .tools/bin links each pinned build: ok, missing (no link, or the
// build is not in the cache), or stale (it links another release).
export function toolStatus({ root, env = process.env, platform = process.platform, arch = process.arch }) {
  const tools = pinnedTools({ root, env, platform, arch });
  if (!tools) return null;
  return tools.map((tool) => {
    const target = linkTarget(tool.link);
    const status = !target ? "missing" : target !== tool.executable ? "stale" : verified(tool) ? "ok" : "missing";
    return { name: tool.name, release: tool.release, status, path: tool.link };
  });
}

// Pin a tool's latest release: its archives keep their names from release
// to release, and GitHub states each one's SHA-256.
export async function bumpTool(name, { root, fetchImpl = globalThis.fetch }) {
  const manifest = readManifest(root);
  const tool = manifest.tools[name];
  if (!tool) throw new Error(`${MANIFEST} pins no tool named ${name} (it pins ${Object.keys(manifest.tools).join(", ")})`);
  const response = await fetchImpl(`https://api.github.com/repos/${tool.repository}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${tool.repository}'s latest release`);
  const release = await response.json();
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  const platforms = {};
  for (const [key, build] of Object.entries(tool.platforms)) {
    const asset = assets.get(build.asset);
    if (!asset) throw new Error(`${tool.repository} ${release.tag_name} has no ${build.asset}`);
    const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "")?.[1];
    if (!digest) throw new Error(`GitHub gives no SHA-256 for ${build.asset} in ${release.tag_name}`);
    platforms[key] = { ...build, sha256: digest };
  }
  const from = tool.release;
  manifest.tools[name] = { ...tool, release: release.tag_name, platforms };
  writeFileSync(join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { name, from, to: release.tag_name };
}
