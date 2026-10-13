import assert from "node:assert/strict";
import test from "node:test";
import { LatestOperation } from "../../src/latest-operation.js";

test("a failed operation does not poison the next operation", async () => {
  const operations = new LatestOperation();
  await assert.rejects(operations.run(async () => {
    throw new Error("failed cleanup");
  }), /failed cleanup/);

  assert.equal(await operations.run(async () => true), true);
});
