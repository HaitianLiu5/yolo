import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestControlPlane, onlineScreen } from "../helpers/fakes.js";

// What the Hub decides that the e2e stack does not show: the media path and
// the relay's modes, who may be a device, and secrets in logs. Playback,
// commands, resume, and reconnects are proven in test/e2e.

const movie = { plugin: "library", id: "42" };
const TESLA = { renderer: "canvas-webcodecs", delivery: ["hls", "mp4"], video: ["avc1"], audio: ["mp4a"], maxHeight: 720, subtitles: "client-vtt" };

async function carPlane() {
  const plane = createTestControlPlane();
  const car = await onlineScreen(plane, { name: "Model Y", capabilities: TESLA });
  const prepares = () => plane.node.calls.filter((call) => call.path === "/internal/v1/prepare").map((call) => call.body);
  return { plane, car, prepares };
}

test("the screen's own probe picks the path, the relay comes last, and with the relay off no path is refused before the node works", async () => {
  const { plane, car, prepares } = await carPlane();
  const prepare = plane.node.routes["POST /internal/v1/prepare"];
  plane.node.routes["POST /internal/v1/prepare"] = (body) => ({ ...prepare(body), network: body.network });
  const lan = { path: "lan", origin: "https://yolo-lan-1.example.com:9443", notAfter: Infinity };
  let media = { paths: [lan], relayMode: "auto" };
  plane.hub.media = async () => media;
  const probe = (path, probes) => plane.hub.deviceMessage(car.id, { type: "network", path, reason: "probe", probes });

  await plane.hub.play({ source: movie });
  assert.equal(prepares().at(-1).network, "relay", "a screen that never probed");
  await probe("lan", { lan: "ok" });
  await plane.hub.play({ source: movie, startTime: 10 });
  assert.equal(prepares().at(-1).network, "lan");
  await plane.hub.play({ source: movie, network: "wan" });
  assert.equal(prepares().at(-1).network, "lan", "an agent cannot move the screen to another path");
  const { sessionId } = await plane.hub.state();
  await plane.hub.play({ source: movie, startTime: 42, reason: "recovery", replaces: sessionId, requester: car.id, network: "relay" });
  assert.deepEqual([prepares().at(-1).network, prepares().at(-1).startTime], ["relay", 42], "the screen's recovery moves down the paths");

  media = { paths: [lan], relayMode: "off", remote: { on: false, status: "off" } };
  await probe(null, { lan: "timeout" });
  const before = prepares().length;
  await assert.rejects(plane.hub.play({ source: movie }), (error) => error.code === "media_unreachable" && /home network: no answer/.test(error.message)
    && /relay is off/.test(error.message) && error.details.fixes.map((fix) => fix.action).join() === "relay,remote");
  assert.equal(prepares().length, before, "the node did no work");
});

test("a connection is the device its credential names; a removed device is refused and closed; a remote never plays", async () => {
  const { plane, car } = await carPlane();
  const { device } = await plane.hub.hello({ deviceId: "dev_someone_else", name: "Browser", kind: "browser" }, { boundDeviceId: car.id });
  assert.deepEqual([device.id, device.name, device.kind], [car.id, "Model Y", "car"], "the owner's name and type stay");
  await assert.rejects(plane.hub.hello({ name: "Ghost" }, { boundDeviceId: "dev_removed" }), { code: "unauthorized" });

  const phone = await onlineScreen(plane, { name: "iPhone", kind: "phone", capabilities: { renderer: "remote" } });
  assert.equal((await plane.hub.play({ source: movie })).device.id, car.id, "two online, one a remote: the car plays");
  await assert.rejects(plane.hub.play({ source: movie, device: phone.id }), { code: "invalid_request" });
  await assert.rejects(plane.hub.transfer(phone.id), { code: "invalid_request" });

  await plane.hub.forgetDevice(car.id);
  assert.deepEqual(plane.transport.closed, [{ deviceId: car.id, code: 4003, reason: "revoked" }]);
  assert.equal((await plane.hub.state()).status, "idle");
});

test("realtime tickets are stored hashed, work once, and expire after 30 seconds; a device's error is logged without its tokens", async () => {
  const { plane, car } = await carPlane();
  const { secret, expiresAt } = await plane.hub.issueTicket("dev_car");
  assert.equal(expiresAt, 1_000_000 + 30_000);
  assert.equal(JSON.stringify([...plane.storage.map.values()]).includes(secret), false);
  assert.deepEqual(await plane.hub.redeemTicket(secret), { deviceId: "dev_car" });
  assert.equal(await plane.hub.redeemTicket(secret), null);
  const late = await plane.hub.issueTicket();
  plane.advance(30_001);
  assert.equal(await plane.hub.redeemTicket(late.secret), null);

  await plane.hub.play({ source: movie });
  await plane.hub.deviceMessage(car.id, {
    type: "error", sessionId: (await plane.hub.state()).sessionId, code: "HLS_SEGMENT_FETCH_FAILED",
    message: "GET https://yolo.example/m/sess.usr.123.c2ln/f/2 failed; wss://yolo.example/v1/realtime?ticket=t1ck3t",
  });
  assert.equal(plane.logs.find((record) => record.event === "device_error").message,
    "GET https://yolo.example/m/<redacted>/f/2 failed; wss://yolo.example/v1/realtime?ticket=<redacted>");
});
