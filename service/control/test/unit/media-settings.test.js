import assert from "node:assert/strict";
import { test } from "node:test";
import { relayMedia } from "../../src/media.js";
import { forgetRelay, readMediaSettings, writeMediaSettings } from "../../src/store/media-settings.js";
import { applyMigration, createTestD1 } from "../helpers/d1.js";

// The relay's three modes (Agent Note 2026-10-13-media-off-the-worker).

test("migration 0008 keeps the relay on where it was on, keeps an owner's off, and makes every other user automatic", async () => {
  const db = createTestD1({ before: "0008_relay_mode.sql" });
  // 0006 gave users from before 2026-10-13 the relay on; later users got it off by default.
  const before0006 = Date.parse("2026-10-01T00:00:00Z");
  const after0006 = Date.parse("2026-10-14T00:00:00Z");
  const users = { usr_on: [before0006, 1, null], usr_turned_off: [before0006, 0, null], usr_accepted_off: [after0006, 0, after0006 + 60_000], usr_never: [after0006, 0, null], usr_new: [after0006] };
  for (const [id, [createdAt, relay, acceptedAt]] of Object.entries(users)) {
    db.raw.prepare("INSERT INTO users (id, user_id, display_name, created_at) VALUES (?, ?, 'Owner', ?)").run(id, id, createdAt);
    if (relay !== undefined) {
      db.raw.prepare("INSERT INTO media_settings (user_id, relay, relay_accepted_at, remote, updated_at) VALUES (?, ?, ?, 1, ?)").run(id, relay, acceptedAt, after0006);
    }
  }
  applyMigration(db.raw, "0008_relay_mode.sql");
  const modes = {};
  for (const id of Object.keys(users)) modes[id] = (await readMediaSettings(db, id)).relayMode;
  assert.deepEqual(modes, { usr_on: "on", usr_turned_off: "off", usr_accepted_off: "off", usr_never: "auto", usr_new: "auto" });
  // `relay` keeps saying whether the Worker relays, which the previous release reads.
  assert.deepEqual(db.raw.prepare("SELECT relay FROM media_settings ORDER BY user_id").all().map((row) => row.relay), [0, 1, 1, 0]);
});

test("the relay passes the node's answer through unchanged, and when the owner turned it off never reaches the node", async () => {
  const db = createTestD1();
  db.raw.prepare("INSERT INTO users (id, user_id, display_name, created_at) VALUES ('usr_r', 'usr_r', 'Owner', 0)").run();
  let calls = 0;
  const NODE = { fetch: async () => (calls += 1, Response.json({ code: "SESSION_EXPIRED" }, { status: 410, headers: { "x-yolo-error-code": "SESSION_EXPIRED" } })) };
  const env = { DB: db, NODE, NODE_TRANSPORT: "vpc", NODE_SECRET: "s" };
  const fetchSegment = () => relayMedia(new Request("https://yolo.example.com/m/ses_1.usr_r.9999999999.sig/f/0"), env);
  const relayed = await fetchSegment();
  assert.deepEqual([relayed.status, relayed.headers.get("x-yolo-error-code"), calls], [410, "SESSION_EXPIRED", 1], "automatic: the node's own answer");
  await writeMediaSettings(db, "usr_r", { relayMode: "off" });
  forgetRelay("usr_r"); // as the owner's settings do
  const refused = await fetchSegment();
  assert.deepEqual([refused.status, refused.headers.get("x-yolo-error-code"), calls], [403, "RELAY_OFF", 1]);
});
