import assert from "node:assert/strict";
import { test } from "node:test";
import { createV1App } from "../../src/api/v1.js";
import { createTestControlPlane, USER } from "../helpers/fakes.js";

// The queue and playlist routes the player's home screen calls, over the
// real service layer and D1 schema, with a fake node.
test("queue and playlist endpoints round-trip", async () => {
  const plane = createTestControlPlane();
  const app = createV1App({ getContext: () => ({ services: plane.services, scopes: ["read", "control", "manage"], userId: USER }) });
  const request = async (method, path, body) => {
    const response = await app.request(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };

  const added = await request("POST", "/v1/queue", { itemId: "library:1" });
  assert.deepEqual([added.status, added.body.item.title], [201, "Movie 1"]);
  await request("POST", "/v1/queue", { itemId: "library:2", position: "next" });
  const queue = await request("GET", "/v1/queue");
  assert.deepEqual(queue.body.map((item) => item.title), ["Movie 2", "Movie 1"]);
  const reordered = await request("POST", "/v1/queue/reorder", { ids: [queue.body[1].id] });
  assert.equal(reordered.body[0].title, "Movie 1");
  assert.equal((await request("DELETE", `/v1/queue/${queue.body[0].id}`)).status, 200);

  const playlist = await request("POST", "/v1/playlists", { name: "Trip" });
  assert.equal(playlist.status, 201);
  await request("POST", `/v1/playlists/${playlist.body.id}/items`, { itemId: "library:2" });
  assert.equal((await request("PATCH", `/v1/playlists/${playlist.body.id}`, { name: "Road trip" })).body.name, "Road trip");
  assert.equal((await request("POST", `/v1/playlists/${playlist.body.id}/enqueue`, { position: "end" })).body.added, 1);
  assert.equal((await request("DELETE", `/v1/playlists/${playlist.body.id}`)).status, 200);
  assert.equal((await request("GET", `/v1/playlists/${playlist.body.id}`)).status, 404);
  assert.equal((await request("DELETE", "/v1/queue")).status, 200);
});
