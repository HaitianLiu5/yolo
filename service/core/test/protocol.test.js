import assert from "node:assert/strict";
import { test } from "node:test";
import { errorBody, fromErrorBody, HEARTBEAT_PING, redactText, sanitizeEventFields, YoloError } from "../src/index.js";

test("wire shapes: the heartbeat envelope and error bodies with their details", () => {
  assert.deepEqual(JSON.parse(HEARTBEAT_PING), { v: 1, type: "ping" });
  const details = { relayMode: "off" };
  const body = errorBody(new YoloError("node_offline", "Media node is offline", { details }));
  assert.deepEqual(body, { error: { code: "node_offline", message: "Media node is offline", retryable: true, details } });
  assert.deepEqual([fromErrorBody(body, 503).code, fromErrorBody(body, 503).details], ["node_offline", details]);
  assert.equal(fromErrorBody({ error: "legacy" }, 404).code, "not_found");
});

test("media tokens, credentials and tickets never leave the device in telemetry", () => {
  assert.equal(redactText("GET https://yolo.test/m/eyJhbGciOi.abc/f/76.m4s?x=1"), "GET https://yolo.test/m/<redacted>/f/76.m4s?x=1");
  assert.equal(redactText("/v1/realtime?ticket=abc123&x=1"), "/v1/realtime?ticket=<redacted>&x=1");
  assert.equal(redactText("Authorization: Bearer ydt_secretvalue"), "Authorization: Bearer <redacted>");
  const fields = sanitizeEventFields({ url: "/m/tok3n/p/index.m3u8", token: "ydt_x", nested: { Authorization: "Bearer x", cookie: "a=b", ticket: "t", ok: 1 } });
  assert.deepEqual(fields, { url: "/m/<redacted>/p/index.m3u8", nested: { ok: 1 } });
});
