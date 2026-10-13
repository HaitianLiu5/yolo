import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { vpcUpdateArgs } from "../commands/provision.js";
import { paths } from "../lib/paths.js";
import { wrangler, wranglerError } from "../lib/run.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SERVICE = "11111111-2222-4333-8444-555555555555";
const TUNNEL = "66666666-7777-4888-9999-000000000000";

test("the suggested VPC service update makes the pinned wrangler PUT the whole service", async (t) => {
  // A fake Cloudflare API on loopback, a fake token, and an empty HOME:
  // wrangler can reach nothing else and has no login of its own.
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const json = body ? JSON.parse(body) : null;
      requests.push({ method: request.method, url: request.url, body: json });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, errors: [], messages: [], result: { service_id: SERVICE, ...json } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), "yolo-wrangler-"));
  t.after(() => {
    server.close();
    rmSync(home, { recursive: true, force: true });
  });
  const p = paths();
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${server.address().port}/client/v4`,
    CLOUDFLARE_API_TOKEN: "fake-token",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    WRANGLER_HIDE_BANNER: "true",
  };

  const args = vpcUpdateArgs({ serviceId: SERVICE, name: "yolo-node", tunnelId: TUNNEL, port: 9191 });
  const updated = await wrangler(p, args, { config: p.template, env, timeoutMs: 60_000 });
  assert.equal(updated.code, 0, `wrangler ${args.join(" ")}: ${wranglerError(updated)}`);
  // The body of the REST call that moved the owner's service to a new tunnel.
  assert.deepEqual(requests, [{
    method: "PUT",
    url: `/client/v4/accounts/${ACCOUNT}/connectivity/directory/services/${SERVICE}`,
    body: { name: "yolo-node", type: "http", http_port: 9191, host: { ipv4: "127.0.0.1", network: { tunnel_id: TUNNEL } } },
  }]);

  // Without --name, wrangler prints its usage and changes nothing; that is
  // a failure, and the reason is reported without wrangler's colours.
  const withoutName = args.filter((arg, index) => arg !== "--name" && args[index - 1] !== "--name");
  const refused = await wrangler(p, withoutName, { config: p.template, env, timeoutMs: 60_000 });
  assert.notEqual(refused.code, 0);
  assert.equal(refused.usage, true);
  const message = wranglerError(refused);
  assert.equal(message, stripVTControlCharacters(message));
  assert.match(message, /^wrangler printed its usage instead of running: Missing required argument: name$/);
  assert.equal(requests.length, 1);
});
