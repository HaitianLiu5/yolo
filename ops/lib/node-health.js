import { NODE_PROTOCOL, PROTOCOL_HEADER, signNodeRequest } from "@useyolo/core";

// The media node's signed health on this machine, as the control plane asks
// for it: { status, json } or a thrown fetch error.
export async function nodeHealth({ secret, host = "127.0.0.1", port = 9191, timeoutMs = 5_000 }) {
  const path = "/internal/v1/health";
  const headers = { ...(await signNodeRequest(secret, { method: "GET", path })), [PROTOCOL_HEADER]: String(NODE_PROTOCOL) };
  const response = await fetch(`http://${host}:${port}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const json = (response.headers.get("content-type") || "").includes("json") ? await response.json() : null;
  return { status: response.status, json };
}

// Waits until the node answers with `version`.
export async function waitForNode(options, version, { timeoutMs = 90_000 } = {}) {
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
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { ok: false, seen };
}
