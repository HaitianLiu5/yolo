import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMigration, createTestD1 } from "../helpers/d1.js";
import { readMediaSettings, relayEnabled, writeMediaSettings } from "../../src/store/media-settings.js";

// The relay's three modes (Agent Note 2026-10-13-media-off-the-worker):
// migration 0008 keeps the relay on where it was on, keeps an owner's own
// "off", and makes every other user automatic, the default for new users.

const MIGRATION = "0008_relay_mode.sql";
// Migration 0006 gave every user that existed when it ran the relay on; it
// was written on 2026-10-13, so a user created before then got such a row.
const BEFORE_0006 = Date.parse("2026-10-01T00:00:00Z");
const AFTER_0006 = Date.parse("2026-10-14T00:00:00Z");

function before0008() {
  const db = createTestD1({ before: MIGRATION });
  const user = (id, createdAt) => db.raw.prepare("INSERT INTO users (id, user_id, display_name, created_at) VALUES (?, ?, 'Owner', ?)").run(id, id, createdAt);
  const row = (id, relay, acceptedAt) => db.raw.prepare("INSERT INTO media_settings (user_id, relay, relay_accepted_at, remote, updated_at) VALUES (?, ?, ?, 1, ?)").run(id, relay, acceptedAt, AFTER_0006);
  return { db, user, row };
}

test("migration 0008 keeps the relay on where it was on, keeps an owner's off, and makes every other user automatic", async () => {
  const { db, user, row } = before0008();
  // From before 0.5: 0006 gave it the relay on, and it stayed on.
  user("usr_on", BEFORE_0006);
  row("usr_on", 1, null);
  // From before 0.5: 0006 gave it the relay on, and the owner turned it off.
  user("usr_turned_off", BEFORE_0006);
  row("usr_turned_off", 0, null);
  // Turned on through the warning, then off again.
  user("usr_accepted_off", AFTER_0006);
  row("usr_accepted_off", 0, AFTER_0006 + 60_000);
  // A new instance whose owner turned remote access on: the relay was off by default.
  user("usr_never", AFTER_0006);
  row("usr_never", 0, null);
  // A new instance whose owner never opened the media settings.
  user("usr_new", AFTER_0006);

  applyMigration(db.raw, MIGRATION);

  const modes = {};
  for (const id of ["usr_on", "usr_turned_off", "usr_accepted_off", "usr_never", "usr_new"]) modes[id] = (await readMediaSettings(db, id)).relayMode;
  assert.deepEqual(modes, { usr_on: "on", usr_turned_off: "off", usr_accepted_off: "off", usr_never: "auto", usr_new: "auto" });
  // `relay` keeps saying whether the Worker relays, which the previous release reads.
  assert.deepEqual(db.raw.prepare("SELECT user_id, relay, relay_mode FROM media_settings ORDER BY user_id").all(), [
    { user_id: "usr_accepted_off", relay: 0, relay_mode: "off" },
    { user_id: "usr_never", relay: 1, relay_mode: "auto" },
    { user_id: "usr_on", relay: 1, relay_mode: "on" },
    { user_id: "usr_turned_off", relay: 0, relay_mode: "off" },
  ]);
  assert.equal(await relayEnabled(db, "usr_never"), true);
  assert.equal(await relayEnabled(db, "usr_new"), true, "a user without a row is automatic");
  assert.equal(await relayEnabled(db, "usr_turned_off"), false);
});

test("each mode is written with the relay column the previous release reads, and that release's own writes stay readable", async () => {
  const db = createTestD1();
  db.raw.prepare("INSERT INTO users (id, user_id, display_name, created_at) VALUES ('usr_w', 'usr_w', 'Owner', 0)").run();
  assert.equal((await readMediaSettings(db, "usr_w")).relayMode, "auto");
  for (const mode of ["off", "on", "auto"]) {
    const written = await writeMediaSettings(db, "usr_w", { relayMode: mode });
    assert.equal(written.relayMode, mode);
    assert.equal((await readMediaSettings(db, "usr_w")).relayMode, mode);
    assert.equal(db.raw.prepare("SELECT relay FROM media_settings WHERE user_id = 'usr_w'").get().relay, mode === "off" ? 0 : 1);
  }
  // The previous release turns the relay off and on by the relay column alone.
  db.raw.prepare("UPDATE media_settings SET relay = 0 WHERE user_id = 'usr_w'").run();
  assert.equal((await readMediaSettings(db, "usr_w")).relayMode, "off");
  await writeMediaSettings(db, "usr_w", { relayMode: "off" });
  db.raw.prepare("UPDATE media_settings SET relay = 1 WHERE user_id = 'usr_w'").run();
  assert.equal((await readMediaSettings(db, "usr_w")).relayMode, "on");
  assert.throws(() => db.raw.prepare("UPDATE media_settings SET relay_mode = 'sometimes'").run(), /CHECK/);
});
