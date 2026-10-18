import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signMediaToken } from "@useyolo/core";
import { DEVICE_SEGMENT_TIMEOUT_MS, SEGMENT_TIMING } from "../src/media/hedge.js";
import { createMediaPipeline, SESSION_EXPIRED } from "../src/media/pipeline.js";

const secret = "media-test-secret";

// /m/* is authorized by the media token in the path alone (Agent Note
// 2026-10-07-device-code-pairing); the rest of the pipeline runs in test/e2e.
test("media tokens authorize /m/*; unknown and ended sessions answer SESSION_EXPIRED", async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "yolo-media-"));
  const media = createMediaPipeline({ secret, runtimeDir, stopGraceMs: 20 });
  media.init();
  t.after(async () => {
    await media.close();
    await rm(runtimeDir, { recursive: true, force: true });
  });
  const exp = Math.floor(Date.now() / 1000) + 600;
  const open = async (sessionId, tokenExp = exp) => media.open({
    sessionId, mediaToken: await signMediaToken(secret, { sessionId, userId: "usr_media", exp: tokenExp }), source: { plugin: "fixture", id: "1" },
    descriptor: { input: { type: "file", url: "https://media.test/a.mp4" } },
  });
  const get = (path) => media.handle(new Request(`http://node.test${path}`));
  const descriptor = await open("ses_a");
  const token = descriptor.delivery.url.split("/")[2];
  assert.equal((await get(`/m/${token.slice(0, -2)}xx/f/0`)).status, 403);
  assert.equal((await get(`/m/${await signMediaToken("other-secret", { sessionId: "ses_a", userId: "usr_media", exp })}/f/0`)).status, 403);
  const unknown = await get(`/m/${await signMediaToken(secret, { sessionId: "ses_gone", userId: "usr_media", exp })}/f/0`);
  assert.deepEqual([unknown.status, unknown.headers.get("x-yolo-error-code")], [410, SESSION_EXPIRED]);
  await assert.rejects(open("ses_old", Math.floor(Date.now() / 1000) - 1), { code: "invalid_request" });
  await media.stop(descriptor.sessionId);
  await new Promise((done) => setTimeout(done, 60));
  assert.equal((await get(descriptor.delivery.url)).status, 410);
  // The node gives up on a segment before the device's own timeout does.
  assert.ok(SEGMENT_TIMING.giveUpMs <= DEVICE_SEGMENT_TIMEOUT_MS - 1_000);
});
