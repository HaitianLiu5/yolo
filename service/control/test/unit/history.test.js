import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_LIMIT } from "@useyolo/core";
import { createTestD1 } from "../helpers/d1.js";
import * as history from "../../src/store/history.js";

const user = "usr_a";

test("history upserts by source key and keeps the newest 500", async () => {
  const db = createTestD1();
  // Two spellings of one video share the source id their plugin chose.
  await history.recordPlay(db, user, { source: { plugin: "web", id: "https://video.test/abc", url: "https://short.test/abc" }, title: "A" });
  await history.recordPlay(db, user, { source: { plugin: "web", id: "https://video.test/abc", url: "https://video.test/abc?t=3" }, title: "A again" });
  let entries = await history.listHistory(db, user);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].playCount, 2);
  assert.equal(entries[0].title, "A again");

  const insert = db.raw.prepare("INSERT INTO history (user_id, source_key, source, title, updated_at) VALUES (?, ?, '{}', 't', ?)");
  db.raw.transaction(() => {
    for (let i = 0; i < HISTORY_LIMIT + 20; i += 1) insert.run(user, `library:${i}`, i);
  })();
  await history.recordPlay(db, user, { source: { plugin: "library", id: "new" }, title: "New" });
  entries = await history.listHistory(db, user, { limit: 1000 });
  assert.equal(entries.length, HISTORY_LIMIT);
  assert.equal(entries[0].sourceKey, "library:new");
  assert.equal(await history.deleteHistory(db, user, "library:new"), 1);
  assert.equal(await history.deleteHistory(db, user), HISTORY_LIMIT - 1);
});
