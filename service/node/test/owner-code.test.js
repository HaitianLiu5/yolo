import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signNodeRequest } from "@useyolo/core";
import { createLocalApp, createNodeApp } from "../src/app.js";
import { listenLocal, requestLocal } from "../src/local.js";
import { createOwnerCodes } from "../src/owner-code.js";

const secret = "node-test-secret";
const wrongFor = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

test("a code is six digits, works once, expires after 15 minutes, and dies after five wrong tries", () => {
  let time = 1_000_000;
  const codes = createOwnerCodes({ now: () => time });
  let { code, expiresAt } = codes.issue();
  assert.match(code, /^[0-9]{6}$/);
  assert.equal(expiresAt, time + 15 * 60_000);
  assert.equal(codes.verify(code).ok, true, "verify does not use the code up");
  assert.deepEqual(codes.consume(code), { ok: true });
  assert.throws(() => codes.consume(code), { code: "forbidden", message: /No pairing code is active/ });

  ({ code } = codes.issue());
  time += 15 * 60_000;
  assert.throws(() => codes.verify(code), { message: /No pairing code is active/ });

  ({ code } = codes.issue());
  // Any input, of any length or type, is one attempt.
  for (const input of [wrongFor(code), "1", null, Number(code)]) assert.throws(() => codes.verify(input), { message: /Wrong pairing code/ });
  assert.throws(() => codes.verify(""), { message: /Too many wrong codes/ });
  assert.throws(() => codes.verify(code), { message: /No pairing code is active/ });
});

test("the control plane's listener verifies and consumes codes but never issues one", async () => {
  const ownerCodes = createOwnerCodes();
  const app = createNodeApp({ secret, ownerCodes, plugins: { sources: {}, status: () => [] } });
  const signed = async (path, body) => {
    const payload = JSON.stringify(body);
    return app.request(path, { method: "POST", headers: { ...await signNodeRequest(secret, { method: "POST", path, body: payload }), "content-type": "application/json" }, body: payload });
  };
  for (const path of ["/internal/v1/owner-code", "/internal/v1/owner-code/issue", "/local/v1/owner-code", "/m/x/../../local/v1/owner-code"]) {
    assert.equal((await signed(path, {})).status, 404, path);
  }
  const { code } = ownerCodes.issue();
  assert.equal((await app.request("/internal/v1/owner-code/verify", { method: "POST", body: JSON.stringify({ code }) })).status, 401);
  assert.equal((await signed("/internal/v1/owner-code/verify", { code: wrongFor(code) })).status, 403);
  assert.equal((await signed("/internal/v1/owner-code/consume", { code })).status, 200);
  assert.equal((await signed("/internal/v1/owner-code/consume", { code })).status, 403);
});

test("codes are issued only over a private Unix socket, to signed requests", async (t) => {
  const socketPath = join(tmpdir(), `yolo-node-test-${process.pid}-${Date.now()}.sock`);
  const ownerCodes = createOwnerCodes();
  const server = await listenLocal(createLocalApp({ secret, ownerCodes }), socketPath);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  const { status, body } = await requestLocal("/local/v1/owner-code", { socketPath, secret });
  assert.equal(status, 200);
  assert.equal(ownerCodes.verify(body.code).ok, true);
  assert.equal((await requestLocal("/local/v1/owner-code", { socketPath, secret: "wrong" })).status, 401);
  assert.equal((await requestLocal("/internal/v1/owner-code/consume", { socketPath, secret, body: { code: body.code } })).status, 404, "the socket serves nothing else");
  await assert.rejects(listenLocal(createLocalApp({ secret, ownerCodes }), socketPath), /already listens/);
});
