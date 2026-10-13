import assert from "node:assert/strict";
import { test } from "node:test";
import { redactText, sanitizeEventFields } from "../src/index.js";

test("media tokens, credentials and tickets never leave the device", () => {
  assert.equal(redactText("GET https://yolo.test/m/eyJhbGciOi.abc/f/76.m4s?x=1"), "GET https://yolo.test/m/<redacted>/f/76.m4s?x=1");
  assert.equal(redactText("/v1/realtime?ticket=abc123&x=1"), "/v1/realtime?ticket=<redacted>&x=1");
  assert.equal(redactText("Authorization: Bearer ydt_secretvalue"), "Authorization: Bearer <redacted>");
  assert.equal(redactText("token ydt_abcDEF-123 leaked"), "token ydt_<redacted> leaked");
  const fields = sanitizeEventFields({
    url: "/m/tok3n/p/index.m3u8",
    token: "ydt_x",
    nested: { Authorization: "Bearer x", cookie: "a=b", ticket: "t", ok: 1, a: { b: { c: { d: { gone: true } } } } },
    list: Array.from({ length: 120 }, (_, index) => index),
    big: 10n,
    nan: Number.NaN,
    fn: () => {},
  });
  assert.deepEqual(fields, {
    url: "/m/<redacted>/p/index.m3u8",
    nested: { ok: 1, a: { b: { c: {} } } },
    list: Array.from({ length: 100 }, (_, index) => index),
    big: 10,
    nan: null,
  });
});

test("an oversized event keeps its small fields and names what it dropped", () => {
  const fields = sanitizeEventFields({ code: "SESSION_EXPIRED", stats: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "x".repeat(400)])) });
  assert.equal(fields.code, "SESSION_EXPIRED");
  assert.deepEqual(fields.truncated, ["stats"]);
  assert.ok(JSON.stringify(fields).length <= 8 * 1024, "an event stays within 8 KiB");
});
