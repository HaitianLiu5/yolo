import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCapabilities } from "@useyolo/core";
import { createTestControlPlane, onlineScreen, USER } from "../helpers/fakes.js";
import { listQueue } from "../../src/store/queue.js";

// The agent canvas (Agent Note 2026-10-21-agent-canvas) through the service
// layer and HubCore, as MCP tools and /v1 reach it.

const CANVAS = { surfaces: ["panel", "player"], kinds: { note: 1, image: 1, choices: 1 } };

function recordSends(plane) {
  const sent = [];
  const send = plane.transport.send;
  plane.transport.send = (deviceId, message) => {
    sent.push({ deviceId, message });
    return send(deviceId, message);
  };
  return sent;
}

async function screen(plane, name = "Car", canvas = CANVAS) {
  return onlineScreen(plane, { name, capabilities: canvas ? { canvas } : {} });
}

test("a host's canvas capability survives normalization, and a malformed one is dropped", () => {
  assert.deepEqual(normalizeCapabilities({ canvas: CANVAS }).canvas, CANVAS);
  assert.equal(normalizeCapabilities({ canvas: { surfaces: ["ceiling"], kinds: { note: 1 } } }).canvas, undefined);
  assert.equal(normalizeCapabilities({}).canvas, undefined);
});

test("a note goes on the only screen with a canvas, reaches it as canvas_ops, and is in its welcome", async () => {
  const plane = createTestControlPlane();
  const sent = recordSends(plane);
  const car = await screen(plane);
  await screen(plane, "Old TV", null);

  const { device, object } = await plane.services.canvasPut({ object: { kind: "note", props: { text: "Tyres at 9 tomorrow" } } });
  assert.equal(device.id, car.id);
  assert.equal(object.surface, "panel");
  assert.equal(object.fallback.text, "Tyres at 9 tomorrow");
  assert.deepEqual(sent.map((entry) => [entry.deviceId, entry.message.type, entry.message.rev]), [[car.id, "canvas_ops", 1]]);

  const { welcome } = await plane.hub.hello({ v: 1, type: "hello", name: "Car", kind: "car", capabilities: { canvas: CANVAS } }, { boundDeviceId: car.id });
  assert.equal(welcome.canvas.rev, 1);
  assert.deepEqual(welcome.canvas.objects.map((entry) => entry.id), [object.id]);
});

test("a screen without a canvas gets none: put refuses and offer answers unsupported", async () => {
  const plane = createTestControlPlane();
  await screen(plane, "Old TV", null);
  await assert.rejects(plane.services.canvasPut({ object: { kind: "note", props: { text: "Hi" } } }), /words/);
  assert.equal((await plane.services.offer({ options: [{ item_id: "library:1" }], waitSeconds: 0 })).status, "unsupported");
});

test("choices carry Yolo's own titles, and a pick plays at once, closes them, and answers a waiting offer", async () => {
  const plane = createTestControlPlane();
  const car = await screen(plane);
  const offered = plane.services.offer({
    title: "Which one?", options: [{ item_id: "library:1", note: "the 2014 one" }, { item_id: "library:2" }], waitSeconds: 5,
  });
  // The offer is waiting; the screen sees the choices and picks the second.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const { objects } = await plane.services.screenCanvas(car.id);
  assert.equal(objects.length, 1);
  assert.deepEqual(objects[0].props.options.map((option) => option.item.title), ["Movie 1", "Movie 2"]);
  assert.equal(objects[0].props.options[0].note, "the 2014 one");

  await plane.services.canvasGesture(car.id, { objectId: objects[0].id, gesture: "pick", payload: { option: 1 } });
  const answer = await offered;
  assert.equal(answer.status, "chosen");
  assert.equal(answer.option, 1);
  assert.equal(answer.played, true);
  assert.equal(answer.choice.title, "Movie 2");
  assert.deepEqual((await plane.hub.getState()).item.source, { plugin: "library", id: "2" });
  assert.equal((await plane.services.screenCanvas(car.id)).objects.length, 0);
});

test("After this queues the choice next instead of playing it", async () => {
  const plane = createTestControlPlane();
  const car = await screen(plane);
  const { status, id } = await plane.services.offer({ options: [{ item_id: "library:3" }], waitSeconds: 0 });
  assert.equal(status, "waiting");
  await plane.services.canvasGesture(car.id, { objectId: id, gesture: "pick", payload: { option: 0, after: true } });
  assert.deepEqual((await listQueue(plane.db, USER, car.id)).map((item) => item.source.id), ["3"], "the screen's own queue");
  assert.equal((await plane.hub.state(car.id)).item, null);
  const { events } = await plane.services.canvasEvents({ objects: [id] });
  assert.equal(events[0].queued, true);
});

