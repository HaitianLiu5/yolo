import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptsProtocol,
  NODE_PROTOCOL,
  requestProtocol,
  signNodeRequest,
  signOperatorRequest,
  verifyNodeRequest,
  verifyOperatorRequest,
} from "../src/index.js";

const secret = "test-secret-with-enough-entropy";

test("the node accepts its own protocol and the one before", () => {
  assert.equal(requestProtocol(undefined), 0);
  assert.equal(requestProtocol(""), 0);
  assert.equal(requestProtocol("3"), 3);
  assert.equal(requestProtocol("x"), null);
  assert.equal(requestProtocol("-1"), null);
  assert.equal(acceptsProtocol(NODE_PROTOCOL), true);
  assert.equal(acceptsProtocol(NODE_PROTOCOL - 1), true);
  assert.equal(acceptsProtocol(NODE_PROTOCOL + 1), false);
  assert.equal(acceptsProtocol(NODE_PROTOCOL - 2), false);
  assert.equal(acceptsProtocol(4, 5), true);
  assert.equal(acceptsProtocol(3, 5), false);
});

test("an operator signature verifies only as an operator request", async () => {
  const headers = await signOperatorRequest(secret, { path: "/.well-known/yolo" });
  assert.equal(await verifyOperatorRequest(secret, { path: "/.well-known/yolo", headers }), true);
  assert.equal(await verifyOperatorRequest(secret, { path: "/.well-known/other", headers }), false);
  assert.equal(await verifyOperatorRequest("other-secret", { path: "/.well-known/yolo", headers }), false);
  assert.equal(await verifyOperatorRequest(undefined, { path: "/.well-known/yolo", headers }), false);
  assert.equal(await verifyOperatorRequest(secret, { path: "/.well-known/yolo", headers: {} }), false);
  // A node request's signature for the same path is not an operator's.
  const node = await signNodeRequest(secret, { method: "GET", path: "/.well-known/yolo" });
  assert.equal(await verifyOperatorRequest(secret, { path: "/.well-known/yolo", headers: node }), false);
  // And an operator's headers do not pass as a node request.
  assert.equal(await verifyNodeRequest(secret, { method: "GET", path: "/.well-known/yolo", headers }), false);
});
