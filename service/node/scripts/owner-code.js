#!/usr/bin/env node
// Print a 6-digit owner pairing code
// (Agent Note 2026-10-08-passkey-owner-sign-in) for the control plane's /login
// page: the first passkey, or a reset after losing every passkey.
//
//   npm run owner-code                              (repository root)
//   npm run owner-code -- --origin https://yolo.example.com
//
// Asks the running node over its local socket, the only place a code can be
// issued (see src/local.js). Reads NODE_SECRET, NODE_LOCAL_SOCKET and
// PUBLIC_ORIGIN from the repository .env like the node does.
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { loadYoloEnv } from "@useyolo/plugin-api/host";
import { localSocketPath, requestLocal, socketPathFits } from "../src/local.js";
import { OWNER_CODE_MAX_ATTEMPTS } from "../src/owner-code.js";

loadYoloEnv({ root: fileURLToPath(new URL("../../../", import.meta.url)) });

function fail(message) {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({ options: { origin: { type: "string" } } });
const secret = process.env.NODE_SECRET;
if (!secret) fail("NODE_SECRET is not set. Put it in the repository .env, as for the node.");

const socketPath = localSocketPath();
if (!socketPathFits(socketPath)) {
  fail(`NODE_LOCAL_SOCKET (${socketPath}) is too long for a Unix socket. Set it to a shorter path in .env, restart the node, then run this again.`);
}
let response;
try {
  response = await requestLocal("/local/v1/owner-code", { socketPath, secret });
} catch (error) {
  if (["ENOENT", "ECONNREFUSED", "ETIMEDOUT"].includes(error.code)) {
    fail([
      `The Yolo media node is not running: nothing answers on ${socketPath}.`,
      "Start it (npm run yolo -- service restart node, or npm run dev:node), then run this again. A node started before this checkout's last update may listen elsewhere: restart it.",
    ].join("\n"));
  }
  if (error.code === "EACCES" || error.code === "EPERM") {
    fail(`No permission to open ${socketPath}. Run this as the user that runs the node.`);
  }
  fail(`Cannot reach the Yolo media node on ${socketPath}: ${error.message} (${error.code ?? "no code"}). Check NODE_LOCAL_SOCKET in .env and the node's log.`);
}
if (response.status !== 200) fail(`The node refused: ${response.body?.error?.message || `HTTP ${response.status}`}`);

const { code, expiresAt } = response.body;
const origin = values.origin || process.env.PUBLIC_ORIGIN;
const signIn = origin ? new URL("/login", origin).href : "/login (on the control plane's address)";
const minutes = Math.round((expiresAt - Date.now()) / 60_000);
console.log(`
  Owner code: ${code}

  Enter it at ${signIn}
  Expires at ${new Date(expiresAt).toLocaleTimeString()} (in ${minutes} minutes), after ${OWNER_CODE_MAX_ATTEMPTS} wrong tries, or once used.
  If passkeys already exist, the new one replaces all of them and signs out every session.
  Running this again replaces the code.
`);
