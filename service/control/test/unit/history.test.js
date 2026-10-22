import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_LIMIT } from "@useyolo/core";
import { applyMigration, createTestD1 } from "../helpers/d1.js";
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

  // An item found under a new id that has its own entry already leaves the
  // old one (Agent Note 2026-10-21-moved-library-items).
  await history.recordPlay(db, user, { source: { plugin: "library", id: "old" }, title: "B", position: 30 });
  await history.recordPlay(db, user, { source: { plugin: "library", id: "moved" }, title: "B" });
  await history.relocateHistory(db, user, "library:old", { plugin: "library", id: "moved" });
  entries = await history.listHistory(db, user);
  assert.deepEqual(entries.filter((entry) => entry.title === "B").map((entry) => [entry.sourceKey, entry.position]), [["library:moved", 0]]);

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

test("history keeps an item watched when it plays again", async () => {
  const db = createTestD1();
  const source = { plugin: "library", id: "film" };
  const watched = async () => (await history.getHistoryEntry(db, user, "library:film")).watched;
  await history.recordPlay(db, user, { source, title: "Film", duration: 1000 });
  await history.recordProgress(db, user, "library:film", { position: 900, duration: 1000 });
  assert.equal(await watched(), false);
  // Its last minute, by the duration the entry already has.
  await history.recordProgress(db, user, "library:film", { position: 950, duration: null });
  assert.equal(await watched(), true);
  // Played again from the start: the position moves, the mark stays.
  await history.recordPlay(db, user, { source, title: "Film", duration: 1000 });
  await history.recordProgress(db, user, "library:film", { position: 12, duration: 1000 });
  const entry = await history.getHistoryEntry(db, user, "library:film");
  assert.deepEqual([entry.position, entry.watched, entry.playCount], [12, true, 2]);
});

test("migration 0011 marks entries already at their end watched", () => {
  const db = createTestD1({ before: "0011_history_watched.sql" });
  const insert = db.raw.prepare("INSERT INTO history (user_id, source_key, source, title, position, duration, updated_at) VALUES (?, ?, '{}', 't', ?, ?, 7)");
  insert.run(user, "library:done", 3990, 4039);
  insert.run(user, "library:half", 519, 4039);
  insert.run(user, "library:live", 50, null);
  applyMigration(db.raw, "0011_history_watched.sql");
  const rows = db.raw.prepare("SELECT source_key, watched_at FROM history ORDER BY source_key").all();
  assert.deepEqual(rows.map((row) => [row.source_key, row.watched_at]), [["library:done", 7], ["library:half", null], ["library:live", null]]);
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
  await conversations.addAnswer(db, user, kept.id, second, { text: "b", status: "done", session: "s-2" });
  await conversations.addAnswer(db, user, kept.id, first, { text: "a".repeat(5000), steps: Array(30).fill("search"), status: "stopped", session: "s-1" });
  const messages = await conversations.listMessages(db, user, kept.id);
  assert.deepEqual(messages.map(({ role, status }) => [role, status]), [["user", undefined], ["agent", "stopped"], ["user", undefined], ["agent", "done"]]);
  const message = messages[1];
  assert.equal(message.text.length, conversations.MAX_ANSWER_TEXT);
  assert.equal(message.steps.length, conversations.MAX_STEPS);
  // The older answer, recorded last, leaves the newer one's session.
  assert.equal((await conversations.getConversation(db, user, kept.id)).agentSession, "s-2");

  // A newer answer that failed holds nothing back.
  const third = await conversations.addQuestion(db, user, kept.id, "three", now + 2);
  const fourth = await conversations.addQuestion(db, user, kept.id, "four", now + 3);
  await conversations.addAnswer(db, user, kept.id, fourth, { text: "Overloaded", status: "error" });
  await conversations.addAnswer(db, user, kept.id, third, { text: "c", status: "done", session: "s-3" });
  assert.equal((await conversations.getConversation(db, user, kept.id)).agentSession, "s-3");

  // A conversation in use keeps its newest messages.
  for (let i = 0; i < conversations.MESSAGE_LIMIT / 2 + 5; i += 1) await conversations.addQuestion(db, user, kept.id, `q${i}`, now + 10 + i);
  const latest = await conversations.listMessages(db, user, kept.id);
  assert.equal(latest.length, conversations.MESSAGE_LIMIT);
  assert.equal(latest.at(-2).text, `q${conversations.MESSAGE_LIMIT / 2 + 4}`);
});
