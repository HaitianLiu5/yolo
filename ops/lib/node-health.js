import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NODE_PROTOCOL, PROTOCOL_HEADER, signNodeRequest } from "@useyolo/core";

// The NODE_PROTOCOL of the release checked out at `root`, read from its
// file. `upgrade` and `rollback` move the checkout while they run, and the
// number this process imported is the release's they started on: a node
// restarted on the other side of a protocol change refuses it. Falls back
// to the imported number when the file does not say.
export function checkoutProtocol(root) {
  try {
    const found = /^export const NODE_PROTOCOL = (\d+);/m.exec(readFileSync(join(root, "service/core/src/protocol.js"), "utf8"));
    return found ? Number(found[1]) : NODE_PROTOCOL;
  } catch {
    return NODE_PROTOCOL;
  }
}

// The media node's signed health on this machine, as the control plane asks
// for it: { status, json } or a thrown fetch error.
export async function nodeHealth({ secret, host = "127.0.0.1", port = 9191, timeoutMs = 5_000, protocol = NODE_PROTOCOL }) {
  const path = "/internal/v1/health";
  const headers = { ...(await signNodeRequest(secret, { method: "GET", path })), [PROTOCOL_HEADER]: String(protocol) };
  const response = await fetch(`http://${host}:${port}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const json = (response.headers.get("content-type") || "").includes("json") ? await response.json() : null;
  return { status: response.status, json };
}

// Waits until the node answers with `version`, asked in the protocol of the
// release now checked out at `root`.
export async function waitForNode({ root, ...options }, version, { timeoutMs = 90_000, intervalMs = 2_000 } = {}) {
  if (root) options.protocol = checkoutProtocol(root);
  const deadline = Date.now() + timeoutMs;
  let seen = null;
  while (Date.now() < deadline) {
    try {
      const { status, json } = await nodeHealth(options);
      seen = json?.version ?? `HTTP ${status}`;
      if (status === 200 && json?.version === version) return { ok: true, seen };
    } catch (error) {
      seen = error.cause?.code ?? error.name;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ok: false, seen };
}
