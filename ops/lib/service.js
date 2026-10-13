import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { DEFAULT_TUNNEL_METRICS } from "./instance.js";
import { run, which } from "./run.js";

// The node and cloudflared as services that start at login and restart when
// they exit: a launchd LaunchAgent on macOS, a systemd user unit on Linux
// (Agent Note 2026-10-13-agent-deployment). Labels come from the
// instance file (default app.useyolo.node and app.useyolo.cloudflared).

export function manager(platform = process.platform) {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return null;
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);

// The Node binary a service runs: the one on PATH (a stable link such as
// /opt/homebrew/bin/node survives upgrades, unlike its versioned target),
// else the one running this command.
export function nodeBinary(env = process.env) {
  const onPath = which("node", env);
  try {
    return onPath && realpathSync(onPath) ? onPath : process.execPath;
  } catch {
    return process.execPath;
  }
}

// A PATH that finds Node, ffmpeg, yt-dlp, Deno and cloudflared from a
// service, which does not read the login shell's profile.
export function servicePath(env = process.env) {
  const dirs = [dirname(nodeBinary(env)), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".deno/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  for (const tool of ["ffmpeg", "yt-dlp", "deno", "cloudflared"]) {
    const found = which(tool, env);
    if (found) dirs.splice(1, 0, dirname(found));
  }
  return [...new Set(dirs)].join(delimiter);
}

// What runs, where, and where it logs. `runtimeDir` is the node's
// YOLO_RUNTIME_DIR (the checkout by default); logs go to its .logs/.
export function nodeSpec({ p, instance, envValues = {}, envFileIsDefault = true }) {
  const runtimeDir = envValues.YOLO_RUNTIME_DIR || p.root;
  const environment = { HOME: homedir(), PATH: servicePath() };
  if (!envFileIsDefault) environment.YOLO_ENV_FILE = p.envFile;
  return {
    role: "node",
    label: instance.services.node,
    description: "Yolo media node",
    program: [nodeBinary(), join(p.root, "service/node/src/main.js")],
    workingDirectory: p.root,
    environment,
    log: join(runtimeDir, ".logs", "node.log"),
  };
}

export function cloudflaredSpec({ p, instance, cloudflared = which("cloudflared") }) {
  return {
    role: "cloudflared",
    label: instance.services.cloudflared,
    description: "Cloudflare Tunnel for Yolo",
    program: [cloudflared ?? "cloudflared", "tunnel", "--no-autoupdate", "--metrics", instance.tunnel.metrics || DEFAULT_TUNNEL_METRICS, "run", "--token-file", p.tunnelToken],
    workingDirectory: dirname(p.tunnelToken),
    environment: { HOME: homedir(), PATH: servicePath() },
    log: join(p.state, "logs", "cloudflared.log"),
  };
}

const xml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// A LaunchAgent, or with `user` a LaunchDaemon that runs as that user.
export function renderPlist(spec, { user = null } = {}) {
  const lines = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(spec.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...spec.program.map((arg) => `    <string>${xml(arg)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(spec.workingDirectory)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(spec.environment).flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`]),
    "  </dict>",
    ...(user ? ["  <key>UserName</key>", `  <string>${xml(user)}</string>`] : []),
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(spec.log)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(spec.log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ];
  return lines.join("\n");
}

