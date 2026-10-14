import assert from "node:assert/strict";
import { test } from "node:test";
import * as setup from "../src/setup.js";
import { API, fakeDesec } from "./fake-desec.js";

// What `npm run yolo -- provision media-dns` and `doctor` read from the
// plugin's setup entry: the owner's steps, the name and token checks.

const TOKEN = "desec-token-never-shown";

test("the setup entry names the provider, its secret, and the owner's steps at desec.io", () => {
  assert.deepEqual([setup.provider, setup.secret, setup.title], ["desec", "DESEC_TOKEN", "deSEC"]);
  assert.deepEqual(setup.nameservers, ["ns1.desec.io", "ns2.desec.org"]);
  const steps = setup.steps({ zone: "home.dedyn.io" });
  assert.ok(steps.length >= 3);
  const text = steps.join("\n");
  for (const fact of [/https:\/\/desec\.io/, /dedyn\.io/, /home\.dedyn\.io/, /token/i, /email/i]) assert.match(text, fact);
  assert.match(setup.steps({ zone: null }).join("\n"), /<name>\.dedyn\.io/);
});

test("the name must be a deSEC domain of its own, not dedyn.io itself", () => {
  assert.equal(setup.checkZone("home.dedyn.io"), null);
  assert.equal(setup.checkZone("example.net"), null, "a custom domain hosted at deSEC also works");
  for (const zone of ["dedyn.io", "https://home.dedyn.io", "a.b.home.dedyn.io", "home", "", null]) assert.equal(typeof setup.checkZone(zone), "string", String(zone));
});

test("the token check reads the domain once and reports what is wrong without the token", async () => {
  const desec = fakeDesec({ token: TOKEN, minimumTtl: 60 });
  assert.deepEqual(await setup.checkToken({ token: TOKEN, zone: "home.dedyn.io", fetch: desec.fetch, api: API }), { ok: true, ttl: 60, message: "deSEC accepts the token for home.dedyn.io (records at a TTL of 60 seconds)" });
  assert.deepEqual(desec.writes(), [], "checking writes nothing");

  const wrong = await setup.checkToken({ token: "typo", zone: "home.dedyn.io", fetch: desec.fetch, api: API });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /rejected the token/);

  const missing = await setup.checkToken({ token: TOKEN, zone: "other.dedyn.io", fetch: desec.fetch, api: API });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /other\.dedyn\.io/);

  const down = await setup.checkToken({ token: TOKEN, zone: "home.dedyn.io", api: API, fetch: async () => {
    throw new TypeError("fetch failed");
  } });
  assert.equal(down.ok, false);
  for (const result of [wrong, missing, down]) assert.equal(JSON.stringify(result).includes(TOKEN), false);
});
