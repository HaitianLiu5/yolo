import { HubCore } from "../../src/hub/hub-core.js";
import { createServices } from "../../src/services.js";
import { upsertDevice } from "../../src/store/devices.js";
import { createTestD1 } from "./d1.js";
import { createDefaultNode, createFakeTransport, createMemoryStorage } from "./fakes.js";

export const USER = "usr_test";

// A full control plane minus Workers: real migrations, HubCore, services.
export function createTestControlPlane({ node = createDefaultNode(), connected = [], db = createTestD1(), helloWaitMs, allowFrame } = {}) {
  db.raw.prepare("INSERT OR IGNORE INTO users (id, user_id, display_name, created_at) VALUES (?, ?, 'Owner', 0)").run(USER, USER);
  const transport = createFakeTransport(connected);
  let clock = 1_000_000;
  const logs = [];
  const storage = createMemoryStorage();
  const hub = new HubCore({
    userId: USER,
    storage,
    db,
    node,
    transport,
    now: () => clock,
    log: (record) => logs.push(record),
    ...(helloWaitMs !== undefined ? { helloWaitMs } : {}),
  });
  const services = createServices({ db, userId: USER, hub, node, log: (record) => logs.push(record), ...(allowFrame ? { allowFrame } : {}) });
  return {
    db, node, transport, hub, services, storage, logs,
    advance(ms) {
      clock += ms;
    },
  };
}

// A paired screen that is connected, as the player is after its hello.
export async function onlineScreen(plane, { name = "Car", kind = "car", capabilities = {} } = {}) {
  const device = await upsertDevice(plane.db, USER, { name, kind, capabilities });
  plane.transport.online.add(device.id);
  return device;
}
