import assert from "node:assert/strict";
import test from "node:test";

import { createChat, readLines, REMEMBER_MS, stepText } from "../../src/ask.js";

const ndjson = (...events) => new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""), { headers: { "content-type": "application/x-ndjson" } });

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

function setup(respond, { conversations = {}, clock = { now: 0 } } = {}) {
  const sent = [];
  const seen = [];
  let played = 0;
  const storage = memoryStorage();
  const chat = createChat({
    request: async (id, body, signal) => {
      sent.push({ id, ...body });
      return respond(id, body, signal);
    },
    load: async (id) => {
      if (!conversations[id]) throw new Error("No such conversation");
      return conversations[id];
    },
    list: async () => Object.values(conversations),
    storage,
    now: () => clock.now,
    onChange: (conversation) => seen.push(conversation.messages.at(-1)?.text),
    onPlayed: () => { played += 1; },
  });
  return { chat, sent, seen, storage, played: () => played };
}

test("lines arrive whole however the stream splits them", async () => {
  const chunks = ['{"a":', '1}\n{"b"', ':2}\n\n{"c":3}'];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const lines = [];
  for await (const line of readLines(body)) lines.push(line);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("a question shows each step, then the answer, and the follow-up stays in the conversation", async () => {
  const { chat, sent, seen, played } = setup((id, body) => ndjson(
    ...(id === "new" ? [{ type: "conversation", id: "cnv_1", title: body.text }] : []),
    { type: "tool", name: "WebSearch" },
    { type: "done", text: `Playing ${body.text}.` },
  ));
  await chat.ask("play friends", "en");
  assert.ok(seen.includes(stepText("WebSearch")));
  assert.equal(chat.current.id, "cnv_1");
  assert.equal(chat.current.title, "play friends");
  await chat.ask("the next one");
  assert.deepEqual(sent.map(({ id, text }) => [id, text]), [["new", "play friends"], ["cnv_1", "the next one"]]);
  assert.deepEqual(chat.current.messages, [
    { role: "user", text: "play friends" },
    { role: "agent", text: "Playing play friends.", kind: "done" },
    { role: "user", text: "the next one" },
    { role: "agent", text: "Playing the next one.", kind: "done" },
  ]);
  // Nothing played here, so the panel stays for the answer.
  assert.equal(played(), 0);
});

test("an answer that played something here lets the panel step aside", async () => {
  const { chat, played } = setup(() => ndjson({ type: "conversation", id: "cnv_1" }, { type: "tool", name: "play" }, { type: "done", text: "Playing." }));
  await chat.ask("play it");
  assert.equal(played(), 1);
});

test("an error from Yolo or the agent is the answer shown", async () => {
  const refused = setup(() => Response.json({ error: { code: "not_found", message: "Upgrade the media node" } }, { status: 404 }));
  await refused.chat.ask("play");
  assert.deepEqual(refused.chat.current.messages.at(-1), { role: "agent", text: "Upgrade the media node", kind: "error" });
  const failed = setup(() => ndjson({ type: "conversation", id: "cnv_1" }, { type: "error", error: { message: "Connect Yolo to Claude Code" } }));
  await failed.chat.ask("play");
  assert.deepEqual(failed.chat.current.messages.at(-1), { role: "agent", text: "Connect Yolo to Claude Code", kind: "error" });
});

test("Stop ends the answer, and asking again stops the one running", async () => {
  let aborted = 0;
  const { chat } = setup((_id, _body, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborted += 1;
      reject(new DOMException("aborted", "AbortError"));
    });
  }));
  const first = chat.ask("one");
  assert.equal(chat.running, true);
  const second = chat.ask("two");
  chat.stop();
  await Promise.all([first, second]);
  assert.equal(aborted, 2);
  assert.equal(chat.running, false);
  assert.deepEqual(chat.current.messages.filter(({ role }) => role === "agent").map(({ kind }) => kind), ["stopped", "stopped"]);
});

test("the panel reopens on the last conversation for six hours, and New starts over", async () => {
  const clock = { now: 0 };
  const conversations = {
    cnv_1: { id: "cnv_1", title: "play friends", messages: [{ role: "user", text: "play friends" }, { role: "agent", text: "", status: "stopped" }] },
  };
  const respond = () => ndjson({ type: "conversation", id: "cnv_1", title: "play friends" }, { type: "done", text: "Playing." });
  const first = setup(respond, { conversations, clock });
  await first.chat.ask("play friends");

  // Another page on this screen, a while later.
  const later = createChat({ request: respond, load: async (id) => conversations[id], list: async () => [], storage: first.storage, now: () => clock.now });
  clock.now = REMEMBER_MS - 1;
  await later.resume();
  assert.equal(later.current.id, "cnv_1");
  assert.deepEqual(later.current.messages.at(-1), { role: "agent", text: "Stopped.", kind: "stopped" });

  later.startNew();
  const fresh = createChat({ request: respond, load: async (id) => conversations[id], list: async () => [], storage: first.storage, now: () => clock.now });
  await fresh.resume();
  assert.equal(fresh.current.id, null);

  // Too old to come back on its own.
  await first.chat.open("cnv_1");
  clock.now += REMEMBER_MS;
  const stale = createChat({ request: respond, load: async (id) => conversations[id], list: async () => [], storage: first.storage, now: () => clock.now });
  await stale.resume();
  assert.equal(stale.current.id, null);
});

test("a conversation that loads late does not replace what came after it", async () => {
  let finish;
  const storage = memoryStorage();
  storage.setItem("yolo.ask.conversation", JSON.stringify({ id: "cnv_old", at: 0 }));
  const chat = createChat({
    request: async () => ndjson({ type: "conversation", id: "cnv_new", title: "play news" }, { type: "done", text: "Playing." }),
    load: (id) => new Promise((resolve) => { finish = () => resolve({ id, title: "old", messages: [] }); }),
    list: async () => [],
    storage,
    now: () => 0,
  });
  const resuming = chat.resume();
  await chat.ask("play news");
  finish();
  await resuming;
  assert.equal(chat.current.id, "cnv_new");
});
