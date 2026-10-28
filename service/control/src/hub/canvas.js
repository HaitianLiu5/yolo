import {
  CANVAS_GESTURES, CANVAS_LIMITS, createRateLimit, isCanvasObjectLive, normalizeCanvasObject, YoloError,
} from "@useyolo/core";

// The agent canvas in the Hub (Agent Note 2026-10-21-agent-canvas): a canvas
// per screen, objects agents place on it, and an event log of what people
// do to them. HubCore owns one and runs the actions that reach playback
// (play, queue); this class keeps the canvases, orders every change, tells
// the screens, and lets agents wait for events. No Workers imports, so it is
// unit tested with HubCore.
//
// Storage: `canvas:<deviceId>` holds a screen's own objects and its `rev`;
// `canvas:all` holds the objects with `scope: all`, which every screen with
// a canvas draws as part of its own and whose changes raise each screen's
// `rev`; `canvas:events` is the log, newest last, and `canvas:cursor` its
// last cursor.

const DEVICE_KEY = "canvas:";
const ALL_KEY = "canvas:all";
const EVENTS_KEY = "canvas:events";
const CURSOR_KEY = "canvas:cursor";

const live = (objects, now) => Object.values(objects || {}).filter((object) => isCanvasObjectLive(object, now));
const byteLength = (value) => new TextEncoder().encode(JSON.stringify(value ?? null)).length;

export class Canvas {
  // `screens()` resolves to the devices that declared a canvas, as
  // [{ id, capabilities }]; `send(deviceId, message)` reaches one screen.
  constructor({ storage, screens, send, now = () => Date.now(), log = () => {} }) {
    this.storage = storage;
    this.screens = screens;
    this.send = send;
    this.now = now;
    this.log = log;
    this.allowOp = createRateLimit({ max: CANVAS_LIMITS.opsPerSecond, windowMs: 1000 }, now);
    // Agents waiting in canvasEvents() or offer(). A waiting call keeps the
    // Hub awake, so these are never lost to hibernation.
    this.waiters = new Set();
  }

  async own(deviceId) {
    return (await this.storage.get(`${DEVICE_KEY}${deviceId}`)) || { rev: 0, objects: {} };
  }

  async shared() {
    return (await this.storage.get(ALL_KEY)) || { objects: {} };
  }

  /** A screen's canvas as it draws it: its objects and those for every screen, live ones only. */
  async read(deviceId) {
    const [own, shared] = await Promise.all([this.own(deviceId), this.shared()]);
    const now = this.now();
    const objects = [...live(shared.objects, now), ...live(own.objects, now)]
      .sort((left, right) => left.layout.z - right.layout.z || left.createdAt - right.createdAt);
    return { rev: own.rev, objects };
  }

  async find(deviceId, objectId) {
    const [own, shared] = await Promise.all([this.own(deviceId), this.shared()]);
    const object = own.objects[objectId] ?? shared.objects[objectId] ?? null;
    return object && isCanvasObjectLive(object, this.now()) ? object : null;
  }

  // Raises the rev of each screen `ops` reach and sends them the ops: one
  // screen for its own objects, every screen with a canvas for shared ones.
  async publish(deviceIds, ops) {
    for (const deviceId of deviceIds) {
      const own = await this.own(deviceId);
      own.rev += 1;
      await this.storage.put(`${DEVICE_KEY}${deviceId}`, own);
      this.send(deviceId, { v: 1, type: "canvas_ops", rev: own.rev, ops });
    }
  }

  async reach(scope, deviceId) {
    if (scope !== "all") return [deviceId];
    return (await this.screens()).map((screen) => screen.id);
  }

  limit() {
    if (!this.allowOp()) throw new YoloError("rate_limited", `At most ${CANVAS_LIMITS.opsPerSecond} canvas changes a second`);
  }

  /** Places `input` on `deviceId`'s canvas, or every screen's with `scope: all`. */
  async put(deviceId, input, { owner = "agent" } = {}) {
    this.limit();
    const object = normalizeCanvasObject(input, { owner, now: this.now() });
    const { objects } = await this.read(deviceId);
    const replacing = objects.some((existing) => existing.id === object.id);
    if (!replacing && objects.length >= CANVAS_LIMITS.objects) {
      throw new YoloError("invalid_request", `A canvas holds at most ${CANVAS_LIMITS.objects} objects; remove one first`);
    }
    await this.store(deviceId, object);
    await this.publish(await this.reach(object.scope, deviceId), [{ op: "put", object }]);
    this.log("canvas_put", { deviceId, objectId: object.id, kind: object.kind, scope: object.scope, owner });
    return object;
  }

  async store(deviceId, object) {
    if (object.scope === "all") {
      const shared = await this.shared();
      shared.objects[object.id] = object;
      await this.storage.put(ALL_KEY, { objects: Object.fromEntries(live(shared.objects, this.now()).map((entry) => [entry.id, entry])) });
      return;
    }
    const own = await this.own(deviceId);
    own.objects = Object.fromEntries(live(own.objects, this.now()).map((entry) => [entry.id, entry]));
    own.objects[object.id] = object;
    await this.storage.put(`${DEVICE_KEY}${deviceId}`, own);
  }

