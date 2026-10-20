import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_LIMIT } from "@useyolo/core";
import { createTestD1 } from "../helpers/d1.js";
import * as history from "../../src/store/history.js";
import * as conversations from "../../src/store/agent-conversations.js";

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

test("agent conversations keep the newest 500 and drop those idle 90 days", async () => {
  const db = createTestD1();
  const now = conversations.CONVERSATION_RETENTION_MS * 2;
  const insert = db.raw.prepare("INSERT INTO agent_conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, 't', ?, ?)");
  db.raw.transaction(() => {
    insert.run("cnv_old", user, 0, 0);
    for (let i = 0; i < conversations.CONVERSATION_LIMIT; i += 1) insert.run(`cnv_${i}`, user, now - 1000 + i, now - 1000 + i);
  })();
  const kept = await conversations.createConversation(db, user, { title: "x".repeat(200), now });
  assert.equal(kept.title.length, conversations.TITLE_LENGTH);
  const ids = (await conversations.listConversations(db, user, { limit: 1000 })).map(({ id }) => id);
  assert.equal(ids.length, conversations.CONVERSATION_LIMIT);
  assert.equal(ids[0], kept.id);
  assert.ok(!ids.includes("cnv_old") && !ids.includes("cnv_0"));

  // An answer keeps only what a screen shows, capped, next to its question
  // however late it ends.
  const first = await conversations.addQuestion(db, user, kept.id, "one", now);
  const second = await conversations.addQuestion(db, user, kept.id, "two", now + 1);
  await conversations.addAnswer(db, user, kept.id, second, { text: "b", status: "done" });
  await conversations.addAnswer(db, user, kept.id, first, { text: "a".repeat(5000), steps: Array(30).fill("search"), status: "stopped", session: "s-1" });
  const messages = await conversations.listMessages(db, user, kept.id);
  assert.deepEqual(messages.map(({ role, status }) => [role, status]), [["user", undefined], ["agent", "stopped"], ["user", undefined], ["agent", "done"]]);
  const message = messages[1];
  assert.equal(message.text.length, conversations.MAX_ANSWER_TEXT);
  assert.equal(message.steps.length, conversations.MAX_STEPS);
  assert.equal((await conversations.getConversation(db, user, kept.id)).agentSession, "s-1");
});