test("a pick made after the agent stopped waiting is in the event log after its cursor", async () => {
  const plane = createTestControlPlane();
  const car = await screen(plane);
  const first = await plane.services.offer({ options: [{ item_id: "library:1" }, { label: "Something else" }], waitSeconds: 0 });
  await plane.services.canvasGesture(car.id, { objectId: first.id, gesture: "pick", payload: { option: 1 } });
  const { events, cursor } = await plane.services.canvasEvents({ since: first.cursor });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "notify");
  assert.equal(events[0].option, 1);
  assert.equal(cursor, events[0].cursor);
  assert.equal((await plane.hub.getState()).item, null);
});

test("a wait that passed over a drag of the choices answers with the cursor from when they were placed", async () => {
  const plane = createTestControlPlane();
  const car = await screen(plane);
  const { object: note } = await plane.services.canvasPut({ object: { kind: "note", props: { text: "Hi" } } });
  const offered = plane.services.offer({ options: [{ item_id: "library:1" }], waitSeconds: 0.2 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [choices] = (await plane.services.screenCanvas(car.id)).objects.filter((object) => object.kind === "choices");
  await plane.services.canvasGesture(car.id, { objectId: note.id, gesture: "press" });
  await plane.services.canvasMove(car.id, { objectId: choices.id, anchor: "bottom-right" });
  const answer = await offered;
  assert.equal(answer.status, "waiting");
  // The note's press came before the drag: reading on from the cursor finds both.
  const { events } = await plane.services.canvasEvents({ since: answer.cursor });
  assert.deepEqual(events.map((event) => [event.objectId, event.gesture]), [[note.id, "press"], [choices.id, "move"]]);
});

test("a note's dismiss removes it, and its press only notifies", async () => {
  const plane = createTestControlPlane();
  const car = await screen(plane);
  const { object } = await plane.services.canvasPut({ object: { kind: "note", props: { text: "Hi" } } });
  await plane.services.canvasGesture(car.id, { objectId: object.id, gesture: "press" });
  assert.equal((await plane.services.screenCanvas(car.id)).objects.length, 1);
  await plane.services.canvasGesture(car.id, { objectId: object.id, gesture: "dismiss" });
  assert.equal((await plane.services.screenCanvas(car.id)).objects.length, 0);
  assert.deepEqual((await plane.services.canvasEvents({})).events.map((event) => event.action), ["notify", "remove"]);
});

test("a person's drag moves the object to another anchor on every screen it is on, and the agent hears of it", async () => {
  const plane = createTestControlPlane();
  const car = await screen(plane);
  const { object } = await plane.services.canvasPut({ object: { kind: "note", props: { text: "Scan me" } } });
  const sent = recordSends(plane);
  await plane.services.canvasMove(car.id, { objectId: object.id, anchor: "bottom-right" });
  assert.equal((await plane.services.screenCanvas(car.id)).objects[0].layout.anchor, "bottom-right");
  assert.equal(sent.find((entry) => entry.message.type === "canvas_ops").message.ops[0].object.layout.anchor, "bottom-right");
  const [event] = (await plane.services.canvasEvents({})).events;
  assert.deepEqual([event.gesture, event.payload, event.action], ["move", { anchor: "bottom-right" }, "notify"]);
  await assert.rejects(plane.services.canvasMove(car.id, { objectId: object.id, anchor: "somewhere" }), { code: "invalid_request" });
});

test("patch merges props and raises the rev; remove takes the object off", async () => {
  const plane = createTestControlPlane();
  const car = await screen(plane);
  const { object } = await plane.services.canvasPut({ object: { kind: "note", props: { title: "Hotels", text: "Looking…" } } });
  await plane.services.canvasPatch({ id: object.id, changes: { props: { text: "From ¥900 a night" } } });
  let canvas = await plane.services.screenCanvas(car.id);
  assert.equal(canvas.rev, 2);
  assert.deepEqual(canvas.objects[0].props, { title: "Hotels", text: "From ¥900 a night" });
  await plane.services.canvasRemove({ id: object.id });
  canvas = await plane.services.screenCanvas(car.id);
  assert.equal(canvas.rev, 3);
  assert.equal(canvas.objects.length, 0);
});

test("an object for every screen reaches each screen with a canvas, on its own rev", async () => {
  const plane = createTestControlPlane();
  const sent = recordSends(plane);
  const car = await screen(plane);
  const phone = await screen(plane, "Phone");
  await plane.services.canvasPut({ device: "Car", object: { kind: "note", props: { text: "Car only" } } });
  const { object } = await plane.services.canvasPut({ device: "Car", object: { kind: "note", scope: "all", props: { text: "Rent on Friday" } } });
  assert.deepEqual((await plane.services.screenCanvas(phone.id)).objects.map((entry) => entry.id), [object.id]);
  assert.equal((await plane.services.screenCanvas(car.id)).objects.length, 2);
  const revs = Object.fromEntries(sent.filter((entry) => entry.message.ops[0].object?.id === object.id).map((entry) => [entry.deviceId, entry.message.rev]));
  assert.deepEqual(revs, { [car.id]: 2, [phone.id]: 1 });
});

test("an id put again with the other scope replaces the object instead of leaving a second copy", async () => {
  const plane = createTestControlPlane();
  const car = await screen(plane);
  const phone = await screen(plane, "Phone");
  const { object } = await plane.services.canvasPut({ device: "Car", object: { kind: "note", scope: "all", props: { text: "Rent on Friday" } } });
  const sent = recordSends(plane);
  await plane.services.canvasPut({ device: "Car", object: { id: object.id, kind: "note", props: { text: "Car only" } } });
  assert.deepEqual((await plane.services.screenCanvas(car.id)).objects.map((entry) => [entry.id, entry.props.text]), [[object.id, "Car only"]]);
  assert.equal((await plane.services.screenCanvas(phone.id)).objects.length, 0);
  assert.deepEqual(sent.map((entry) => [entry.deviceId, entry.message.ops[0].op]).sort(), [[car.id, "put"], [phone.id, "remove"]].sort());
  await plane.services.canvasPut({ device: "Car", object: { id: object.id, kind: "note", scope: "all", props: { text: "Everyone" } } });
  assert.deepEqual((await plane.services.screenCanvas(car.id)).objects.map((entry) => entry.props.text), ["Everyone"]);
  await plane.services.canvasRemove({ device: "Car", id: object.id });
  assert.equal((await plane.services.screenCanvas(car.id)).objects.length, 0, "no copy left under the other scope");
});

test("a drag of the choices is not a pick: the offer goes on waiting", async () => {
  const plane = createTestControlPlane();
  const car = await screen(plane);
  const offered = plane.services.offer({ options: [{ item_id: "library:1" }, { item_id: "library:2" }], waitSeconds: 5 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [{ id }] = (await plane.services.screenCanvas(car.id)).objects;
  await plane.services.canvasMove(car.id, { objectId: id, anchor: "bottom-right" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await plane.services.canvasGesture(car.id, { objectId: id, gesture: "pick", payload: { option: 0, after: true } });
  const answer = await offered;
  assert.deepEqual([answer.status, answer.option, answer.queued], ["chosen", 0, true]);
});

test("choices read from the canvas and sent back with the node offline keep Yolo's titles, never the agent's", async () => {
  const plane = createTestControlPlane();
  const car = await screen(plane);
  const { id } = await plane.services.offer({ options: [{ item_id: "library:1" }, { item_id: "library:2" }], waitSeconds: 0 });
  const [{ props }] = (await plane.services.canvasRead({})).screens[0].objects;
  plane.node.offline = true;
  const options = [...props.options.map((option) => ({ ...option, item: { ...option.item, title: "The agent's words" } })), { item: { source: { plugin: "library", id: "9" }, title: "Made up" } }];
  await plane.services.canvasPatch({ id, changes: { props: { options } } });
  assert.deepEqual((await plane.services.screenCanvas(car.id)).objects[0].props.options.map((option) => option.item.title), ["Movie 1", "Movie 2", null]);
});

test("transient choices expire after ten minutes", async () => {
  const plane = createTestControlPlane();
  const car = await screen(plane);
  await plane.services.offer({ options: [{ item_id: "library:1" }], waitSeconds: 0 });
  plane.advance(10 * 60_000 + 1);
  assert.equal((await plane.services.screenCanvas(car.id)).objects.length, 0);
});

test("objects are checked: an unknown kind, a picture that is not http, and too many choices are refused", async () => {
  const plane = createTestControlPlane();
  await screen(plane);
  await assert.rejects(plane.services.canvasPut({ object: { kind: "web", props: {} } }), /kind/);
  await assert.rejects(plane.services.canvasPut({ object: { kind: "image", props: { url: "javascript:alert(1)" } } }), /http/);
  await assert.rejects(plane.services.offer({ options: Array.from({ length: 7 }, (_, index) => ({ item_id: `library:${index}` })) }), /at most 6/);
});
