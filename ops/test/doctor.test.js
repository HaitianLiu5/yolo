import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { fetchJson } from "../commands/doctor.js";

test("doctor reads cloudflared's ready connections, which /ready sends as text/plain JSON", async (t) => {
  // cloudflared 2026.3's metrics server answers /ready like this.
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(JSON.stringify({ status: 200, readyConnections: 4, connectorId: "1edc4cad-e219-4fcb-a68b-6fd379cc2e16" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { status, json } = await fetchJson(`http://127.0.0.1:${server.address().port}/ready`, { timeoutMs: 3_000 });
  assert.equal(status, 200);
  assert.equal(json?.readyConnections, 4);
});
