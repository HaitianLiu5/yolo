import assert from "node:assert/strict";
import { test } from "node:test";
import { openImageLink, sealImageLink, signMediaToken, verifyMediaToken, signNodeRequest, verifyNodeRequest } from "../src/index.js";

const secret = "test-secret-with-enough-entropy";

test("media tokens verify until they expire and reject tampering", async () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = await signMediaToken(secret, { sessionId: "ses_a", userId: "usr_b", exp });
  assert.deepEqual(await verifyMediaToken(secret, token), { sessionId: "ses_a", userId: "usr_b", exp });
  assert.equal(await verifyMediaToken(secret, token.replace("ses_a", "ses_c")), null);
  assert.equal(await verifyMediaToken(secret, `${token}x`), null);
  assert.equal(await verifyMediaToken("other-secret", token), null);
  assert.equal(await verifyMediaToken(secret, token, (exp + 1) * 1000), null);
});

test("node request signatures bind method, path, body and time", async () => {
  const timestamp = Date.now();
  const headers = await signNodeRequest(secret, { method: "POST", path: "/internal/v1/prepare", body: "{}", timestamp });
  const ok = (overrides = {}) => verifyNodeRequest(secret, {
    method: "POST", path: "/internal/v1/prepare", body: "{}", headers, now: timestamp, ...overrides,
  });
  assert.equal(await ok(), true);
  assert.equal(await ok({ method: "GET" }), false);
  assert.equal(await ok({ path: "/internal/v1/health" }), false);
  assert.equal(await ok({ body: "{\"x\":1}" }), false);
  assert.equal(await ok({ now: timestamp + 10 * 60 * 1000 }), false);
});

// Image links (Agent Note 2026-10-07-remote-mcp-server): one opaque token per
// image and key version, the same every time, that only the secret opens.
const PAYLOAD = JSON.stringify(["usr_owner", "a", "library:7", "poster"]);
const flip = (token, at) => {
  const bytes = Buffer.from(token, "base64url");
  bytes[at] ^= 0x01;
  return bytes.toString("base64url");
};

test("an image link is deterministic and shows nothing of what it names", async () => {
  const token = await sealImageLink(secret, 1, PAYLOAD);
  assert.equal(await sealImageLink(secret, 1, PAYLOAD), token);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  for (const part of ["library:7", "poster", "usr_owner"]) assert.ok(!Buffer.from(token, "base64url").toString("latin1").includes(part), part);
  assert.deepEqual(await openImageLink(secret, token), { version: 1, payload: PAYLOAD });
  assert.notEqual(await sealImageLink(secret, 1, PAYLOAD.replace("library:7", "library:8")), token);
  // Another key version is another key: the same image gets another token.
  const next = await sealImageLink(secret, 2, PAYLOAD);
  assert.notEqual(next, token);
  assert.deepEqual(await openImageLink(secret, next), { version: 2, payload: PAYLOAD });
});

test("an image link with a wrong signature, a tampered byte, or another secret does not open", async () => {
  const token = await sealImageLink(secret, 3, PAYLOAD);
  const length = Buffer.from(token, "base64url").length;
  // The version, the signature, and the sealed image, one byte each.
  for (const at of [1, 4, 5, 20, 21, length - 1]) assert.equal(await openImageLink(secret, flip(token, at)), null, `byte ${at}`);
  assert.equal(await openImageLink("another-secret-of-enough-length", token), null);
  assert.equal(await openImageLink(secret, token.slice(0, -2)), null);
  assert.equal(await openImageLink(secret, `${token}AA`), null);
  for (const junk of ["", "x", "not a token", "%2F%2F", "A".repeat(5000), Buffer.from(PAYLOAD).toString("base64url")]) {
    assert.equal(await openImageLink(secret, junk), null, junk.slice(0, 20));
  }
  await assert.rejects(sealImageLink(secret, 0, PAYLOAD), TypeError);
  await assert.rejects(sealImageLink(secret, 1, ""), TypeError);
});
