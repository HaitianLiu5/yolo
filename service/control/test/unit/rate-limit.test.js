import assert from "node:assert/strict";
import { test } from "node:test";
import { guardMedia, limitPublicRequest } from "../../src/rate-limit.js";

// The binding's contract: limit({ key }) counts one call and says whether the
// key is still within its limit.
function binding(limit) {
  const counts = new Map();
  return { counts, limit: async ({ key }) => ({ success: counts.set(key, (counts.get(key) ?? 0) + 1).get(key) <= limit }) };
}
const from = (ip, path) => new Request(`https://yolo.test${path}`, { headers: { "cf-connecting-ip": ip } });

test("sign-in, pairing, and OAuth routes are limited per address; refused media tokens stop reaching the node", async () => {
  const env = { PUBLIC_LIMIT: binding(2), MEDIA_DENIED_LIMIT: binding(2) };
  for (const path of ["/oauth/register", "/device"]) assert.equal(await limitPublicRequest(from("203.0.113.1", path), env), null);
  const limited = await limitPublicRequest(from("203.0.113.1", "/login"), env);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(await limitPublicRequest(from("203.0.113.2", "/auth/passkey/login/options"), env), null);
  assert.equal(await limitPublicRequest(from("203.0.113.1", "/v1/me"), env), null, "credentialed routes are not counted");
  assert.equal(await limitPublicRequest(from("203.0.113.1", "/m/token/f/0"), {}), null, "no binding, no limit");

  let nodeCalls = 0;
  const node = (response) => async () => { nodeCalls += 1; return response(); };
  const refused = () => Response.json({ error: { code: "forbidden" } }, { status: 403 });
  const sourceDenied = () => new Response(null, { status: 403, headers: { "x-yolo-error-code": "UPSTREAM_ACCESS_DENIED" } });
  // A source's own 403 is not the token's fault.
  for (let i = 0; i < 3; i += 1) assert.equal((await guardMedia(from("198.51.100.7", "/m/ok/f/0"), env, node(sourceDenied))).status, 403);
  for (let i = 0; i < 2; i += 1) assert.equal((await guardMedia(from("198.51.100.9", "/m/forged/f/0"), env, node(refused))).status, 403);
  assert.equal((await guardMedia(from("198.51.100.9", "/m/forged/f/0"), env, node(refused))).status, 429);
  const callsBefore = nodeCalls;
  assert.equal((await guardMedia(from("198.51.100.9", "/m/forged/f/1"), env, node(refused))).status, 429);
  assert.equal(nodeCalls, callsBefore, "an address over the limit does not reach the node");
  assert.equal((await guardMedia(from("198.51.100.7", "/m/ok/f/0"), env, node(() => new Response("bytes")))).status, 200);
});
