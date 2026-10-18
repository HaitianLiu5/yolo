import assert from "node:assert/strict";
import { test } from "node:test";
import {
  openImageLink, sealImageLink, signMediaToken, signNodeRequest, signOperatorRequest, verifyMediaToken, verifyNodeRequest, verifyOperatorRequest,
} from "../src/index.js";

const secret = "test-secret-with-enough-entropy";

test("media tokens verify until they expire and reject tampering or another secret", async () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = await signMediaToken(secret, { sessionId: "ses_a", userId: "usr_b", exp });
  assert.deepEqual(await verifyMediaToken(secret, token), { sessionId: "ses_a", userId: "usr_b", exp });
  for (const [key, forged, now] of [[secret, token.replace("ses_a", "ses_c")], [secret, `${token}x`], ["other-secret", token], [secret, token, (exp + 1) * 1000]]) {
    assert.equal(await verifyMediaToken(key, forged, now), null);
  }
});

test("node signatures bind method, path, body and time; operator signatures are not node ones", async () => {
  const timestamp = Date.now();
  const headers = await signNodeRequest(secret, { method: "POST", path: "/internal/v1/prepare", body: "{}", timestamp });
  const ok = (overrides = {}) => verifyNodeRequest(secret, { method: "POST", path: "/internal/v1/prepare", body: "{}", headers, now: timestamp, ...overrides });
  assert.equal(await ok(), true);
  for (const change of [{ method: "GET" }, { path: "/internal/v1/health" }, { body: "{\"x\":1}" }, { now: timestamp + 10 * 60 * 1000 }]) {
    assert.equal(await ok(change), false, JSON.stringify(change));
  }
  const path = "/.well-known/yolo";
  const operator = await signOperatorRequest(secret, { path });
  assert.equal(await verifyOperatorRequest(secret, { path, headers: operator }), true);
  assert.equal(await verifyOperatorRequest(secret, { path: "/.well-known/other", headers: operator }), false);
  assert.equal(await verifyOperatorRequest(undefined, { path, headers: operator }), false);
  assert.equal(await verifyOperatorRequest(secret, { path, headers: await signNodeRequest(secret, { method: "GET", path }) }), false);
  assert.equal(await verifyNodeRequest(secret, { method: "GET", path, headers: operator }), false);
});

// Image links (Agent Note 2026-10-07-remote-mcp-server): one opaque token per
// image and key version that only the secret opens.
test("an image link is deterministic, opaque, and opens only untampered with the secret", async () => {
  const payload = JSON.stringify(["usr_owner", "a", "library:7", "poster"]);
  const token = await sealImageLink(secret, 1, payload);
  assert.equal(await sealImageLink(secret, 1, payload), token);
  assert.ok(!Buffer.from(token, "base64url").toString("latin1").includes("library:7"));
  assert.deepEqual(await openImageLink(secret, token), { version: 1, payload });
  assert.notEqual(await sealImageLink(secret, 2, payload), token);
  const bytes = Buffer.from(token, "base64url");
  for (const at of [1, 5, 21, bytes.length - 1]) {
    const flipped = Buffer.from(bytes);
    flipped[at] ^= 1;
    assert.equal(await openImageLink(secret, flipped.toString("base64url")), null, `byte ${at}`);
  }
  for (const junk of ["", "x", token.slice(0, -2), Buffer.from(payload).toString("base64url")]) assert.equal(await openImageLink(secret, junk), null);
  assert.equal(await openImageLink("another-secret-of-enough-length", token), null);
});