const systemdQuote = (value) => (/[\s"\\]/.test(value) ? `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"` : value);

export function renderSystemdUnit(spec) {
  return [
    "[Unit]",
    `Description=${spec.description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${spec.program.map(systemdQuote).join(" ")}`,
    `WorkingDirectory=${spec.workingDirectory}`,
    ...Object.entries(spec.environment).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`),
    "Restart=always",
    "RestartSec=10",
    `StandardOutput=append:${spec.log}`,
    `StandardError=append:${spec.log}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function serviceFile(spec, { daemon = false, platform = process.platform, home = homedir() } = {}) {
  if (manager(platform) === "launchd") {
    return daemon ? join("/Library/LaunchDaemons", `${spec.label}.plist`) : join(home, "Library/LaunchAgents", `${spec.label}.plist`);
  }
  return join(home, ".config/systemd/user", `${spec.label}.service`);
}

export function renderService(spec, { daemon = false, platform = process.platform } = {}) {
  return manager(platform) === "launchd" ? renderPlist(spec, { user: daemon ? userInfo().username : null }) : renderSystemdUnit(spec);
}

// { manager, loaded, running, pid, detail } for a label; read-only.
export async function serviceStatus(label, { platform = process.platform } = {}) {
  const kind = manager(platform);
  if (kind === "launchd") {
    for (const domain of [`gui/${uid()}`, "system"]) {
      const result = await run("launchctl", ["print", `${domain}/${label}`], { timeoutMs: 10_000 });
      if (result.code !== 0) continue;
      const state = /^\s*state = (\S+)/m.exec(result.stdout)?.[1] ?? "unknown";
      const pid = Number(/^\s*pid = (\d+)/m.exec(result.stdout)?.[1]) || null;
      const lastExit = /^\s*last exit code = (.+)$/m.exec(result.stdout)?.[1] ?? null;
      return { manager: kind, domain, loaded: true, running: state === "running", pid, detail: `state ${state}${lastExit ? `, last exit ${lastExit}` : ""}` };
    }
    return { manager: kind, loaded: false, running: false, pid: null, detail: "not loaded" };
  }
  if (kind === "systemd") {
    const result = await run("systemctl", ["--user", "show", `${label}.service`, "-p", "LoadState,ActiveState,MainPID"], { timeoutMs: 10_000 });
    if (result.code !== 0) return { manager: kind, loaded: false, running: false, pid: null, detail: (result.stderr || "systemctl failed").trim() };
    const value = (key) => new RegExp(`^${key}=(.*)$`, "m").exec(result.stdout)?.[1];
    return { manager: kind, loaded: value("LoadState") === "loaded", running: value("ActiveState") === "active", pid: Number(value("MainPID")) || null, detail: `${value("LoadState")}, ${value("ActiveState")}` };
  }
  return { manager: null, loaded: false, running: false, pid: null, detail: `no service manager on ${platform}` };
}

// Writes the service file and (re)loads it. Idempotent: an unchanged file of
// a running service is left alone unless `restart`. A LaunchDaemon needs
// root, so it is written to `stage` and returned as commands for a human.
export async function installService(spec, { daemon = false, dryRun = false, restart = false, stage } = {}) {
  const kind = manager();
  if (!kind) return { status: "fail", message: `No supported service manager on ${process.platform}`, fix: "Run the node in a terminal: npm run dev:node" };
  const file = serviceFile(spec, { daemon });
  const content = renderService(spec, { daemon });
  if (dryRun) return { status: "info", message: `Would write ${file}`, file, content };
  mkdirSync(dirname(spec.log), { recursive: true });
  if (daemon) {
    const staged = join(stage, `${spec.label}.plist`);
    mkdirSync(stage, { recursive: true });
    writeFileSync(staged, content);
    return {
      status: "needs_human",
      message: `A LaunchDaemon needs an administrator. Run: sudo cp ${staged} ${file} && sudo chown root:wheel ${file} && sudo launchctl bootout system/${spec.label} 2>/dev/null; sudo launchctl bootstrap system ${file}`,
      file,
    };
  }
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  const status = await serviceStatus(spec.label);
  if (current === content && status.running && !restart) return { status: "unchanged", message: `${spec.label} is installed and running (${file})`, file };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (kind === "launchd") {
    const domain = `gui/${uid()}`;
    if (status.loaded) await run("launchctl", ["bootout", `${domain}/${spec.label}`], { timeoutMs: 30_000 });
    const loaded = await run("launchctl", ["bootstrap", domain, file], { timeoutMs: 30_000 });
    if (loaded.code !== 0) return { status: "fail", message: `launchctl bootstrap failed: ${(loaded.stderr || loaded.stdout).trim()}`, fix: `launchctl print ${domain}/${spec.label}`, file };
  } else {
    for (const args of [["daemon-reload"], ["enable", "--now", `${spec.label}.service`], ...(current !== null ? [["restart", `${spec.label}.service`]] : [])]) {
      const result = await run("systemctl", ["--user", ...args], { timeoutMs: 30_000 });
      if (result.code !== 0) return { status: "fail", message: `systemctl --user ${args.join(" ")} failed: ${result.stderr.trim()}`, fix: "journalctl --user -xe", file };
    }
  }
  return { status: "done", message: `${current === null ? "Installed" : "Reinstalled"} and started ${spec.label} (${file})`, file };
}

export async function restartService(label) {
  const kind = manager();
  const result = kind === "launchd"
    ? await run("launchctl", ["kickstart", "-k", `${(await serviceStatus(label)).domain ?? `gui/${uid()}`}/${label}`], { timeoutMs: 30_000 })
    : await run("systemctl", ["--user", "restart", `${label}.service`], { timeoutMs: 30_000 });
  return result.code === 0
    ? { status: "done", message: `Restarted ${label}` }
    : { status: "fail", message: `Could not restart ${label}: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`, fix: `npm run yolo -- service install ${label.endsWith("cloudflared") ? "cloudflared" : "node"}` };
}

export async function uninstallService(spec) {
  const kind = manager();
  const file = serviceFile(spec);
  if (kind === "launchd") await run("launchctl", ["bootout", `gui/${uid()}/${spec.label}`], { timeoutMs: 30_000 });
  else await run("systemctl", ["--user", "disable", "--now", `${spec.label}.service`], { timeoutMs: 30_000 });
  rmSync(file, { force: true });
  return { status: "done", message: `Stopped ${spec.label} and removed ${file}`, file };
}
