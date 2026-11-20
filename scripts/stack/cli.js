#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMediaStack } from "./fixtures.js";
import { fileContext, OWNER } from "./stack.js";

// `npm run stack`: the whole of Yolo on this machine for acceptance
// (.agents/skills/yolo-acceptance/SKILL.md). It builds the player, starts the
// media node and the control plane under `wrangler dev --local` on free
// ports, with ffmpeg-made media, a yt-dlp and a Plex that answer locally, a
// folder library, and a library of events, and keeps running until Ctrl-C.
// Nothing reaches Cloudflare, the live node, or port 9191. What a later
// command needs is in .stack/stack.json.
//
//   npm run stack [-- start] [--seconds 300] [--no-build] [--plugin <dir>]…
//   npm run stack -- approve [<PAIR-CODE>|-] [car|browser|phone|tablet|tv|other]   (- or none: the newest code shown)
//   npm run stack -- pending
//   npm run stack -- mcp <tool> ['{"json":"args"}']
//   npm run stack -- api <path> ['{"json":"body"}']   (as the agent, GET without a body)
//   npm run stack -- owner-code
//   npm run stack -- info

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const stateDir = join(root, ".stack");
const statePath = join(stateDir, "stack.json");

// A first word that is a flag (`npm run stack -- --no-build`) starts the stack.
const words = process.argv.slice(2);
const [command, ...rest] = !words[0] || words[0].startsWith("--") ? ["start", ...words] : words;
const flag = (name) => rest.includes(name);
const option = (name, fallback) => {
  const at = rest.indexOf(name);
  return at >= 0 && rest[at + 1] ? rest[at + 1] : fallback;
};

function readState() {
  if (!existsSync(statePath)) throw new Error("No stack is running: start one with npm run stack");
  return JSON.parse(readFileSync(statePath, "utf8"));
}

// The stack's own process answers the commands below over HTTP on loopback,
// since its helpers hold the owner's session and the agent's token.
async function ask(path, body) {
  const { control } = readState();
  const response = await fetch(`${control}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const text = await response.text();
  if (!response.ok) throw new Error(text);
  return text;
}

// The codes screens are showing now, newest first, from the stack's local D1.
function pendingCodes(dir) {
  const result = spawnSync(process.execPath, [
    join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "yolo", "--local", "--json",
    "--persist-to", join(dir, "wrangler"), "--config", join(dir, "wrangler.stack.json"),
    "--command", `SELECT user_code, device_name, device_kind, requested_at FROM device_codes WHERE status = 'pending' AND expires_at > ${Date.now()} ORDER BY requested_at DESC`,
  ], { cwd: join(root, "service/control"), encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" } });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout)[0]?.results ?? [];
}

async function start() {
  if (!flag("--no-build")) {
    const built = spawnSync("npm", ["run", "build", "-w", "clients/player"], { cwd: root, stdio: "inherit" });
    if (built.status !== 0) process.exit(built.status ?? 1);
  }
  const seconds = Number(option("--seconds", "300"));
  const shared = fileContext();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping the stack…");
    await shared.cleanup();
    await rm(statePath, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // --plugin <dir> (repeatable) loads a plugin under development, first.
  const plugins = rest.flatMap((word, at) => (word === "--plugin" && rest[at + 1] ? [{ source: resolve(rest[at + 1]) }] : []));
  const { media, plex, yolo, library } = await startMediaStack(shared, { seconds, events: true, plugins });
  const agent = await yolo.agentToken();

  // The live stream (`play.live`): its 5-second segments go out one at a
  // time, as a live source publishes them, from two at the start to the
  // last, a minute in, where it ends.
  media.live.published = 2;
  const publishing = setInterval(() => { media.live.published += 1; }, 5_000);
  shared.after(() => clearInterval(publishing));

  // The control channel for `approve`, `mcp`, `api`, and `owner-code`.
  const { createServer } = await import("node:http");
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    try {
      let out;
      if (req.url === "/approve") {
        // No code: the newest one a screen is showing, as a native app
        // shows its code only behind "Use another device".
        const code = input.code || pendingCodes(yolo.dir)[0]?.user_code;
        if (!code) throw new Error("No screen is waiting to pair");
        const fields = input.kind ? { kind: input.kind } : {};
        out = await yolo.approve(code, "approve", fields);
        if (out.status !== 200) throw new Error(`Approval failed (${out.status}): ${out.text.slice(0, 300)}`);
        out = `Approved ${code}${input.kind ? ` as ${input.kind}` : ""}`;
      } else if (req.url === "/pending") {
        out = JSON.stringify(pendingCodes(yolo.dir), null, 2);
      } else if (req.url === "/mcp") {
        out = JSON.stringify(await yolo.mcp(agent, input.tool, input.args || {}), null, 2);
      } else if (req.url === "/api") {
        out = JSON.stringify(await yolo.api(agent, input.path, input.body ? { method: input.method || "POST", body: input.body } : {}), null, 2);
      } else if (req.url === "/owner-code") {
        out = await yolo.ownerCode();
      } else {
        res.writeHead(404);
        return res.end();
      }
      res.end(out);
    } catch (error) {
      res.writeHead(500);
      res.end(error.body ? JSON.stringify(error.body, null, 2) : String(error.stack || error));
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  shared.after(() => new Promise((done) => server.close(done)));

  const state = {
    origin: yolo.origin,
    control: `http://127.0.0.1:${server.address().port}`,
    owner: OWNER,
    ownerSession: yolo.ownerSession.cookie,
    nodePort: yolo.nodePort,
    // What to play: each stream type and source the stack serves.
    play: {
      direct: `${media.url}/clip.webm`,
      hls: `${media.url}/hls/index.m3u8`,
      hlsTs: `${media.url}/hls-ts/index.m3u8`,
      dashSplit: "https://videos.test/watch?v=dash",
      live: "https://videos.test/watch?v=live",
      plex: plex.url,
      folder: library,
    },
    startedAt: new Date().toISOString(),
  };
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));

  console.log(`
Yolo is running at ${yolo.origin}

  Open it in a browser, or enter it as the server in the iOS or tvOS
  Simulator; a new screen shows a pairing code:
    npm run stack -- approve <CODE> [car|browser|phone|tablet|tv|other]
  A native app's code (newest first):  npm run stack -- pending; approve - <kind>
  An agent's MCP call:            npm run stack -- mcp search '{"query":"Fixture"}'
  The owner's passkey code:       npm run stack -- owner-code   (then ${yolo.origin}/login)
  The owner session cookie:       ${state.ownerSession}

  Media (${seconds} s each): ${Object.entries(state.play).map(([key, value]) => `\n    ${key.padEnd(9)} ${value}`).join("")}

  State: ${statePath}. Ctrl-C stops the stack and deletes everything it made.
`);
}

try {
  if (command === "start") await start();
  else if (command === "info") console.log(JSON.stringify(readState(), null, 2));
  else if (command === "approve") console.log(await ask("/approve", { code: rest[0] === "-" ? null : rest[0], kind: rest[1] }));
  else if (command === "pending") console.log(await ask("/pending"));
  else if (command === "mcp") console.log(await ask("/mcp", { tool: rest[0], args: rest[1] ? JSON.parse(rest[1]) : {} }));
  else if (command === "api") console.log(await ask("/api", { path: rest[0], body: rest[1] ? JSON.parse(rest[1]) : undefined }));
  else if (command === "owner-code") console.log(await ask("/owner-code"));
  else {
    console.error(`Unknown command: ${command}`);
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