  /**
   * Changes an object: `changes` replaces its props (merged one level),
   * layout, actions, fallback, or expiry, and the object is checked again.
   */
  async patch(deviceId, objectId, changes = {}) {
    this.limit();
    const existing = await this.find(deviceId, objectId);
    if (!existing) throw new YoloError("not_found", `No object ${objectId} on this screen's canvas`);
    const object = normalizeCanvasObject({
      ...existing,
      props: changes.props ? { ...existing.props, ...changes.props } : existing.props,
      layout: changes.layout ? { ...existing.layout, ...changes.layout } : existing.layout,
      actions: changes.actions ?? existing.actions,
      fallback: changes.fallback ?? existing.fallback,
      expiresAt: changes.expiresAt !== undefined ? changes.expiresAt : existing.expiresAt,
    }, { owner: existing.owner, now: this.now(), id: existing.id });
    object.createdAt = existing.createdAt;
    await this.store(deviceId, object);
    await this.publish(await this.reach(object.scope, deviceId), [{ op: "put", object }]);
    return object;
  }

  /** Removes an object from the canvas it is on: every screen's, for a shared one. */
  async remove(deviceId, objectId, { limited = true } = {}) {
    if (limited) this.limit();
    const [own, shared] = await Promise.all([this.own(deviceId), this.shared()]);
    if (own.objects[objectId]) {
      delete own.objects[objectId];
      await this.storage.put(`${DEVICE_KEY}${deviceId}`, own);
      await this.publish([deviceId], [{ op: "remove", id: objectId }]);
      return { removed: true };
    }
    if (shared.objects[objectId]) {
      delete shared.objects[objectId];
      await this.storage.put(ALL_KEY, shared);
      await this.publish(await this.reach("all", deviceId), [{ op: "remove", id: objectId }]);
      return { removed: true };
    }
    throw new YoloError("not_found", `No object ${objectId} on this screen's canvas`);
  }

  /** A screen paired again or removed: its own canvas goes with it. */
  async forget(deviceId) {
    await this.storage.delete(`${DEVICE_KEY}${deviceId}`);
  }

  /**
   * What a gesture on `objectId` asks for: the object and its action. A
   * choice's `pick` plays the option the payload names, or queues it next
   * with `after: true`; a `dismiss` without an action of its own removes the
   * object; anything else only notifies.
   */
  async resolveGesture(deviceId, { objectId, gesture, payload = null }) {
    if (!CANVAS_GESTURES.includes(gesture)) throw new YoloError("invalid_request", `gesture must be one of ${CANVAS_GESTURES.join(", ")}`);
    if (byteLength(payload) > CANVAS_LIMITS.payloadBytes) throw new YoloError("invalid_request", `payload is larger than ${CANVAS_LIMITS.payloadBytes} bytes`);
    const object = await this.find(deviceId, objectId);
    if (!object) throw new YoloError("not_found", "That object is no longer on this screen");
    if (object.kind === "choices" && gesture === "pick") {
      const index = Number(payload?.option);
      const option = Number.isInteger(index) ? object.props.options[index] : null;
      if (!option) throw new YoloError("invalid_request", "payload.option must name one of the choices");
      return { object, option: index, action: { do: option.item ? (payload?.after ? "queue" : "play") : "notify" }, item: option.item ?? null };
    }
    const action = object.actions[gesture] ?? { do: gesture === "dismiss" ? "remove" : "notify" };
    return { object, option: null, action, item: null };
  }

  /** Adds an event to the log and wakes the agents waiting for it. */
  async record(event) {
    const now = this.now();
    const cursor = ((await this.storage.get(CURSOR_KEY)) || 0) + 1;
    const entry = { cursor, at: now, ...event };
    const kept = ((await this.storage.get(EVENTS_KEY)) || [])
      .filter((existing) => now - existing.at < CANVAS_LIMITS.eventsKeptMs)
      .slice(-(CANVAS_LIMITS.events - 1));
    await this.storage.put(EVENTS_KEY, [...kept, entry]);
    await this.storage.put(CURSOR_KEY, cursor);
    for (const waiter of [...this.waiters]) waiter(entry);
    return entry;
  }

  /**
   * The events after `since`, of `objects` when given. With `waitSeconds`
   * and none yet, waits for the first that matches, up to the limit.
   */
  async events({ since = 0, objects = null, waitSeconds = 0 } = {}) {
    const wanted = objects?.length ? new Set(objects) : null;
    const matches = (event) => event.cursor > since && (!wanted || wanted.has(event.objectId));
    const now = this.now();
    const log = ((await this.storage.get(EVENTS_KEY)) || []).filter((event) => now - event.at < CANVAS_LIMITS.eventsKeptMs);
    const found = log.filter(matches);
    const cursor = (await this.storage.get(CURSOR_KEY)) || 0;
    const wait = Math.min(CANVAS_LIMITS.waitSeconds, Math.max(0, Number(waitSeconds) || 0));
    if (found.length || !wait) return { events: found, cursor };
    const event = await this.waitFor(matches, wait * 1000);
    return event ? { events: [event], cursor: event.cursor } : { events: [], cursor };
  }

  /** Resolves the first event `matches` accepts, or null after `timeoutMs`. */
  waitFor(matches, timeoutMs) {
    return new Promise((resolve) => {
      const done = (event) => {
        if (event && !matches(event)) return;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(event ?? null);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      this.waiters.add(done);
    });
  }
}
