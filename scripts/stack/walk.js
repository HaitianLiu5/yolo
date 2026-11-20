#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `npm run stack:walk -- <screen> [stream] [--sim <udid>] [--out <dir>]`: one
// screen's main path on the running stack (npm run stack), as the owner walks
// it. The screen pairs (its code approved as the owner would), an agent plays
// `stream` (a key of .stack/stack.json's `play`, hls by default) on it over
// MCP, and pauses it, seeks to 1:00 (the middle of a short item), and resumes it. A screenshot and what the screen and
// Yolo said are kept at each step. It asserts nothing: it prints what it saw,
// and the agent judges that against the acceptance checklist
// (.agents/skills/yolo-acceptance/SKILL.md).
//
// Screens: `web` (a computer's Chrome, the <video> engine), `phone` (a phone's
// Chrome), `car` (the Tesla's window, paired as a car: the canvas engine), and
// `ios` or `tv`, the Apple apps' debug build already installed in the
// Simulator `--sim` names, launched with -YoloServer at the stack.

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const state = JSON.parse(readFileSync(join(root, ".stack/stack.json"), "utf8"));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const [value] = args.splice(at, 2).slice(1);
  return value;
};
const sim = option("--sim", null);
const out = option("--out", join(root, ".stack/walk"));
const [screen = "web", stream = "hls"] = args;
const kind = { car: "car", web: "browser", phone: "phone", ios: "phone", tv: "tv" }[screen];
if (!kind) throw new Error(`Unknown screen ${screen}: web, phone, car, ios, or tv`);
const native = screen === "ios" || screen === "tv";
if (native && !sim) throw new Error(`${screen} needs --sim <udid> with the debug build installed`);
// `plex` and `folder` are library items, found by search: the Plex movie,
// and the folder's MP4 movie.
const SEARCH = { plex: "Fixture Movie", folder: "Clip" };
if (!state.play[stream]) throw new Error(`No stream ${stream}; one of ${Object.keys(state.play).join(", ")}`);
mkdirSync(out, { recursive: true });

const stack = (...words) => execFileSync(process.execPath, [join(root, "scripts/stack/cli.js"), ...words], { encoding: "utf8" }).trim();
const mcp = (tool, input = {}) => JSON.parse(stack("mcp", tool, JSON.stringify(input)));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const BUNDLE = "yolo.yolo";

// What Yolo says of this screen's session.
function session(deviceId) {
  const found = mcp("get_status").sessions?.find((entry) => entry.device?.id === deviceId);
  return found ? { status: found.status, position: found.position, duration: found.item?.duration ?? null, item: found.item?.title ?? null } : null;
}

async function until(check, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(1000);
  }
}

// --- The screen: a browser page, or an app in the Simulator ----------------
let screenApi;
if (native) {
  const bundle = execFileSync("xcrun", ["simctl", "listapps", sim], { encoding: "utf8" })
    .split("\n").map((line) => /^\s*"?([\w.-]+\.yolo\.yolo)"?\s*=/.exec(line)?.[1]).find(Boolean);
  if (!bundle) throw new Error(`No Yolo app (…${BUNDLE}) in Simulator ${sim}; build the debug scheme for it and install it`);
  screenApi = {
    async shot(path) {
      execFileSync("xcrun", ["simctl", "io", sim, "screenshot", path], { stdio: "ignore" });
    },
    async state() {
      return {};
    },
    errors: [],
    async close() {},
  };
  try {
    execFileSync("xcrun", ["simctl", "terminate", sim, bundle], { stdio: "ignore" });
  } catch {
    // Not running.
  }
  // A fresh pairing each walk: the app keeps its credential in the Keychain.
  execFileSync("xcrun", ["simctl", "keychain", sim, "reset"], { stdio: "ignore" });
  execFileSync("xcrun", ["simctl", "launch", sim, bundle, "-YoloServer", state.origin], { stdio: "ignore" });
} else {
  const { CAR_BROWSER, PHONE_BROWSER, launch, pairCode, playerState } = await import("./browser.js");
  const { browser, context } = await launch({ context: screen === "car" ? CAR_BROWSER : screen === "phone" ? PHONE_BROWSER : {} });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(state.origin, { waitUntil: "domcontentloaded" });
  screenApi = {
    code: () => pairCode(page),
    shot: (path) => page.screenshot({ path }),
    state: () => playerState(page),
    errors,
    close: () => browser.close(),
  };
}

const steps = [];
async function step(name, extra = {}) {
  const path = join(out, `${screen}-${String(steps.length + 1).padStart(2, "0")}-${name}.png`);
  await screenApi.shot(path);
  const entry = { step: name, screenshot: path, screen: await screenApi.state(), ...extra };
  steps.push(entry);
  console.log(JSON.stringify(entry));
}

try {
  // Pair: a browser shows its code; an app shows it behind "Use another
  // device", so the newest code waiting is the app's.
  const code = screenApi.code
    ? await screenApi.code()
    : await until(() => JSON.parse(stack("pending"))[0]?.user_code, "the app's pairing code", 30_000);
  await step("pairing", { code });
  const before = new Set(mcp("list_devices").devices.map((device) => device.id));
  console.log(stack("approve", code, kind));
  const device = await until(() => mcp("list_devices").devices.find((entry) => !before.has(entry.id) && entry.online), "the screen online after pairing", 30_000);
  await sleep(2000);
  await step("paired-home", { device: { id: device.id, name: device.name, kind: device.kind } });

  const what = SEARCH[stream]
    ? { item_id: mcp("search", { query: SEARCH[stream] }).results.find((result) => result.kind !== "show")?.id }
    : { url: state.play[stream] };
  mcp("play", { ...what, device: device.id, start_at: 0 });
  await until(() => {
    const now = session(device.id);
    return now?.status === "playing" && now.position > 3 && now;
  }, "playing past 3 s");
  await step("playing", { yolo: session(device.id) });

  mcp("control", { action: "pause", device: device.id });
  await until(() => session(device.id)?.status === "paused", "paused", 15_000);
  await step("paused", { yolo: session(device.id) });

  // 1:00, or the middle of an item shorter than 2:00 (the stack's MPEG-TS clip is 8 s).
  const { duration } = session(device.id);
  const to = duration && duration < 120 ? Math.floor(duration / 2) : 60;
  mcp("seek", { position_seconds: to, device: device.id });
  mcp("control", { action: "resume", device: device.id });
  await until(() => {
    const now = session(device.id);
    return now?.status === "playing" && now.position > to + 0.5 && now;
  }, `playing past ${to} s after the seek`, 30_000);
  await step("seeked-playing", { yolo: session(device.id) });
} catch (error) {
  await step("failed", { error: String(error.message || error) }).catch(() => {});
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify({ screen, stream, result: process.exitCode ? "failed" : "walked", pageErrors: screenApi.errors }));
  await screenApi.close();
}
