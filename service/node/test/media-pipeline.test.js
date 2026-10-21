import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NODE_PROTOCOL, PROTOCOL_HEADER, signMediaToken, signNodeRequest } from "@useyolo/core";
import { createNodeApp } from "../src/app.js";
import { DEVICE_SEGMENT_TIMEOUT_MS, SEGMENT_TIMING } from "../src/media/hedge.js";
import { createMediaPipeline, SESSION_EXPIRED } from "../src/media/pipeline.js";
import { loadPlugins } from "../src/plugins.js";

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

// A node whose one source counts the items it resolves, behind the signed
// internal API, with a clock the test moves.
async function shareNode(t) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "yolo-share-"));
  const clock = { now: Date.now() };
  const media = createMediaPipeline({
    secret, runtimeDir, stopGraceMs: 5, now: () => clock.now,
    fetchImpl: async () => new Response(null, { status: 200, headers: { "content-type": "video/mp4", "content-length": "4" } }),
  });
  media.init();
  const resolved = { count: 0 };
  const prepare = async () => {
    resolved.count += 1;
    return { input: { type: "file", url: "https://media.test/a.mp4" } };
  };
  const plugins = await loadPlugins([{ name: "fixture", enabled: true, options: {}, factory: (yolo) => yolo.registerSource("web", { prepare }) }]);
  await plugins.start();
  const app = createNodeApp({ secret, plugins, media });
  t.after(async () => {
    await media.close();
    await rm(runtimeDir, { recursive: true, force: true });
  });
  const call = async (method, path, body) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers = { ...(await signNodeRequest(secret, { method, path, body: text })), [PROTOCOL_HEADER]: String(NODE_PROTOCOL), "content-type": "application/json" };
    const response = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: text }) });
    return { status: response.status, body: await response.json() };
  };
  const play = async (sessionId, fields = {}) => call("POST", "/internal/v1/prepare", {
    sessionId,
    mediaToken: await signMediaToken(secret, { sessionId, userId: "usr_media", exp: Math.floor(clock.now / 1000) + 3600 }),
    source: { plugin: "web", id: "1" },
    capabilities: {},
    ...fields,
  });
  // The sessions among `ids` the node still holds once retired ones are released.
  const held = async (...ids) => {
    await new Promise((done) => setTimeout(done, 30));
    return ids.filter((id) => media.has(id));
  };
  // A media request, as a friend's player makes while it plays.
  const read = async (stream) => (await app.request(stream.delivery.url, { method: "HEAD" })).status;
  return { clock, resolved, call, play, held, read };
}

// Share links (Agent Note 2026-10-20-share-links): friends' streams never
// disturb the owner's, at most two play at once, and a refused one costs no
// source work.
test("friends' share-link streams are capped apart from the owner's and admitted before their source resolves", async (t) => {
  const { clock, resolved, play, held, read } = await shareNode(t);
  assert.equal((await play("ses_x", { share: "not-a-share" })).body.error.code, "invalid_request");
  assert.equal((await play("ses_owner")).status, 200);
  assert.equal((await play("ses_f1", { share: "shr_a" })).status, 200);
  const second = await play("ses_f2", { share: "shr_b" });
  assert.equal(second.status, 200);
  const before = resolved.count;
  const refused = await play("ses_f3", { share: "shr_c" });
  assert.deepEqual([refused.status, refused.body.error.code], [429, "rate_limited"]);
  assert.match(refused.body.error.message, /Two friends are already watching/);
  // `replaces` frees a place only for a session of the same share.
  assert.equal((await play("ses_f3", { share: "shr_a", replaces: "ses_f2" })).status, 429);
  assert.equal((await play("ses_f3", { share: "shr_a", replaces: "ses_owner" })).status, 429);
  assert.equal(resolved.count, before, "a refused stream never reaches its source");
  assert.deepEqual(await held("ses_owner", "ses_f1", "ses_f2"), ["ses_owner", "ses_f1", "ses_f2"]);
  assert.equal((await play("ses_f1b", { share: "shr_a", replaces: "ses_f1" })).status, 200);
  assert.deepEqual(await held("ses_f1", "ses_f1b", "ses_f2"), ["ses_f1b", "ses_f2"]);
  // A friend's place frees up two minutes after its last media request.
  clock.now += 60_000;
  assert.equal((await play("ses_f3", { share: "shr_c" })).status, 429);
  clock.now += 2 * 60_000;
  assert.equal(await read(second.body), 200);
  assert.equal((await play("ses_f3", { share: "shr_c" })).status, 200);
  assert.deepEqual(await held("ses_owner", "ses_f1b", "ses_f2", "ses_f3"), ["ses_owner", "ses_f2", "ses_f3"]);
  // The owner keeps eight sessions of their own, whatever friends play.
  for (let index = 1; index <= 7; index += 1) assert.equal((await play(`ses_o${index}`)).status, 200);
  assert.deepEqual(await held("ses_owner", "ses_f2", "ses_f3"), ["ses_owner", "ses_f2", "ses_f3"]);
  assert.equal((await play("ses_o8")).status, 200);
  assert.deepEqual(await held("ses_owner", "ses_f2", "ses_f3", "ses_o1", "ses_o8"), ["ses_f2", "ses_f3", "ses_o1", "ses_o8"]);
});

test("revoking a share link stops only its friends' sessions", async (t) => {
  const { call, play, held } = await shareNode(t);
  for (const [sessionId, share] of [["ses_owner", undefined], ["ses_a", "shr_a"], ["ses_b", "shr_b"]]) {
    assert.equal((await play(sessionId, share ? { share } : {})).status, 200);
  }
  assert.deepEqual(await call("DELETE", "/internal/v1/shares/shr_a"), { status: 200, body: { stopped: 1 } });
  assert.deepEqual(await held("ses_owner", "ses_a", "ses_b"), ["ses_owner", "ses_b"]);
  assert.equal((await call("DELETE", "/internal/v1/shares/ses_owner")).status, 400);
});
